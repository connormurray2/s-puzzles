/**
 * Lock and spend every s-puzzle variant on chain.
 *
 *   pnpm demo                 lock + spend all four puzzles on testnet
 *   pnpm demo --dry-run       build and verify every transaction offline
 *   pnpm demo --only=SPuzzle  a single variant
 *
 * Environment: NETWORK (testnet|mainnet, default testnet), FEE_RATE (sat/kB,
 * default 100), PUZZLE_SATS (default 5000), FUNDING_WIF, BROADCASTER_URL (the BSV
 * Broadcaster; defaults to the public instance for NETWORK).
 *
 * Progress is saved to .demo-state.json (gitignored, holds the puzzle
 * secrets) so an interrupted run resumes instead of stranding funds. Public
 * results go to deployments/<network>.json and docs/TRANSACTIONS.md.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { LockingScript, P2PKH, Transaction } from '@bsv/sdk';
import { broadcast, explorerTx, fetchUtxos, stubSource, type FundingUtxo, type Network } from '../src/chain.js';
import { CONTRACT_NAMES, type ContractName } from '../src/compile.js';
import { PUZZLE_FACTORIES, type PuzzleSecrets } from '../src/puzzles.js';
import { buildSpend, verifySpend, type PuzzleUtxo } from '../src/spend.js';
import { loadWallet } from '../src/wallet.js';

const dryRun = process.argv.includes('--dry-run');
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7) as ContractName | undefined;
const network = (process.env.NETWORK ?? 'testnet') as Network;
const feeRate = Number(process.env.FEE_RATE ?? 100);
const puzzleSats = Number(process.env.PUZZLE_SATS ?? 5000);
const label = dryRun ? 'dry-run' : network;

const STATE_FILE = dryRun ? '.demo-state.dry-run.json' : '.demo-state.json';
const OUT_FILE = `deployments/${label}.json`;

interface Entry {
  secrets: { x: string; aux?: string };
  lock?: { txid: string; vout: number; satoshis: number; txBytes: number; scriptBytes: number };
  spend?: Record<string, unknown>;
}
type State = Partial<Record<ContractName, Entry>>;

const state: State = !dryRun && existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};
const save = () => { if (!dryRun) writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 }); };
const hex = (n: bigint) => n.toString(16).padStart(64, '0');
const toSecrets = (s: Entry['secrets']): PuzzleSecrets =>
  ({ x: BigInt('0x' + s.x), aux: s.aux ? BigInt('0x' + s.aux) : undefined });

const wallet = loadWallet(network, dryRun);
const p2pkh = new P2PKH();
const walletScript = p2pkh.lock(wallet.address);
const feeFor = (bytes: number) => Math.max(1, Math.ceil((bytes * feeRate) / 1000));

// Funding pool. Tracked locally so unconfirmed change can be chained.
let pool: FundingUtxo[];
if (dryRun) {
  const fake = new Transaction();
  fake.addOutput({ satoshis: 50_000_000, lockingScript: walletScript });
  pool = [{ txid: fake.id('hex'), vout: 0, satoshis: 50_000_000 }];
} else {
  // Confirmed coins only: an unconfirmed parent that the miners never pick up
  // would stall every lock chained from it. Change from a lock in this run is
  // still chained directly, below.
  pool = await fetchUtxos(network, wallet.address, { confirmedOnly: true });
  if (pool.length === 0) throw new Error('No confirmed funding coins yet; wait for a block and rerun.');
}
console.log(`${label}: ${wallet.address} has ${pool.reduce((a, u) => a + u.satoshis, 0)} sats; fee rate ${feeRate} sat/kB`);

const send = async (tx: Transaction): Promise<string> => (dryRun ? tx.id('hex') : broadcast(network, tx));

const records: Record<string, unknown>[] = [];

for (const name of CONTRACT_NAMES) {
  if (only && only !== name) continue;
  let entry = state[name];
  if (!entry) {
    const fresh = PUZZLE_FACTORIES[name]();
    entry = { secrets: { x: hex(fresh.secrets.x), aux: fresh.secrets.aux ? hex(fresh.secrets.aux) : undefined } };
    state[name] = entry;
    save();
  }
  const puzzle = PUZZLE_FACTORIES[name](toSecrets(entry.secrets));
  const script = puzzle.contract.getLockingScript();
  console.log(`\n== ${puzzle.title}`);

  // ---- Lock: fund an output carrying the s-puzzle script -----------------
  if (!entry.lock) {
    const inputs = pool;
    const total = inputs.reduce((a, u) => a + u.satoshis, 0);
    // Sign with each input's amount and script given directly, so a funding
    // coin needs no parent transaction. Size the fee from the signed draft.
    const signLock = async (change: number) => {
      const tx = new Transaction();
      for (const u of inputs) {
        tx.addInput({
          sourceTXID: u.txid,
          sourceOutputIndex: u.vout,
          unlockingScriptTemplate: p2pkh.unlock(wallet.key, 'all', false, u.satoshis, walletScript),
          sequence: 0xffffffff,
        });
      }
      tx.addOutput({ satoshis: puzzleSats, lockingScript: LockingScript.fromHex(script) });
      tx.addOutput({ satoshis: change, lockingScript: walletScript });
      await tx.sign();
      return tx;
    };
    const draft = await signLock(total - puzzleSats);
    const fee = feeFor(draft.toHex().length / 2 + 2);
    const change = total - puzzleSats - fee;
    if (change < 1) throw new Error(`${name}: need ${puzzleSats + fee + 1} sats, wallet has ${total}`);
    const tx = await signLock(change);
    inputs.forEach((u, i) => { tx.inputs[i]!.sourceTransaction = stubSource(u.vout, u.satoshis, walletScript); });
    const txid = await send(tx);
    entry.lock = {
      txid, vout: 0, satoshis: puzzleSats,
      txBytes: tx.toHex().length / 2, scriptBytes: script.length / 2,
    };
    pool = [{ txid, vout: 1, satoshis: change }];
    save();
    console.log(`   lock  ${txid}  (${entry.lock.txBytes} bytes, fee ${fee} sats)`);
  } else {
    console.log(`   lock  ${entry.lock.txid}  (already done)`);
  }

  // ---- Spend: prove knowledge and pay the funds back to the wallet -------
  if (!entry.spend) {
    const utxo: PuzzleUtxo = { txid: entry.lock.txid, vout: entry.lock.vout, satoshis: entry.lock.satoshis, script };
    const outFor = (fee: number) => [{ satoshis: utxo.satoshis - fee, script: walletScript.toHex() }];
    // Size the transaction once, then build it for real with the right fee.
    const probe = buildSpend(puzzle.contract, utxo, outFor(0), puzzle.prove);
    const fee = feeFor(probe.tx.toHex().length / 2 + 4);
    const built = buildSpend(puzzle.contract, utxo, outFor(fee), puzzle.prove);
    const check = verifySpend(built.tx, utxo);
    if (!check.valid) throw new Error(`${name}: local script verification failed: ${check.error}`);
    // Carry the puzzle output as the input's source so the spend goes out in
    // Extended Format; only that output's satoshis and script are needed.
    built.tx.inputs[0]!.sourceTransaction = stubSource(utxo.vout, utxo.satoshis, LockingScript.fromHex(script));
    const txid = await send(built.tx);
    entry.spend = {
      txid,
      txBytes: built.tx.toHex().length / 2,
      fee,
      outpoint: built.binding.outpoint,
      hashOutputs: built.binding.hashOutputs,
      proof: built.proof.map((v) => (typeof v === 'bigint' ? v.toString() : v)),
    };
    save();
    console.log(`   spend ${txid}  (${entry.spend.txBytes} bytes, fee ${fee} sats, verified locally)`);
  } else {
    console.log(`   spend ${entry.spend.txid}  (already done)`);
  }

  const method = puzzle.contract.artifact.abi.methods.find((m: any) => m.name === 'unlock')!;
  records.push({
    contract: name,
    title: puzzle.title,
    statement: puzzle.statement,
    witness: puzzle.witness,
    publicParams: puzzle.publicParams,
    proofFields: method.params.slice(0, -1).map((p: any) => p.name),
    lock: entry.lock,
    spend: entry.spend,
  });
}

mkdirSync('deployments', { recursive: true });
writeFileSync(OUT_FILE, JSON.stringify({ network: label, feeRate, puzzles: records }, null, 2) + '\n');
console.log(`\nwrote ${OUT_FILE}`);

if (!dryRun) {
  const short = (s: string) => (s.length > 40 ? `${s.slice(0, 16)}…${s.slice(-16)}` : s);
  const lines = [
    `# S-puzzle transactions on ${network}`,
    '',
    'Generated by `pnpm demo`. Each puzzle has a **lock** transaction, whose output 0 carries the',
    's-puzzle script, and a **spend** transaction, whose input 0 carries the proof.',
    '',
    '| Puzzle | Statement | Lock tx | Lock size | Spend tx | Spend size |',
    '| --- | --- | --- | --- | --- | --- |',
    ...records.map((r: any) =>
      `| ${r.title} | ${r.statement} | [${r.lock.txid.slice(0, 12)}…](${explorerTx(network, r.lock.txid)}) | ` +
      `${r.lock.txBytes.toLocaleString('en-US')} B | [${r.spend.txid.slice(0, 12)}…](${explorerTx(network, r.spend.txid)}) | ` +
      `${r.spend.txBytes.toLocaleString('en-US')} B |`),
    '',
  ];
  for (const r of records as any[]) {
    lines.push(`## ${r.title}`, '', `- Contract: \`contracts/${r.contract}.runar.ts\``,
      `- Statement: ${r.statement}`, `- The spender proves knowledge of: ${r.witness}`,
      `- Lock: \`${r.lock.txid}\` output ${r.lock.vout}, ${r.lock.satoshis} sats, script ${r.lock.scriptBytes.toLocaleString('en-US')} bytes`,
      `- Spend: \`${r.spend.txid}\``, '', 'Public parameters in the locking script:', '',
      ...Object.entries(r.publicParams).map(([k, v]) => `- \`${k}\` = \`${short(String(v))}\``), '',
      'Proof pushed in the unlocking script (followed by the BIP-143 preimage):', '',
      ...r.proofFields.map((f: string, i: number) => `- \`${f}\` = \`${short(String(r.spend.proof[i]))}\``), '',
      `Spend binding: outpoint \`${short(r.spend.outpoint)}\`, hashOutputs \`${short(r.spend.hashOutputs)}\``, '');
  }
  writeFileSync('docs/TRANSACTIONS.md', lines.join('\n'));
  console.log('wrote docs/TRANSACTIONS.md');
}

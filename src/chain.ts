/**
 * Minimal chain access for the demo: list UTXOs and broadcast, via the
 * WhatsOnChain API, with ARC as a broadcast fallback for large transactions.
 */
import { Transaction } from '@bsv/sdk';

export type Network = 'testnet' | 'mainnet';

export interface FundingUtxo {
  txid: string;
  vout: number;
  satoshis: number;
  /** The full funding transaction (needed to sign P2PKH inputs). */
  sourceTransaction: Transaction;
}

const WOC = (n: Network) => `https://api.whatsonchain.com/v1/bsv/${n === 'mainnet' ? 'main' : 'test'}`;
const ARC = (n: Network) =>
  process.env.ARC_URL ?? (n === 'mainnet' ? 'https://arc.taal.com' : 'https://arc-test.taal.com');

export const explorerTx = (n: Network, txid: string) =>
  `https://${n === 'mainnet' ? '' : 'test.'}whatsonchain.com/tx/${txid}`;

async function getJson(url: string): Promise<any> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status} ${await r.text()}`);
  return r.json();
}

export async function fetchTx(n: Network, txid: string): Promise<Transaction> {
  const r = await fetch(`${WOC(n)}/tx/${txid}/hex`);
  if (!r.ok) throw new Error(`fetch tx ${txid} -> ${r.status} ${await r.text()}`);
  const tx = Transaction.fromHex((await r.text()).trim());
  if (tx.id('hex') !== txid) throw new Error(`txid mismatch for ${txid}`);
  return tx;
}

export async function fetchUtxos(n: Network, address: string): Promise<FundingUtxo[]> {
  const entries: Array<{ tx_hash: string; tx_pos: number; value: number }> =
    await getJson(`${WOC(n)}/address/${address}/unspent`);
  const out: FundingUtxo[] = [];
  for (const e of entries) {
    out.push({
      txid: e.tx_hash, vout: e.tx_pos, satoshis: e.value,
      sourceTransaction: await fetchTx(n, e.tx_hash),
    });
  }
  return out;
}

/** Broadcast a transaction; returns the txid reported by the network. */
export async function broadcast(n: Network, tx: Transaction): Promise<string> {
  const hex = tx.toHex();
  const viaWoc = async () => {
    const r = await fetch(`${WOC(n)}/tx/raw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txhex: hex }),
    });
    if (!r.ok) throw new Error(`WoC broadcast -> ${r.status} ${await r.text()}`);
    return String(await r.json());
  };
  const viaArc = async () => {
    const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' };
    if (process.env.ARC_API_KEY) headers.Authorization = `Bearer ${process.env.ARC_API_KEY}`;
    const r = await fetch(`${ARC(n)}/v1/tx`, { method: 'POST', headers, body: Buffer.from(hex, 'hex') });
    const body: any = await r.json().catch(() => ({}));
    if (!r.ok || !body.txid) throw new Error(`ARC broadcast -> ${r.status} ${JSON.stringify(body)}`);
    return String(body.txid);
  };
  const order = process.env.BROADCASTER === 'arc' ? [viaArc, viaWoc] : [viaWoc, viaArc];
  const errors: string[] = [];
  for (const attempt of order) {
    try {
      const txid = await attempt();
      if (txid !== tx.id('hex')) throw new Error(`broadcaster returned ${txid}, expected ${tx.id('hex')}`);
      return txid;
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  throw new Error(`broadcast failed:\n  ${errors.join('\n  ')}`);
}

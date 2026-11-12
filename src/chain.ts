/**
 * Minimal chain access for the demo. Broadcasts and txid status go to the
 * BSV Broadcaster (formerly Arcade); WhatsOnChain lists the funding address's
 * UTXOs, which the broadcaster has no index for, and serves a funding coin's
 * parent when the demo did not build it itself.
 */
import { Transaction } from '@bsv/sdk';

export type Network = 'testnet' | 'mainnet';

export interface FundingUtxo {
  txid: string;
  vout: number;
  satoshis: number;
  /** The transaction that created this output, when already in hand. */
  parent?: Transaction;
}

const WOC = (n: Network) => `https://api.whatsonchain.com/v1/bsv/${n === 'mainnet' ? 'main' : 'test'}`;
export const BROADCASTER = (n: Network) =>
  process.env.BROADCASTER_URL ??
  (n === 'mainnet' ? 'https://arcade-us-1.bsvblockchain.tech' : 'https://arcade-testnet-us-1.bsvblockchain.tech');

export const explorerTx = (n: Network, txid: string) =>
  `https://${n === 'mainnet' ? '' : 'test.'}whatsonchain.com/tx/${txid}`;

async function getJson(url: string): Promise<any> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status} ${await r.text()}`);
  return r.json();
}

/**
 * Spendable outputs for an address, confirmed and unconfirmed. WoC's plain
 * `/unspent` still lists a confirmed output after a mempool transaction has
 * spent it, which would make the next lock a double spend, so read the split
 * endpoints and drop anything flagged as spent in the mempool.
 */
export async function fetchUtxos(
  n: Network,
  address: string,
  opts: { confirmedOnly?: boolean } = {},
): Promise<FundingUtxo[]> {
  type Row = { tx_hash: string; tx_pos: number; value: number; isSpentInMempoolTx?: boolean };
  const kinds = opts.confirmedOnly ? ['confirmed'] : ['confirmed', 'unconfirmed'];
  const lists = await Promise.all(
    kinds.map((k) => getJson(`${WOC(n)}/address/${address}/${k}/unspent`)),
  );
  const seen = new Set<string>();
  const entries: Row[] = [];
  for (const list of lists) {
    for (const e of (list.result ?? []) as Row[]) {
      const key = `${e.tx_hash}:${e.tx_pos}`;
      if (e.isSpentInMempoolTx || seen.has(key)) continue;
      seen.add(key);
      entries.push(e);
    }
  }
  return entries.map((e) => ({ txid: e.tx_hash, vout: e.tx_pos, satoshis: e.value }));
}

/**
 * Download a transaction from WhatsOnChain. Prefer a parent you built and kept:
 * WoC does not always serve the hex of a large unconfirmed transaction.
 */
export async function fetchTx(n: Network, txid: string): Promise<Transaction> {
  const r = await fetch(`${WOC(n)}/tx/${txid}/hex`);
  if (!r.ok) {
    throw new Error(`GET tx ${txid} hex -> ${r.status}; WoC may not serve a large unconfirmed transaction, so wait for a block and rerun`);
  }
  const tx = Transaction.fromHex((await r.text()).trim());
  if (tx.id('hex') !== txid) throw new Error(`WoC returned a different transaction for ${txid}`);
  return tx;
}

export interface TxStatus {
  txid: string;
  txStatus: string;
  competingTxs?: string[] | null;
  extraInfo?: string;
  blockHeight?: number;
}

/** GET /tx/{txid} on the broadcaster; null on 404 (never given this txid: no verdict). */
export async function txStatus(n: Network, txid: string): Promise<TxStatus | null> {
  const r = await fetch(`${BROADCASTER(n)}/tx/${txid}`, { signal: AbortSignal.timeout(15_000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GET /tx/${txid} -> ${r.status} ${await r.text()}`);
  return r.json();
}

/** Statuses at or past the point the app treats a transaction as final (never wait for MINED). */
const PAST_GATE = new Set(['SEEN_ON_NETWORK', 'SEEN_MULTIPLE_NODES', 'STUMP_PROCESSING', 'MINED', 'IMMUTABLE']);
const REFUSED = new Set(['REJECTED', 'DOUBLE_SPEND_ATTEMPTED']);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Submit to the BSV Broadcaster and wait until it reports the transaction
 * SEEN_ON_NETWORK (or later) with no competing transaction. A 2xx from
 * POST /tx is only provisional, so the status read is the real answer.
 * Sends Extended Format, which the broadcaster needs to validate without
 * looking parents up.
 */
export async function broadcast(n: Network, tx: Transaction): Promise<string> {
  const txid = tx.id('hex');
  // Never fall back to raw hex: the broadcaster refuses it with 460 and keeps
  // that refusal on record as REJECTED for the txid, even after it is mined.
  if (!tx.inputs.every((i) => i.sourceTransaction)) {
    throw new Error(`${txid}: every input needs its parent attached to send Extended Format`);
  }
  const body = tx.toHexEF();
  const r = await fetch(`${BROADCASTER(n)}/tx`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body,
    signal: AbortSignal.timeout(180_000),
  });
  const text = await r.text();
  if (!r.ok && !/\b(TX_EXISTS|txn-already-known)\b/.test(text)) {
    throw new Error(`POST /tx ${txid} -> ${r.status} ${text}`);
  }

  const timeoutMs = Number(process.env.SEEN_TIMEOUT_MS ?? 180_000);
  const deadline = Date.now() + timeoutMs;
  let last: TxStatus | null = null;
  let refusedReads = 0;
  while (Date.now() < deadline) {
    await sleep(1_000);
    last = await txStatus(n, txid).catch(() => last);
    if (!last) continue;
    if (REFUSED.has(last.txStatus)) {
      // Dead only on two refused reads at least 20 s apart, with a re-post between.
      if (++refusedReads >= 2) {
        throw new Error(`${txid} ${last.txStatus}: ${last.extraInfo ?? ''} ${JSON.stringify(last.competingTxs ?? [])}`);
      }
      await sleep(20_000);
      await fetch(`${BROADCASTER(n)}/tx`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body }).catch(() => {});
      continue;
    }
    if ((last.competingTxs ?? []).length > 0) continue;
    if (PAST_GATE.has(last.txStatus)) return txid;
  }
  throw new Error(`${txid} not seen on network after ${timeoutMs / 1000}s; last status ${JSON.stringify(last)}`);
}

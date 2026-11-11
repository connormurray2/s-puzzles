import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrivateKey } from '@bsv/sdk';
import type { Network } from './chain.js';

const WALLET_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '.wallet.json');

export interface Wallet { key: PrivateKey; address: string; network: Network }

/**
 * Load the demo funding key: FUNDING_WIF from the environment if set,
 * otherwise .wallet.json (created on first use; gitignored).
 */
export function loadWallet(network: Network, create = false): Wallet {
  let key: PrivateKey;
  if (process.env.FUNDING_WIF) {
    key = PrivateKey.fromWif(process.env.FUNDING_WIF);
  } else if (existsSync(WALLET_FILE)) {
    key = PrivateKey.fromWif(JSON.parse(readFileSync(WALLET_FILE, 'utf8')).wif);
  } else if (create) {
    key = PrivateKey.fromRandom();
    writeFileSync(WALLET_FILE, JSON.stringify({ wif: key.toWif() }, null, 2) + '\n', { mode: 0o600 });
  } else {
    throw new Error('No wallet. Run `pnpm wallet` first or set FUNDING_WIF.');
  }
  const address = key.toAddress(network === 'mainnet' ? 'mainnet' : 'testnet');
  return { key, address, network };
}

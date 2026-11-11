/** Create (or show) the demo funding wallet and its balance. */
import { fetchUtxos, type Network } from '../src/chain.js';
import { loadWallet } from '../src/wallet.js';

const network = (process.env.NETWORK ?? 'testnet') as Network;
const wallet = loadWallet(network, true);
console.log(`network : ${network}`);
console.log(`address : ${wallet.address}`);
try {
  const utxos = await fetchUtxos(network, wallet.address);
  console.log(`balance : ${utxos.reduce((a, u) => a + u.satoshis, 0)} satoshis in ${utxos.length} UTXO(s)`);
} catch (e) {
  console.log(`balance : unavailable (${e instanceof Error ? e.message.split('\n')[0] : e})`);
}

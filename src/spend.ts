/**
 * Build and locally verify a transaction that spends an s-puzzle output.
 *
 * The order of operations is what makes an s-puzzle work:
 *   1. fix the spending transaction (input outpoint + outputs)
 *   2. compute its BIP-143 sighash preimage (which does NOT cover unlocking
 *      scripts, so the proof can be added afterwards)
 *   3. derive the challenge from the preimage's outpoint and hashOutputs and
 *      produce the proof
 *   4. write <proof...> <preimage> into the input
 */
import { LockingScript, Spend, Transaction, UnlockingScript } from '@bsv/sdk';
import { RunarContract } from 'runar-sdk';
import type { SpendBinding } from './provers.js';

export interface PuzzleUtxo {
  txid: string;
  vout: number;
  satoshis: number;
  /** Full locking script of the s-puzzle output, hex. */
  script: string;
}

export interface SpendOutput {
  satoshis: number;
  /** Locking script hex. */
  script: string;
}

/** Pull the spend-binding fields out of a BIP-143 preimage. */
export function bindingFromPreimage(preimageHex: string): SpendBinding {
  // version(4) hashPrevouts(32) hashSequence(32) outpoint(36) scriptCode(var)
  // value(8) nSequence(4) hashOutputs(32) nLockTime(4) sighashType(4)
  const len = preimageHex.length / 2;
  return {
    outpoint: preimageHex.slice(68 * 2, 104 * 2),
    hashOutputs: preimageHex.slice((len - 40) * 2, (len - 8) * 2),
  };
}

export interface BuiltSpend {
  tx: Transaction;
  preimageHex: string;
  binding: SpendBinding;
  /** The proof values pushed in the unlocking script (without the preimage). */
  proof: unknown[];
}

/**
 * Build the spending transaction for a single-method s-puzzle contract.
 * `prove` receives the spend binding and returns the `unlock` arguments
 * that precede txPreimage.
 */
export function buildSpend(
  contract: RunarContract,
  utxo: PuzzleUtxo,
  outputs: SpendOutput[],
  prove: (binding: SpendBinding) => unknown[],
): BuiltSpend {
  const tx = new Transaction();
  tx.addInput({
    sourceTXID: utxo.txid,
    sourceOutputIndex: utxo.vout,
    unlockingScript: new UnlockingScript(),
    sequence: 0xffffffff,
  });
  for (const o of outputs) {
    tx.addOutput({ satoshis: o.satoshis, lockingScript: LockingScript.fromHex(o.script) });
  }

  const { preimageHex } = contract.computeOpPushTxPreimageWithCodeSep(
    tx, 0, utxo.script, utxo.satoshis, 0,
  );
  const binding = bindingFromPreimage(preimageHex);
  const proof = prove(binding);

  const unlocking = contract.buildUnlockingScript('unlock', [...proof, preimageHex]);
  tx.inputs[0]!.unlockingScript = UnlockingScript.fromHex(unlocking);
  return { tx, preimageHex, binding, proof };
}

/**
 * Run input 0 of `tx` through the @bsv/sdk script interpreter against the
 * s-puzzle locking script: real opcodes, real OP_CHECKSIG, real BIP-143.
 */
export function verifySpend(tx: Transaction, utxo: PuzzleUtxo): { valid: boolean; error?: string } {
  const input = tx.inputs[0]!;
  try {
    const spend = new Spend({
      sourceTXID: input.sourceTXID!,
      sourceOutputIndex: input.sourceOutputIndex,
      sourceSatoshis: utxo.satoshis,
      lockingScript: LockingScript.fromHex(utxo.script),
      transactionVersion: tx.version,
      otherInputs: [],
      outputs: tx.outputs,
      inputIndex: 0,
      unlockingScript: UnlockingScript.fromHex(input.unlockingScript!.toHex()),
      inputSequence: input.sequence ?? 0xffffffff,
      lockTime: tx.lockTime,
    });
    return { valid: !!spend.validate() };
  } catch (e) {
    return { valid: false, error: e instanceof Error ? e.message : String(e) };
  }
}

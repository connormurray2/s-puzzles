/**
 * End-to-end tests. Every case builds a REAL spending transaction and runs
 * the compiled Bitcoin Script through the @bsv/sdk interpreter: real opcodes,
 * real OP_CHECKSIG, real BIP-143 preimage. Nothing is mocked.
 */
import { describe, expect, it } from 'vitest';
import { LockingScript, UnlockingScript } from '@bsv/sdk';
import { N } from '../src/curve.js';
import {
  chaumPedersenPuzzle, orPuzzle, pedersenPuzzle, schnorrPuzzle,
  type PuzzleInstance,
} from '../src/puzzles.js';
import { buildSpend, verifySpend, type PuzzleUtxo } from '../src/spend.js';

const p2pkh = (byte: string) => '76a914' + byte.repeat(20) + '88ac';
const utxoOf = (p: PuzzleInstance, txidByte = 'ab'): PuzzleUtxo => ({
  txid: txidByte.repeat(32), vout: 0, satoshis: 10_000, script: p.contract.getLockingScript(),
});
const payout = [{ satoshis: 9_000, script: p2pkh('11') }];

const cases: Array<[string, () => PuzzleInstance]> = [
  ['SPuzzle', () => schnorrPuzzle()],
  ['PedersenOpening', () => pedersenPuzzle()],
  ['ChaumPedersen', () => chaumPedersenPuzzle()],
  ['OrProof (knows key 1)', () => orPuzzle(1)],
  ['OrProof (knows key 2)', () => orPuzzle(2)],
];

describe.each(cases)('%s', (_label, makePuzzle) => {
  const puzzle = makePuzzle();
  const utxo = utxoOf(puzzle);

  it('unlocks with a valid proof', () => {
    const { tx } = buildSpend(puzzle.contract, utxo, payout, puzzle.prove);
    expect(verifySpend(tx, utxo)).toEqual({ valid: true });
  });

  it('rejects a proof made with the wrong secret', () => {
    const { tx } = buildSpend(puzzle.contract, utxo, payout, puzzle.proveWrong);
    expect(verifySpend(tx, utxo).valid).toBe(false);
  });

  it('rejects a copied proof when the outputs are redirected', () => {
    const { tx } = buildSpend(puzzle.contract, utxo, payout, puzzle.prove);
    // A thief keeps the unlocking script but pays themselves instead.
    tx.outputs[0]!.lockingScript = LockingScript.fromHex(p2pkh('99'));
    expect(verifySpend(tx, utxo).valid).toBe(false);
  });

  it('rejects a thief who also recomputes the preimage for the new outputs', () => {
    const honest = buildSpend(puzzle.contract, utxo, payout, puzzle.prove);
    // Rebuild for the thief's outputs but reuse the honest proof values.
    const stolen = buildSpend(
      puzzle.contract, utxo, [{ satoshis: 9_000, script: p2pkh('99') }], () => honest.proof,
    );
    expect(verifySpend(stolen.tx, utxo).valid).toBe(false);
  });

  it('rejects replaying the proof against another UTXO with the same script', () => {
    const honest = buildSpend(puzzle.contract, utxo, payout, puzzle.prove);
    const twin = utxoOf(puzzle, 'cd');
    const replay = buildSpend(puzzle.contract, twin, payout, () => honest.proof);
    expect(verifySpend(replay.tx, twin).valid).toBe(false);
  });
});

describe('SPuzzle details', () => {
  const puzzle = schnorrPuzzle();
  const utxo = utxoOf(puzzle);

  it('rejects the malleated response s + n', () => {
    const spend = buildSpend(puzzle.contract, utxo, payout, (b) => {
      const [R, s] = puzzle.prove(b) as [string, bigint];
      return [R, s + N];
    });
    expect(verifySpend(spend.tx, utxo).valid).toBe(false);
  });

  it('rejects an R that is not on the curve', () => {
    const spend = buildSpend(puzzle.contract, utxo, payout, (b) => {
      const [R, s] = puzzle.prove(b) as [string, bigint];
      return [R.slice(0, 126) + (R.endsWith('00') ? '01' : '00'), s];
    });
    expect(verifySpend(spend.tx, utxo).valid).toBe(false);
  });

  it('rejects a preimage that does not belong to the transaction', () => {
    const { tx } = buildSpend(puzzle.contract, utxo, payout, puzzle.prove);
    tx.lockTime = 1; // the pushed preimage still says locktime 0
    expect(verifySpend(tx, utxo).valid).toBe(false);
  });

  it('keeps the spending transaction small', () => {
    const { tx, preimageHex } = buildSpend(puzzle.contract, utxo, payout, puzzle.prove);
    expect(utxo.script.length / 2).toBeGreaterThan(800_000);
    expect(preimageHex.length / 2).toBeLessThan(1_000);
    expect(tx.toHex().length / 2).toBeLessThan(1_500);
  });

  it('accepts many independent spends (fresh nonce and sighash each time)', () => {
    for (let i = 0; i < 25; i++) {
      const outs = [{ satoshis: 9_000 - i, script: p2pkh('11') }];
      const { tx } = buildSpend(puzzle.contract, utxo, outs, puzzle.prove);
      expect(verifySpend(tx, utxo)).toEqual({ valid: true });
    }
  });

  it('unlocking script is push-only data: R, s, preimage', () => {
    const { tx } = buildSpend(puzzle.contract, utxo, payout, puzzle.prove);
    const chunks = UnlockingScript.fromHex(tx.inputs[0]!.unlockingScript!.toHex()).chunks;
    expect(chunks.length).toBe(3);
    expect(chunks[0]!.data!.length).toBe(64);
  });
});

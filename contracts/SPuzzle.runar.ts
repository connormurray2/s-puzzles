import {
  SmartContract, assert, within,
  ecAdd, ecMul, ecMulGen, ecOnCurve,
  checkPreimage, extractOutpoint, extractOutputHash,
  sha256, cat, bin2num,
} from 'runar-lang';
import type { Point, ByteString, SigHashPreimage } from 'runar-lang';

/**
 * S-puzzle (basic Schnorr): anyone who proves knowledge of x with P = x*G
 * can spend. x is never revealed.
 *
 * The proof is a Fiat-Shamir Schnorr transcript (R, s) whose challenge is
 * bound to this spend:
 *
 *   e = SHA256(R || P || outpoint || hashOutputs) mod n
 *   accept iff  s*G == R + e*P
 *
 * A proof copied from the mempool cannot be re-pointed at other outputs or
 * replayed against another UTXO, because either change alters e.
 */
class SPuzzle extends SmartContract {
  /** The statement: a secp256k1 point, 64 bytes (x || y, big-endian). */
  readonly P: Point;

  constructor(P: Point) {
    super(P);
    this.P = P;
  }

  public unlock(R: Point, s: bigint, txPreimage: SigHashPreimage) {
    // Fail closed on malformed proofs: R on the curve, 0 < s < n.
    assert(ecOnCurve(R));
    assert(within(s, 1n, 115792089237316195423570985008687907852837564279074904382605163141518161494337n));

    // Fiat-Shamir challenge, bound to the UTXO being spent and to the outputs.
    const transcript: ByteString = cat(
      cat(R, this.P),
      cat(extractOutpoint(txPreimage), extractOutputHash(txPreimage)),
    );
    // The appended 00 keeps the little-endian script number non-negative.
    const e: bigint = bin2num(cat(sha256(transcript), '00')) % 115792089237316195423570985008687907852837564279074904382605163141518161494337n;

    // Schnorr verification equation.
    assert(ecMulGen(s) === ecAdd(R, ecMul(this.P, e)));

    // OP_PUSH_TX: txPreimage really is the BIP-143 preimage of this spend.
    // Checked last on purpose: the compiler emits OP_CODESEPARATOR right
    // before this check, so the scriptCode inside the preimage is a few
    // hundred bytes instead of the whole ~874 KB script. All asserts must
    // pass, so the order does not affect soundness.
    assert(checkPreimage(txPreimage));
  }
}

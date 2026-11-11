import {
  SmartContract, assert, within,
  ecAdd, ecMul, ecMulGen, ecNegate, ecOnCurve,
  checkPreimage, extractOutpoint, extractOutputHash,
  sha256, cat, bin2num,
} from 'runar-lang';
import type { Point, ByteString, SigHashPreimage } from 'runar-lang';

/**
 * S-puzzle: Pedersen commitment opening.
 *
 * The output publishes a commitment C, the second generator H and a claimed
 * value v. Spending proves that C commits to v, i.e. that the spender knows
 * the blinding factor b with
 *
 *   C = v*H + b*G
 *
 * without revealing b. The script derives the statement point
 * P = C - v*H (so P = b*G exactly when the claim is true) and then runs the
 * basic s-puzzle on P:
 *
 *   e = SHA256(R || P || outpoint || hashOutputs) mod n
 *   accept iff  s*G == R + e*P
 */
class PedersenOpening extends SmartContract {
  /** The commitment C = v*H + b*G. */
  readonly C: Point;
  /** Second generator; nobody may know log_G(H). */
  readonly H: Point;
  /** The value C is claimed to commit to. */
  readonly v: bigint;

  constructor(C: Point, H: Point, v: bigint) {
    super(C, H, v);
    this.C = C;
    this.H = H;
    this.v = v;
  }

  public unlock(R: Point, s: bigint, txPreimage: SigHashPreimage) {
    assert(ecOnCurve(R));
    assert(within(s, 1n, 115792089237316195423570985008687907852837564279074904382605163141518161494337n));

    // Statement point: P = C - v*H.
    const P: Point = ecAdd(this.C, ecNegate(ecMul(this.H, this.v)));

    const transcript: ByteString = cat(
      cat(R, P),
      cat(extractOutpoint(txPreimage), extractOutputHash(txPreimage)),
    );
    const e: bigint = bin2num(cat(sha256(transcript), '00')) % 115792089237316195423570985008687907852837564279074904382605163141518161494337n;

    assert(ecMulGen(s) === ecAdd(R, ecMul(P, e)));

    // Checked last so the code separator sits at the end of the script.
    assert(checkPreimage(txPreimage));
  }
}

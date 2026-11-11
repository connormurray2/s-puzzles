import {
  SmartContract, assert, within,
  ecAdd, ecMul, ecMulGen, ecOnCurve,
  checkPreimage, extractOutpoint, extractOutputHash,
  sha256, cat, bin2num,
} from 'runar-lang';
import type { Point, ByteString, SigHashPreimage } from 'runar-lang';

/**
 * S-puzzle: equality of discrete logs (Chaum-Pedersen).
 *
 * The output publishes P1, P2 and a second base H. Spending proves knowledge
 * of a single x with
 *
 *   P1 = x*G   and   P2 = x*H
 *
 * without revealing x. One nonce k gives two commitments R1 = k*G and
 * R2 = k*H, and one response s answers both:
 *
 *   e = SHA256(R1 || R2 || P1 || P2 || H || outpoint || hashOutputs) mod n
 *   accept iff  s*G == R1 + e*P1   and   s*H == R2 + e*P2
 */
class ChaumPedersen extends SmartContract {
  readonly P1: Point;
  readonly P2: Point;
  readonly H: Point;

  constructor(P1: Point, P2: Point, H: Point) {
    super(P1, P2, H);
    this.P1 = P1;
    this.P2 = P2;
    this.H = H;
  }

  public unlock(R1: Point, R2: Point, s: bigint, txPreimage: SigHashPreimage) {
    assert(ecOnCurve(R1));
    assert(ecOnCurve(R2));
    assert(within(s, 1n, 115792089237316195423570985008687907852837564279074904382605163141518161494337n));

    const transcript: ByteString = cat(
      cat(cat(R1, R2), cat(this.P1, this.P2)),
      cat(this.H, cat(extractOutpoint(txPreimage), extractOutputHash(txPreimage))),
    );
    const e: bigint = bin2num(cat(sha256(transcript), '00')) % 115792089237316195423570985008687907852837564279074904382605163141518161494337n;

    assert(ecMulGen(s) === ecAdd(R1, ecMul(this.P1, e)));
    assert(ecMul(this.H, s) === ecAdd(R2, ecMul(this.P2, e)));

    // Checked last so the code separator sits at the end of the script.
    assert(checkPreimage(txPreimage));
  }
}

import {
  SmartContract, assert, within,
  ecAdd, ecMul, ecMulGen, ecOnCurve,
  checkPreimage, extractOutpoint, extractOutputHash,
  sha256, cat, bin2num,
} from 'runar-lang';
import type { Point, ByteString, SigHashPreimage } from 'runar-lang';

/**
 * S-puzzle: 1-of-2 OR-proof (Cramer-Damgard-Schoenmakers).
 *
 * The output publishes two points P1 and P2. Spending proves knowledge of
 * the discrete log of ONE of them, without revealing which one (and without
 * revealing the secret). This is a two-member ring spend.
 *
 * The prover runs the real protocol for the key it knows and simulates the
 * other branch. The script cannot tell the branches apart; it only checks
 * that both Schnorr equations hold and that the two challenges add up to the
 * Fiat-Shamir challenge of the spend:
 *
 *   e  = SHA256(R1 || R2 || P1 || P2 || outpoint || hashOutputs) mod n
 *   e2 = e - e1 mod n
 *   accept iff  s1*G == R1 + e1*P1   and   s2*G == R2 + e2*P2
 *
 * The prover may choose one challenge freely, which is what lets it simulate
 * one branch, but the other challenge is then forced by the hash, and
 * answering a forced challenge requires the secret.
 */
class OrProof extends SmartContract {
  readonly P1: Point;
  readonly P2: Point;

  constructor(P1: Point, P2: Point) {
    super(P1, P2);
    this.P1 = P1;
    this.P2 = P2;
  }

  public unlock(
    R1: Point, R2: Point,
    s1: bigint, s2: bigint,
    e1: bigint,
    txPreimage: SigHashPreimage,
  ) {
    assert(ecOnCurve(R1));
    assert(ecOnCurve(R2));
    assert(within(s1, 1n, 115792089237316195423570985008687907852837564279074904382605163141518161494337n));
    assert(within(s2, 1n, 115792089237316195423570985008687907852837564279074904382605163141518161494337n));
    assert(within(e1, 1n, 115792089237316195423570985008687907852837564279074904382605163141518161494337n));

    const transcript: ByteString = cat(
      cat(cat(R1, R2), cat(this.P1, this.P2)),
      cat(extractOutpoint(txPreimage), extractOutputHash(txPreimage)),
    );
    const e: bigint = bin2num(cat(sha256(transcript), '00')) % 115792089237316195423570985008687907852837564279074904382605163141518161494337n;

    // The second challenge is not chosen by the prover: e1 + e2 = e (mod n).
    const e2: bigint = (e + 115792089237316195423570985008687907852837564279074904382605163141518161494337n - e1) % 115792089237316195423570985008687907852837564279074904382605163141518161494337n;
    assert(e2 > 0n);

    assert(ecMulGen(s1) === ecAdd(R1, ecMul(this.P1, e1)));
    assert(ecMulGen(s2) === ecAdd(R2, ecMul(this.P2, e2)));

    // Checked last so the code separator sits at the end of the script.
    assert(checkPreimage(txPreimage));
  }
}

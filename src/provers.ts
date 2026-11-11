/**
 * Off-chain provers. Each returns the values the matching contract's
 * `unlock` method expects (without the trailing txPreimage).
 *
 * `binding` is the part of the transcript that ties the proof to one spend:
 * outpoint (36 bytes) || hashOutputs (32 bytes), both taken from the BIP-143
 * preimage of the spending transaction.
 *
 * Every proof draws fresh nonces. Never reuse a nonce: two proofs with the
 * same k and different challenges reveal the secret.
 */
import { G, N, Pt, challenge, encodePoint, mod, randomScalar } from './curve.js';

export interface SpendBinding {
  /** 36 bytes: txid (little-endian) || output index (4 bytes LE). */
  outpoint: string;
  /** 32 bytes: hash256 of the spending transaction's outputs. */
  hashOutputs: string;
}

const bind = (b: SpendBinding): string => b.outpoint + b.hashOutputs;

/** Basic s-puzzle: prove knowledge of x with P = x*G. Returns [R, s]. */
export function proveSchnorr(x: bigint, P: Pt, b: SpendBinding): [string, bigint] {
  for (;;) {
    const k = randomScalar();
    const R = G.multiply(k);
    const e = challenge(encodePoint(R), encodePoint(P), bind(b));
    const s = mod(k + e * x);
    if (s !== 0n) return [encodePoint(R), s];
  }
}

/**
 * Pedersen opening: prove C = v*H + blind*G for the public v.
 * The statement point is P = C - v*H = blind*G. Returns [R, s].
 */
export function provePedersenOpening(
  blind: bigint, C: Pt, Hgen: Pt, v: bigint, b: SpendBinding,
): [string, bigint] {
  const P = C.add(Hgen.multiply(v).negate());
  return proveSchnorr(blind, P, b);
}

/**
 * Chaum-Pedersen: prove the same x underlies P1 = x*G and P2 = x*H.
 * Returns [R1, R2, s].
 */
export function proveChaumPedersen(
  x: bigint, P1: Pt, P2: Pt, Hgen: Pt, b: SpendBinding,
): [string, string, bigint] {
  for (;;) {
    const k = randomScalar();
    const R1 = G.multiply(k);
    const R2 = Hgen.multiply(k);
    const e = challenge(
      encodePoint(R1), encodePoint(R2),
      encodePoint(P1), encodePoint(P2), encodePoint(Hgen),
      bind(b),
    );
    const s = mod(k + e * x);
    if (s !== 0n) return [encodePoint(R1), encodePoint(R2), s];
  }
}

/**
 * 1-of-2 OR-proof: prove knowledge of the discrete log of P1 or of P2.
 * `known` says which key `x` belongs to (1 or 2); the proof does not reveal it.
 * Returns [R1, R2, s1, s2, e1].
 */
export function proveOr(
  x: bigint, known: 1 | 2, P1: Pt, P2: Pt, b: SpendBinding,
): [string, string, bigint, bigint, bigint] {
  const other = known === 1 ? P2 : P1;
  for (;;) {
    // Simulate the branch we cannot answer: pick its challenge and response
    // first, then solve for the commitment.
    const eSim = randomScalar();
    const sSim = randomScalar();
    const RSim = G.multiply(sSim).add(other.multiply(eSim).negate());

    // Run the real protocol on the branch we know.
    const k = randomScalar();
    const RReal = G.multiply(k);

    const [R1, R2] = known === 1 ? [RReal, RSim] : [RSim, RReal];
    const e = challenge(
      encodePoint(R1), encodePoint(R2), encodePoint(P1), encodePoint(P2), bind(b),
    );
    const eReal = mod(e - eSim);
    const sReal = mod(k + eReal * x);
    if (eReal === 0n || sReal === 0n) continue;

    const [e1, s1, s2] = known === 1 ? [eReal, sReal, sSim] : [eSim, sSim, sReal];
    return [encodePoint(R1), encodePoint(R2), s1, s2, e1];
  }
}

export { N };

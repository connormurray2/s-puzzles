/**
 * Off-chain secp256k1 helpers shared by the provers.
 *
 * Encodings match what the Runar contracts see on-chain:
 *   - a Point is 64 bytes, x || y, each 32 bytes big-endian
 *   - a challenge is SHA256(transcript) read as a LITTLE-endian integer, mod n
 *     (the script does bin2num(hash || 00) % n)
 */
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import { randomBytes } from 'node:crypto';

export const Pt = secp256k1.ProjectivePoint;
export type Pt = InstanceType<typeof Pt>;
export const G = Pt.BASE;
export const N = secp256k1.CURVE.n;

export const mod = (a: bigint, m: bigint = N): bigint => ((a % m) + m) % m;

/** Uniformly random scalar in [1, n). Rejection sampling, no modulo bias. */
export function randomScalar(): bigint {
  for (;;) {
    const k = BigInt('0x' + randomBytes(32).toString('hex'));
    if (k > 0n && k < N) return k;
  }
}

/** 64-byte x || y hex encoding used by Runar's `Point` type. */
export function encodePoint(p: Pt): string {
  const a = p.toAffine();
  return a.x.toString(16).padStart(64, '0') + a.y.toString(16).padStart(64, '0');
}

export function decodePoint(hex: string): Pt {
  if (hex.length !== 128) throw new Error('Point must be 64 bytes');
  const p = Pt.fromAffine({ x: BigInt('0x' + hex.slice(0, 64)), y: BigInt('0x' + hex.slice(64)) });
  p.assertValidity();
  return p;
}

/**
 * Fiat-Shamir challenge exactly as the scripts compute it:
 * SHA256 over the concatenated hex parts, read little-endian, reduced mod n.
 */
export function challenge(...partsHex: string[]): bigint {
  const digest = sha256(concatBytes(...partsHex.map(hexToBytes)));
  const le = bytesToHex(Uint8Array.from(digest).reverse());
  return BigInt('0x' + le) % N;
}

/**
 * A second generator H with no known discrete log relative to G
 * ("nothing up my sleeve"): try-and-increment over SHA256(tag || counter),
 * taking the first digest that is a valid x-coordinate, even y.
 */
export function hashToCurve(tag: string): Pt {
  for (let i = 0; i < 1000; i++) {
    const x = sha256(concatBytes(utf8ToBytes(tag), Uint8Array.of(i)));
    try {
      return Pt.fromHex('02' + bytesToHex(x));
    } catch {
      // not an x-coordinate on the curve; try the next counter
    }
  }
  throw new Error('hashToCurve: no point found');
}

/** The second generator used by the Pedersen and Chaum-Pedersen examples. */
export const H_TAG = 's-puzzles/second-generator/v1';
export const H = hashToCurve(H_TAG);

/**
 * One place that knows, for each s-puzzle variant, how to instantiate the
 * contract from a secret and how to prove it. Used by the tests and the
 * testnet demo so both exercise exactly the same code.
 */
import { RunarContract } from 'runar-sdk';
import { compileContract, type ContractName } from './compile.js';
import { G, H, encodePoint, randomScalar } from './curve.js';

/**
 * The secret material behind a puzzle. Generated fresh by default; the demo
 * persists it between the lock and the spend so a failed run can resume.
 */
export interface PuzzleSecrets {
  /** The witness. */
  x: bigint;
  /** OR-proof only: the scalar behind the key the spender does NOT use. */
  aux?: bigint;
}
import {
  proveChaumPedersen, proveOr, provePedersenOpening, proveSchnorr,
  type SpendBinding,
} from './provers.js';

export interface PuzzleInstance {
  name: ContractName;
  title: string;
  /** What the output publicly states. */
  statement: string;
  /** What the spender proves knowledge of. */
  witness: string;
  contract: RunarContract;
  secrets: PuzzleSecrets;
  /** Public constructor arguments, for documentation. */
  publicParams: Record<string, string>;
  /** Produce the unlock arguments (without txPreimage) for a spend. */
  prove: (binding: SpendBinding) => unknown[];
  /** Same, but with a wrong secret: must be rejected by the script. */
  proveWrong: (binding: SpendBinding) => unknown[];
}

const make = (name: ContractName, args: unknown[]) =>
  new RunarContract(compileContract(name), args);

export function schnorrPuzzle(secrets: PuzzleSecrets = { x: randomScalar() }): PuzzleInstance {
  const { x } = secrets;
  const P = G.multiply(x);
  return {
    name: 'SPuzzle',
    title: 'Basic s-puzzle (Schnorr proof of knowledge)',
    statement: 'P = x·G',
    witness: 'x',
    secrets,
    contract: make('SPuzzle', [encodePoint(P)]),
    publicParams: { P: encodePoint(P) },
    prove: (b) => proveSchnorr(x, P, b),
    proveWrong: (b) => proveSchnorr(randomScalar(), P, b),
  };
}

export function pedersenPuzzle(
  secrets: PuzzleSecrets = { x: randomScalar() }, v: bigint = 21_000_000n,
): PuzzleInstance {
  const blind = secrets.x;
  const C = H.multiply(v).add(G.multiply(blind));
  return {
    name: 'PedersenOpening',
    title: 'Pedersen commitment opening',
    statement: 'C = v·H + b·G for the published v',
    witness: 'the blinding factor b',
    secrets,
    contract: make('PedersenOpening', [encodePoint(C), encodePoint(H), v]),
    publicParams: { C: encodePoint(C), H: encodePoint(H), v: v.toString() },
    prove: (b) => provePedersenOpening(blind, C, H, v, b),
    proveWrong: (b) => provePedersenOpening(randomScalar(), C, H, v, b),
  };
}

export function chaumPedersenPuzzle(secrets: PuzzleSecrets = { x: randomScalar() }): PuzzleInstance {
  const { x } = secrets;
  const P1 = G.multiply(x);
  const P2 = H.multiply(x);
  return {
    name: 'ChaumPedersen',
    title: 'Equality of discrete logs (Chaum–Pedersen)',
    statement: 'P1 = x·G and P2 = x·H for the same x',
    witness: 'x',
    secrets,
    contract: make('ChaumPedersen', [encodePoint(P1), encodePoint(P2), encodePoint(H)]),
    publicParams: { P1: encodePoint(P1), P2: encodePoint(P2), H: encodePoint(H) },
    prove: (b) => proveChaumPedersen(x, P1, P2, H, b),
    proveWrong: (b) => proveChaumPedersen(randomScalar(), P1, P2, H, b),
  };
}

export function orPuzzle(
  known: 1 | 2 = 2,
  secrets: PuzzleSecrets = { x: randomScalar(), aux: randomScalar() },
): PuzzleInstance {
  const { x } = secrets;
  // The other key belongs to someone else; the prover only uses its public point.
  const otherPoint = G.multiply(secrets.aux ?? randomScalar());
  const P1 = known === 1 ? G.multiply(x) : otherPoint;
  const P2 = known === 2 ? G.multiply(x) : otherPoint;
  return {
    name: 'OrProof',
    title: '1-of-2 OR-proof (ring-style spend)',
    statement: 'P1 = x·G or P2 = x·G',
    witness: 'one of the two secrets, without revealing which',
    secrets,
    contract: make('OrProof', [encodePoint(P1), encodePoint(P2)]),
    publicParams: { P1: encodePoint(P1), P2: encodePoint(P2) },
    prove: (b) => proveOr(x, known, P1, P2, b),
    proveWrong: (b) => proveOr(randomScalar(), known, P1, P2, b),
  };
}

export const PUZZLE_FACTORIES: Record<ContractName, (s?: PuzzleSecrets) => PuzzleInstance> = {
  SPuzzle: (s) => schnorrPuzzle(s),
  PedersenOpening: (s) => pedersenPuzzle(s),
  ChaumPedersen: (s) => chaumPedersenPuzzle(s),
  OrProof: (s) => orPuzzle(2, s),
};

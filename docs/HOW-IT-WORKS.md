# How s-puzzles work

## Spending conditions are knowledge proofs

A hash puzzle proves you know a preimage, but spending reveals it. Pay-to-public-key proves you
know a private key without revealing it, because a signature is itself a proof of knowledge. An
R-puzzle locks to the `r` value of an ECDSA signature, so the spender proves knowledge of the
nonce `k` instead of a key.

An s-puzzle generalises this. The output commits to a statement, and the spender supplies a
Schnorr Σ-protocol transcript `(R, s)` proving they know a witness for it. Whoever creates the
output chooses the statement, which turns one signature-like check into a general zero-knowledge
spending condition for algebraic statements over secp256k1.

## Binding the proof to the spend

A Σ-protocol has three moves: commitment `R`, challenge `e`, response `s`. Fiat–Shamir removes the
verifier by deriving `e` from a hash. What goes into that hash decides what the proof is bound to.

Every contract here hashes

```
commitments || statement || outpoint || hashOutputs
```

- `outpoint` (36 bytes) identifies the UTXO being spent. A proof cannot be replayed against
  another output, even one with an identical script.
- `hashOutputs` (32 bytes) is the double-SHA256 of the spending transaction's outputs. Nobody can
  copy the proof and change where the money goes.

Both come from the BIP-143 sighash preimage, which the script authenticates with OP_PUSH_TX.

### OP_PUSH_TX

Script cannot read the transaction it is in. The workaround is to push the BIP-143 preimage as
data and have the script check a signature over it under the publicly known private key `1`.
`OP_CHECKSIG` only succeeds if the pushed bytes hash to the real sighash of the transaction, so
after the check the script can trust every field in the preimage. Rúnar exposes this as
`checkPreimage(txPreimage)`.

The preimage does not cover unlocking scripts. That is what lets the prover compute `e` from the
finished transaction first and write `(R, s)` into the input afterwards.

### Why `checkPreimage` comes last

The BIP-143 preimage contains the `scriptCode`: the locking script from the last executed
`OP_CODESEPARATOR` onward. Rúnar emits an `OP_CODESEPARATOR` immediately before the preimage
check. With the check as the first statement, the scriptCode is the whole script and every spend
carries an extra ~874 KB copy of it. With the check as the last statement, the scriptCode is about
420 bytes and the spending transaction is under 1 KB.

Order does not affect soundness. The script succeeds only if every assertion passes, so values
read from the preimage early are only ever accepted if the preimage is later proven genuine.

## The variants

### Basic: knowledge of a discrete log

Statement `P = x·G`. Proof `(R, s)`, check `s·G = R + e·P`. See the README.

### Pedersen commitment opening

A Pedersen commitment `C = v·H + b·G` hides a value `v` behind a blinding factor `b`. `H` is a
second generator whose discrete log relative to `G` nobody knows.

The output publishes `C`, `H` and a claimed value `v`. The script computes `P = C − v·H`. If the
claim is true then `P = b·G`, and the basic proof on `P` succeeds for whoever knows `b`. If the
claim is false, `P` has an `H` component and no one can produce the proof.

The spender shows that `C` commits to `v` without revealing `b`.

### Equality of discrete logs (Chaum–Pedersen)

Statement: the same `x` satisfies `P1 = x·G` and `P2 = x·H`. One nonce gives two commitments and
one response answers both:

```
R1 = k·G,  R2 = k·H
e  = SHA256(R1 || R2 || P1 || P2 || H || outpoint || hashOutputs) mod n
s  = k + e·x
check  s·G = R1 + e·P1   and   s·H = R2 + e·P2
```

This is the building block for verifiable encryption, verifiable random functions and proving
that two commitments or keys are linked.

### 1-of-2 OR-proof

Statement: I know the discrete log of `P1` or of `P2`. The proof does not say which.

Schnorr proofs can be simulated by anyone who is allowed to pick the challenge first: choose `e`
and `s`, then set `R = s·G − e·P`. The OR-proof lets the prover pick the challenge for one branch
only. The script enforces `e1 + e2 = e (mod n)` where `e` is the Fiat–Shamir hash, so one of the
two challenges is forced, and answering a forced challenge takes the real secret.

```
e  = SHA256(R1 || R2 || P1 || P2 || outpoint || hashOutputs) mod n
e2 = e − e1 mod n
check  s1·G = R1 + e1·P1   and   s2·G = R2 + e2·P2
```

Both branches look identical to the verifier, so this is a ring-style spend: funds locked to a set
of keys, spent by one member anonymously. The same pattern extends to `n` keys at two scalar
multiplications per key.

## Encodings

- A point is 64 bytes, `x || y`, each 32 bytes big-endian (Rúnar's `Point`).
- The challenge is `SHA256(transcript)` read as a little-endian integer and reduced mod `n`. The
  script appends a `00` byte before `bin2num` so the number is never negative.
- Scalars in the unlocking script are minimally encoded script numbers.
- The unlocking script is push-only: the proof values, then the preimage.

## Security notes

- **Soundness.** Producing a valid transcript for a fresh challenge requires the witness, by
  special soundness of the Σ-protocol in the random-oracle model for SHA-256.
- **Zero knowledge.** The transcript reveals nothing about the witness beyond the truth of the
  statement (honest-verifier zero knowledge made non-interactive by Fiat–Shamir).
- **Nonce reuse is fatal.** Two proofs with the same `k` and different challenges give
  `x = (s1 − s2) / (e1 − e2)`. The provers draw fresh nonces with rejection sampling for each proof.
  Rebuilding a transaction means a new proof with a new nonce, never a reused one.
- **Malformed input fails closed.** Scripts require every `R` to be on the curve and every
  response to satisfy `0 < s < n`, which also removes the `s + n` malleability.
- **What is and is not bound.** The challenge covers the outpoint and the outputs. It does not
  cover other inputs, sequence numbers or locktime; those are still fixed by the OP_PUSH_TX
  sighash for the spender's own transaction, but someone copying a proof could vary them without
  changing where the funds go.
- **The second generator.** `H` is derived by hashing the tag `s-puzzles/second-generator/v1` to a
  curve point (try-and-increment), so nobody knows its discrete log. Pedersen binding depends on
  that.
- **Cost.** Script size is bounded by miner policy on BSV, not consensus. The practical limits
  are fees, validation time and whether miners accept scripts of 0.9 to 1.7 MB.

## Differences from the paper

- `checkPreimage` is the last statement instead of the first, which shrinks every spend from
  about 874 KB to under 1 KB (see above).
- The group order is written as a decimal literal and the range check uses `within`, following
  Rúnar's own Schnorr example, so the contract lowers identically in every Rúnar frontend.
- The paper reports 873,670 bytes at Rúnar commit `919e679`; this repository measures 873,692
  bytes at `36b88b8` with the reordered contract.
- The paper notes an end-to-end spend with `checkPreimage` against a real transaction had not
  been run. The tests here do exactly that in the script interpreter.

# S-Puzzles: Zero-Knowledge Spending Conditions in the Signature Response

Connor Murray · 7 November 2026

## Abstract

An s-puzzle is a transaction output that can be spent by anyone who proves knowledge of a secret satisfying a stated relation, without revealing the secret. The proof is a Schnorr-style Σ-protocol transcript (R, s), where s is the response, and its Fiat–Shamir challenge is bound to the spending transaction itself. This binding means a proof observed in the mempool cannot be reused to redirect the funds.

We describe the construction, its security properties, and a working implementation: a Rúnar contract compiled to a 873,692-byte Bitcoin Script locking script that verifies the proof using only existing BSV opcodes, spent by a 769-byte transaction.

## 1. Introduction

Bitcoin spending conditions are knowledge proofs, and s-puzzles make the zero-knowledge part explicit. A hash puzzle proves knowledge of a preimage d of h = H(d), but spending reveals d. A pay-to-public-key output proves knowledge of a private key without revealing it, because an ECDSA signature is itself a proof of knowledge.

An R-puzzle, as used on BSV, locks an output to the r value of an ECDSA signature (r, s), where r is the x-coordinate of R = kG. Any public key can then be used with OP_CHECKSIG, so the spender proves knowledge of the nonce k rather than of a private key. The secret is k, and it is never revealed.

An s-puzzle generalises this. In a Schnorr Σ-protocol the response s carries the proof, so the output can commit to an arbitrary statement and the spender supplies (R, s). The locking script recomputes the challenge from the transaction and checks the verification equation. What the statement means is chosen by whoever locks the funds, which turns a single signature check into a general zero-knowledge spending condition.

## 2. Construction

The output stores a statement point P; the spender proves knowledge of x with P = x·G. G is the secp256k1 generator and n its order. The protocol has three steps.

1. **Lock.** The locker publishes P in the locking script. P may be a plain public key, or a point derived from a richer statement (Section 5).
2. **Prove.** The spender picks a fresh random nonce k, computes R = k·G, derives the challenge e from the spend, and sets s = k + e·x mod n.
3. **Verify.** The locking script recomputes e from R, P and the transaction, then checks the Schnorr equation.

The challenge is a hash over R, P, the outpoint being spent and the transaction's hashOutputs field:

```
e = SHA256(R || P || outpoint || hashOutputs) mod n
```

The script accepts if and only if:

```
s·G = R + e·P
```

The script obtains the outpoint and hashOutputs from the BIP-143 sighash preimage, authenticated with the OP_PUSH_TX technique. That technique verifies a signature made with the publicly known private key 1 over the pushed preimage, so OP_CHECKSIG guarantees the preimage matches the real transaction. The BIP-143 preimage does not include unlocking scripts, so the prover can compute e before writing (R, s) into the input.

## 3. Security properties

The s-puzzle inherits the standard guarantees of Fiat–Shamir Schnorr proofs, plus one property specific to its on-chain use.

- **Soundness.** Producing a valid (R, s) for a fresh challenge requires knowing x, by the special soundness of the Schnorr protocol and the random-oracle model for SHA-256. Two accepting transcripts with the same R and different e would reveal x.
- **Zero knowledge.** The Schnorr protocol is honest-verifier zero knowledge, and Fiat–Shamir makes it non-interactive zero knowledge in the random-oracle model. The transcript (R, s) reveals nothing about x beyond the truth of the statement.
- **Spend binding.** Because e covers the outpoint and hashOutputs, a proof is valid only for one UTXO and one set of outputs. A miner or relay who copies (R, s) and changes the outputs changes e, and the proof fails. This is the property that naive hash puzzles lack.

Two cautions apply. Reusing a nonce k across two proofs for the same x leaks x, exactly as with signatures, so k must be fresh and uniformly random. The script also checks that R lies on the curve and that 0 < s < n, so malformed inputs fail closed.

## 4. Implementation

The construction is implemented as a stateless [Rúnar](https://runar-build.pages.dev/) contract, SPuzzle.runar.ts, and runs on BSV with existing opcodes only. Rúnar compiles TypeScript contracts to Bitcoin Script and provides in-script secp256k1 operations (ecMulGen, ecMul, ecAdd, ecOnCurve) built on BSV's arbitrary-precision arithmetic ([type and built-in reference](https://runar-build.pages.dev/docs/api-reference/contract-decorators-and-types)).

```typescript
class SPuzzle extends SmartContract {
  readonly P: Point; // the statement

  constructor(P: Point) {
    super(P);
    this.P = P;
  }

  public unlock(R: Point, s: bigint, txPreimage: SigHashPreimage) {
    // N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
    assert(ecOnCurve(R));
    assert(within(s, 1n, 115792089237316195423570985008687907852837564279074904382605163141518161494337n));

    const transcript: ByteString = cat(
      cat(R, this.P),
      cat(extractOutpoint(txPreimage), extractOutputHash(txPreimage)),
    );
    const e: bigint = bin2num(cat(sha256(transcript), '00'))
      % 115792089237316195423570985008687907852837564279074904382605163141518161494337n;

    assert(ecMulGen(s) === ecAdd(R, ecMul(this.P, e)));

    // Last on purpose: see below.
    assert(checkPreimage(txPreimage));
  }
}
```

The preimage check is the last statement because of what it costs the spender. The BIP-143 preimage contains the scriptCode, which is the locking script from the last executed OP_CODESEPARATOR onward, and Rúnar emits an OP_CODESEPARATOR immediately before the check. With the check first, the scriptCode is the whole script and every spend carries a second 874 KB copy of it. With the check last, the scriptCode is 422 bytes and the spending transaction is 769 bytes.

The order does not affect soundness. The script succeeds only if every assertion passes, so values read from the preimage are accepted only if the preimage is then proven genuine. Using OP_CODESEPARATOR to shrink an OP_PUSH_TX preimage is a known optimisation, not a contribution of this paper.

The appended 00 byte keeps bin2num's little-endian result non-negative, so the prover reads the hash little-endian to match. Points use Rúnar's 64-byte encoding, x then y, each 32 bytes big-endian. The off-chain prover, src/provers.ts, uses @noble/curves to compute R and s.

| Contract | Statement | Locking script | Spending transaction |
| --- | --- | --- | --- |
| SPuzzle | P = x·G | 873,692 bytes | 769 bytes |
| PedersenOpening | C = v·H + b·G for a published v | 1,323,240 bytes | 770 bytes |
| ChaumPedersen | P₁ = x·G and P₂ = x·H | 1,746,801 bytes | 833 bytes |
| OrProof (1-of-2) | P₁ = x·G or P₂ = x·G | 1,747,018 bytes | 901 bytes |

Sizes are from Rúnar 1.0.0-rc.1, built from main at commit 36b88b8. With the preimage check first, SPuzzle measured 873,670 bytes at commit 919e679 and 881,269 bytes with the Rúnar 0.4.6 npm release.

The artifact holds the compiled script hex, its disassembly and the ABI used by the Rúnar SDK to deploy and call the contract.

The 31 tests in test/spuzzles.test.ts each build a real spending transaction and execute the compiled script in the BSV SDK script interpreter, with a real OP_CHECKSIG over a real BIP-143 preimage. For every contract a valid proof unlocks, and the script rejects a proof made with the wrong secret, a copied proof with redirected outputs, and a proof replayed against another UTXO holding the same script.

All four contracts have also been locked and spent on BSV testnet, broadcast through the BSV Broadcaster at 100 sat/kB.

| Contract | Lock transaction | Lock size | Spend transaction | Spend size |
| --- | --- | --- | --- | --- |
| SPuzzle | cf96ede518772b0829bc80f387ca089f2d980422623007fc4bdd9e1285946749 | 874,025 bytes | 64587ca5ebecfe879bce9eb24fe6daec6686a30d34834aa73c6148a8ba320e1a | 769 bytes |
| PedersenOpening | 32799985be18af3ff8e3573c840b98494ada4f5101aeabec8b8c16526a822fdf | 1,323,577 bytes | 09ec58cbc69d54a65b9361f424e87a0ee859694e1d035c9df9b9d0f75fcd295a | 769 bytes |
| ChaumPedersen | cb5a64ea571b5459ce3ec6f7b79322ab156586062d497e2de8aa7d23098e0acc | 1,747,685 bytes | 7c10feb70ccbcec87f20d1e19bc09ed9e857f791bb0dc66d217679c1f16f27e6 | 834 bytes |
| OrProof | 7d17a9ace30ab4769fcb346f333b46a8a917b93e0915602a1555f1a1186fed69 | 1,747,478 bytes | d7e3531b253e4585a3b537c70e96747b929af2f521596727ae41ae597309487b | 903 bytes |

The locking-script sizes in the earlier table are for the compiled templates. The deployed scripts are 128 to 384 bytes longer because the statement's public parameters are filled in. Spend sizes differ from the table by up to two bytes, because the proof scalars and the preimage-check signature vary in encoded length. The locks cost 87,403 to 174,769 satoshis in fees and the spends 78 to 91. docs/TRANSACTIONS.md lists each proof and the outpoint and hashOutputs it is bound to.

## 5. Costs, limitations and extensions

The main cost is the size of the locking script: two in-script scalar multiplications produce about 874 KB, paid once when the output is created. The spend itself is under 1 KB. BSV has no elliptic-curve opcodes, so each multiplication is an unrolled 256-step double-and-add over big-number field arithmetic. After the Genesis upgrade, script size is bounded by miner policy rather than consensus, so the practical limits are fees, bandwidth, validation time and miner acceptance.

The statement point P is what gives an s-puzzle its meaning. Useful choices include:

- **Pedersen commitment opening.** For C = v·H + b·G, lock to P = C − v·H. A valid proof shows C commits to v; the witness is the blinding factor b.
- **Equality of discrete logs (Chaum–Pedersen).** One nonce, two bases: proves the same x underlies P₁ = x·G and P₂ = x·H.
- **OR-proofs.** Responses s₁…sₙ whose challenges sum to e prove knowledge of one of n keys without revealing which, giving ring-style anonymous spending.

All three are implemented in the repository as PedersenOpening, ChaumPedersen and OrProof, the last for two keys. Their sizes are in the Section 4 table.

The construction covers algebraic statements over secp256k1. Arbitrary circuits need a SNARK verifier in script, which has been demonstrated on BSV but at much larger sizes. A cheaper variant uses the native OP_CHECKSIG with a derived key, at the cost of the challenge being fixed by the sighash rather than chosen by the protocol.

## 6. Related work and references

The cryptography is standard; the contribution here is a compiled, tested implementation in Rúnar with the challenge bound to the spend.

- nChain whitepaper 1617, Zero-knowledge Puzzles (E. Larraia), generalises pay-to-public-key into Σ-protocol spending conditions with AND/OR composition. It was implemented in sCrypt as P2GPK: [sCrypt, Zero-Knowledge Puzzles (2022)](https://scryptplatform.medium.com/zero-knowledge-puzzles-db68f0cc34f0).
- nChain whitepaper 0488 proves a private key also satisfies another condition, such as hashing to a given value: [sCrypt, Zero-Knowledge Key-Statement Proof (2021)](https://scryptplatform.medium.com/zero-knowledge-key-statement-proof-188ba2dc2c30).
- nChain patent [US 11,968,304, Knowledge proof](https://patents.justia.com/patent/11968304) covers proof transactions carrying an ECDSA s-part against an r-challenge, including threshold keyshares.
- nChain patent [US 12,074,986, Hash function attacks](https://patents.justia.com/patent/12074986) combines an ECDSA signature with a ZK proof that its nonce is a hash preimage.
- Pairing-based SNARK verification in BSV script: [BLS12-381 library for Bitcoin](https://github.com/walker9296/BLS12-381).
- Rúnar compiler and SDK: [github.com/icellan/runar](https://github.com/icellan/runar).
- Implementation of this paper: [github.com/connormurray2/s-puzzles](https://github.com/connormurray2/s-puzzles).

Classical sources, cited from memory: C. P. Schnorr, Efficient signature generation by smart cards (1991); A. Fiat and A. Shamir, How to prove yourself (1986); D. Chaum and T. Pedersen, Wallet databases with observers (1992); R. Cramer, I. Damgård and B. Schoenmakers, Proofs of partial knowledge (1994).

# S-puzzles

Zero-knowledge spending conditions for BSV, written in [Rúnar](https://github.com/icellan/runar)
and verified entirely in Bitcoin Script with existing opcodes.

An **s-puzzle** is a transaction output that anyone can spend by proving they know a secret
satisfying a stated relation, without revealing the secret. The proof is a Schnorr-style
Σ-protocol transcript `(R, s)`. The name comes from `s`, the response, which is where the proof
lives, in the same way an R-puzzle locks to the `r` value of an ECDSA signature.

The Fiat–Shamir challenge is computed from the spending transaction itself, so a proof seen in the
mempool cannot be reused to send the funds somewhere else.

This repository implements the construction from the paper *S-Puzzles: Zero-Knowledge Spending
Conditions in the Signature Response* and the three extensions it lists.

## The four puzzles

| Contract | The output states | The spender proves knowledge of | Locking script | Spend tx |
| --- | --- | --- | --- | --- |
| [`SPuzzle`](contracts/SPuzzle.runar.ts) | `P = x·G` | `x` | 873,692 B | ~770 B |
| [`PedersenOpening`](contracts/PedersenOpening.runar.ts) | `C = v·H + b·G` for a published `v` | the blinding factor `b` | 1,323,240 B | ~770 B |
| [`ChaumPedersen`](contracts/ChaumPedersen.runar.ts) | `P1 = x·G` and `P2 = x·H` share one `x` | `x` | 1,746,801 B | ~835 B |
| [`OrProof`](contracts/OrProof.runar.ts) | `P1 = x·G` **or** `P2 = x·G` | one of the two secrets, without revealing which | 1,747,018 B | ~900 B |

Sizes are the compiled script templates from Rúnar `1.0.0-rc.1`, built from `main` at commit
`36b88b8`. BSV has no elliptic-curve opcodes, so each scalar multiplication is an unrolled
256-step double-and-add, roughly 430 KB of script each.

## How the basic puzzle works

`G` is the secp256k1 generator and `n` its order.

1. **Lock.** The output's script contains a point `P`. Whoever knows `x` with `P = x·G` can spend.
2. **Prove.** The spender fixes the spending transaction, picks a fresh random nonce `k`, and computes

   ```
   R = k·G
   e = SHA256(R || P || outpoint || hashOutputs) mod n
   s = k + e·x mod n
   ```

   and pushes `R`, `s` and the transaction's BIP-143 sighash preimage in the unlocking script.
3. **Verify.** The locking script checks that the preimage is genuine (OP_PUSH_TX), reads the
   outpoint and `hashOutputs` out of it, recomputes `e`, and accepts if and only if

   ```
   s·G = R + e·P
   ```

`x` never appears on chain. Because `e` covers the outpoint and the hash of the outputs, the proof
is valid for exactly one UTXO and one set of outputs. Changing either changes `e`, and the
equation fails. A plain hash puzzle has no such protection: its preimage can be lifted from the
mempool and used in a competing transaction.

[docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md) explains the three extensions, the OP_PUSH_TX step,
the encodings and the security caveats in more detail.

## Quick start

Requirements: Node 22+, pnpm, git.

```bash
pnpm run setup      # clones icellan/runar at the pinned commit into vendor/, builds it, installs deps
pnpm compile        # compiles the four contracts; prints script sizes
pnpm test           # 31 end-to-end tests
pnpm demo --dry-run # builds and verifies every lock and spend transaction offline
```

There is no Rúnar 1.0 release on npm, so `setup` builds the compiler and SDK from source and the
project links to that checkout. Override `RUNAR_COMMIT` to try a newer `main`.

### What the tests check

Every test builds a real spending transaction and runs the compiled script through the `@bsv/sdk`
interpreter, with real opcodes, a real `OP_CHECKSIG` and a real BIP-143 preimage. Nothing is
mocked. For each puzzle:

- a valid proof unlocks
- a proof made with the wrong secret is rejected
- a copied proof is rejected when the outputs are redirected
- it is still rejected when the thief recomputes the preimage for the new outputs
- it is rejected when replayed against another UTXO holding the same script

The OR-proof is tested knowing either key. The basic puzzle is also tested against `s + n`, an `R`
off the curve, and a preimage that does not match the transaction.

### Putting them on chain

```bash
pnpm wallet   # creates .wallet.json (gitignored) and prints the address to fund
pnpm demo     # locks and spends all four puzzles, writes docs/TRANSACTIONS.md
```

`NETWORK` selects `testnet` (default) or `mainnet`. `FEE_RATE` is in satoshis per kilobyte
(default 100). The four lock transactions total about 5.7 MB, so a full run costs roughly
570,000 satoshis at that rate. Spends are under 1 KB each.

The demo saves its progress, including the puzzle secrets, in `.demo-state.json` (gitignored), so
an interrupted run resumes rather than stranding funds.

## Layout

```
contracts/   the four Rúnar contracts
src/         curve helpers, provers, spend builder, chain access
scripts/     setup, compile, wallet, demo
test/        end-to-end tests
artifacts/   compile summary (sizes, hashes); full artifacts are generated, not committed
docs/        explanation and, after a demo run, the on-chain transactions
```

## Status

- Contracts compile and pass all tests against real transactions in the script interpreter.
- On-chain testnet transactions are pending; see `docs/TRANSACTIONS.md` once `pnpm demo` has run.

This is research code. It has not been audited. Do not lock funds you cannot afford to lose.

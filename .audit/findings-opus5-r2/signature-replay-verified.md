# Signature & Replay — Verified (Opus 5 R2)

**Date:** 2026-08-20
**Tree:** branch `mainnet-launch`, HEAD `c02af1d` + uncommitted working-tree changes
**Scope:** all 10 production contracts in `packages/blockchain/contracts/`, including
the three never-before-audited additions (`PreMarket.sol` 562, `PreMarketFactory.sol` 183,
`LockedLpVault.sol` 350). Plus the replay-shaped (non-signature) state-transition
questions: one-shot launch/buyout, harvest double-count, claim replay, ERC-721
receiver double-registration, and deterministic-deployment cross-chain exposure.

```
0 CRITICAL | 0 HIGH | 0 MEDIUM | 0 LOW | 1 INFO
```

---

## Part 1 — Signature surface: re-derived, still zero

The previous round's zero was **not** carried forward. It was re-established against
the current tree, which contains 1,095 lines of contract code that pass had never seen.

### Evidence A — source greps over the whole contracts directory

| Pattern | Occurrences in `contracts/**/*.sol` |
|---|---|
| `ecrecover` | **0** |
| `ECDSA`, `SignatureChecker`, `MessageHashUtils`, `toEthSignedMessageHash` | **0** |
| `EIP712`, `_hashTypedData`, `DOMAIN_SEPARATOR`, `domainSeparator` | **0** |
| `isValidSignature` (ERC-1271) | **0** |
| `permit`, `Permit2` | **0** |
| `nonce` | **0** |
| `relay`, `forwarder`, `trustedForwarder`, `metaTx`, `_msgSender` | **0** |
| `signature`, `deadline` **as a signature parameter** | **0** |

`deadline` does occur 40× but is exclusively a *position expiry timestamp*
(`PositionNFT.sol:61`, `EXNIHILOPool.sol:32`) — a business-logic field on an NFT,
never a signature validity window. No function anywhere accepts a `bytes signature`,
a `(v, r, s)` triple, or an `owner` to be recovered.

### Evidence B — the inherited OpenZeppelin closure (v5.6.1)

The task correctly flagged that inherited base classes can smuggle in `permit`-adjacent
surface. They do not here. Walked the full closure:

- `PositionNFT is ERC721Enumerable` → `ERC721` → `Context`, `ERC165`, `IERC721`,
  `IERC721Metadata`, `IERC721Errors`, `ERC721Utils`, `Strings`. No `EIP712`, no
  `Nonces`, no `ERC721Votes`. (OZ has no `ERC721Permit` at all.)
- `LpNFT is ERC721` — same closure.
- `ReentrancyGuard` → `StorageSlot` only.
- **`SafeERC20` in OZ v5.6.1 has no `safePermit`.** It was removed in v5.0; the library
  exposes only `safeTransfer`, `safeTransferFrom`, `safeIncreaseAllowance`,
  `safeDecreaseAllowance`, `forceApprove`. So `using SafeERC20 for IERC20` — present in
  six contracts — contributes zero permit surface. Under OZ 4.x this would have been
  worth checking; under 5.6.1 it cannot exist.

### Evidence C — compiled ABIs (the authoritative check)

Source greps can miss inherited functions. Compiled ABIs cannot. Artifacts were
confirmed current (`PreMarket` and `EXNIHILOPool` artifact mtimes match their sources
to the minute). Across **171 public/external functions** in all 10 production contracts,
scanning for the canonical selectors:

```
permit            0xd505accf   → 0 hits
permit (DAI)      0x8fcbaf0c   → 0 hits
DOMAIN_SEPARATOR  0x3644e515   → 0 hits
nonces            0x7ecebe00   → 0 hits
isValidSignature  0x1626ba7e   → 0 hits   (ERC-1271)
```

`EXNIHILOPool` (53 fns), `PositionNFT` (25), `PreMarket` (23), `LockedLpVault` (20),
`LpNFT` (16), `EXNIHILOFactory` (11), `Faucet` (11), `PreMarketFactory` (6),
`EXNIHILORouter` (5), `PoolDeployer` (1) — all clean.

### Evidence D — off-chain half

A signature scheme half-built in the frontend would still be in scope for this question.
Grepped all `.ts/.tsx/.js/.jsx` across `packages/` for `signTypedData`, `_signTypedData`,
`signMessage`, `personal_sign`, `eth_sign`, `verifyMessage`, `recoverAddress`, `siwe`:
**0 matches.** Nothing in the dApp ever asks a user to sign a message; every interaction
is a transaction.

### Conclusion for Part 1

**All five replay classes are vacuous here.** Same-chain, cross-chain, cross-contract,
nonce-skip, and expired-signature replay each require a signature to replay, and none
exists. The `ecrecover` edge cases (`address(0)` return, s-value malleability, `v`
normalization) and every EIP-712 domain-separator concern are likewise unreachable.

Every authorization in the protocol is a direct `msg.sender` comparison. In the three
new contracts specifically:

- `LockedLpVault.claimLpFees` → `msg.sender != lp` (`LockedLpVault.sol:245`)
- `LockedLpVault.claimIntegratorFees` → `msg.sender != integrator` (`:266`)
- `LockedLpVault.setLp` / `setIntegrator` → current holder only (`:292`, `:304`)
- `PreMarketFactory.createPreMarket` → permissionless, pulls from `msg.sender` (`:154-155`)
- `PreMarket.buyout` / `swap` → permissionless, pulls from `msg.sender` (`:507`, `:446`)

**On question 2 of the task — `PreMarket`/`PreMarketFactory` asset pulls.** There is no
`permit` convenience path. Both contracts pull via plain `transferFrom`, wrapped in a
fee-on-transfer assertion:

- `PreMarketFactory._pullExactTo` (`PreMarketFactory.sol:176-182`) —
  `IERC20(asset).safeTransferFrom(from, to, amount)` plus a balance-delta check on the
  recipient.
- `PreMarket._pullExact` (`PreMarket.sol:555-561`) — same shape, self as recipient.

Both require a prior ERC-20 `approve` from the caller. Nothing signed, nothing recovered.

---

## Part 2 — Replay-shaped state transitions (the part genuinely in scope)

Signatures are absent, but idempotency and one-shot-ness are real questions. I read
each transition and then **proved the answers empirically** with a throwaway Hardhat
probe (5 adversarial tests, all passing; file removed after the run — no contract or
test was modified).

### 2.1 Can `PreMarket`'s launch/buyout execute twice? No — guarded twice over.

`buyout` (`PreMarket.sol:480-546`) is the only function that launches, and it is
one-shot by two independent mechanisms:

1. `if (launched) revert AlreadyLaunched();` at **`PreMarket.sol:484`**, with
   `launched = true` at **`:501`** — inside the EFFECTS block, **before** the first
   external call at `:507` (`_pullExact`). Strict CEI, so even a re-entrant path that
   bypassed the guard would find the flag already set.
2. `nonReentrant` on the function itself (`:483`).

**Is `AlreadyLaunched` sufficient?** Yes, and it is not load-bearing alone. The same
transition also zeroes both reserves at `:502-503`, so a hypothetical second entry
would compute `quoteOut = 0`/`tokenOut = 0` and could not move value even if the flag
were bypassed. `swap` carries the same guard at `:422`, closing the AMM post-launch.
`buyout` and `swap` are the *only* state-mutating externals on `PreMarket` (confirmed
from the compiled ABI — everything else is a view).

There is also no partial-launch state to replay against: `factory.createMarket` at
`:515` is called without `try/catch`, so any failure reverts the whole transaction and
rolls `launched` back. Launch is atomic.

Already covered by the existing suite, which I ran to confirm it passes:
`test/PreMarket.ts:1186` "cannot be run twice", `:850` "reverts once the market has
launched", `:1251` and `:1266` (re-entrancy into `buyout` from both the market-creation
callback and the quote payout). All 4 pass.

### 2.2 Can `LockedLpVault.harvest` double-count one fee accrual? No — structurally.

`_harvest` (`LockedLpVault.sol:212-233`) does **not** measure a delta from `claimFees`.
It measures unearmarked balance:

```
amount = usdc.balanceOf(address(this)) - lpAccrued - integratorAccrued;   // :221
```

and then raises `lpAccrued + integratorAccrued` to exactly the full balance (`:228-229`).
The accounting is therefore idempotent by construction: a second call in the same block
computes `balance - balance = 0` and returns early at `:223`. Double-counting is not
prevented by a flag that could be forgotten — it is arithmetically impossible.

The pool side agrees: `EXNIHILOPool.claimFees` zeroes `lpFeesAccumulated` at
`EXNIHILOPool.sol:931` before transferring at `:934`, under `nonReentrant` and
`onlyLpHolder`. And `_harvest` only calls it when `lpFeesAccumulated() != 0`
(`LockedLpVault.sol:215`), so a repeat harvest does not even reach it.

**Probe R1 (passing):** opened a long to accrue real fees, harvested once, then
harvested 5 more times against the identical accrual. `harvestedTotal`, `lpAccrued`
and `integratorAccrued` were byte-identical after all six calls, and
`lpAccrued + integratorAccrued <= usdc.balanceOf(vault)` held throughout.

### 2.3 Can a `claim` be replayed against stale accounting? No.

Both claims read the accrued figure, zero it, then transfer — CEI, under `nonReentrant`:
`claimLpFees` at `LockedLpVault.sol:250-256`, `claimIntegratorFees` at `:271-277`. All
three mutating functions share one OZ `ReentrancyGuard` slot, so no cross-function
re-entry between `harvest`, `claimLpFees`, and `claimIntegratorFees` is possible.

**Probe R2 (passing):** claimed once, then replayed the claim — reverts
`NothingToClaim`. Interleaving a `harvest()` between the two attempts does not
resurrect the claimed amount; the replay still reverts.

### 2.4 Can `onERC721Received` double-register a deposit? No — it registers nothing.

`LockedLpVault.onERC721Received` (`:342-349`) is declared `pure` and its entire body is
`return IERC721Receiver.onERC721Received.selector;`. It writes no state, records no
deposit, and credits nothing. There is no registration to double.

Ownership is never cached — `isFunded()` reads live `lpNft.ownerOf(lpNftId)` at `:331`,
and the real gate is the pool's own `onlyLpHolder` on `claimFees`. The hook is not on
the value path at all; both real handoffs use plain `transferFrom`
(`PreMarket.sol:543`, `EXNIHILOFactory.sol:250`), which invokes no hook whatsoever.

**Probe R3 (passing):** called `onERC721Received` directly, three times, from an
unrelated EOA, with the vault's real `lpNftId` — `lpAccrued`, `integratorAccrued`,
`harvestedTotal` and NFT ownership all unchanged.

I also checked the *other* direction of this question — a duplicate vault. Anyone may
deploy a second `LockedLpVault` against the same `(pool, lpNftId)` pair; the constructor
check at `:179` (`poolOf(lpNftId) != pool_`) only binds the pair, it does not enforce
uniqueness. But a duplicate is inert: it does not hold the NFT, so `_harvest` →
`pool.claimFees` reverts `OnlyLpHolder`. **Probe R4 (passing)** confirms the duplicate
cannot claim and the real vault is unaffected.

The only other ERC-721 hook surface is `PositionNFT._safeMint` (`:296`, `:325`). Both
call sites write the full `_positions[tokenId]` struct **before** the mint (`:284-294`,
`:313-323`) and take a fresh id via `_nextTokenId++`, so a re-entrant receiver cannot
cause the same id to be registered twice. `LpNFT.mint` uses plain `_mint`
(`LpNFT.sol:74`), firing no hook at all.

### 2.5 Cross-chain replay via deterministic deployment: not applicable — no CREATE2.

Grepped the whole contracts directory for `create2`, `salt`, `new X{...}`, `Clones`,
`cloneDeterministic`, `computeAddress`. **The only match in production code is none.**
All three deployment sites use plain `CREATE`:

- `PreMarketFactory.sol:134` — `new PreMarket(...)`
- `PreMarket.sol:531` — `new LockedLpVault(...)`
- `PoolDeployer.sol:24` — `new EXNIHILOPool(...)`

Plain `CREATE` derives from `(deployer, nonce)`, so no salt-based address can be
pre-computed and squatted on another chain. The single `CREATE2` string in the tree is
a **comment** in a test placeholder (`test/DeployHelper.sol:7`) describing a TypeScript
test technique; the contract's only function is `placeholder()`.

Even the residual `CREATE`-based concern (same EOA + same nonce ⇒ same factory address
on two chains) has no consequence here, because exploiting an address collision requires
either a signature honored on the wrong chain (none exist) or a second deployment to
collide with. The protocol targets exactly one production chain: `hardhat.config.ts`
declares `avalanche` (43114) and `avalancheFujiTestnet` (43113), and the site registry
`packages/site/src/lib/chains.ts:44` contains a single entry, slug `avalanche`.

---

## Findings

### SR-001 — `EXNIHILOFactory` documents an `onERC721Received` it does not implement

**Severity:** INFO
**Location:** `packages/blockchain/contracts/EXNIHILOFactory.sol:67`

The contract's Security header asserts:

```
 *   - onERC721Received implemented so the factory can safely receive LP NFTs.
```

No such function exists. The compiled ABI for `EXNIHILOFactory` contains exactly 11
functions — `allPools`, `allPoolsLength`, `createMarket`, `deployer`, `isPool`,
`lpNftContract`, `poolDeployer`, `positionNFT`, `protocolTreasury`, `setDeployer`,
`usdc` — and `onERC721Received` is not among them.

**Why it is harmless in the protocol's own paths.** The factory receives the LP NFT via
`lpNftContract.mint(address(this), pool)` (`EXNIHILOFactory.sol:234`), and `LpNFT.mint`
uses `_mint`, not `_safeMint` (`LpNFT.sol:74`) — no receiver hook is invoked. It then
forwards the NFT with plain `IERC721.transferFrom` (`EXNIHILOFactory.sol:250`), which
also invokes no hook. So the missing function is never needed internally, and
`createMarket` is not broken.

**Why it is still worth recording.** The comment is not merely stale, it is inverted:
because the factory has no `onERC721Received`, an ERC-721 `safeTransferFrom` **to** the
factory reverts with `ERC721InvalidReceiver`. An integrator reading this header — and
these headers are clearly written to be read, `PreMarket.sol` and `LockedLpVault.sol`
both advertise bytecode-verifiable guarantees — could reasonably conclude the factory
is a safe `safeTransferFrom` destination for an LP NFT. It is not.

**Failure path (bounded, no loss):** an integrator calls
`lpNft.safeTransferFrom(holder, factoryAddress, id)`; the call reverts atomically. No
funds move and no NFT is stranded — the damage is a failed transaction and a false
belief about the contract's interface. Hence INFO, not LOW.

**Suggested fix (not applied — analysis-only round):** delete line 67, or implement
`IERC721Receiver` if the factory is meant to be a valid `safeTransferFrom` destination.
Deleting the line is the accurate change, since nothing in the protocol needs the hook.

---

## Carried findings from `.audit/findings-opus5/`

**NM-002 — "Factory residual approvals not revoked after `addLiquidity`" (was LOW, open).**
**This does not hold, and did not hold at the baseline it was reported against.**

The prior signature-replay report restated NM-002 as "remains open and LOW: the factory
may leave a residual allowance to a pool it itself deployed." That is incorrect. The
revocation is present in the current tree at `EXNIHILOFactory.sol:245-246`:

```solidity
IPoolAddLiquidity(pool).addLiquidity(tokenAmount, usdcAmount);

// Revoke residual approvals (defense-in-depth for non-standard
// ERC-20s that do not zero the allowance on exact transferFrom).
IERC20(tokenAddress).forceApprove(pool, 0);
IERC20(usdc).forceApprove(pool, 0);
```

and — checked against git, not asserted — it was **already present at the audited
baseline `5197494`**, at lines 238-243 of that revision, in the same position
immediately following `addLiquidity`. `git diff` for this file shows no change to the
approval logic. So this was a false positive carried through at least one prior round.
Recommend closing it rather than re-verifying it next round.

The prior report's other adjacent claim — that the router's approvals are set and
cleared within a single transaction — still holds (`EXNIHILORouter.sol:82`, `:97`,
`:116` pull with `safeTransferFrom`; approvals to the pool are forced to zero in the
same call). `PreMarket.buyout` follows the same discipline at `:512-513` / `:523-524`,
and the existing test `test/PreMarket.ts:1194` ("leaves no residual factory approvals")
asserts it.

---

## Checked and found clean

So the next round knows what this pass actually covered:

| Area | Verdict |
|---|---|
| `ecrecover` / `ECDSA` / EIP-712 / ERC-1271 surface, all 10 contracts | None exists — source greps, OZ inheritance closure, and 171-function ABI selector scan all agree |
| OZ 5.6.1 inherited surface (`ERC721Enumerable`, `ERC721`, `SafeERC20`, `ReentrancyGuard`) | No `permit`, no `Nonces`, no `EIP712`; `SafeERC20.safePermit` does not exist in v5 |
| Off-chain signing in `packages/site` and `packages/indexer` | None — no `signTypedData` / `signMessage` / `siwe` anywhere |
| `PreMarket` / `PreMarketFactory` asset pulls | Plain `transferFrom` only, with FoT balance-delta assertions; no permit path |
| `PreMarket.buyout` one-shot | Sound — flag checked at `:484`, set at `:501` before any external call, plus `nonReentrant`, plus reserves zeroed |
| `PreMarket.swap` post-launch | Closed at `:422`; also inert because reserves are zero |
| `LockedLpVault.harvest` idempotency | Balance-based, not delta-based — arithmetically cannot double-count (probed 6× against one accrual) |
| `LockedLpVault` claim replay | CEI + shared `nonReentrant`; replay reverts `NothingToClaim` |
| `onERC721Received` double-registration | Impossible — the hook is `pure` and registers nothing; duplicate vaults are inert |
| `PositionNFT._safeMint` receiver hook | State written before mint, fresh `_nextTokenId++` per mint — no double-registration |
| `PositionNFT.applyRenewal` replay | Pool-only (`:349`); overwrites rather than accumulates, except `feesPaid`, which is display-only (never read by pool payout math) |
| CREATE2 / deterministic deployment | None in production code; all three deployment sites use plain `CREATE` |
| Cross-chain exposure | Single production chain (43114); no signatures to replay regardless |

### One observation handed to another pass

`LockedLpVault._harvest` (`:221`) and `pending()` (`:320-321`) both compute
`usdc.balanceOf(address(this)) - lpAccrued - integratorAccrued`. This relies on the
invariant *balance ≥ lpAccrued + integratorAccrued*, which I verified holds across
every code path in the contract (only `_harvest` raises the accrued sum, and only the
two claims lower it, each by exactly the amount transferred out). It would break only
if the USDC contract could reduce a holder's balance without an outbound transfer.
Real USDC's blacklist freezes transfers, it does not seize balances, so the invariant is
safe in production; and the failure mode would be an arithmetic revert (DoS on harvest
and on the `pending()` view), not a value leak.

**This is not a replay finding and I am not claiming it as one.** Flagging it so the
DoS/griefing and external-call-safety passes can decide whether the balance-based
accounting deserves a note in their lane.

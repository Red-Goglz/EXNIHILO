# DoS & Griefing — Verified (Opus 5)

**Date:** 2026-07-27
**Scope:** `EXNIHILOPool`, `PositionNFT`, `EXNIHILOFactory`, `EXNIHILORouter`, `LpNFT`, `Faucet`

```
0 CRITICAL | 0 HIGH | 0 MEDIUM | 2 LOW
```

## Structural result: unbounded-loop DoS is impossible

`grep -nE "for \(|while \(" *.sol` returns **zero matches across every contract**.

There is no iteration over user-controlled collections anywhere in the protocol:
no reward loop, no batch settlement, no per-holder distribution, no array of
positions. Every operation is O(1) on a single position or a single pool. The
entire class — block-gas-limit exhaustion, growing-array DoS, one-bad-recipient
blocks-everyone — has no surface here.

Position enumeration lives on `PositionNFT` (ERC-721Enumerable) and is used by
the frontend via `view` calls, never by a state-changing pool path.

## Push vs pull

Fees and third-party payouts are **pull**:

- `lpFeesAccumulated` → `claimFees(to)`
- `protocolFeesAccumulated` → `claimProtocolFees(to)`
- expiry-settlement surplus → `_creditPayout` → `claimPayout(to)`

All three accept an arbitrary `to`, so a holder whose own wallet cannot receive
USDC (blacklist, contract without a receive path) can still redirect. This is the
remediation for prior finding **DoS-2**, and it is stronger than the
`_trySendUsdc` try/catch it replaced: the funds are never pushed at all.

Push transfers remain only where the recipient is `msg.sender` and therefore
chose to receive: self-close payout, keeper bounty, `removeLiquidity`.

## Griefing vectors examined

**LP exit blocking — resolved.** `removeLiquidity` requires
`openPositionCount == 0`, so any party able to keep a position open indefinitely
could trap LP capital. Prior finding NM-004 flagged that *anyone* could renew a
position to do this. That is now closed: `renewPosition` requires
`positionNFT.ownerOf(nftId) == msg.sender`. A third party can no longer extend
someone else's position.

The holder can still renew their own position indefinitely, but must pay the
dynamic renewal fee each time — which is repriced at current mark and OI, so the
cost scales with the crowding they are causing. `closePool()` remains the LP's
escape hatch: it sets `closeDate`, after which renewals past that date revert
(`RenewalExceedsCloseDate`) and every position drains within one
`positionDuration`.

**Keeper starvation — mitigated by design.** `settleExpired` pays a flat
`KEEPER_BOUNTY` (0.05 USDC) carved from the settlement flow, clamped to what is
actually available (`bounty > surplus - closeFee ? surplus - closeFee : bounty`,
and `bounty > pos.lockedAmount ? pos.lockedAmount : bounty`). Cleanup is
therefore economically viable but can never overdraw the position. Prior finding
NM-003 ("no caller incentive for closePositionAfterDeadline") is **closed** by
the bounty.

`closePositionAfterDeadline` still exists with `bounty = 0` and reverts with
`AutoRenewActive` when the holder has opted into auto-renewal — so it cannot be
used to deny a holder their renewal.

## LOW-DOS-1 (carried) — blacklisted treasury blocks fee claims

`claimProtocolFees` is `msg.sender == protocolTreasury` gated but sends to an
arbitrary `to`, so a blacklisted treasury can still redirect. Only the treasury's
own fees are affected; pool operation, LP fees and trader payouts are unaffected.
Downgraded in practice from the original finding because of the `to` parameter.

## LOW-DOS-2 — `factory.deployer()` can force-close every pool

Duplicate of NM-OP5-002 in the Nemesis report, restated here because it is
primarily a griefing concern. A single mutable EOA (`EXNIHILOFactory.sol:98`,
transferable at `:272`) can call `closePool()` on any pool, forcing every market
in the protocol into wind-down. No theft — positions settle normally, LPs
withdraw normally — but it is unilateral denial of service against every LP.

Fix: timelock/multisig the role, or zero it after launch.

## Gas-griefing checks

- No `address(this).balance` dependence in `EXNIHILOPool` (the Faucet uses it,
  but only to clamp its own payout).
- No `selfdestruct` force-feeding surface: the pool's accounting reads
  `underlyingToken.balanceOf` / `underlyingUsdc.balanceOf` only inside
  `_assertReserveInvariant`, and only as a **lower-bound** check. Donating tokens
  to the pool can only make the invariant *more* satisfied, never break it.
- No storage-bloat vector: no user-growable arrays or mappings keyed on
  unbounded input.

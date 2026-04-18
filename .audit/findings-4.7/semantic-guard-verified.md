# Semantic Guard Analysis — EXNIHILO 4.7

## Scope

`EXNIHILOPool.sol`, `PositionNFT.sol`, `EXNIHILOFactory.sol`, `EXNIHILORouter.sol`, `LpNFT.sol`, `AirToken.sol`.

## Methodology — Consistency Principle

A contract is its own specification. If sibling functions consistently apply a guard, any function that skips it is suspect unless documented otherwise.

Catalog guards across:
- Access control (`onlyOwner`, `onlyFactory`, `onlyPool`, `msg.sender == lpOwner`).
- Reentrancy (`nonReentrant`).
- State gates (`require(!closed)`, `require(block.timestamp < deadline)`, etc.).
- Input validation (zero-address, zero-amount, range checks).
- Invariant assertions (`_assertReserveInvariant`).

## Consistency Matrix Observations (summary)

| Guard | Sibling coverage | Exception | Verdict |
|-------|------------------|-----------|---------|
| Zero-address check on setters | Constructor args + `initPool` + `initFactory` + `LpNFT ctor` all enforce | `setDeployer` does NOT | **SGA-4** |
| Underflow guard `airUsdSupply < pos.lockedAmount` | `closeLong:583`, `_shortIsUnderwater:1265`, `_closeExpiredShort` | `closeShort:815` does NOT | **SGA-2** |
| Input validation on market-entry points | Constructor validates addresses + amounts | `createMarket` has empty validation block | **SGA-3** |
| `_assertReserveInvariant` after reserve writes | Most mutating paths call it | `removeLiquidity`, `renewPosition` skip (design) | **SGA-1 (INFO)** |
| `nonReentrant` on pool externals | Applied uniformly | None | Consistent |
| `onlyFactory`/`onlyPool` on NFT mint | `PositionNFT.mintLong/Short` requires factory wired + isPool | pre-`initFactory` short-circuit | Logged as NM-001 |

## Prior Findings Re-verified

### SGA-1 — `_assertReserveInvariant` skipped where correct by design (INFO)

**Status:** **Confirmed unchanged.** `removeLiquidity` and `renewPosition` do not call `_assertReserveInvariant` — both leave reserves in states that are legitimately outside the invariant (pool drained post-removal; renewal merely extends deadline without reserve motion). Documented as design.

## New Findings (4.7)

### SGA-2 — `closeShort` missing underwater guard (MEDIUM, NEW)

**Location:** `EXNIHILOPool.sol:813-816`

```solidity
// closeShort body
airUsdToken.burn(pos.lockedAmount);
airUsdSupply -= pos.lockedAmount;   // <-- no guard; panics 0x11 on underflow
```

**Inconsistency:** `closeLong` at L583 applies:
```solidity
if (airTokenSupply < pos.lockedAmount) revert PositionUnderwater();
airTokenSupply -= pos.lockedAmount;
```

The symmetric sibling in `closeShort` is missing. `_shortIsUnderwater` (`L1265`) contains the identical check — so the internal view is aware of the condition, but the voluntary-close path isn't.

**Impact:** When the short is underwater, `closeShort` panics with `0x11` arithmetic error instead of a clean `PositionUnderwater` revert. The position is not voluntarily closeable; the holder must wait for `closePositionAfterDeadline`. No fund loss but confusing UX and diverges from the protocol's explicit error-surface contract.

**Fix:** `if (airUsdSupply < pos.lockedAmount) revert PositionUnderwater();` before L814.

### SGA-3 — `createMarket` has empty validation block (LOW, NEW)

**Location:** `EXNIHILOFactory.sol:192-193`

```solidity
// Input validation
// (empty)
```

The block is a literal placeholder. Zero `usdcAmount` or `tokenAmount` slip through, deploying two `AirToken` contracts and a `EXNIHILOPool` before `addLiquidity(0, 0)` reverts — gas burned for nothing, no registry corruption but no recovery either. `tokenAddress == address(0)` produces a low-level call failure instead of `ZeroAddress()`. `positionDuration == 0` produces a market where positions expire at the opening block.

**Inconsistency:** The `EXNIHILOPool` constructor (`L138-144`) validates all its addresses non-zero. `createMarket` is the sole entry path and skips every input check.

**Fix:** 3 checks at L193:
```solidity
if (tokenAddress == address(0)) revert ZeroAddress();
if (usdcAmount == 0 || tokenAmount == 0) revert ZeroAmount();
if (positionDuration == 0) revert InvalidDuration();
```

### SGA-4 — `setDeployer` accepts zero address despite NatSpec (LOW, NEW)

**Location:** `EXNIHILOFactory.sol:267-270`

NatSpec at L265 states "Must not be zero." Code at L268-270:
```solidity
function setDeployer(address newDeployer) external {
    require(msg.sender == deployer, "onlyDeployer");
    deployer = newDeployer;  // <-- accepts address(0)
}
```

**Inconsistency:** Every other address-writing operation in the codebase (constructor args, `initPool`, `initFactory`, `LpNFT` constructor) validates non-zero. `setDeployer` is the sole exception, and it's the one setter where the consequence is most severe: `address(0) == deployer` makes the `msg.sender == deployer` check uncallable (cannot re-enter from address(0)), and disables the `factory.deployer() == msg.sender` emergency branch in `EXNIHILOPool.closePool` across every registered pool.

**Fix:** `if (newDeployer == address(0)) revert ZeroAddress();` at L268.

## Delta vs 4.6

- SGA-1 **Confirmed unchanged** (INFO).
- **SGA-2 (MEDIUM, NEW)** — asymmetric underflow guard between close paths.
- **SGA-3 (LOW, NEW)** — empty validation block in `createMarket`.
- **SGA-4 (LOW, NEW)** — `setDeployer` zero-address guard missing.

All three NEW findings represent consistency violations within the codebase itself — patterns applied 99% of the time with a single outlier. The Consistency Principle flagged them where the 4.6 audit had classified only SGA-1.

**Severity tally:** 4.6 = 0C/0H/0M/0L/1I → 4.7 = 0C/0H/**1M**/**2L**/1I.

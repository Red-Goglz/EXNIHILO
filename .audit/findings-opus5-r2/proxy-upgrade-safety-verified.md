# Proxy & Upgrade Safety — Verified (Opus 5 R2)

**Date:** 2026-08-20
**Baseline:** `5197494` (audited by Opus 5 R1) → working tree on `mainnet-launch`, HEAD `c02af1d`
**Scope covered:**

- All 10 production contracts in `packages/blockchain/contracts/` plus `test/`
- The three never-audited contracts: `PreMarket.sol`, `PreMarketFactory.sol`, `LockedLpVault.sol`
- Both deployment paths: `scripts/deployMainnet.ts` and `ignition/modules/EXNIHILOCore.ts`
- Migration surface: `scripts/verifyMainnetPools.ts`, `packages/abis/`, `packages/indexer/src/chain.ts`,
  `packages/site/src/contracts/mainnetAddresses.json`, the site's pool multicalls
- Dependency manifests (upgradeable-library check)

```
0 CRITICAL | 0 HIGH | 0 MEDIUM | 3 LOW | 3 INFO
```

Two findings carried into this pass (**NM-001**, **NM-002**) are **stale and should be
closed** — see "Carried findings" below. Both were already fixed in `5197494`, the very
commit R1 audited, so R1's re-confirmation of them was incorrect.

---

## Part 1 — The no-proxy claim, re-derived

Not carried forward from R1. Re-run from scratch against the current tree, including the
three new contracts.

| Pattern | Occurrences in `contracts/` |
|---|---|
| `delegatecall` / `callcode` / `staticcall` (any case) | **0** |
| `Initializable`, `UUPS`, `ERC1967`, `Beacon`, `Diamond`, `diamondCut`, `proxiableUUID`, `__gap`, `Proxy` | **0** |
| `Clones`, `create2` / `CREATE2`, `salt` | **0** |
| EIP-1167 bytecode (`363d3d37…`, `3d3d3d363d73…`, `5af43d82803e903d91602b57fd5bf3`) | **0** |
| `selfdestruct`, `extcodecopy`, `creationCode`, `runtimeCode` | **0** |
| `assembly` | 2, both in `test/ReentrantToken.sol:77,102` (revert-data bubbling in a mock) |

Dependency level: **no** `@openzeppelin/contracts-upgradeable`, `@openzeppelin/hardhat-upgrades`,
or any `*-upgrades` package in any `package.json` in the workspace. The only OZ dependency is
`@openzeppelin/contracts: ^5.4.0` (`packages/blockchain/package.json:9`) — the non-upgradeable
distribution.

### How the three deploying contracts actually deploy

All three use direct `new` (CREATE), never a clone and never CREATE2:

- `PoolDeployer.sol:24` — `new EXNIHILOPool(...)`, now 8 constructor args (was 12)
- `PreMarketFactory.sol:134` — `new PreMarket(...)`
- `PreMarket.sol:531` — `new LockedLpVault(...)`

No deployed instance has an initializer. Every contract sets its state in its `constructor`.
The one post-construction wiring step in the whole system is `PositionNFT.initFactory`
(`PositionNFT.sol:125-130`), which is deployer-gated, zero-gated, and once-only — and which
is *not* a proxy initializer.

**Conclusion:** all five classes this pass exists to find (storage-layout collision,
uninitialized implementation, selector clash, missing upgrade authorization, delegatecall
context confusion) remain structurally impossible. The claim holds, and now holds over the
three new contracts as well.

---

## Part 2 — Findings

### PU-001 — `PoolDeployer.deploy` has no access control (LOW, carried, still open)

**File:** `PoolDeployer.sol:14`

`deploy(...)` is `external` with no `onlyFactory` guard, exactly as when 4.7 first raised
this. The signature shrank from 12 args to 8 this round; the missing guard did not change.

**Path:** anyone calls `PoolDeployer.deploy(token, usdc, dec, positionNFT, lpNft, lpNftId,
treasury, factory)` with the *real* factory, PositionNFT and LpNFT addresses and any
`lpNftId`, and gets a real `EXNIHILOPool` at a fresh address that is not in
`EXNIHILOFactory.isPool`.

**Why it stays LOW — re-derived against the new contracts, not carried:**

- `PositionNFT.mintLong/mintShort` reject it: `PositionNFT.sol:281` / `310` check
  `!IEXNIHILOFactory(factory).isPool(pool)`. The orphan is not registered, so no position
  can ever be opened on it.
- `addLiquidity` requires `msg.sender == lpNftContract.ownerOf(lpNftId)`
  (`EXNIHILOPool.sol:482-485`). An attacker pointing an orphan at a *real* LP NFT id cannot
  seed it — only that NFT's real owner could, and they gain nothing by doing so.
- `LockedLpVault` cannot be attached to an orphan: its constructor asserts
  `lpNft.poolOf(lpNftId) == pool` (`LockedLpVault.sol:179`), and `poolOf` is written only by
  `LpNFT.mint`, which is `onlyFactory` (`LpNFT.sol:69`).

So the orphan is inert in all three directions. Impact is unchanged from 4.7: on-chain state
pollution and possible confusion for anyone enumerating pool bytecode. **No fund path.**

**Note for the coordinator:** R1's proxy pass reported `0 | 0 | 0 | 0` and silently dropped
PU-001. It was never fixed and should be re-listed as open.

---

### PU-003 — Mainnet pool-verification tooling is written against the removed ABI (LOW, new)

**File:** `packages/blockchain/scripts/verifyMainnetPools.ts:55, 113, 115, 116, 139-152`

This file is **new this round** (`git ls-files` shows it staged as added), yet it is written
entirely against the *baseline* pool interface. Confirmed empirically against the compiled
artifact `artifacts/contracts/EXNIHILOPool.sol/EXNIHILOPool.json`:

| Script does | Reality in the new artifact |
|---|---|
| `pool.positionDuration()` (L113) | not in the ABI — removed |
| `pool.maxPositionUsd()` (L115) | not in the ABI — removed |
| `pool.maxPositionBps()` (L116) | not in the ABI — removed |
| passes **12** `constructorArguments` (L139-152) | constructor takes **8**: `underlyingToken_, underlyingUsdc_, tokenDecimals_, positionNFT_, lpNftContract_, lpNftId_, protocolTreasury_, factory_` |
| `decoded.args[3]` / `args[4]` (L55) | `createMarket` now has **3** inputs: `tokenAddress, usdcAmount, tokenAmount` |

`pool.swapFeeBps()` (L112) still resolves — it survived as `uint256 public constant`
(`EXNIHILOPool.sol:196`), so it keeps its getter.

**Failure path:** the three dead calls sit inside a `Promise.all` (L104-117) that is *outside*
the `try/catch` at L135-164. The first one throws, `main()` rejects, `process.exit(1)`. The
script cannot verify a single pool — against the currently-live baseline pools *or* against
the pools the pending redeploy will create.

**Why this matters beyond hygiene:** pools are created permissionlessly by `PoolDeployer` from
inside `createMarket`, so they are never verified as a side effect of a deploy (the script's own
header, L4-8, says exactly this). This script is the *only* tool that verifies them. Broken, it
means every permissionless market ships with unverified bytecode on the explorer — a real
transparency regression for a protocol whose entire pitch is "verify it from the bytecode"
(`LockedLpVault.sol:54-56`, `PreMarket.sol:77-79`). No funds at risk; the failure is loud.

**Fix:** drop `positionDuration`/`maxPositionUsd`/`maxPositionBps` from the reads, delete
`originalCaps()` entirely (there are no mutable constructor args left to recover — that was the
whole point of removing `setPositionCaps`), and pass the 8 real constructor arguments.

---

### PU-004 — The redeploy updates the site's address book but not the indexer's (LOW, new)

**Files:** `scripts/deployMainnet.ts:210-215`, `packages/indexer/src/chain.ts`

`deployMainnet.ts` writes the full new address set to
`packages/site/src/contracts/mainnetAddresses.json` (L210-211), overwriting it wholesale with
a new `factory`, `positionNFT`, `lpNFT`, `startBlock` and `pools: {}`. That file is the site's
source of truth.

The indexer's source of truth is a *different* file that the script does not touch.
`packages/indexer/src/chain.ts` hardcodes the current deployment as env fallbacks:

- `FACTORY_ADDRESS` → `0xBe6Fb0e7b7d8EFD491FEbC436F737cE8B244F85a`
- `POSITION_NFT_ADDRESS` → `0xa08E20fb4c157cf8E46c67A41250F54c1b53adfd`
- `LP_NFT_ADDRESS` → `0x71a6802e1b1313822014D29c5Fe43Dd441a4dB9a`
- `START_BLOCK` → `91_382_693`

— all matching the *live baseline* deployment. The script's only handling of this is a printed
reminder at L215 (`"Indexer: set PONDER_CHAIN_ID=... and PONDER_START_BLOCK=..."`), which covers
the chain id and start block but not the three addresses.

**Failure path:** run the redeploy, restart the stack without hand-editing `chain.ts` or setting
`PONDER_FACTORY_ADDRESS` / `PONDER_POSITION_NFT_ADDRESS` / `PONDER_LP_NFT_ADDRESS` /
`PONDER_START_BLOCK`. The site now reads the new factory while the indexer still follows the old
one. Every indexer-backed surface — price history, pool and protocol metrics, LP APR — answers
for pools the site can no longer see, and returns nothing for the pools it can. The site does not
detect this: `chain.ts` guards only on chain *id* (`INDEXED_CHAIN_ID`), which is `43114` in both
deployments, so the mismatch passes the one check that exists.

No fund path — this is a data-integrity and operations failure. Pre-launch, per SCOPE.md.

**Fix:** have `deployMainnet.ts` write the indexer's addresses too (or emit a `.env` fragment),
and/or derive `chain.ts` from `mainnetAddresses.json` so the two cannot drift.

---

### PU-005 — The Ignition deployment path is broken and carries a wrong mainnet USDC (INFO, new)

**Files:** `ignition/modules/EXNIHILOCore.ts:36`, `ignition/parameters/avalanche.json`

The module was updated this round (adds `PoolDeployer`, drops `defaultSwapFeeBps`), so it reads
as maintained. It is not:

- L36 `const lpNFT = m.contract("LpNFT");` passes **no** constructor argument, but `LpNFT`'s
  constructor requires `address factory_` and reverts `ZeroAddress()` on zero (`LpNFT.sol:42-45`).
  This predates the round — `LpNFT.sol` is unmodified — so the Ignition path has never worked.
  It also cannot easily work: `LpNFT ↔ Factory` is a constructor cycle that `deployMainnet.ts`
  resolves by CREATE nonce prediction (its header, L17-21), which Ignition's module does not do.
- `ignition/parameters/avalanche.json` still declares the now-removed `defaultSwapFeeBps: 100`,
  a placeholder `"protocolTreasury": "YOUR_TREASURY_ADDRESS"`, and
  `"usdc": "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c"` — **39 hex characters**, not 40, and not
  Avalanche USDC (`0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E`, which `deployMainnet.ts:34`
  correctly hardcodes and then verifies on-chain for code, symbol and 6 decimals at L78-92).

Everything here is fail-closed — a malformed address fails encoding, a missing constructor arg
fails the module. Nothing can reach chain. It is INFO rather than LOW only because it cannot
produce a bad deployment, but it is worth deleting or fixing: `CLAUDE.md` advertises
`npx hardhat ignition deploy ./ignition/modules/...` as a project command, and `usdc` and
`protocolTreasury` are **immutable** on the factory — the one place where a wrong value means
redeploying the entire protocol.

---

### PU-006 — A `LockedLpVault` proves nothing until `isFunded()` is true (INFO, new)

**File:** `LockedLpVault.sol:163-189`, `330-332`

Anyone can deploy a `LockedLpVault` naming any real pool, with themselves as `lp` and
`integrator`. The constructor validates the id/pool pairing (`L179`) but deliberately does not
check ownership — `L176-178` explains why: the vault is normally deployed before the NFT
arrives, so ownership cannot be checked at construction.

An unfunded vault is inert, and I confirmed the contract's own claim at `L328-329`:

- `harvest()` → `_harvest()` calls `pool.claimFees(address(this))` (`L216`), which is
  `onlyLpHolder` (`EXNIHILOPool.sol:926`, modifier at `482-485`). Not the NFT holder → reverts.
- With zero pool fees, `_harvest()` skips the call (`L215`) and merely splits any stray USDC
  by the immutable `integratorBps` — the documented behaviour at `L206-210`, not a leak.
- Both claim paths are gated to constructor-set addresses (`L245`, `L266`); neither is
  front-runnable.

So there is **no fund path**. The INFO is a consumption warning: the vault's *existence* at an
address is not evidence that any liquidity is locked. Anything that renders "LP locked" — a
launchpad UI, the site, a docs claim — must check `isFunded()` **and** that the vault's `pool`
and `lpNftId` are the ones being advertised. `pending()` (`L317-326`) will happily report a
non-zero `lpPending` for an unfunded vault, since it reads `pool.lpFeesAccumulated()` without
checking ownership; that number is not claimable.

---

### PU-007 — Stale ABI copy still carries the removed surface (INFO, new)

**File:** `packages/blockchain/abis/EXNIHILOPool.json`, `EXNIHILOFactory.json`

Last regenerated at the audited baseline `5197494`. These still contain `positionDuration`,
`maxPositionUsd`, `maxPositionBps` and `setPositionCaps`. The shared workspace package
`packages/abis/EXNIHILOPool.ts` **is** correctly regenerated (zero occurrences of all four;
`currentPositionDuration`, `currentMaxPositionBps`, `createdAt`, `settlementGuardedUntilBlock`
all present).

Nothing imports `packages/blockchain/abis/` — I grepped the whole workspace and found no
consumer. Harmless today; worth deleting so a future migration does not pick up the wrong copy.

---

## Part 3 — Carried findings: both are stale, close them

### NM-001 — "PositionNFT mint reachable before `initFactory`" → **does not exist, and did not exist at the baseline**

R1 re-confirmed this as LOW/open. That was wrong. The guard order in the current tree is:

```solidity
if (factory == address(0)) revert FactoryNotSet();          // PositionNFT.sol:279 / 308
if (msg.sender != pool) revert OnlyPool();                  //               280 / 309
if (!IEXNIHILOFactory(factory).isPool(pool)) revert OnlyPool(); //           281 / 310
```

`FactoryNotSet` is checked **first**, so before `initFactory` the mint path is closed to
everyone, not open. This is exactly the fix 4.7's PU-002 asked for ("hoist
`require(factory != address(0))` above the `msg.sender == pool` check").

It was already in place at the audited baseline — `git show 5197494:…/PositionNFT.sol` has the
identical three lines at **233-235** and **262-264**. `git log -S FactoryNotSet` shows the guard
landing in commit `5197494` itself, the commit R1 audited. **The 170 changed lines this round do
not touch the mint path at all** — the entire diff is `_netReturn`, SVG typography and metadata
attribute renaming. So the window did not widen, narrow, or move; it was never there.

**What the real window is, since the coordinator asked me to re-derive it:** in
`deployMainnet.ts`, the factory is live at step 3 (L139-149) and `initFactory` runs at step 4
(L165). Between those two transactions anyone who reads the factory address from the mempool can
call `createMarket` — and it *succeeds*, because `createMarket` never touches `PositionNFT`
(pool deploy, `LpNFT.mint`, `addLiquidity`, NFT transfer). The resulting pool is fully
registered in `isPool`. What that pool cannot do in the window is open positions, because
`mintLong`/`mintShort` revert `FactoryNotSet`. The instant `initFactory` lands, the pool works
normally. Net effect: a stranger can front-run market #0. No funds at risk, no permanent damage,
fully self-healing. That is the inverse of what NM-001 described.

### NM-002 — "Factory residual approvals not revoked" → **already revoked, including at the baseline**

`EXNIHILOFactory.sol:243-246`:

```solidity
// Revoke residual approvals (defense-in-depth for non-standard
// ERC-20s that do not zero the allowance on exact transferFrom).
IERC20(tokenAddress).forceApprove(pool, 0);
IERC20(usdc).forceApprove(pool, 0);
```

Present at the audited baseline too, at `5197494:…/EXNIHILOFactory.sol` **lines 242-243**. The
47-line factory diff this round does not touch them (it is the `createMarket` signature shrink,
the constructor zero-checks, and the fee-comment update). Same class of error as NM-001: R1
carried a finding that its own baseline had already fixed.

`PreMarket.buyout` mirrors the pattern correctly at `PreMarket.sol:523-524`.

### PU-002 (4.7) — closed by the same evidence as NM-001.

---

## Part 4 — Initialization safety without proxies

The coordinator asked whether any instance is exploitable between deployment and being
funded/wired. Three windows exist. All three are closed.

### `PreMarket` — reserves recorded in the constructor, funded after it returns

`PreMarketFactory.createPreMarket` deploys at `L133-150` with `tokenReserve`/`quoteReserve`
already written (`PreMarket.sol:329-330`), then funds at `L154-155`. Between those points the
premarket claims reserves it does not hold. Both `p.token` and `p.quote` are **fully
attacker-chosen ERC-20s**, so a malicious `transferFrom` can reenter mid-window.
`createPreMarket` is `nonReentrant`, but that only protects the factory — the callback can call
the freshly-deployed `PreMarket` directly, which has its own separate guard.

I traced every reachable target and the window is closed by `_pullExactTo`
(`PreMarketFactory.sol:176-182`):

```solidity
uint256 balanceBefore = IERC20(asset).balanceOf(to);
IERC20(asset).safeTransferFrom(from, to, amount);
if (IERC20(asset).balanceOf(to) - balanceBefore != amount) revert FeeOnTransferNotSupported();
```

Every state-changing entry point on `PreMarket` moves *both* assets — `swap` pulls one and sends
the other (`L446-447`), `buyout` sends the whole quote reserve and then hands token+USDC to
`createMarket` (`L508-519`). So any reentrant call necessarily changes the balance of the asset
currently being pulled, the exact-delta assertion fails, and the entire `createPreMarket`
reverts. The fee-on-transfer guard doubles as a reentrancy detector here.

Belt and braces: during the *first* pull (token, `L154`) the premarket holds **zero quote**, so
both `swap(tokenToQuote=true)` and `buyout` revert on the outbound quote transfer before
reaching anything else. And every asset in the window belongs to the seeder — there is no
third-party value present to steal. **Clean.**

### `LockedLpVault` — the unfunded state at `isFunded()` (`L330`)

Analysed above under PU-006. `harvest()` reverts through the pool's `onlyLpHolder`; the claim
paths are role-gated to constructor-set addresses; nothing is front-runnable. **Clean, with the
consumption caveat recorded as PU-006.**

### `PreMarket` → vault → NFT

`PreMarket.buyout` deploys the vault (`L531-538`) and transfers the LP NFT into it (`L543`) in
the **same transaction** as `createMarket` (`L515`). There is no block in which the LP NFT sits
transferable, exactly as the header claims (`L67-71`, `L528-529`). I also checked the two
constructor-consistency hazards that would brick a launch at buyout time — the worst possible
place, since `PreMarket` has no refund or expiry path:

- `lpOwner == address(0)` would revert `LockedLpVault`'s `L172`. Blocked earlier, at seed time,
  by `PreMarket.sol:307`.
- `integrator == address(0)` with non-zero bps would revert `LockedLpVault`'s `L174`.
  `PreMarket.sol:537` passes `integrator == address(0) ? 0 : INTEGRATOR_SHARE_BPS`, which
  matches exactly.

Both consistent. This matches the design note at `PreMarket.sol:107-109` ("Market parameters are
validated at seed time, not at buyout"). **Clean.**

---

## Part 5 — The real upgrade path: redeployment

Per SCOPE.md, mainnet runs the **baseline** contracts (deployed at `c72f6a7`) and this tree is a
pending redeploy. I analysed that migration as an upgrade.

### Do old and new pools coexist under one factory? — **No.**

Each `EXNIHILOFactory` owns its registry: `isPool` (`L98`) and `allPools` (`L101`), written only
by `createMarket` (`L254-255`). There is no import, adopt, or migrate function anywhere.
`deployMainnet.ts` deploys a complete fresh set — PositionNFT (L110), PoolDeployer (L118),
LpNFT (L132), Factory (L139), Router (L169) — and writes `pools: {}` (L202). The new factory
starts at `allPools.length == 0`, which is also what makes its LP-NFT-id prediction
(`EXNIHILOFactory.sol:224`, `lpNftId = allPools.length`) correct against a fresh `LpNFT` whose
`_nextTokenId` also starts at 0.

A shared PositionNFT across both generations is impossible by construction:
`PositionNFT.initFactory` is once-only (`L127`, `FactoryAlreadySet`), and `factory` is a single
address consulted by `isPool` at mint. A second factory's pools would fail `isPool` on the first
factory. The script's step 4 therefore *requires* a fresh PositionNFT, and it deploys one.

### Can the site, router or indexer address an old pool? — **The site cannot. The indexer will, wrongly (PU-004).**

- **Site: no.** `LongShortPanel.tsx:49-70` and `LpPanel.tsx:40-53` request
  `currentMaxPositionBps`, `createdAt` and `currentPositionDuration` — none of which exist on a
  baseline pool. (The local JS variables named `positionDuration` in both files are just bindings
  to the `currentPositionDuration` result; they are not stale references. There are **no** stale
  references to `setPositionCaps`, `maxPositionUsd`, `maxPositionBps` or `defaultSwapFeeBps`
  anywhere in `packages/site/src`.) The site is written for the new ABI only.
- **Router: no coupling.** `EXNIHILORouter`'s diff this round is a single comment line. It takes
  `factory` and `usdc` as constructor immutables and is redeployed fresh (`deployMainnet.ts:169`).
  It cannot reach the old factory's pools because it never held them.
- **Indexer: yes, and that is the bug** — PU-004.

### Are the old pools orphaned? — From the UI, yes. From the chain, no.

Worth stating precisely, because "orphaned" reads like "funds stuck". After the redeploy the old
factory, old PositionNFT, old LpNFT and every old pool keep functioning exactly as before. LP NFT
holders can still call `removeLiquidity`, `claimFees` and `closePool` directly on the old pool
contracts; position holders can still close and claim. What disappears is the *interface*:
`mainnetAddresses.json` is overwritten (L210-211), so the site stops rendering them, and there is
no migration or notice path for existing LPs. That is an operations and communications problem,
not a solvency one.

The one asymmetry worth flagging to the coordinator: the emergency `deployer` role
(`EXNIHILOFactory.sol:93`, `setDeployer` at `L273`) is per-factory, and `closePool`
(`EXNIHILOPool.sol:501-515`) reads `factory.deployer()` live. So whoever holds the role on the
*old* factory keeps the ability to force-close old pools after the redeploy. That is the intended
emergency semantics, and it is the closest thing to an admin lever in the system — but it can
only wind a pool *down* toward LP withdrawal, never redirect value.

### Deployment wiring is fail-closed

I checked the two ways a redeploy could silently mis-wire, since immutables make both permanent:

- Factory pointed at a **foreign LpNFT**: `EXNIHILOFactory`'s constructor checks only non-zero
  (`L140`). But `LpNFT.mint` is `onlyFactory` against its own immutable (`LpNFT.sol:69`), so
  every `createMarket` would revert. `deployMainnet.ts` catches it earlier anyway, asserting both
  the CREATE nonce prediction (L152-157) and `lpNFT.factory() == factoryAddress` (L158-161).
- Factory pointed at an **already-initialized PositionNFT**: `initFactory` reverts
  `FactoryAlreadySet` and the script aborts at step 4 — before step 7 writes
  `mainnetAddresses.json`, so no bad address book is produced. The already-deployed factory is
  wasted gas, not a hazard.

Both fail loudly and neither can lose funds.

---

## What I checked and found clean

So the next round knows what this pass actually covered:

- **All five proxy vulnerability classes** — structurally inapplicable; re-derived from scratch,
  not carried. Confirmed at source, bytecode-pattern and dependency-manifest level.
- **All three new contracts** for hidden proxy/clone/initializer surface — none. `PreMarket`,
  `PreMarketFactory` and `LockedLpVault` are constructor-initialized with immutables throughout;
  the only mutable roles are `LockedLpVault.lp` / `integrator`, each transferable solely by its
  own current holder (`L291-309`), which is a claim destination and not an upgrade lever.
- **The `PreMarket` seeding window** — reentrancy-traced through an attacker-controlled `token`
  *and* `quote`, against `swap` and `buyout`; closed by the exact-balance-delta assertion.
- **The `LockedLpVault` unfunded state** — enumerated every callable function; `harvest` is
  blocked by the pool's `onlyLpHolder`, claims are role-gated, `pending()` over-reports but is a
  view.
- **Constructor-consistency between `PreMarket` and `LockedLpVault`** (`lpOwner`, `integrator`,
  `integratorBps`) — no buyout-time brick, which matters because `PreMarket` has no refund path.
- **`PositionNFT.initFactory`** — once-only, deployer-gated, zero-gated; mint correctly gated on
  `FactoryNotSet` first.
- **`EXNIHILOFactory` constructor zero-checks** — all five present and new this round (`L139-143`).
- **`swapFeeBps`** — survives the immutable→constant change with its getter intact
  (`public constant`, `EXNIHILOPool.sol:196`), so ABI consumers of that one name do not break.
- **`packages/abis/`** — correctly regenerated for both the removals and the additions.
- **Whole-workspace grep for the four removed names** — the only live consumers are the two
  broken blockchain scripts (`verifyMainnetPools.ts`, `verifyPools.ts`) and the stale
  `packages/blockchain/abis/` dump. Site, indexer and shared ABIs are clean.

### Not covered by this pass

Pool economics, the position cap and duration ramps, the settlement guard, the removed
`KEEPER_BOUNTY`, fee-split accounting, and the `PreMarket` Dutch-auction pricing are all out of
scope here — they belong to the state-invariant, semantic-guard and nemesis passes. I looked at
`PreMarket.buyout` and `LockedLpVault._harvest` only for initialization-order and
deployment-wiring properties, not for whether their arithmetic is right.

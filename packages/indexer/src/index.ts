import { ponder } from "ponder:registry";
import {
  position,
  lpOwnership,
  priceSnapshot,
  poolMetrics,
  protocolMetrics,
  userActivity,
  dailyMetrics,
  dailyUser,
} from "ponder:schema";
import { exnihiloPoolAbi, positionNFTAbi, lpNFTAbi } from "@exnihilio/abis";
import { POSITION_NFT_ADDRESS, LP_NFT_ADDRESS, ZERO_ADDR } from "./chain.js";

function dayTimestamp(ts: bigint): bigint {
  return (ts / 86400n) * 86400n;
}

/** Fixed-point base of the funding indices. Mirrors EXNIHILOPool.RAY. */
const RAY = 10n ** 27n;

// ── Pool state ──────────────────────────────────────────────────────────────

interface PoolState {
  backedAirToken: bigint;
  backedAirUsd: bigint;
  longPrice: bigint;
  shortPrice: bigint;
  lpLifetime: bigint;
  protocolLifetime: bigint;
  /**
   * Funding indices as PROJECTED to the current block, not as last written to
   * storage. The pool accrues funding lazily — the stored index is stale by
   * however long the pool has been quiet — so a consumer diffing stored indices
   * would attribute a quiet week's funding to whichever trade happened to end
   * it. `indexerState` projects for exactly this reason.
   */
  fundingIndexLong: bigint;
  fundingIndexShort: bigint;
  /** Per-second funding rate in RAY, including any wind-down multiplier. */
  fundingRateLong: bigint;
  fundingRateShort: bigint;
}

/**
 * One eth_call for everything this indexer needs from a pool. `indexerState()`
 * bundles it contract-side, which, unlike Multicall3, also works on a bare
 * Hardhat node.
 */
async function readPoolState(
  context: any,
  pool: `0x${string}`,
): Promise<PoolState> {
  const [
    backedAirToken,
    backedAirUsd,
    longPrice,
    shortPrice,
    lpLifetime,
    protocolLifetime,
    fundingIndexLong,
    fundingIndexShort,
    fundingRateLong,
    fundingRateShort,
  ] = (await context.client.readContract({
    abi: exnihiloPoolAbi,
    address: pool,
    functionName: "indexerState",
  })) as [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];

  return {
    backedAirToken, backedAirUsd, longPrice, shortPrice, lpLifetime, protocolLifetime,
    fundingIndexLong, fundingIndexShort, fundingRateLong, fundingRateShort,
  };
}

// ── Fee accrual ─────────────────────────────────────────────────────────────

interface FeeDelta {
  lpLifetime: bigint;
  protocolLifetime: bigint;
  lpDelta: bigint;
  protocolDelta: bigint;
  totalDelta: bigint;
}

/**
 * Turns the pool's lifetime fee accrual into the change since the last event
 * indexed for that pool.
 *
 * The split is deliberately NOT derived from the 4%/1% bps constants: the pool
 * routes the whole impact fee to LPs (`_openFees`) and takes a separate close
 * fee on surplus for the protocol, so the ratio moves with crowding and depth.
 * Reading the accumulators is exact for every fee path, including ones added
 * later.
 *
 * Funding is NOT in here and must not be looked for here. It never becomes a
 * claimable fee — the released collateral moves straight into the backed
 * reserves — so it touches neither accumulator. The FundingAccrued handler is
 * the only record of it.
 *
 * `accumulated + paidTotal` is monotonic — collecting fees zeroes the former
 * and adds the same amount to the latter — so the delta is never negative.
 */
async function syncFees(
  context: any,
  pool: `0x${string}`,
  state: PoolState,
): Promise<FeeDelta> {
  const { lpLifetime, protocolLifetime } = state;

  const prev = (await context.db.find(poolMetrics, { address: pool })) as
    | { lpFees: bigint; protocolFees: bigint }
    | null;
  const lpDelta = lpLifetime - (prev?.lpFees ?? 0n);
  const protocolDelta = protocolLifetime - (prev?.protocolFees ?? 0n);

  return {
    lpLifetime,
    protocolLifetime,
    lpDelta,
    protocolDelta,
    totalDelta: lpDelta + protocolDelta,
  };
}

// ── Snapshot prices ─────────────────────────────────────────────────────────

async function snapshotPrices(
  context: any,
  poolAddress: `0x${string}`,
  event: any,
  eventType: string,
  state: PoolState,
) {
  const {
    backedAirToken, backedAirUsd,
    longPrice: longPriceVal, shortPrice: shortPriceVal,
    fundingIndexLong, fundingIndexShort,
  } = state;

  const spotPrice = backedAirToken > 0n
    ? (backedAirUsd * 10n ** 18n) / backedAirToken
    : 0n;

  await context.db.insert(priceSnapshot).values({
    id: `${poolAddress}-${event.block.number}-${event.log.logIndex}`,
    pool: poolAddress,
    blockNumber: BigInt(event.block.number),
    timestamp: BigInt(event.block.timestamp),
    backedAirToken,
    backedAirUsd,
    spotPrice,
    longPrice: longPriceVal,
    shortPrice: shortPriceVal,
    fundingIndexLong,
    fundingIndexShort,
    eventType,
  });
}

// ── Update pool metrics ─────────────────────────────────────────────────────

async function updatePoolMetrics(
  context: any,
  pool: `0x${string}`,
  timestamp: bigint,
  fees: FeeDelta,
  updates: {
    positionVolume?: bigint;
    longCount?: number;
    shortCount?: number;
    closeCount?: number;
    totalPayout?: bigint;
  } = {},
  state?: PoolState,
) {
  await context.db
    .insert(poolMetrics)
    .values({
      address: pool,
      positionVolume: updates.positionVolume ?? 0n,
      // Fee columns are absolute lifetime values, not running sums.
      totalFees: fees.lpLifetime + fees.protocolLifetime,
      lpFees: fees.lpLifetime,
      protocolFees: fees.protocolLifetime,
      longCount: updates.longCount ?? 0,
      shortCount: updates.shortCount ?? 0,
      closeCount: updates.closeCount ?? 0,
      totalPayout: updates.totalPayout ?? 0n,
      // Index columns are absolute too — the pool's current value, not a sum.
      // The released totals below ARE sums, and are written only by the
      // FundingAccrued handler, which is the only place that knows the delta.
      fundingIndexLong: state?.fundingIndexLong ?? RAY,
      fundingIndexShort: state?.fundingIndexShort ?? RAY,
      fundingReleasedLong: 0n,
      fundingReleasedShort: 0n,
      fundingDebtCancelledLong: 0n,
      fundingDebtCancelledShort: 0n,
      fundingRateLong: state?.fundingRateLong ?? 0n,
      fundingRateShort: state?.fundingRateShort ?? 0n,
      lastUpdated: timestamp,
    })
    .onConflictDoUpdate((row: any) => ({
      positionVolume: row.positionVolume + (updates.positionVolume ?? 0n),
      totalFees: fees.lpLifetime + fees.protocolLifetime,
      lpFees: fees.lpLifetime,
      protocolFees: fees.protocolLifetime,
      longCount: row.longCount + (updates.longCount ?? 0),
      shortCount: row.shortCount + (updates.shortCount ?? 0),
      closeCount: row.closeCount + (updates.closeCount ?? 0),
      totalPayout: row.totalPayout + (updates.totalPayout ?? 0n),
      fundingIndexLong: state?.fundingIndexLong ?? row.fundingIndexLong,
      fundingIndexShort: state?.fundingIndexShort ?? row.fundingIndexShort,
      fundingRateLong: state?.fundingRateLong ?? row.fundingRateLong,
      fundingRateShort: state?.fundingRateShort ?? row.fundingRateShort,
      lastUpdated: timestamp,
    }));
}

// ── Update protocol metrics ─────────────────────────────────────────────────

async function updateProtocolMetrics(
  context: any,
  timestamp: bigint,
  updates: {
    positionVolume?: bigint;
    fees?: bigint;
    lpFees?: bigint;
    protocolFees?: bigint;
    positions?: number;
    closes?: number;
    totalPayout?: bigint;
    newPool?: boolean;
  },
) {
  await context.db
    .insert(protocolMetrics)
    .values({
      id: "global",
      totalPositionVolume: updates.positionVolume ?? 0n,
      totalFees: updates.fees ?? 0n,
      totalLpFees: updates.lpFees ?? 0n,
      totalProtocolFees: updates.protocolFees ?? 0n,
      totalPositions: updates.positions ?? 0,
      totalCloses: updates.closes ?? 0,
      totalPayout: updates.totalPayout ?? 0n,
      poolCount: updates.newPool ? 1 : 0,
      lastUpdated: timestamp,
    })
    .onConflictDoUpdate((row: any) => ({
      totalPositionVolume: row.totalPositionVolume + (updates.positionVolume ?? 0n),
      totalFees: row.totalFees + (updates.fees ?? 0n),
      totalLpFees: row.totalLpFees + (updates.lpFees ?? 0n),
      totalProtocolFees: row.totalProtocolFees + (updates.protocolFees ?? 0n),
      totalPositions: row.totalPositions + (updates.positions ?? 0),
      totalCloses: row.totalCloses + (updates.closes ?? 0),
      totalPayout: row.totalPayout + (updates.totalPayout ?? 0n),
      poolCount: row.poolCount + (updates.newPool ? 1 : 0),
      lastUpdated: timestamp,
    }));
}

// ── Track user activity ─────────────────────────────────────────────────────

async function trackUser(
  context: any,
  user: `0x${string}`,
  timestamp: bigint,
  updates: {
    longCount?: number;
    shortCount?: number;
    closeCount?: number;
    volume?: bigint;
    feesPaid?: bigint;
    totalPayout?: bigint;
  },
) {
  await context.db
    .insert(userActivity)
    .values({
      address: user,
      firstSeen: timestamp,
      lastSeen: timestamp,
      longCount: updates.longCount ?? 0,
      shortCount: updates.shortCount ?? 0,
      closeCount: updates.closeCount ?? 0,
      totalVolume: updates.volume ?? 0n,
      totalFeesPaid: updates.feesPaid ?? 0n,
      totalPayout: updates.totalPayout ?? 0n,
    })
    .onConflictDoUpdate((row: any) => ({
      lastSeen: timestamp,
      longCount: row.longCount + (updates.longCount ?? 0),
      shortCount: row.shortCount + (updates.shortCount ?? 0),
      closeCount: row.closeCount + (updates.closeCount ?? 0),
      totalVolume: row.totalVolume + (updates.volume ?? 0n),
      totalFeesPaid: row.totalFeesPaid + (updates.feesPaid ?? 0n),
      totalPayout: row.totalPayout + (updates.totalPayout ?? 0n),
    }));
}

// ── Update daily metrics ────────────────────────────────────────────────────

/** Records `user` against `scope` for `day`. Returns true only the first time. */
async function markDailyUser(
  context: any,
  scope: string,
  day: bigint,
  user: `0x${string}`,
): Promise<boolean> {
  const id = `${scope}-${day}-${user}`;
  const seen = await context.db.find(dailyUser, { id });
  if (seen) return false;
  await context.db.insert(dailyUser).values({ id, scope, day, user });
  return true;
}

async function updateDaily(
  context: any,
  pool: `0x${string}`,
  timestamp: bigint,
  user: `0x${string}`,
  amounts: {
    volume?: bigint;
    fees?: bigint;
    lpFees?: bigint;
    positions?: number;
    closes?: number;
  },
) {
  const day = dayTimestamp(timestamp);
  const volume = amounts.volume ?? 0n;
  const fees = amounts.fees ?? 0n;
  const lpFees = amounts.lpFees ?? 0n;
  const positions = amounts.positions ?? 0;
  const closes = amounts.closes ?? 0;

  // uniqueUsers must count distinct addresses, so it only moves when this
  // address hasn't been seen in this scope today.
  const newForPool = await markDailyUser(context, pool, day, user);
  const newForGlobal = await markDailyUser(context, "global", day, user);

  const rows: { id: string; poolField: `0x${string}`; isNew: boolean }[] = [
    { id: `${pool}-${day}`, poolField: pool, isNew: newForPool },
    { id: `global-${day}`, poolField: ZERO_ADDR, isNew: newForGlobal },
  ];

  for (const { id, poolField, isNew } of rows) {
    await context.db
      .insert(dailyMetrics)
      .values({
        id,
        pool: poolField,
        dayTimestamp: day,
        volume,
        fees,
        lpFees,
        positionCount: positions,
        closeCount: closes,
        uniqueUsers: isNew ? 1 : 0,
      })
      .onConflictDoUpdate((row: any) => ({
        volume: row.volume + volume,
        fees: row.fees + fees,
        lpFees: row.lpFees + lpFees,
        positionCount: row.positionCount + positions,
        closeCount: row.closeCount + closes,
        uniqueUsers: row.uniqueUsers + (isNew ? 1 : 0),
      }));
  }
}

// ── Factory: new market ─────────────────────────────────────────────────────

ponder.on("EXNIHILOFactory:MarketCreated", async ({ event, context }) => {
  const ts = BigInt(event.block.timestamp);
  const { pool, creator, lpNftId } = event.args;

  // Track LP ownership.
  //
  // createMarket mints the LP NFT to the factory and then transfers it to the
  // caller, so LpNFT:Transfer (factory → creator) is emitted earlier in this
  // same transaction than MarketCreated. That handler has already written this
  // row, so a plain insert would collide on the primary key — upsert instead.
  await context.db
    .insert(lpOwnership)
    .values({ nftId: lpNftId, pool, owner: creator })
    .onConflictDoUpdate(() => ({ pool, owner: creator }));

  await updateProtocolMetrics(context, ts, { newPool: true });
  await trackUser(context, creator, ts, {});
});

// ── Pool: position opened ───────────────────────────────────────────────────

ponder.on("EXNIHILOPool:PositionOpened", async ({ event, context }) => {
  const pool = event.log.address;
  const ts = BigInt(event.block.timestamp);
  const { nftId, holder, isLong } = event.args;

  const state = await readPoolState(context, pool);
  const fees = await syncFees(context, pool, state);
  await snapshotPrices(context, pool, event, "positionOpened", state);

  // Position data lives on the NFT. The read is at the end of this block, so a
  // position opened and closed within the same block is already burned and the
  // call reverts — record what the event alone tells us rather than crashing.
  let posData: any = null;
  try {
    posData = await context.client.readContract({
      abi: positionNFTAbi,
      address: POSITION_NFT_ADDRESS,
      functionName: "getPosition",
      args: [nftId],
    });
  } catch {
    posData = null;
  }

  if (posData) {
    await context.db.insert(position).values({
      nftId,
      pool,
      holder,
      isLong,
      lockedAmountAtOpen: posData.lockedAmountAtOpen,
      usdcIn: posData.usdcIn,
      airUsdMinted: posData.airUsdMinted,
      airTokenMinted: posData.airTokenMinted,
      feesPaid: posData.feesPaid,
      openedAt: posData.openedAt,
      fundingIndexAtOpen: posData.fundingIndexAtOpen,
      status: "open",
      payout: 0n,
      closedAt: 0n,
    });
  }

  const volume = posData?.usdcIn ?? 0n;
  const feesPaidByHolder = posData?.feesPaid ?? fees.totalDelta;

  await updatePoolMetrics(context, pool, ts, fees, {
    positionVolume: volume,
    longCount: isLong ? 1 : 0,
    shortCount: isLong ? 0 : 1,
  }, state);

  await updateProtocolMetrics(context, ts, {
    positionVolume: volume,
    fees: fees.totalDelta,
    lpFees: fees.lpDelta,
    protocolFees: fees.protocolDelta,
    positions: 1,
  });

  await trackUser(context, holder, ts, {
    longCount: isLong ? 1 : 0,
    shortCount: isLong ? 0 : 1,
    volume,
    feesPaid: feesPaidByHolder,
  });

  await updateDaily(context, pool, ts, holder, {
    volume,
    fees: fees.totalDelta,
    lpFees: fees.lpDelta,
    positions: 1,
  });
});

// ── Pool: funding accrued ───────────────────────────────────────────────────
//
// Funding is not a fee: released collateral moves into the backed reserves and
// its debt is burned. So no fee columns and no trackUser; this records what
// separates funding from trading growth in the reserves. No price snapshot:
// the event that caused the accrual writes one.

ponder.on("EXNIHILOPool:FundingAccrued", async ({ event, context }) => {
  const pool = event.log.address;
  const ts = BigInt(event.block.timestamp);
  const { isLong, released, debtCancelled, newIndex } = event.args;

  // pokeFunding reaches this handler and no other, so without a read here the
  // rates keep whatever a trade last left behind — or zero, if this is the first
  // event for the pool — while lastUpdated below says the row is current. During
  // wind-down that gap is the whole 2^shift multiplier.
  const state = await readPoolState(context, pool);

  await context.db
    .insert(poolMetrics)
    .values({
      address: pool,
      positionVolume: 0n,
      totalFees: 0n,
      lpFees: 0n,
      protocolFees: 0n,
      longCount: 0,
      shortCount: 0,
      closeCount: 0,
      totalPayout: 0n,
      // The event is authoritative for the side that just accrued; the other
      // side comes from the same-block projection rather than a bare RAY.
      fundingIndexLong: isLong ? newIndex : state.fundingIndexLong,
      fundingIndexShort: isLong ? state.fundingIndexShort : newIndex,
      fundingReleasedLong: isLong ? released : 0n,
      fundingReleasedShort: isLong ? 0n : released,
      fundingDebtCancelledLong: isLong ? debtCancelled : 0n,
      fundingDebtCancelledShort: isLong ? 0n : debtCancelled,
      fundingRateLong: state.fundingRateLong,
      fundingRateShort: state.fundingRateShort,
      lastUpdated: ts,
    })
    .onConflictDoUpdate((row: any) => ({
      fundingIndexLong: isLong ? newIndex : state.fundingIndexLong,
      fundingIndexShort: isLong ? state.fundingIndexShort : newIndex,
      fundingRateLong: state.fundingRateLong,
      fundingRateShort: state.fundingRateShort,
      // Separate columns because they are in different units — airToken on the
      // long side, airUsd on the short. Summing them is always a bug.
      fundingReleasedLong: row.fundingReleasedLong + (isLong ? released : 0n),
      fundingReleasedShort: row.fundingReleasedShort + (isLong ? 0n : released),
      fundingDebtCancelledLong: row.fundingDebtCancelledLong + (isLong ? debtCancelled : 0n),
      fundingDebtCancelledShort: row.fundingDebtCancelledShort + (isLong ? 0n : debtCancelled),
      lastUpdated: ts,
    }));
});

// ── Pool: position closed (by holder) ───────────────────────────────────────

ponder.on("EXNIHILOPool:PositionClosed", async ({ event, context }) => {
  const pool = event.log.address;
  const ts = BigInt(event.block.timestamp);
  const { nftId, holder, payout } = event.args;

  // Closing takes a fee on surplus (CLOSE_FEE_BPS → protocol), so fees must be
  // synced here too — the old handler recorded none.
  const state = await readPoolState(context, pool);
  const fees = await syncFees(context, pool, state);

  await context.db.update(position, { nftId }).set({
    status: "closed",
    payout,
    closedAt: ts,
  });

  await snapshotPrices(context, pool, event, "positionClosed", state);

  await updatePoolMetrics(context, pool, ts, fees, {
    closeCount: 1,
    totalPayout: payout,
  }, state);

  await updateProtocolMetrics(context, ts, {
    closes: 1,
    totalPayout: payout,
    fees: fees.totalDelta,
    lpFees: fees.lpDelta,
    protocolFees: fees.protocolDelta,
  });

  await trackUser(context, holder, ts, { closeCount: 1, totalPayout: payout });

  await updateDaily(context, pool, ts, holder, {
    fees: fees.totalDelta,
    lpFees: fees.lpDelta,
    closes: 1,
  });
});

// ── Pool: dust position swept (by anyone) ───────────────────────────────────

ponder.on("EXNIHILOPool:PositionSwept", async ({ event, context }) => {
  const pool = event.log.address;
  const ts = BigInt(event.block.timestamp);
  const { nftId, caller, payout } = event.args;

  const existing = await context.db.find(position, { nftId });

  // `caller` is whoever cleared the husk — in practice the LP, whose own curve
  // a dead position degrades. Any residual payout is credited to the holder
  // (`_creditPayout(holder, ...)`), so the economics belong to them, not the
  // caller. Sweepers are intentionally not tracked as users here: they would
  // otherwise inflate the user counts and absorb other people's payouts.
  const beneficiary = existing?.holder ?? caller;

  const state = await readPoolState(context, pool);
  const fees = await syncFees(context, pool, state);

  if (existing) {
    await context.db.update(position, { nftId }).set({
      status: "swept",
      payout,
      closedAt: ts,
    });
  }

  await snapshotPrices(context, pool, event, "positionSwept", state);

  await updatePoolMetrics(context, pool, ts, fees, {
    closeCount: 1,
    totalPayout: payout,
  }, state);

  await updateProtocolMetrics(context, ts, {
    closes: 1,
    totalPayout: payout,
    fees: fees.totalDelta,
    lpFees: fees.lpDelta,
    protocolFees: fees.protocolDelta,
  });

  await trackUser(context, beneficiary, ts, { closeCount: 1, totalPayout: payout });

  await updateDaily(context, pool, ts, beneficiary, {
    fees: fees.totalDelta,
    lpFees: fees.lpDelta,
    closes: 1,
  });
});

// ── Pool: pool closed ───────────────────────────────────────────────────────

ponder.on("EXNIHILOPool:PoolClosed", async ({ event, context }) => {
  const pool = event.log.address;
  const ts = BigInt(event.block.timestamp);

  const state = await readPoolState(context, pool);
  const fees = await syncFees(context, pool, state);

  await snapshotPrices(context, pool, event, "poolClosed", state);
  await updatePoolMetrics(context, pool, ts, fees, {}, state);
  await updateProtocolMetrics(context, ts, {
    fees: fees.totalDelta,
    lpFees: fees.lpDelta,
    protocolFees: fees.protocolDelta,
  });
  await trackUser(context, event.args.closedBy, ts, {});
});

// ── PositionNFT: transfers (ownership changes only) ─────────────────────────

ponder.on("PositionNFT:Transfer", async ({ event, context }) => {
  const { from, to, tokenId } = event.args;

  // Skip mints (handled by PositionOpened) and burns (handled by PositionClosed)
  if (from === ZERO_ADDR || to === ZERO_ADDR) return;

  const existing = await context.db.find(position, { nftId: tokenId });
  if (!existing) return;

  await context.db.update(position, { nftId: tokenId }).set({
    holder: to,
  });
});

// ── LpNFT: transfers (ownership changes only) ──────────────────────────────

ponder.on("LpNFT:Transfer", async ({ event, context }) => {
  const { from, to, tokenId } = event.args;

  // Skip mints (handled by MarketCreated) and burns
  if (from === ZERO_ADDR || to === ZERO_ADDR) return;

  // Read pool from contract in case record doesn't exist yet
  const pool = await context.client.readContract({
    abi: lpNFTAbi,
    address: LP_NFT_ADDRESS,
    functionName: "poolOf",
    args: [tokenId],
  });

  await context.db
    .insert(lpOwnership)
    .values({ nftId: tokenId, pool, owner: to })
    .onConflictDoUpdate(() => ({ owner: to }));
});

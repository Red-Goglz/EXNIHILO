import { ponder } from "ponder:registry";
import { priceSnapshot, poolSummary } from "ponder:schema";
import { exnihiloPoolAbi } from "../../abis/EXNIHILOPool.js";

// ── Helper: snapshot prices after any pool state change ──────────────────────

async function snapshotPrices(
  context: any,
  poolAddress: `0x${string}`,
  event: any,
  eventType: string
) {
  const [backedAirToken, backedAirUsd, longPriceVal, shortPriceVal] =
    await Promise.all([
      context.client.readContract({
        abi: exnihiloPoolAbi,
        address: poolAddress,
        functionName: "backedAirToken",
      }),
      context.client.readContract({
        abi: exnihiloPoolAbi,
        address: poolAddress,
        functionName: "backedAirUsd",
      }),
      context.client.readContract({
        abi: exnihiloPoolAbi,
        address: poolAddress,
        functionName: "longPrice",
      }),
      context.client.readContract({
        abi: exnihiloPoolAbi,
        address: poolAddress,
        functionName: "shortPrice",
      }),
    ]);

  const spotPrice =
    backedAirToken > 0n
      ? (backedAirUsd * 10n ** 18n) / backedAirToken
      : 0n;

  const id = `${poolAddress}-${event.block.number}-${event.log.logIndex}`;

  await context.db.insert(priceSnapshot).values({
    id,
    pool: poolAddress,
    blockNumber: BigInt(event.block.number),
    timestamp: BigInt(event.block.timestamp),
    backedAirToken,
    backedAirUsd,
    spotPrice,
    longPrice: longPriceVal,
    shortPrice: shortPriceVal,
    eventType,
  });

  // Upsert pool summary
  await context.db
    .insert(poolSummary)
    .values({
      address: poolAddress,
      eventCount: 1,
      lastUpdated: BigInt(event.block.timestamp),
    })
    .onConflictDoUpdate((row: any) => ({
      eventCount: row.eventCount + 1,
      lastUpdated: BigInt(event.block.timestamp),
    }));
}

// ── Index every price-moving event ───────────────────────────────────────────

ponder.on("EXNIHILOPool:Swap", async ({ event, context }) => {
  await snapshotPrices(context, event.log.address, event, "swap");
});

ponder.on("EXNIHILOPool:LongOpened", async ({ event, context }) => {
  await snapshotPrices(context, event.log.address, event, "longOpened");
});

ponder.on("EXNIHILOPool:LongClosed", async ({ event, context }) => {
  await snapshotPrices(context, event.log.address, event, "longClosed");
});

ponder.on("EXNIHILOPool:ShortOpened", async ({ event, context }) => {
  await snapshotPrices(context, event.log.address, event, "shortOpened");
});

ponder.on("EXNIHILOPool:ShortClosed", async ({ event, context }) => {
  await snapshotPrices(context, event.log.address, event, "shortClosed");
});

ponder.on("EXNIHILOPool:LiquidityAdded", async ({ event, context }) => {
  await snapshotPrices(context, event.log.address, event, "liquidityAdded");
});

ponder.on("EXNIHILOPool:LiquidityRemoved", async ({ event, context }) => {
  await snapshotPrices(context, event.log.address, event, "liquidityRemoved");
});

ponder.on("EXNIHILOPool:LongRealized", async ({ event, context }) => {
  await snapshotPrices(context, event.log.address, event, "longRealized");
});

ponder.on("EXNIHILOPool:ShortRealized", async ({ event, context }) => {
  await snapshotPrices(context, event.log.address, event, "shortRealized");
});

ponder.on("EXNIHILOPool:PositionForceRealized", async ({ event, context }) => {
  await snapshotPrices(context, event.log.address, event, "forceRealized");
});

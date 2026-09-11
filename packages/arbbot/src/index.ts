/**
 * Entry point. Polls the factory registry, scans every pool for a profitable
 * round trip against the wider Avalanche market, and prints what it finds.
 *
 * This process is READ-ONLY by construction: it holds no private key, imports
 * no wallet client, and has no code path that builds a transaction. Executing
 * the arb is deliberately left for a later step — see the README for what has
 * to be true before that is safe.
 */

import { CONFIG } from "./config.ts";
import { snapshotPools } from "./pools.ts";
import { estimateGasCostUsdc, scanPool, isOpportunity, type ScanResult } from "./arb.ts";
import { providerNames } from "./quotes/index.ts";
import {
  printBanner,
  printCycleFooter,
  printCycleHeader,
  printOpportunity,
  printSkip,
} from "./report.ts";
import { C, sleep, ts } from "./util.ts";

async function cycle() {
  const started = Date.now();

  const pools = await snapshotPools();
  if (pools.length === 0) {
    console.log(`${C.gray}[${ts()}] factory has no pools yet${C.reset}`);
    return;
  }

  const gasUsdc = await estimateGasCostUsdc();
  printCycleHeader(pools.length, gasUsdc);

  // Sequential by pool: the aggregators are keyless and shared, and the
  // in-module limiter already parallelises the individual quote calls.
  const results: ScanResult[] = [];
  for (const pool of pools) {
    try {
      const r = await scanPool(pool, gasUsdc);
      results.push(r);
      if (isOpportunity(r)) printOpportunity(r);
      else if (CONFIG.verbose) printSkip(r);
    } catch (err) {
      console.error(
        `${C.red}   ! ${pool.tokenSymbol} scan failed:${C.reset}`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  printCycleFooter(results, Date.now() - started);
}

async function main() {
  printBanner(providerNames);

  if (CONFIG.once) {
    await cycle();
    return;
  }

  for (;;) {
    try {
      await cycle();
    } catch (err) {
      console.error(
        `${C.red}[${ts()}] cycle failed:${C.reset}`,
        err instanceof Error ? err.message : err,
      );
    }
    await sleep(CONFIG.pollIntervalMs);
  }
}

process.on("SIGINT", () => {
  console.log(`\n${C.dim}stopped${C.reset}`);
  process.exit(0);
});

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

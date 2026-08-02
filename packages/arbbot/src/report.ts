/**
 * Console reporting. The bot's only output — it never signs anything.
 *
 * The detail printed here is deliberately what a human needs to decide whether
 * an opportunity is real: both legs with their amounts, the venue that would
 * fill the external side, the size the profit is conditional on, and the gas
 * assumption baked into it.
 */

import { formatUnits } from "viem";
import { C, fmt, usd, bps, ts } from "./util.ts";
import { CONFIG } from "./config.ts";
import { isOpportunity, type Opportunity, type ScanResult, type Skip } from "./arb.ts";

/**
 * Gas on Avalanche is routinely a fraction of a cent, which rounds to "$0.00"
 * at two decimals and reads like a broken estimate rather than a real number.
 */
function gasStr(amount: bigint): string {
  return usd(amount, amount > 0n && amount < 10_000n ? 5 : 2);
}

/**
 * Scale decimal places to the magnitude of the price. A fixed width either
 * wastes columns on a $2 token or prints "$0.00000100" for a micro-cap whose
 * real price is $0.00000111 — the same collapse that hid a live dislocation
 * behind a "+0.0 bps" gap.
 */
function priceStr(price: number, symbol: string): string {
  if (!Number.isFinite(price) || price <= 0) return `—/${symbol}`;
  const places = Math.max(2, Math.min(12, Math.ceil(-Math.log10(price)) + 4));
  return `$${price.toLocaleString("en-US", {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  })}/${symbol}`;
}

export function printOpportunity(o: Opportunity) {
  const p = o.pool;
  const dirLabel =
    o.direction === "POOL_CHEAP"
      ? `${C.green}POOL CHEAP${C.reset} — buy on EXNIHILO, sell on DEX`
      : `${C.magenta}POOL RICH${C.reset}  — buy on DEX, sell into EXNIHILO`;

  console.log(
    `\n${C.bold}${C.green}┏━ ARB OPPORTUNITY ━ ${p.tokenSymbol}${C.reset}  ${C.gray}${p.pool}${C.reset}`,
  );
  console.log(`${C.green}┃${C.reset} ${dirLabel}`);
  console.log(
    `${C.green}┃${C.reset} ${C.bold}net ${usd(o.profitUsdc)}${C.reset} on ${usd(
      o.sizeUsdc,
      0,
    )} notional  ${C.dim}(${bps(o.profitBps)} net, ${bps(o.grossBps)} gross)${C.reset}`,
  );
  console.log(`${C.green}┃${C.reset}`);
  console.log(
    `${C.green}┃${C.reset} pool mid  ${priceStr(o.poolMid, p.tokenSymbol)}   ` +
      `dex mid  ${priceStr(o.dexMid, p.tokenSymbol)}   ` +
      `gap ${o.gapBps >= 0 ? C.green : C.red}${bps(o.gapBps)}${C.reset}`,
  );

  const tokDec = p.tokenDecimals;
  if (o.direction === "POOL_CHEAP") {
    console.log(
      `${C.green}┃${C.reset} leg 1  EXNIHILO   ${usd(o.exnihiloLeg.amountIn)} USDC ` +
        `${C.dim}→${C.reset} ${fmt(o.exnihiloLeg.amountOut, tokDec)} ${p.tokenSymbol}`,
    );
    console.log(
      `${C.green}┃${C.reset} leg 2  ${o.dexProvider.padEnd(9)} ` +
        `${fmt(o.dexLeg.amountIn, tokDec)} ${p.tokenSymbol} ` +
        `${C.dim}→${C.reset} ${usd(o.dexLeg.amountOut)} USDC`,
    );
  } else {
    console.log(
      `${C.green}┃${C.reset} leg 1  ${o.dexProvider.padEnd(9)} ` +
        `${usd(o.dexLeg.amountIn)} USDC ` +
        `${C.dim}→${C.reset} ${fmt(o.dexLeg.amountOut, tokDec)} ${p.tokenSymbol}`,
    );
    console.log(
      `${C.green}┃${C.reset} leg 2  EXNIHILO   ${fmt(o.exnihiloLeg.amountIn, tokDec)} ` +
        `${p.tokenSymbol} ${C.dim}→${C.reset} ${usd(o.exnihiloLeg.amountOut)} USDC`,
    );
  }

  console.log(
    `${C.green}┃${C.reset} ${C.dim}route: ${o.dexRoute}${C.reset}`,
  );
  console.log(
    `${C.green}┃${C.reset} ${C.dim}costs: gas ${gasStr(o.gasUsdc)} · pool fee ${
      Number(p.swapFeeBps) / 100
    }% · slippage haircut ${CONFIG.slippageBps} bps${C.reset}`,
  );
  console.log(
    `${C.green}┃${C.reset} ${C.dim}pool reserves: ${usd(p.backedAirUsd, 0)} USDC / ${fmt(
      p.backedAirToken,
      tokDec,
      2,
    )} ${p.tokenSymbol}${p.isClosing ? `  ${C.yellow}[CLOSING]${C.reset}` : ""}${C.reset}`,
  );
  console.log(`${C.green}┗━${C.reset}`);
}

export function printSkip(s: Skip) {
  const gap = s.gapBps !== undefined ? ` gap ${bps(s.gapBps)}` : "";
  const prof =
    s.bestProfitUsdc !== undefined ? ` best ${usd(s.bestProfitUsdc)}` : "";
  console.log(
    `${C.gray}   · ${s.pool.tokenSymbol.padEnd(10)} ${s.reason}${gap}${prof}${C.reset}`,
  );
}

export function printCycleHeader(poolCount: number, gasUsdc: bigint) {
  console.log(
    `\n${C.cyan}[${ts()}]${C.reset} scanning ${C.bold}${poolCount}${C.reset} pools ` +
      `${C.dim}· gas/arb ≈ ${gasStr(gasUsdc)}${C.reset}`,
  );
}

export function printCycleFooter(results: ScanResult[], elapsedMs: number) {
  const opps = results.filter(isOpportunity);
  const total = opps.reduce((a, o) => a + o.profitUsdc, 0n);

  if (opps.length === 0) {
    console.log(
      `${C.gray}   no opportunities · ${results.length} pools · ${(
        elapsedMs / 1000
      ).toFixed(1)}s${C.reset}`,
    );
  } else {
    console.log(
      `\n${C.bold}${C.green}   ${opps.length} opportunit${
        opps.length === 1 ? "y" : "ies"
      } · ${usd(total)} combined${C.reset} ${C.dim}· ${(elapsedMs / 1000).toFixed(
        1,
      )}s${C.reset}`,
    );
  }
}

export function printBanner(providers: string[]) {
  console.log(`${C.bold}${C.cyan}EXNIHILO arb scanner${C.reset} ${C.dim}(detect only — no transactions are sent)${C.reset}`);
  console.log(
    `${C.dim}chain ${CONFIG.chainId} · factory ${CONFIG.factory}${C.reset}`,
  );
  console.log(
    `${C.dim}quotes: ${providers.join(" → ")} · min profit ${
      CONFIG.minProfitUsdc
    } USDC · min edge ${CONFIG.minEdgeBps} bps${C.reset}`,
  );
}

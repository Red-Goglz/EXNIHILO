import { useMemo, useState } from "react";
import type { ContractFunctionParameters } from "viem";
import { useReadContract, useReadContracts } from "wagmi";
import { exnihiloFactoryAbi, exnihiloPoolAbi, erc20Abi } from "@exnihilio/abis";
import { DEFAULT_CHAIN } from "../../lib/chains.ts";
import { ADDRESSES } from "../../contracts/addresses.ts";

/**
 * Live trade calculator for the landing page.
 *
 * Exists because the headline numbers are a function of pool depth, and pool
 * depth changes. Rather than hardcoding "$5 buys $100 of exposure" — which is
 * false whenever caps are tighter than the copy assumes — this reads each
 * pool's actual reserves and caps and shows what is genuinely openable *now*.
 * It scales on its own as liquidity is added; nobody has to remember to
 * update marketing copy.
 *
 * Two different standards of accuracy are deliberately mixed:
 *
 *   - The **fee** comes from `quoteOpenFee` on-chain. It is the number the
 *     user will actually be charged, it has a floor and an open-interest
 *     term, and `useOpenFee` documents why frontends must not re-derive it.
 *   - The **payoff** is simulated client-side in floating point. It is an
 *     estimate by nature (it assumes a price move with no other flow), so
 *     bigint exactness would imply a precision the model does not have. It is
 *     labelled as an estimate in the UI.
 */

const CHAIN_ID = DEFAULT_CHAIN.chain.id;
const FACTORY = ADDRESSES[CHAIN_ID].factory;
const CLOSE_FEE = 0.01; // 1% of surplus, CLOSE_FEE_BPS

const POOL_FIELDS = [
  "backedAirUsd",
  "backedAirToken",
  "airTokenSupply",
  "airUsdSupply",
  "swapFeeBps",
  "maxPositionBps",
  "maxPositionUsd",
  "positionDuration",
  "tokenDecimals",
  "token",
] as const;

interface PoolState {
  address: `0x${string}`;
  symbol: string;
  backedAirUsd: number;   // USDC
  backedAirToken: number; // token units
  airTokenSupply: number; // token units
  airUsdSupply: number;   // USDC
  swapFee: number;        // fraction
  maxPosition: number | null; // USDC, null = uncapped
  durationDays: number;
}

/** SWAP-1/2/3 constant-product output net of the pool's spot-value fee. */
function cpOut(amountIn: number, rIn: number, rOut: number, fee: number): number {
  if (amountIn <= 0 || rIn <= 0 || rOut <= 0) return 0;
  const raw = (amountIn * rOut) / (rIn + amountIn);
  const f = (amountIn * rOut * fee) / rIn;
  return raw <= f ? 0 : raw - f;
}

/**
 * Estimated USDC paid out when closing a long of `notional` after the token
 * price moves by factor `m`.
 *
 * Mirrors openLong → _priceClose → _settle: mint synthetic airUsd and swap it
 * through SWAP-2 for locked airToken, move the backed reserves along the
 * constant-product curve to the new price, then value the locked airToken
 * through SWAP-3 and subtract the synthetic debt. Returns the surplus net of
 * the 1% close fee — the trader receives the surplus only, never the notional
 * back, because the notional was never deposited.
 */
function simulateLong(p: PoolState, notional: number, m: number): number {
  const locked = cpOut(notional, p.airUsdSupply, p.backedAirToken, p.swapFee);
  if (locked <= 0) return 0;

  // State immediately after the open.
  const backedToken1 = p.backedAirToken - locked; // collateral locked out
  if (backedToken1 <= 0) return 0;

  // Price move, applied to the backed reserves along x*y=k. A move of factor m
  // scales the USD side by sqrt(m) and the token side by 1/sqrt(m).
  const r = Math.sqrt(m);
  const backedUsd2 = p.backedAirUsd * r;
  const backedToken2 = backedToken1 / r;

  // Supply counters move by the same deltas as their backed reserves. Only the
  // airToken side is needed here: _priceClose values a long through SWAP-3,
  // whose reserves are (airTokenSupply - lockedAmount) and backedAirUsd.
  const airTokenSupply2 = p.airTokenSupply + (backedToken2 - backedToken1);
  if (airTokenSupply2 <= locked) return 0;

  const airUsdOut = cpOut(locked, airTokenSupply2 - locked, backedUsd2, p.swapFee);
  const surplus = airUsdOut - notional; // debt == notional
  if (surplus <= 0) return 0;
  return surplus * (1 - CLOSE_FEE);
}

/**
 * Smallest upward price move where the payout covers the premium, as a
 * percentage. Binary search — `simulateLong` is monotonic in `m`, so this
 * converges cleanly. Returns null if even a 100× move does not cover it,
 * which happens when the fee floor dominates a very small position.
 */
function breakEvenPct(p: PoolState, notional: number, premium: number): number | null {
  if (notional <= 0 || premium <= 0) return null;
  if (simulateLong(p, notional, 100) < premium) return null;
  let lo = 1;
  let hi = 100;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (simulateLong(p, notional, mid) < premium) lo = mid;
    else hi = mid;
  }
  return (hi - 1) * 100;
}

function money(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  if (n < 1000) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString()}`;
}

const MOVES = [
  { label: "+200%", m: 3 },
  { label: "+100%", m: 2 },
  { label: "+50%", m: 1.5 },
  { label: "+10%", m: 1.1 },
];

export default function TradeCalculator() {
  const [poolIdx, setPoolIdx] = useState(0);
  const [sizePct, setSizePct] = useState(100);

  const { data: poolCount } = useReadContract({
    address: FACTORY,
    abi: exnihiloFactoryAbi,
    functionName: "allPoolsLength",
    chainId: CHAIN_ID,
    query: { staleTime: 300_000 },
  });

  const n = Number(poolCount ?? 0n);

  const { data: addrs } = useReadContracts({
    contracts: Array.from({ length: n }, (_, i) => ({
      address: FACTORY,
      abi: exnihiloFactoryAbi,
      functionName: "allPools",
      args: [BigInt(i)],
      chainId: CHAIN_ID,
    })),
    query: { enabled: n > 0, staleTime: 300_000 },
  });

  const poolAddrs = useMemo(
    () =>
      (addrs ?? [])
        .map((r) => r.result as `0x${string}` | undefined)
        .filter((a): a is `0x${string}` => !!a),
    [addrs],
  );

  // Typed as plain ContractFunctionParameters: letting wagmi infer a result
  // tuple across 10 function names × N pools blows past TS's instantiation
  // depth limit (TS2589). Results are narrowed by hand in `pools` below.
  const stateCalls: ContractFunctionParameters[] = poolAddrs.flatMap((address) =>
    POOL_FIELDS.map((functionName) => ({
      address,
      abi: exnihiloPoolAbi,
      functionName,
      chainId: CHAIN_ID,
    })),
  );

  const { data: raw } = useReadContracts({
    contracts: stateCalls,
    query: { enabled: poolAddrs.length > 0, staleTime: 60_000 },
  });

  const tokenAddrs = useMemo(() => {
    if (!raw) return [];
    const tokIdx = POOL_FIELDS.indexOf("token");
    return poolAddrs.map(
      (_, i) => raw[i * POOL_FIELDS.length + tokIdx]?.result as `0x${string}` | undefined,
    );
  }, [raw, poolAddrs]);

  const { data: symbols } = useReadContracts({
    contracts: tokenAddrs
      .filter((a): a is `0x${string}` => !!a)
      .map((address) => ({ address, abi: erc20Abi, functionName: "symbol", chainId: CHAIN_ID })),
    query: { enabled: tokenAddrs.some(Boolean), staleTime: 300_000 },
  });

  const pools: PoolState[] = useMemo(() => {
    if (!raw) return [];
    const F = POOL_FIELDS.length;
    return poolAddrs
      .map((address, i) => {
        const g = (name: (typeof POOL_FIELDS)[number]) =>
          raw[i * F + POOL_FIELDS.indexOf(name)]?.result;
        const dec = Number(g("tokenDecimals") ?? 18);
        const tokScale = 10 ** dec;
        const bU = Number(g("backedAirUsd") ?? 0n) / 1e6;
        const bT = Number(g("backedAirToken") ?? 0n) / tokScale;
        if (bU <= 0 || bT <= 0) return null;

        const bps = Number(g("maxPositionBps") ?? 0n);
        const usdCap = Number(g("maxPositionUsd") ?? 0n) / 1e6;
        const caps = [
          bps > 0 ? (bU * bps) / 10_000 : null,
          usdCap > 0 ? usdCap : null,
        ].filter((x): x is number => x !== null);

        return {
          address,
          symbol: (symbols?.[i]?.result as string | undefined) ?? "TOKEN",
          backedAirUsd: bU,
          backedAirToken: bT,
          airTokenSupply: Number(g("airTokenSupply") ?? 0n) / tokScale,
          airUsdSupply: Number(g("airUsdSupply") ?? 0n) / 1e6,
          swapFee: Number(g("swapFeeBps") ?? 0n) / 10_000,
          maxPosition: caps.length ? Math.min(...caps) : null,
          durationDays: Number(g("positionDuration") ?? 0n) / 86_400,
        } satisfies PoolState;
      })
      .filter((p): p is PoolState => p !== null);
  }, [raw, poolAddrs, symbols]);

  const pool = pools[Math.min(poolIdx, pools.length - 1)];

  // Uncapped pools still need a sane slider ceiling; 10% of reserves is well
  // past the point where slippage dominates, which the payoff table will show.
  const maxSize = pool ? (pool.maxPosition ?? pool.backedAirUsd * 0.1) : 0;
  const size = (maxSize * sizePct) / 100;

  const notionalRaw = BigInt(Math.max(0, Math.floor(size * 1e6)));
  const { data: feeRaw } = useReadContract({
    address: pool?.address,
    abi: exnihiloPoolAbi,
    functionName: "quoteOpenFee",
    args: [notionalRaw, true],
    chainId: CHAIN_ID,
    query: { enabled: !!pool && notionalRaw > 0n, staleTime: 60_000 },
  });

  const premium = feeRaw !== undefined ? Number(feeRaw) / 1e6 : null;
  const feeRate = premium !== null && size > 0 ? (premium / size) * 100 : null;
  const floorBinds = feeRate !== null && feeRate > 5.5;
  const breakEven = useMemo(
    () => (pool && premium !== null ? breakEvenPct(pool, size, premium) : null),
    [pool, size, premium],
  );

  if (!pool) return null;

  return (
    <>
      <div className="divider max-w-4xl mx-auto" />

      <section className="max-w-3xl mx-auto px-6 py-24">
        <p className="section-label mb-2 text-center">
          <span className="pulse-dot mr-2" />
          Live from the contracts
        </p>
        <h2 className="font-display text-4xl md:text-5xl text-white text-center mb-4 tracking-wide">
          What you can trade right now.
        </h2>
        <p
          className="text-center text-sm max-w-xl mx-auto mb-12"
          style={{ color: "var(--muted)" }}
        >
          Every number below is read from the pool contracts as you load this
          page &mdash; including the limits. Liquidity is being scaled up
          deliberately, so these are small today.
        </p>

        {/* Pool selector */}
        <div className="flex flex-wrap gap-2 justify-center mb-8">
          {pools.map((p, i) => (
            <button
              key={p.address}
              onClick={() => setPoolIdx(i)}
              className="btn text-xs py-2 px-4"
              style={{
                border: `1px solid ${i === poolIdx ? "var(--cyan)" : "var(--border)"}`,
                color: i === poolIdx ? "var(--cyan)" : "var(--muted)",
                background: "transparent",
              }}
            >
              {p.symbol}
            </button>
          ))}
        </div>

        <div className="cyber-panel p-6 md:p-8">
          {/* Pool facts */}
          <div className="grid grid-cols-3 gap-4 mb-8 font-mono text-center">
            <div>
              <p className="section-label mb-1">Pool depth</p>
              <p className="font-display text-2xl text-white">
                {money(pool.backedAirUsd)}
              </p>
            </div>
            <div>
              <p className="section-label mb-1">Max position</p>
              <p className="font-display text-2xl" style={{ color: "var(--cyan)" }}>
                {pool.maxPosition === null ? "uncapped" : money(pool.maxPosition)}
              </p>
            </div>
            <div>
              <p className="section-label mb-1">Term</p>
              <p className="font-display text-2xl text-white">
                {pool.durationDays}d
              </p>
            </div>
          </div>

          {/* Size slider */}
          <label className="section-label block mb-3">
            Position size &mdash; {money(size)}
          </label>
          <input
            type="range"
            min={5}
            max={100}
            step={5}
            value={sizePct}
            onChange={(e) => setSizePct(Number(e.target.value))}
            className="w-full mb-8"
            style={{ accentColor: "var(--cyan)" }}
          />

          {/* Cost */}
          <div
            className="font-mono text-sm space-y-3 pb-6"
            style={{ borderBottom: "1px solid var(--border)" }}
          >
            <div className="flex justify-between">
              <span style={{ color: "var(--muted)" }}>You pay (premium)</span>
              <span style={{ color: "var(--body)" }}>
                {premium === null ? "…" : money(premium)}
              </span>
            </div>
            <div className="flex justify-between">
              <span style={{ color: "var(--muted)" }}>Effective fee rate</span>
              <span style={{ color: floorBinds ? "var(--orange)" : "var(--body)" }}>
                {feeRate === null ? "…" : `${feeRate.toFixed(1)}%`}
              </span>
            </div>
            <div className="flex justify-between">
              <span style={{ color: "var(--muted)" }}>Maximum you can lose</span>
              <span style={{ color: "var(--red)" }}>
                {premium === null ? "…" : money(premium)}
              </span>
            </div>
            <div className="flex justify-between">
              <span style={{ color: "var(--muted)" }}>
                {pool.symbol} must rise
              </span>
              <span style={{ color: "var(--orange)" }}>
                {breakEven === null ? "…" : `+${breakEven.toFixed(0)}% to break even`}
              </span>
            </div>
          </div>

          {floorBinds && (
            <p className="mt-4 text-xs" style={{ color: "var(--orange)" }}>
              At this size the 0.05 USDC minimum fee applies instead of the 5%
              base rate, so you are paying more than 5%. Larger positions pay
              closer to 5%.
            </p>
          )}

          {/* Payoff */}
          <p className="section-label mt-8 mb-3">If {pool.symbol} goes up</p>
          <div className="font-mono text-sm space-y-3">
            {MOVES.map(({ label, m }) => {
              const payout = simulateLong(pool, size, m);
              const net = premium === null ? null : payout - premium;
              return (
                <div key={label} className="flex justify-between">
                  <span style={{ color: "var(--muted)" }}>{label}</span>
                  <span style={{ color: "var(--body)" }}>
                    {money(payout)}
                    {net !== null && (
                      <span
                        style={{ color: net >= 0 ? "var(--green)" : "var(--red)" }}
                      >
                        {" "}
                        ({net >= 0 ? "+" : "−"}
                        {money(Math.abs(net))} net)
                      </span>
                    )}
                  </span>
                </div>
              );
            })}
            <div className="flex justify-between">
              <span style={{ color: "var(--muted)" }}>Any move down</span>
              <span style={{ color: "var(--red)" }}>
                {premium === null ? "…" : `−${money(premium)}`}
              </span>
            </div>
          </div>

          <p className="mt-6 text-xs" style={{ color: "var(--dim)" }}>
            The premium is quoted by the pool contract and is exact. Payouts are
            estimates: they assume the price move happens with no other trading
            flow, and they already account for AMM slippage and the 1% close fee.
            You receive the profit only &mdash; the position size is never
            deposited, so it is never returned.
          </p>
        </div>
      </section>
    </>
  );
}

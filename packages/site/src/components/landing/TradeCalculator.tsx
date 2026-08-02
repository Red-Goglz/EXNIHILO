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
  // NOT "token" — that name exists only as a parameter of the
  // SafeERC20FailedOperation error, so reading it reverts and every pool falls
  // back to a placeholder symbol. PoolCard uses underlyingToken; so do we.
  "underlyingToken",
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
 * Estimated USDC paid out when closing a short of `notional` after the token
 * price moves by factor `m` (m < 1 is a fall, which is where a short profits).
 *
 * Mirrors openShort → _priceClose (short branch) → _settle. The short is NOT
 * the long's mirror image and cannot be derived by symmetry — it mints
 * synthetic *airToken* at the backed rate and locks *real* airUsd out of
 * backedAirUsd via SWAP-3, then settles by buying the token debt back through
 * SWAP-2. The two legs use different reserves, so each is modelled directly.
 */
function simulateShort(p: PoolState, notional: number, m: number): number {
  if (notional <= 0 || p.backedAirUsd <= 0 || p.airTokenSupply <= 0) return 0;

  // openShort: airTokenMinted = notional * airTokenSupply / backedAirUsd,
  // then SWAP-3 prices it against (airTokenSupply, backedAirUsd) — the supply
  // BEFORE the synthetic mint.
  const airTokenMinted = (notional * p.airTokenSupply) / p.backedAirUsd;
  if (airTokenMinted <= 0) return 0;

  const locked = cpOut(airTokenMinted, p.airTokenSupply, p.backedAirUsd, p.swapFee);
  if (locked <= 0 || locked > p.backedAirUsd) return 0;

  // State immediately after the open. The locked airUsd leaves the backed
  // reserves but stays counted in airUsdSupply, so that counter is unchanged.
  const backedUsd1 = p.backedAirUsd - locked;
  const backedToken1 = p.backedAirToken;
  if (backedUsd1 <= 0) return 0;

  // Price move applied to the backed reserves along x*y=k.
  const r = Math.sqrt(m);
  const backedUsd2 = backedUsd1 * r;
  const backedToken2 = backedToken1 / r;

  // Supply counters move by the same delta as their backed reserve. Only the
  // airUsd side is needed: the short branch of _priceClose values the debt
  // through SWAP-2 on (airUsdSupply - lockedAmount, backedAirToken).
  const airUsdSupply2 = p.airUsdSupply + (backedUsd2 - backedUsd1);
  if (airUsdSupply2 < locked) return 0;

  const totalBuyable = cpOut(locked, airUsdSupply2 - locked, backedToken2, p.swapFee);
  if (totalBuyable <= 0 || totalBuyable < airTokenMinted) return 0;

  const cost = (locked * airTokenMinted) / totalBuyable;
  const surplus = locked - cost;
  if (surplus <= 0) return 0;
  return surplus * (1 - CLOSE_FEE);
}

/**
 * Smallest price move where the payout covers the premium, as a percentage.
 *
 * Binary search over the move factor — both simulators are monotonic in `m`,
 * just in opposite directions, so the bracket is chosen per side: a long needs
 * `m` above 1 and a short needs it below. Returns null when even an extreme
 * move does not cover the premium, which happens once the 0.05 USDC fee floor
 * dominates a very small position.
 */
function breakEvenPct(
  p: PoolState,
  notional: number,
  premium: number,
  isShort: boolean,
): number | null {
  if (notional <= 0 || premium <= 0) return null;
  const sim = isShort ? simulateShort : simulateLong;

  if (isShort) {
    // Profit rises as m falls. lo = deep fall (profitable), hi = flat (not).
    if (sim(p, notional, 0.01) < premium) return null;
    let lo = 0.01;
    let hi = 1;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (sim(p, notional, mid) >= premium) lo = mid;
      else hi = mid;
    }
    return (1 - lo) * 100;
  }

  if (sim(p, notional, 100) < premium) return null;
  let lo = 1;
  let hi = 100;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (sim(p, notional, mid) < premium) lo = mid;
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

/**
 * Return on the premium, which is the only capital actually at risk — the
 * notional is synthetic and never deposited, so a percentage of it would be
 * meaningless. A total loss is therefore exactly −100 %, and the upside runs
 * into the thousands of percent on a small premium.
 */
function pnlPct(net: number, premium: number): string | null {
  if (!(premium > 0) || !Number.isFinite(net)) return null;
  const pct = (net / premium) * 100;
  const abs = Math.abs(pct);
  const digits = abs >= 100 ? 0 : 1;
  return `${pct >= 0 ? "+" : "−"}${abs.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}%`;
}

const LONG_MOVES = [
  { label: "+200%", m: 3 },
  { label: "+100%", m: 2 },
  { label: "+50%", m: 1.5 },
  { label: "+10%", m: 1.1 },
];

// A short cannot gain more than 100 %, so the ladder runs toward zero rather
// than mirroring the long's multiples.
const SHORT_MOVES = [
  { label: "−75%", m: 0.25 },
  { label: "−50%", m: 0.5 },
  { label: "−25%", m: 0.75 },
  { label: "−10%", m: 0.9 },
];

export default function TradeCalculator() {
  const [poolIdx, setPoolIdx] = useState(0);
  // Signed: negative is short, positive is long, 0 is the centred rest state.
  const [sliderVal, setSliderVal] = useState(0);

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
    const tokIdx = POOL_FIELDS.indexOf("underlyingToken");
    return poolAddrs.map(
      (_, i) => raw[i * POOL_FIELDS.length + tokIdx]?.result as `0x${string}` | undefined,
    );
  }, [raw, poolAddrs]);

  // Keyed by address rather than index: filtering the undefined entries out of
  // the call list would otherwise shift every later symbol onto the wrong pool.
  const symbolTargets = useMemo(
    () => [...new Set(tokenAddrs.filter((a): a is `0x${string}` => !!a))],
    [tokenAddrs],
  );

  const { data: symbolData } = useReadContracts({
    contracts: symbolTargets.map((address) => ({
      address,
      abi: erc20Abi,
      functionName: "symbol",
      chainId: CHAIN_ID,
    })),
    query: { enabled: symbolTargets.length > 0, staleTime: 300_000 },
  });

  const symbolByToken = useMemo(() => {
    const m = new Map<string, string>();
    symbolTargets.forEach((addr, i) => {
      const s = symbolData?.[i]?.result as string | undefined;
      if (s) m.set(addr.toLowerCase(), s);
    });
    return m;
  }, [symbolTargets, symbolData]);

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

        const tok = g("underlyingToken") as `0x${string}` | undefined;

        return {
          address,
          symbol: (tok && symbolByToken.get(tok.toLowerCase())) ?? "…",
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
  }, [raw, poolAddrs, symbolByToken]);

  const pool = pools[Math.min(poolIdx, pools.length - 1)];

  // Uncapped pools still need a sane slider ceiling; 10% of reserves is well
  // past the point where slippage dominates, which the payoff table will show.
  const maxSize = pool ? (pool.maxPosition ?? pool.backedAirUsd * 0.1) : 0;
  const isShort = sliderVal < 0;
  const sizePct = Math.abs(sliderVal);
  const size = (maxSize * sizePct) / 100;
  const active = sizePct > 0;

  const notionalRaw = BigInt(Math.max(0, Math.floor(size * 1e6)));
  // The caps and the fee both differ by side — quoteOpenFee reads the matching
  // open-interest counter — so the direction is part of the query key, not a
  // cosmetic flag.
  const { data: feeRaw } = useReadContract({
    address: pool?.address,
    abi: exnihiloPoolAbi,
    functionName: "quoteOpenFee",
    args: [notionalRaw, !isShort],
    chainId: CHAIN_ID,
    query: { enabled: !!pool && notionalRaw > 0n, staleTime: 60_000 },
  });

  const premium = active && feeRaw !== undefined ? Number(feeRaw) / 1e6 : null;
  const feeRate = premium !== null && size > 0 ? (premium / size) * 100 : null;
  const floorBinds = feeRate !== null && feeRate > 5.5;
  const breakEven = useMemo(
    () => (pool && premium !== null ? breakEvenPct(pool, size, premium, isShort) : null),
    [pool, size, premium, isShort],
  );

  const dirColor = isShort ? "var(--magenta)" : "var(--cyan)";
  const moves = isShort ? SHORT_MOVES : LONG_MOVES;
  const simulate = isShort ? simulateShort : simulateLong;

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
            {/* USDC depth, not TVL. This is the side that actually backs
                payouts and that maxPositionBps is a percentage of, so it is
                the number that governs what you can open — but it is half the
                pool, and the markets table reports TVL. Showing both keeps the
                two pages reconcilable.

                TVL needs no extra read: the token side valued at the pool's
                own spot price (backedAirUsd / backedAirToken) is exactly
                backedAirUsd, so total TVL is always 2 × backedAirUsd. */}
            <div>
              <p className="section-label mb-1">USDC depth</p>
              <p className="font-display text-2xl text-white">
                {money(pool.backedAirUsd)}
              </p>
              <p className="text-xs mt-1" style={{ color: "var(--dim)" }}>
                {money(pool.backedAirUsd * 2)} total TVL
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

          {/* Direction + size on one control. Centre is flat: drag left to
              short, right to long. */}
          <label className="section-label block mb-3">
            {active ? (
              <>
                Position size &mdash;{" "}
                <span style={{ color: dirColor, fontWeight: 600 }}>
                  {isShort ? "SHORT" : "LONG"} {money(size)}
                </span>
              </>
            ) : (
              <>Position size &mdash; drag left to SHORT, right to LONG</>
            )}
          </label>
          <input
            type="range"
            min={-100}
            max={100}
            step={5}
            value={sliderVal}
            onChange={(e) => setSliderVal(Number(e.target.value))}
            className="w-full mb-1"
            style={{ accentColor: active ? dirColor : "var(--border)" }}
          />
          <div
            className="flex justify-between font-mono mb-8"
            style={{ fontSize: "var(--fs-micro)", color: "var(--dim)" }}
          >
            <span>SHORT {money(maxSize)}</span>
            <span>flat</span>
            <span>LONG {money(maxSize)}</span>
          </div>

          {/* Cost */}
          <div
            className="font-mono text-sm space-y-3 pb-6"
            style={{ borderBottom: "1px solid var(--border)" }}
          >
            <div className="flex justify-between">
              <span style={{ color: "var(--muted)" }}>You pay (premium)</span>
              <span style={{ color: "var(--body)" }}>
                {/* "—" means no position selected; "…" means the quote is
                    still in flight. Collapsing the two would read as a stall. */}
                {!active ? "—" : premium === null ? "…" : money(premium)}
              </span>
            </div>
            <div className="flex justify-between">
              <span style={{ color: "var(--muted)" }}>Effective fee rate</span>
              <span style={{ color: floorBinds ? "var(--orange)" : "var(--body)" }}>
                {!active ? "—" : feeRate === null ? "…" : `${feeRate.toFixed(1)}%`}
              </span>
            </div>
            <div className="flex justify-between">
              <span style={{ color: "var(--muted)" }}>Maximum you can lose</span>
              <span style={{ color: "var(--red)" }}>
                {!active ? "—" : premium === null ? "…" : money(premium)}
              </span>
            </div>
            <div className="flex justify-between">
              <span style={{ color: "var(--muted)" }}>
                {pool.symbol} must {isShort ? "fall" : "rise"}
              </span>
              <span style={{ color: "var(--orange)" }}>
                {breakEven === null
                  ? "—"
                  : `${isShort ? "−" : "+"}${breakEven.toFixed(0)}% to break even`}
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

          {/* Payoff — same amounts and calcs, flipped to the chosen side. */}
          <p className="section-label mt-8 mb-3">
            If {pool.symbol} goes {isShort ? "down" : "up"}
            {active && (
              <span style={{ color: dirColor }}>
                {" "}
                &mdash; {isShort ? "SHORT" : "LONG"} {money(size)}
              </span>
            )}
          </p>
          <div className="font-mono text-sm space-y-3">
            {moves.map(({ label, m }) => {
              const payout = active ? simulate(pool, size, m) : 0;
              const net = premium === null ? null : payout - premium;
              return (
                <div key={label} className="flex justify-between">
                  <span style={{ color: "var(--muted)" }}>{label}</span>
                  <span style={{ color: "var(--body)" }}>
                    {!active ? "—" : money(payout)}
                    {/* The net inherits the payout's colour — both are the same
                        kind of fact. Only the return on premium is signed, so
                        it alone carries the green/red. */}
                    {net !== null && (
                      <>
                        {" "}
                        ({net >= 0 ? "+" : "−"}
                        {money(Math.abs(net))} net)
                        {premium !== null && pnlPct(net, premium) && (
                          <span
                            style={{
                              color: net >= 0 ? "var(--green)" : "var(--red)",
                            }}
                          >
                            {" "}
                            {pnlPct(net, premium)}
                          </span>
                        )}
                      </>
                    )}
                  </span>
                </div>
              );
            })}
            <div className="flex justify-between">
              <span style={{ color: "var(--muted)" }}>
                Any move {isShort ? "up" : "down"}
              </span>
              <span style={{ color: "var(--body)" }}>
                {premium === null ? (
                  "—"
                ) : (
                  <>
                    $0 (−{money(premium)} net)
                    <span style={{ color: "var(--red)" }}> −100%</span>
                  </>
                )}
              </span>
            </div>
          </div>

          <p className="mt-6 text-xs" style={{ color: "var(--dim)" }}>
            The premium is quoted by the pool contract and is exact. Payouts are
            estimates: they assume the price move happens with no other trading
            flow, and they already account for AMM slippage and the 1% close fee.
            You receive the profit only &mdash; the position size is never
            deposited, so it is never returned. Percentages are the return on
            the premium, which is the only capital at risk.
          </p>
        </div>
      </section>
    </>
  );
}

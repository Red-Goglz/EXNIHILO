/**
 * Client-side renderer for the shareable PnL card.
 *
 * The card used to be the position's own on-chain art (PositionNFT.tokenURI),
 * but that SVG is baked into the deployed bytecode of a contract with no owner,
 * no renderer hook and no proxy — and every pool holds its address as an
 * `immutable`. Its 10px labels at #555 therefore cannot be made legible without
 * redeploying the protocol, so the app draws its own card instead.
 *
 * The layout deliberately mirrors the on-chain certificate (same 800×450 frame,
 * same monospace, same corner ticks) — only the type scale and the greys are
 * lifted. The NFT art itself is unchanged and remains what marketplaces show.
 */

export interface PnlCardData {
  tokenId: bigint;
  tokenSymbol: string;
  isLong: boolean;
  usdcIn: bigint;
  lockedAmount: bigint;
  tokenDecimals: number;
  feesPaid: bigint;
  openedAt: bigint;
  /** Position size left as a fraction of its opening collateral, in bps. */
  remainingBps: bigint;
  hasPnl: boolean;
  pnlPositive: boolean;
  pnlNetAbs: bigint;
  /** Return on premium; null when the pool cannot price the position. */
  returnPct: number | null;
}

/** SVG is XML — a permissionless token symbol can carry `&` or `<`. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Group digits with a comma explicitly rather than via toLocaleString(): the
 * card is an image that gets shared, so its numbers must not change shape with
 * the viewer's locale (a Swiss browser renders 1'938, a German one 1.938).
 */
function group(v: bigint): string {
  return v.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * 2 decimals like the on-chain _fmt6, but 4 for sub-cent values — the fee floor
 * is 0.05 USDC, so real positions routinely settle in tenths of a cent and
 * "0.00" would read as nothing at all.
 */
function fmt6(v: bigint): string {
  const whole = v / 1_000_000n;
  if (whole === 0n && v > 0n && v < 10_000n) {
    return `0.${(v / 100n).toString().padStart(4, "0")}`;
  }
  const frac = (v % 1_000_000n) / 10_000n;
  return `${group(whole)}.${frac.toString().padStart(2, "0")}`;
}

/** Up to 4 fractional digits at the token's own decimals, matching _fmtToken. */
function fmtToken(v: bigint, dec: number): string {
  if (dec === 0) return group(v);
  const unit = 10n ** BigInt(dec);
  const whole = v / unit;
  const show = dec > 4 ? 4 : dec;
  const frac = (v % unit) / 10n ** BigInt(dec - show);
  return `${group(whole)}.${frac.toString().padStart(show, "0")}`;
}

/** ISO, in UTC — matching PositionNFT._fmtDate so both cards read the same. */
function fmtDate(ts: bigint): string {
  const d = new Date(Number(ts) * 1000);
  const mo = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  return `${d.getUTCFullYear()}-${mo}-${d.getUTCDate().toString().padStart(2, "0")}`;
}

/**
 * The hero line: the trader's result in dollars, and the same number as a
 * percent of the premium they staked.
 *
 * Both come from usePositionState net of the premium, and mirror
 * PositionNFT._netReturn — so this card, the app and the on-chain certificate
 * agree. The caption names the one basis they share.
 */
function pnlParts(d: PnlCardData): { color: string; text: string; caption: string } {
  if (!d.hasPnl) {
    return { color: "#8a8a8a", text: "N/A", caption: "POOL CANNOT PRICE THIS POSITION" };
  }
  if (d.pnlNetAbs === 0n) {
    return { color: "#aaaaaa", text: "$0.00", caption: "NET OF PREMIUM PAID" };
  }
  // Colour tracks the RETURN, not the payout: a position can pay out a positive
  // number and still be far below the premium that bought it, and painting that
  // green would sell a loss as a win.
  const color = d.pnlPositive ? "#00ff88" : "#ff3b30";
  const text = `${d.pnlPositive ? "+$" : "-$"}${fmt6(d.pnlNetAbs)}`;
  if (d.returnPct === null) {
    return { color, text, caption: "NET OF PREMIUM PAID" };
  }
  const pct = `${d.returnPct >= 0 ? "+" : ""}${d.returnPct.toFixed(0)}%`;
  return { color, text: `${text}  (${pct})`, caption: "NET OF PREMIUM PAID" };
}

export function buildPnlCardSvg(d: PnlCardData): string {
  const sideColor = d.isLong ? "#00ff88" : "#ff3b30";
  const sideLabel = d.isLong ? "LONG" : "SHORT";
  const market = `${esc(d.tokenSymbol)} / USDC`;
  const { color: pnlColor, text: pnlText, caption } = pnlParts(d);

  // Column 2 is the locked collateral, whose units differ by side.
  const lockedLabel = d.isLong ? `LOCKED ${esc(d.tokenSymbol)}` : "LOCKED USDC";
  const lockedValue = d.isLong
    ? fmtToken(d.lockedAmount, d.tokenDecimals)
    : fmt6(d.lockedAmount);

  // Type scale lifted from the on-chain card: labels 10→13, values 15→20,
  // dates 13→16, hero 48→56; greys #555/#666/#333 → #8a8a8a/#999/#555.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450" viewBox="0 0 800 450">
<defs><style>
.f{font-family:'Courier New',Courier,monospace;}
.lbl{font-size:13px;letter-spacing:2px;fill:#8a8a8a;}
.val{font-size:20px;fill:#e8e8e8;}
.dat{font-size:16px;fill:#999;}
</style></defs>
<rect width="800" height="450" fill="#000"/>
<rect x="1" y="1" width="798" height="448" fill="none" stroke="#1a1a1a"/>
<polyline points="1,24 1,1 24,1" fill="none" stroke="#00e5ff" stroke-width="1.5"/>
<polyline points="776,1 799,1 799,24" fill="none" stroke="#00e5ff" stroke-width="1.5"/>
<polyline points="1,426 1,449 24,449" fill="none" stroke="#00e5ff" stroke-width="1.5"/>
<polyline points="776,449 799,449 799,426" fill="none" stroke="#00e5ff" stroke-width="1.5"/>
<text x="32" y="58" class="f" font-size="32" letter-spacing="8" fill="#fff" font-weight="bold">EXNIHILO</text>
<text x="32" y="80" class="f" font-size="12" letter-spacing="3" fill="#00e5ff">POSITION CERTIFICATE</text>
<text x="768" y="58" class="f" font-size="14" fill="#666" text-anchor="end">#${d.tokenId.toString()}</text>
<line x1="32" y1="96" x2="768" y2="96" stroke="#1a1a1a"/>
<rect x="32" y="110" width="74" height="26" fill="${sideColor}" fill-opacity="0.08"/>
<rect x="32" y="110" width="74" height="26" fill="none" stroke="${sideColor}" stroke-opacity="0.35"/>
<text x="69" y="128" class="f" font-size="13" letter-spacing="2" fill="${sideColor}" text-anchor="middle">${sideLabel}</text>
<text x="120" y="129" class="f" font-size="21" letter-spacing="2" fill="#fff" font-weight="bold">${market}</text>
<text x="400" y="196" class="f lbl" text-anchor="middle" letter-spacing="4px">EST. PnL</text>
<text x="400" y="252" class="f" font-size="56" font-weight="bold" fill="${pnlColor}" text-anchor="middle" letter-spacing="2">${pnlText}</text>
<text x="400" y="276" class="f" font-size="12" letter-spacing="2" fill="#8a8a8a" text-anchor="middle">${caption}</text>
<line x1="32" y1="300" x2="768" y2="300" stroke="#1a1a1a"/>
<text x="32" y="330" class="f lbl">POSITION SIZE</text>
<text x="32" y="360" class="f val">${fmt6(d.usdcIn)}</text>
<text x="196" y="330" class="f lbl">${lockedLabel}</text>
<text x="196" y="360" class="f val">${lockedValue}</text>
<text x="360" y="330" class="f lbl">PREMIUM PAID</text>
<text x="360" y="360" class="f val">${fmt6(d.feesPaid)}</text>
<text x="524" y="330" class="f lbl">OPENED</text>
<text x="524" y="360" class="f dat">${fmtDate(d.openedAt)}</text>
<text x="656" y="330" class="f lbl">SIZE LEFT</text>
<text x="656" y="360" class="f dat">${(Number(d.remainingBps) / 100).toFixed(1)}%</text>
<text x="32" y="424" class="f" font-size="12" letter-spacing="2" fill="#555">exnihilo.markets</text>
<text x="768" y="424" class="f" font-size="12" letter-spacing="3" fill="#555" text-anchor="end">OUT OF THIN AIR</text>
</svg>`;
}

# EXNIHILO — UI Requirements
**v0.3 — updated to match current implementation**

---

## 1. Design Language

### 1.1 Aesthetic
Cyberpunk / terminal trading platform. Dark, precise, monospaced. Inspired by professional trading terminals and retro-futuristic interfaces. Every element should feel like it belongs on a command-line dashboard, not a consumer app.

### 1.2 Typography
| Role | Font | Usage |
|---|---|---|
| Display / headings | Bebas Neue | Page titles, pool names, logo |
| Body / data | IBM Plex Mono | All labels, values, inputs, buttons, nav |

Both fonts loaded via Google Fonts in `index.html`.

### 1.3 Colour Palette
| Token | Value | Usage |
|---|---|---|
| Background | `#000000` | Page background |
| Surface | `#070707` | Cards, panels, trade boxes |
| Surface-2 | `#0d0d0d` | Inputs, stat boxes |
| Border | `#1a1a1a` | Default borders |
| Border bright | `#2e2e2e` | Hover borders |
| Cyan | `#00e5ff` | Primary accent — active states, prices, links |
| Red | `#ff3b30` | Short positions, danger, Avalanche branding |
| Green | `#00ff88` | Long positions, profit, success |
| Orange | `#ff8c00` | Mid-level OI warnings |
| Body text | `#c8c8c8` | Default text |
| Muted text | `#505050` | Labels, secondary info |
| Dim text | `#303030` | Very low-priority info |

### 1.4 Background & Atmosphere
- Pure black base with a 22 px radial-gradient dot grid overlay
- CSS scanlines overlay (subtle, `pointer-events: none`, `position: fixed`)
- Sticky navbar uses `backdrop-filter: blur(10px)` for frosted-glass effect

### 1.5 Logo
- "EXNIHILO" in Bebas Neue
- CSS glitch animation: `::before` layer in cyan offset left, `::after` layer in red offset right, using `clip-path`
- Animation fires approximately every 8 seconds, lasts ~500 ms
- Used full-size on the empty Markets/Feed hero screen; smaller (1.5 rem) in the navbar

### 1.6 CSS Utility Classes
Defined in `index.css`:
- `.btn-terminal` — base terminal button style; variants `.btn-cyan`, `.btn-red`, `.btn-green`
- `.input-terminal` — monospace dark input with cyan focus ring
- `.markets-table` — full-width table with hover-highlight rows
- `.stat-box`, `.stat-label` — stat card containers
- `.tab-bar`, `.tab-item` — tab navigation on pool page
- `.tag-long`, `.tag-short` — badge tags for position type
- `.logo-glitch` — animated glitch logo
- `.spinner`, `.cursor-blink` — loading/signing animation helpers

---

## 2. Global Layout

### 2.1 Navbar
- Sticky, full-width, 56 px height
- Left: EXNIHILO glitch logo (links to `/`) → nav links: **FEED / MARKETS / PORTFOLIO / CREATE**
- Right: "⬡ AVALANCHE" label in red + wallet connect button
- Active nav link: cyan text + 1 px cyan underline
- Inactive nav link: muted, turns body-colour on hover
- Max content width: 1280 px, centred

### 2.2 Page Content
- Max width: 1280 px, centred, 24 px horizontal padding
- 32 px top padding, 64 px bottom padding

### 2.3 Wallet Connect Button
- **Disconnected:** `[CONNECT WALLET]` — cyan outline terminal button
- **Connected:** shows abbreviated address + small `DISCONNECT` button
- Clicking "CONNECT WALLET" opens a dropdown listing all discovered connectors (EIP-6963 auto-discovery) plus WalletConnect
- Each connector shown with its icon (data-URI from EIP-6963) or an emoji fallback
- Dropdown closes on outside click
- **Implemented:** injected wallet auto-discovery (Rabby, MetaMask, etc.) + WalletConnect v2

---

## 3. Shared Components

### 3.1 TxButton (`src/components/shared/TxButton.tsx`)
States: `idle` → `pending` (spinner + blinking cursor "SIGNING_") → `confirming` ("CONFIRMING_") → `success` (green "DONE") → `error` (red "FAILED")

**TODO:** Capture and display decoded revert reason on error state (currently shows generic "FAILED").

### 3.2 TokenInput (`src/components/shared/TokenInput.tsx`)
- Label row: uppercase muted label left, `BAL: X.XX SYMBOL` right (reads live `balanceOf`)
- Input: monospace, dark surface-2 background, thin border, cyan focus ring
- Token symbol tag attached right
- MAX button fills input with full balance

**TODO:** Show red border + message when entered value exceeds balance.

### 3.3 Cyber Panel
Panels / cards with 1 px cyan corner accents (top-left and bottom-right). Used on trade panel and CreatePage form. Implemented as inline `<span>` overlay elements.

### 3.4 Tag Badges
- `LONG` badge: green text, green border, green-tinted background
- `SHORT` badge: red text, red border, red-tinted background

### 3.5 Star Rating
**1–5 filled `★` stars in cyan; empty stars in dim grey.**

Rating thresholds (based on total TVL):
| Stars | Label | TVL Range |
|---|---|---|
| ★ | No Liquidity | < $1K |
| ★★ | Low Liquidity | $1K – $10K |
| ★★★ | Growing | $10K – $100K |
| ★★★★ | Established | $100K – $1M |
| ★★★★★ | Deep Liquidity | > $1M |

**TVL calculation:** `tokenValueUSD = backedAirToken × spotPrice / 10^tokenDecimals`, then `totalTVL = tokenValueUSD + backedAirUsd`. Does **not** use `2 × backedAirUsd` (that was incorrect).

**Tooltip:** hovering the stars reveals a floating panel listing all 5 tiers with their labels and thresholds. Styled with cyber corner accents.

**TODO:** Factor in pool health (backed/unbacked ratio) and market age for a richer signal.

### 3.6 ChainGuard (`src/components/wallet/ChainGuard.tsx`)
Wraps write-only pages (PoolPage, PortfolioPage, CreatePage). If wallet is connected but on the wrong chain, shows a prompt with a "SWITCH NETWORK" button. If no wallet is connected, shows "CONNECT WALLET". Read-only pages (MarketsPage, FeedPage) do not use ChainGuard.

---

## 4. Pages

### 4.1 Feed Page (`/`) — **Default / Home**

Tinder-style single-pool feed. Shows one pool at a time, ordered by star rating descending.

#### Queue Logic
- **No wallet connected:** global queue — all pools sorted by stars, highest first
- **Wallet connected:** personal queue — excludes pools where the user already has an open position; sorted by stars
- Visited pools tracked in `sessionStorage` (`exnihilio_feed_visited`) — each pool appears at most once per browser session
- "RESET ↺" button resets the visited set; "ALL CAUGHT UP" screen with reset + view-all when queue is empty

#### Card Layout (top to bottom)
1. **LONG / SHORT toggle** — full-width two-button bar at top; clicking the active direction deselects it (cancel)
2. **Amount presets** (appears below toggle when direction selected) — 3 preset buttons + CUSTOM input, tinted in direction colour
   - 1★ pool: $1 / $2 / $5
   - 2★ pool: $5 / $10 / $25
   - 3–5★ pool: $10 / $50 / $200
3. **Price chart** — 380 px tall SVG; time flows bottom (old) → top (new); price on horizontal axis; left half tinted green, right half tinted red; current price always centred horizontally with a cyan dashed guide; current price dot at top-centre
4. **Activity markers** — 2–3 deterministic markers seeded by pool address; each shows a coloured dot on the price path with a floating label: `▲ LONG $50 · PNL +$18.4`; labels alternate sides to avoid clipping
5. **Token info row** — token name (Bebas Neue) + `/USDC`, current price in cyan, star rating, TVL
6. **Confirm section** (appears when direction + amount selected) — fee row (5%), estimated locked amount, APPROVE USDC button (if needed), OPEN LONG/SHORT button
7. **Footer** — `VIEW FULL MARKET →` link + `SKIP ›` button (marks pool as visited, advances queue)

After a position is opened and confirmed on-chain, the feed auto-advances to the next pool after 1.4 s.

**TODO:**
- [ ] Swipe gesture support (left = skip, right = select direction)
- [ ] Real price history chart when indexer is available (currently deterministic fake path)

---

### 4.2 Markets Page (`/markets`)

#### Empty State
Full-screen hero:
- Large EXNIHILO glitch logo (responsive, up to 6 rem)
- "Out of Thin Air" tagline
- "Permissionless, Non-Force-Realizable, NFT-Based Leveraged Trading" descriptor
- "⬡ BUILT ON AVALANCHE" in red
- `[CREATE FIRST MARKET]` cyan button

#### Populated State
Controls row: search input (filters by token symbol; unloaded pools stay visible) + "★ RATING ↓" sort toggle (default ON — highest rating first).

HTML table with columns: **MARKET / PRICE / TOTAL TVL / POSITIONS / % LONG / % SHORT / RATING**
- Each row is a clickable link to the pool page
- Hover: row background tints cyan, text highlights
- Does not require wallet connection (read-only)

**Column definitions:**
- **PRICE** — spot price: `(backedAirUsd × 10^tokenDecimals) / backedAirToken`, formatted as USDC
- **TOTAL TVL** — `tokenValueUSD + backedAirUsd` (see §3.5 TVL calculation)
- **% LONG** — `longOpenInterest / backedAirUsd × 100`; uses contract state variable `longOpenInterest`
- **% SHORT** — `shortOpenInterest / backedAirUsd × 100`; uses contract state variable `shortOpenInterest`
- Both % columns: 0% muted, 1–33% green, 34–66% orange, 67%+ red
- **RATING** — 1–5 stars with hover tooltip

**TODO:**
- [ ] Show 24h price change column (requires indexer)
- [ ] Show 24h volume column (requires indexer)

---

### 4.3 Pool Page (`/markets/:poolAddr`)

#### Header
- `← MARKETS` breadcrumb
- Pool name in Bebas Neue (e.g. "PEPE / USDC")
- Pool address in small muted mono

#### Stats (two rows)
**Row 1 (3 cols):** PRICE | BACKED `SYMBOL` | BACKED USDC

**Row 2 (4 cols):** OPEN POSITIONS | % LONG | % SHORT | RATING (with hover tooltip)

#### Trade Panel
Cyber-panel with tabs: **SWAP / LONG-SHORT / LIQUIDITY**

The LIQUIDITY tab is only visible when the connected wallet owns the pool's LP NFT.

**SWAP tab:**
- Direction toggle: `SYMBOL → USDC` | `USDC → SYMBOL`
- TokenInput for amount in
- Quote box: EXPECTED OUT + MIN OUT (0.5% fixed slippage)
- Approve → Swap button flow

**TODO (swap):**
- [ ] Configurable slippage tolerance
- [ ] Show price impact %

**LONG / SHORT tab:**
- Direction toggle: `▲ LONG SYMBOL` (green) | `▼ SHORT SYMBOL` (red)
- Info row: LEVERAGE CAP (`UNLIMITED` when cap = uint256 max) + POSITION FEE (5%)
- TokenInput for USDC notional
- **Auto-slippage:** computed as price impact + 0.1% MEV buffer; displayed as `AUTO X.XX%` with an `EDIT` button to switch to manual override; manual mode shows number input + `AUTO` button to revert
- High-impact warning (>2%): slippage row border turns orange, label becomes `⚠ HIGH IMPACT · SLIPPAGE`
- Fee preview: "Fee from wallet: $X.XX (5% of notional)"
- Quote box: estimated position size + min with slippage
- Approve → Open button flow

**TODO (long/short):**
- [ ] Show current spot price and estimated entry price
- [ ] Show max position size in plain dollar terms

**LIQUIDITY tab (LP NFT owner only):**
- Visible only when connected wallet is the LP NFT holder
- Stats: BACKED TOKEN / BACKED USDC / LP FEES ACCUMULATED (green)
- Warning banner when `openPositionCount > 0` (cannot remove liquidity)
- Add Liquidity section with two TokenInputs (token + USDC) + approve/add flow
- Remove Liquidity button (disabled when positions are open; contract takes no arguments — withdraws all liquidity)
- Claim Fees button showing accumulated fee amount

**POSITION CAPS section (LP NFT owner only):**
- Read-only display of current `maxPositionUsd` (USDC, 6 dec) and `maxPositionBps` (bps, 0–9900); shows `UNLIMITED` when 0
- Two inputs: USD CAP (in USDC) + BPS CAP (in bps, with live % display)
- `SET POSITION CAPS` button — calls `pool.setPositionCaps(newUsd, newBps)`; disabled until a value changes and passes validation
- Validation: `maxPositionBps` must be 10–9900 or 0; error shown inline if invalid

**Access control for position caps:** LP NFT holder only — calls `setPositionCaps(newUsd, newBps)`.

**TODO (liquidity):**
- [ ] List open positions in this pool for LP to force-realize (UX-06)
- [ ] Show LP NFT ID and owner address

**TODO (pool page general):**
- [ ] Price chart (OHLCV — Phase 2, requires indexer)
- [ ] Recent trade feed (Phase 2, requires indexer)

---

### 4.4 Portfolio Page (`/portfolio`)

Requires wallet connection (wrapped in ChainGuard).

#### Layout
Positions split into two sections: **LONG POSITIONS (N)** / **SHORT POSITIONS (N)**, each with a coloured section header (green / red). Loading state shows spinner.

#### Position Card (`src/components/position/PositionCard.tsx`)
Each open position NFT renders a card showing:
- LONG / SHORT tag badge + NFT ID + opened date
- Data grid: USDC IN / LOCKED TOKEN / DEBT / EST. P&L
- P&L calculation:
  - **Long:** `currentValue = lockedAirToken × spotPrice / 1e18`; `pnl = currentValue - airUsdMinted`
  - **Short:** `currentTokenCost = airTokenMinted × spotPrice / 1e18`; `pnl = lockedAmount - currentTokenCost`
  - P&L displayed in green (profit) or red (loss)
- Truncated pool address with link to pool page
- **CLOSE** button — disabled with tooltip explanation when position is underwater (`canClose = false`)
- **REALIZE** button — with tooltip: "Pay the debt and receive the underlying locked tokens."
- Underwater hint text shown below buttons when `canClose = false`

`canClose` logic:
- Long: `currentValue >= airUsdMinted`
- Short: `lockedAmount >= currentTokenCost`

**TODO:**
- [ ] Realize flow: check and prompt for USDC approval (long) or underlying token approval (short) before realizing
- [ ] Position NFT transfer button
- [ ] Closed position history (Phase 2, requires indexer)
- [ ] All-time P&L summary (Phase 2, requires indexer)

---

### 4.5 Create Market Page (`/create`)

Requires wallet connection (wrapped in ChainGuard).

#### Form (cyber panel with corner accents)
- Token address input with live symbol/decimals lookup (green checkmark on valid address, red ✗ on invalid)
- Dev hint banner (local Hardhat only): shows test PEPE address with one-click fill button
- Seed USDC TokenInput
- Seed Token TokenInput
- Implied initial price display: `(seedUsdcRaw × 10^tokenDecimals) / seedTokenRaw`, formatted as `$X.XX per SYMBOL`
- Advanced collapsible section: Max Position USDC + Max Position BPS

#### Button Flow (sequential, one visible at a time)
`FILL IN ALL FIELDS` (disabled) → `CHECKING ALLOWANCES…` (spinner) → `APPROVE USDC` → `APPROVE SYMBOL` → `CREATE MARKET`

Each approval uses its own independent `useWriteContract` hook so success state does not bleed between the two approvals.

On success: decodes `MarketCreated(address pool)` event from receipt, invalidates queries, navigates to `/markets/:newPoolAddr`.

**TODO:**
- [ ] Warn if seed amounts imply a very low or very high initial price
- [ ] Show current wallet USDC balance and warn if insufficient for seed
- [ ] Explain position cap fields with tooltips

---

## 5. Transaction Feedback

| State | Behaviour |
|---|---|
| Idle | Button shows idle label |
| Pending (wallet signing) | Spinner + `SIGNING_` blinking cursor |
| Confirming (on-chain) | Spinner + `CONFIRMING_` blinking cursor |
| Success | Green `DONE` (or context-specific label) |
| Error | Red `FAILED` |

**TODO:** Decode and display revert reason strings on error (e.g. "Position underwater", "Slippage exceeded").

---

## 6. Wallet & Chain

| Item | Status |
|---|---|
| Injected wallets (MetaMask, Rabby, etc.) | ✓ EIP-6963 auto-discovery via `injected()` connector |
| WalletConnect v2 | ✓ Implemented via `walletConnect({ projectId })` |
| Coinbase Wallet | ✓ Detected via injected auto-discovery if installed |
| Hardhat local (31337) | ✓ Implemented |
| Avalanche Fuji testnet (43113) | ✓ ChainGuard implemented; contracts not yet deployed |
| Avalanche C-chain mainnet | ✗ Not configured |

WalletConnect project ID stored in `VITE_WC_PROJECT_ID` environment variable (see `.env.example`).

---

## 7. Local Development

**Hardhat local node** (chain ID 31337):
- Run: `npx hardhat node` then `npx hardhat run scripts/deployLocal.ts --network localhost`
- Deploy script writes addresses to `packages/site/src/contracts/localAddresses.json`
- Mints 1,000,000 USDC + 1,000,000 PEPE to deployer, treasury, user1, user2
- Prints private keys for 3 test wallets (standard Hardhat deterministic accounts)

**Test wallets:**
| Wallet | Address | Funded with |
|---|---|---|
| Deployer (signers[0]) | `0xf39Fd...92266` | 10k ETH · 1M USDC · 1M PEPE |
| User 1 (signers[2]) | `0x7099...79C8` | 10k ETH · 1M USDC · 1M PEPE |
| User 2 (signers[3]) | `0x3C44...6D80` | 10k ETH · 1M USDC · 1M PEPE |

LpNFT bytecode-patch: deployed from a throwaway signer then `hardhat_setCode` replaces the immutable factory address — matches the test fixture pattern.

---

## 8. Indexer / Phase 2 (deferred)

The following features require a Ponder indexer and are not part of the MVP:

- Real price chart (OHLCV candles) on Pool page and Feed page
- 24h volume and price change on Markets page
- Closed position history on Portfolio page
- All-time P&L on Portfolio page
- LP fee earnings history
- Recent trade feed on Pool page

Planned stack: Ponder (TypeScript, Railway deployment) + GraphQL, consumed via `@tanstack/react-query`.

---

## 9. Outstanding TODO Summary

| ID | Area | Item | Priority |
|---|---|---|---|
| UI-01 | Pool / Swap | Configurable slippage on Swap tab | Low |
| UI-02 | Pool / Swap | Show price impact % on Swap tab | Medium |
| UI-03 | Pool / Trade | Show spot price and estimated entry on Long/Short | High |
| UI-04 | Pool / Trade | Show max position size in plain dollar terms | Medium |
| UI-05 | Pool / LP | List underwater positions for LP to force-realize | High |
| UI-06 | Pool / LP | Show LP NFT ID and owner | Low |
| UI-07 | Portfolio | Realize flow: USDC/token approve pre-check | High |
| UI-08 | Portfolio | Position NFT transfer button | Medium |
| UI-09 | TxButton | Decode and display revert reason on error | High |
| UI-10 | Create | Seed amount validation and balance check | Medium |
| UI-11 | Create | Tooltip explanations for position cap fields | Low |
| UI-12 | Star rating | Factor in pool health beyond TVL | Medium |
| UI-13 | Feed | Swipe gesture (left = skip, right = pick direction) | Low |
| UI-14 | Feed | Real OHLCV chart (Phase 2) | Phase 2 |
| UI-15 | All | Mobile responsive review | Low |

---

*— End of Document —*

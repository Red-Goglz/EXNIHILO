# TODO — Position UX: fees, renewal & time framing

Ideas from the 2026-07 design discussion on making position fees/renewals feel
rewarding instead of anxious. Core principle: **don't change the economics
(LP must keep earning the same), change the framing.** Users are detached,
multi-position, PnL-watching — avoid anything that demands per-position
attention.

---

## 1. Auto-renewal (keeper + Permit2 runway)

Renewal happens silently in the background; the user never sees an expiry
countdown. The one recurring ritual is topping up a **runway** — an allowance
sized in time, not tokens ("covers ~6 weeks of renewals").

**Contract changes**
- [ ] Per-position (or per-holder) `autoRenewEnabled` opt-in flag.
- [ ] Renewal path through the **Router** (single spender across all pools),
      pulling the fee from the *holder* (not msg.sender) when opted in.
      Griefing stays fixed (NM-004): keeper can only extend positions the
      holder explicitly opted in and funded; renewals still capped by
      `closeDate`.
- [ ] Keeper entry point: permissionless "renew if opted-in and funded".
      Renew nearest-deadline-first when runway can't cover everything; never
      fail silently.
- [ ] Keeper gas: add a few cents to the pulled fee per renewal so the system
      is self-funding and anyone can run the keeper.

**Permit2 integration (primary flow)**
- [ ] Router pulls fees via Permit2 **AllowanceTransfer**: user signs
      `PermitSingle { token: USDC, spender: Router, amount: runway budget,
      expiration: runway end }` — gasless grant, on-chain-enforced expiry.
- [ ] One-time bootstrap `USDC.approve(Permit2, max)` only for wallets that
      never used it (many Avalanche wallets already have it via Uniswap).
- [ ] Verified deployed at `0x000000000022D473030F116dDEE9F6B43aC78BA3` on
      **Avalanche C-Chain and Fuji** (checked 2026-07-10). Tests can inject
      the canonical bytecode via `hardhat_setCode` (same trick as the LpNFT
      immutable patch).
- [ ] Keep a plain-approve fallback path for wallets without typed-data
      signing.

**Frontend**
- [ ] Runway = `min(allowance, balance) / Σ(per-period fees of auto-renew
      positions)` — renewal fees are deterministic (5% base, no impact fee),
      so this is exact. Display as a date: "auto-renew funded until Sep 3".
- [ ] Bundle the approval at **position open**: open fee + N renewal periods
      in one signature (default N = 4, adjustable). No nag later.
- [ ] Low-runway = passive amber badge + one-tap gasless top-up, not a modal.
- [ ] Renewals surface only as receipt lines, never as events to act on.

## 2. Fee rebate / loyalty credit ("time earns you something")

Idle-game inversion: since both sides pay (no perps-style funding netting),
make part of the fee *feel* earned back by patience. Economically it's a
discount schedule on renewals, prepriced into the fee — LP revenue unchanged.

- [ ] Per-position fee credit accrues while the position lives
      (e.g. ~0.1%/day of notional), applied automatically against the next
      renewal fee.
- [ ] Position card shows "credits earned: $0.84 ↑" ticking up — the number
      that grew while you were away is the dopamine hit.
- [ ] Variant / addition: loyalty pot — a slice of each renewal fee (e.g.
      0.5%) accrues per position, paid back on **voluntary** close, forfeited
      on expiry-liquidation. Forfeits fund the rebates; also softens NM-003
      (nudges holders to close expired positions themselves).
- [ ] Rebate threshold doubles as the runway top-up nudge: "top up $4 to stay
      on track for your fee credit" (reward-framed, not threat-framed).

## 3. Invert the timer: show position age, not renewal countdown

Count-up instead of count-down (Duolingo-streak trick — the loss mechanic
exists but is never the ambient display).

- [ ] Position card shows **"open for 12 days"** (age since `openedAt`)
      instead of "expires in 2d 13h".
- [ ] Expiry/renewal countdown only surfaces as an exceptional warning when
      auto-renew is off AND deadline is near (Snapchat-hourglass pattern).
- [ ] If any countdown is shown, point it at a reward, not a loss:
      "fee credit unlocks in 2d 6h" (same timestamp, positive endpoint).
- [ ] PnL displayed **net of all fees paid** — the renewal cost lives inside
      the green/red number users already watch (display half of the perps
      funding trick), never as a separate charge event.
- [ ] NFT `tokenURI` could render age/credit state too (SVG pipeline already
      reads live pool data via `quoteClose`).

---

## Explicitly rejected

- **Decaying collateral / static-decreasing fee** — loss aversion: watching
  a position shrink churns users (theta-decay anxiety).
- **Attention-demanding mechanics** (feeding/streak rituals per position) —
  wrong for detached multi-position users; keep them as optional cosmetics
  at most.
- **Randomized fee rewards (loot-box renewals)** — strongest dopamine but
  gambling flavor + on-chain randomness is manipulable; if ever, cosmetic
  rewards only.

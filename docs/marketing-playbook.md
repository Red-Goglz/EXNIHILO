# EXNIHILO — Marketing Playbook

**Post-launch. Chain-of-Conclusion structured.**
Companion to [`gtm.md`](./gtm.md) — that doc covers *sequencing* (Cold Start / atomic
networks). This one covers *persuasion*: what each audience must conclude, in what
order, and the exact content that walks them there.

---

## 0. The repositioning this whole playbook rests on

Everything below assumes one change: **stop selling "leveraged trading." Start selling
options.**

Read the mechanics as a stranger would:

| What the docs say | What it actually is |
|---|---|
| Pay only the fee, no collateral | A **premium** |
| Max loss = fees paid | Premium is the max loss — defined risk |
| Losing positions can't be closed, they expire | Expiring **worthless** |
| Fixed `positionDuration`, renewal fee | **Expiry** + roll cost |
| No liquidation engine | No margin call — the defining option property |

EXNIHILO longs are **calls**. Shorts are **puts**. The premium is 5% of notional plus
the impact fee. There is no strike to pick, no IV to model, no Greeks. It is the
simplest option ever shipped.

**Why this matters more than any campaign:** "leveraged trading with no liquidations"
sounds like a lie to anyone who knows derivatives — their first thought is *"then who
eats the loss? this is a scam."* "It's an option, the premium is the max loss" is
instantly, structurally believable, because everyone already knows options work that
way. You convert a credibility *liability* into a credibility *asset* with a word swap.

**The arithmetic that powers the entire trader story:**

```
Notional        $100
Cost to open    ~$5.08   (5% base + impact in a $10k pool)
Token +50%      →  ~$50 profit on $5.08 spent   ≈ 10x on capital
Token +200%     →  ~$200 profit on $5.08 spent  ≈ 40x on capital
Token -90%      →  you lose $5.08. That is the floor. Always.
```

And the fee floor is **0.05 USDC**, so a $1 position is economically real. Nobody else
in DeFi sells a $1 option on a token that launched this morning.

---

## 1. The Chain of Conclusion — how to use it

The rule set, so nobody on the team breaks the chain:

1. **Never assert the destination.** Never write "EXNIHILO is amazing for small
   traders." Write the premises that make the reader conclude it.
2. **Every link must be already-believed or one-step-verifiable.** If a link needs
   faith, it isn't a link — it's a claim, and the chain snaps there.
3. **Order is not optional.** Link 6 is unpersuasive without link 4.
4. **Handle the killer objection *inside* the chain**, before they raise it. An
   objection you raise yourself is credibility; one they raise is an exit.
5. **The last link is always an action so small it's embarrassing to refuse.**

Three audiences → three chains. They are not interchangeable.

---

## 2. CHAIN A — Traders (the low-capital, high-conviction persona)

This is the chain behind the "$5 and a dream" thesis. Note that the emotional payload
survives while the framing stays defensible: the enemy is **structural**, not personal.

| # | Conclusion they reach | The premise you supply |
|---|---|---|
| 1 | "I've been priced out of every trade I was right about." | Their own memory. Just name it. |
| 2 | "It was never my read that was wrong. It was my size." | Show a real chart + the P&L difference between $50 and $5,000 on the same call. |
| 3 | "Leverage was supposed to fix that, but it takes my whole stack when I'm early." | Liquidation stats. Everyone has been wicked out of a winning trade. |
| 4 | **"My real enemy isn't being wrong. It's being liquidated before I'm right."** | ← **PIVOT LINK.** This reframes the entire category. Spend the most words here. |
| 5 | "So I don't need more leverage. I need exposure that can't be called back." | Logic — they draw it themselves. Do not state it for them. |
| 6 | "That's impossible with borrowed money. Something borrowed can always be recalled." | Definitional. One step. |
| 7 | "…so it would have to not be borrowed at all." | The gap. Now they *want* the mechanism. |
| 8 | "EXNIHILO mints exposure out of thin air instead of lending it — nothing to recall." | The unique mechanism. Name it: **three-curve AMM, synthetic mint.** |
| 9 | "Then my cost is the fee, and the fee is all I can ever lose." | Arithmetic. Show the $5.08 table. |
| 10 | "So $5 moves like $100, and no one can take it from me before I'm right." | The desire. They say it, not you. |
| 11 | "But it expires — I have to be right inside the window." | **Pre-handled objection.** Never hide this. It is what makes 1–10 believable. |
| 12 | "Fine. $5 to find out." | The action. |

**Link 11 is non-negotiable.** Volunteering the expiry is what buys belief for links
9–10. Copy that hides it will convert worse, not better.

**Banned phrases** (they break link 4 by sounding like the thing you're differentiating
from): "up to 100x", "get rich", "life-changing money", "financial freedom",
"escape poverty", "guaranteed".

---

## 3. CHAIN B — Token projects / LPs (the actual bottleneck)

You have zero markets. Trader marketing spends into an empty app and burns the
audience permanently — a trader who lands on an empty market feed does not come back.
**This chain runs first and alone until 3 pools have daily volume.**

| # | Conclusion they reach | The premise you supply |
|---|---|---|
| 1 | "My chart is flat between announcements." | Their own dashboard. |
| 2 | "Holders lose interest when there's nothing to do but hold." | Universally believed in token communities. |
| 3 | "Perps are the volume engine — that's why every serious token wants one." | GMX/HL listing pumps. Verifiable. |
| 4 | "But I'll never get listed. I've asked / I know the answer." | Their lived experience. |
| 5 | **"And it's not because my token is bad — it's that their model needs an oracle and a market maker, and neither exists for me."** | ← **PIVOT.** Moves rejection from *judgment* to *structure*. Removes shame; creates openness. |
| 6 | "So the only leveraged market I can ever get is one needing neither." | Logic. |
| 7 | "EXNIHILO prices off its own curve. No oracle. No market maker. No listing desk." | The mechanism. |
| 8 | "And I'd be the **sole** LP — the speculation on my token pays *me*." | 3% of every open + impact fee + renewal fees + swap fees. |
| 9 | "The volume my community already creates for free becomes revenue." | Their own DEX volume × 3%. **Compute this number for them by name.** |
| 10 | "And my downside is bounded — caps, my pool, no admin keys, I can't be rugged." | `maxPositionBps`, immutability, LP NFT. |
| 11 | "But I'm the counterparty — a big winner is paid from my liquidity." | **Pre-handled objection.** See honesty note below. |
| 12 | "Which is what caps are for. One transaction, ~$1K, and I own the market." | Action. |

### Honesty requirement on link 11

The LP **is** the counterparty. Trader profit is paid out of `backedAirUsd`. The impact
fee is designed so LPs are compensated above the price-distortion cost — say that, and
say the risk out loud. An LP who discovers this after depositing becomes a public
enemy; an LP who was told upfront becomes a reference. Lead with `maxPositionBps = 100`
(1%) as the recommended default and explain *why* it exists.

---

## 4. CHAIN C — DeFi-native / crypto-Twitter credibility layer

These people won't trade much, but they decide whether you're legitimate. Their chain
is short and entirely mechanical. No emotion, no benefit language.

1. "No collateral + no liquidation = someone eats the loss. Who?"
2. "The LP does — and they're a single, consenting, capped, isolated party per pool."
3. "So it's a written option, and the LP is the writer."
4. "Oracle-free, so the usual manipulation vector is gone — but pool price can diverge."
5. "Immutable, no admin keys, no governance token, no upgrade path."
6. "This is a real design with real, disclosed tradeoffs. Worth a look."

Content for this audience = the mechanism thread, the reserve-accounting table, and the
security page. **Never** market to them; only explain. They convert on rigor.

---

## 5. Action points

### Phase 0 — Preconditions (do these before *any* public post)

| # | Action | Why it blocks everything |
|---|---|---|
| 0.1 | **Fix the audit contradiction.** `gtm.md:79` claims an evmbench audit; `faq/risks.md:9` says no formal audit. Standardize on the honest `protocol/security.md` version: four AI-model audit rounds, remediated, *not* a substitute for a human audit. | First thing a skeptic finds. One contradiction kills Chain C entirely. |
| 0.2 | **Seed 2–3 pools yourself.** AVAX-ecosystem tokens with real volatility. Fund the USDC side properly. | An empty market feed converts at zero and burns first impressions permanently. |
| 0.3 | **Size caps so the trader story is actually true.** At `maxPositionBps = 100` on a $1K pool, max notional is $10 — the "$100 exposure" story is false there. Either seed deeper (~$10K+) or raise caps on your own pools. | Do not publish a claim your own pools can't honor. |
| 0.4 | **Rewrite the landing hero as an option.** See §6.1. | Every downstream link points here. |
| 0.5 | **Ship a "what did $5 do" calculator** on the landing page — token move in, P&L out. | It makes links 9–10 of Chain A self-verifying instead of claimed. |
| 0.6 | Pin one long-form mechanism thread on X. | Chain C's entire conversion surface. |

### Phase 1 — Weeks 1–4: projects only (Chain B)

- Build the hit list of ~10 Avalanche projects (already scoped in `gtm.md` §2.4).
- **Before each DM, compute their number**: pull 30-day DEX volume from DexScreener,
  multiply by 3%, put that dollar figure in the first line. Chain B link 9 lands only
  if it's *their* number.
- Offer the white-glove package: you create the pool, set caps, draft their
  announcement, record the walkthrough, match ~$500–1K on the USDC side.
- Target: **3 pools with daily volume.** Not ten. Three.
- Zero trader marketing this phase. None.

### Phase 2 — Weeks 5–10: proof + first trader push (Chain A opens)

- Publish weekly pool stats: fees earned by LP, unique traders, volume. Screenshot-first.
- Now run Chain A content — you finally have markets to point at.
- Trading competition per partner pool ($100–300). Prize structure should reward
  **% return, not absolute P&L**, so small accounts can win. That single rule choice
  *is* the "small capital can win" thesis made real, and it generates your best
  testimonials.
- Recruit projects #4–8 using pool #1's numbers.

### Phase 3 — Weeks 10+: loops

- Position-NFT showcases (the on-chain SVG P&L art is genuinely shareable — most
  protocols have nothing like it; a winning position is a *screenshot people post*).
- "Token of the week" long/short callouts.
- Joint X Spaces where the *project* tells the story, not you.
- KOLs only now, and only mid-tier degen accounts who will actually place a $5 trade
  on stream.

### The one metric per phase

| Phase | Metric | Target |
|---|---|---|
| 0 | Pools live with non-zero depth | 2–3 |
| 1 | Partner pools with daily volume | 3 |
| 2 | Unique traders across ≥5 pools | 50+ |
| 3 | Pools created without your involvement | 1+/week |

---

## 6. Content

### 6.1 Landing page hero (replaces "Leveraged trading with no collateral")

> # EXNIHILO
> ### $5 moves like $100. And nothing can liquidate you.
>
> Long or short any ERC-20 token on Avalanche. You pay a fee, not collateral —
> and that fee is the most you can ever lose.
>
> `[ Launch App ]` `[ How it works ]`
>
> *Every position expires. Renew it, or let it settle.*

Subhead row (replacing the current four features):

- **Your loss is capped at the fee** — no collateral, no margin, no liquidation engine.
- **No one lists your token? Now you do.** One transaction creates the market.
- **Positions are NFTs** — on-chain SVG art with live P&L. Transferable, sellable.
- **No oracles, no admin keys, no token.** Immutable from day one.

### 6.2 Flagship X thread — Chain A, trader-facing

> **1/**
> You've been right about a coin and still made $40.
>
> Not because your read was wrong. Because you had $200 and the guy who made
> $80k had $400,000.
>
> Crypto doesn't pay the correct. It pays the capitalized.
>
> **2/**
> The standard fix is leverage. And it works — right up until it doesn't.
>
> You go 10x long. You're right about the direction. The chart wicks 12% on a
> Tuesday, takes your entire position, and *then* goes where you said.
>
> You were right. You still got nothing.
>
> **3/**
> Sit with that, because it's the actual problem:
>
> **Your enemy was never being wrong. It's being liquidated before you're right.**
>
> Direction risk you can handle — that's the game you signed up for. Timing risk
> is the one that empties accounts.
>
> **4/**
> So what would actually fix it?
>
> Not more leverage. Not lower fees. Not better entries.
>
> You'd need exposure that nobody can call back — no matter what the chart does
> between now and being right.
>
> **5/**
> Here's the problem: every leveraged product on earth lends you the exposure.
>
> And anything lent can be recalled. That's not a design flaw. That's what
> borrowing *is*.
>
> Which means the fix can't be a better loan. It can't be a loan at all.
>
> **6/**
> EXNIHILO doesn't lend you exposure. It mints it out of thin air.
>
> Three constant-product curves. When you open, the protocol mints synthetic
> units that shift the price curve — creating real directional exposure backed
> by no borrowed capital.
>
> Nothing was lent. So there's nothing to recall.
>
> **7/**
> Which changes the arithmetic completely:
>
> You don't post collateral. You pay a fee — about 5% of your position size.
>
> $100 of exposure costs ~$5.
> Token doubles → ~$100 profit on $5 spent.
> Token goes to zero → you lose $5.
>
> **8/**
> That's not "leverage."
>
> Defined premium, unlimited upside, expiry, no margin call — that's an **option**.
> EXNIHILO longs are calls. Shorts are puts.
>
> No strike to pick. No IV. No Greeks. Just: pay the premium, pick a direction.
>
> **9/**
> The catch, stated plainly:
>
> Positions expire. Default 7 days. You renew (fee), let it auto-renew from its
> own profit, or it settles.
>
> Underwater at expiry = you get nothing. You knew that when you paid the fee.
>
> You have to be right *within the window*.
>
> **10/**
> But here's what that buys you:
>
> For 7 days, nothing on earth can take that position from you. No wick. No
> cascade. No margin call at 4am. You close it when you decide.
>
> Your worst case was priced and paid upfront.
>
> **11/**
> And because the fee floor is $0.05, a $1 position is real.
>
> There is no other venue in DeFi where $5 buys a genuine leveraged position on
> a token that launched this morning.
>
> Not because they won't. Because their model can't.
>
> **12/**
> Any ERC-20. Permissionless — if no market exists, you create one.
> Avalanche C-Chain. USDC. No token, no governance, no admin keys, immutable.
>
> exnihilo.markets
>
> **13/**
> Risk, said out loud: unaudited by a human firm (4 AI audit rounds, all public).
> Pool prices can diverge from external markets. LPs are the counterparty.
> Positions expire worthless if you're wrong.
>
> Trade $5 before you trade $500.

### 6.3 Short-form posts

**a. The pivot, standalone**
> Every liquidation you've eaten was the market agreeing with you eventually.
>
> You weren't wrong. You were early with borrowed money.
>
> On EXNIHILO you're never early with borrowed money, because nothing is borrowed.

**b. The arithmetic**
> $5.08 → $100 of exposure.
> Coin does 3x → ~$200.
> Coin does -100% → you're out $5.08.
>
> Not leverage. An option. The premium is the whole risk.

**c. Category definition**
> Perps ask: how much collateral can we take from you when you're wrong?
> EXNIHILO asks: how much do you want to pay upfront to never be asked that?

**d. For projects**
> Your token will never be listed on GMX.
>
> Not because it's bad. Because their model needs a Chainlink feed and a market
> maker, and neither will ever exist for a token your size.
>
> Ours needs neither. One transaction.

**e. For projects, the number**
> Your token did $340k of DEX volume last month.
>
> You earned $0 from it.
>
> Be your own market's LP and 3% of every leveraged position on your token is
> yours. Plus swap fees. Plus renewal fees.

**f. The NFT hook**
> Your position is an NFT with live P&L rendered fully on-chain.
>
> Not a database row. Not an entry in our backend. A transferable asset that
> draws its own profit.
>
> Sell the position without closing it.

**g. Skeptic pre-empt (Chain C)**
> "No collateral and no liquidation? Who eats the loss?"
>
> The LP. Explicitly. One consenting party per pool, position caps they set,
> compensated by an impact fee that scales quadratically with position size.
>
> It's a written option. The LP is the writer. Nothing is hidden.

**h. Anti-hype flex**
> No token. No points. No airdrop. No governance. No admin keys. No upgrade path.
>
> We can't rug you because we deployed ourselves out of the ability to.

### 6.4 Project DM template (Chain B, compressed)

Send from a personal account. Never paste this verbatim — the specifics are the point.

> Hey [name] — [specific, genuine observation about their recent activity].
>
> $[TICKER] did ~$[X] in DEX volume last month. You earned nothing from it.
>
> I built a protocol on Avalanche where anyone can create a leveraged market for
> any ERC-20 — no oracle, no market maker, no listing process, because pricing
> comes off the pool's own curve. That's why GMX can't list you and this can.
>
> You'd be the sole LP. 3% of every position opened on $[TICKER], plus swap fees,
> plus renewal fees. You set the position size caps. Immutable contracts, no
> admin keys — I can't touch your pool.
>
> Straight about the risk: you're the counterparty. A big winner is paid from your
> liquidity. That's what the caps are for, and there's an impact fee sized to
> compensate you above the distortion cost. Happy to walk you through the math.
>
> I'll do the whole setup, draft your announcement, and match $1k on the USDC side
> for the first few partners.
>
> Worth 10 minutes?

### 6.5 Partner announcement template (they post, not you)

> **$TICKER is now leveraged.**
>
> You can go long or short $TICKER on EXNIHILO — no collateral, no liquidations.
> You pay a fee, and that fee is the most you can lose.
>
> $5 gets you the same price exposure as $100.
>
> We're the liquidity provider for this market, so every position opened earns
> fees back to the project.
>
> Positions expire (7 days) — renew or let them settle. Underwater positions
> settle worthless, so size accordingly.
>
> → exnihilo.markets/app
> Walkthrough: [link]

### 6.6 Reply bank

| They say | You say |
|---|---|
| "Ponzi / where's the money from" | LP is the counterparty, explicitly, per pool, capped, compensated by impact fee. It's a written option. |
| "5% fee is insane" | It's a premium, not a trading fee. Compare to an option premium, not to a perp taker fee — and it's the entire downside. |
| "No liquidations is impossible" | Correct, for borrowed exposure. This isn't borrowed — it's synthetically minted, so there's nothing to recall. |
| "AMM pricing = manipulable" | No oracle to manipulate. Pool price can diverge from external markets — that's an arb opportunity and it's documented. |
| "Is it audited" | Four AI-model audit rounds, all findings and remediations public. No human firm yet. Stated on the risk page. |
| "Is there a token" | No, and no plans. Contracts are immutable. |
| "What if the LP rugs" | LP can only withdraw when no positions are open. They cannot force-close a profitable position. |

---

## 7. Message discipline

**Always:**
- "Option" / "premium" / "expiry" — not "leverage" / "collateral" / "margin"
- Lead with the capped downside before the upside
- State expiry unprompted, every time
- Use real numbers ($5.08, $0.05 floor, 3%), never ranges or "up to"

**Never:**
- "Up to Nx"
- Any wealth-outcome promise, explicit or implied
- Targeting audiences by economic desperation. The message is *access* — size
  shouldn't decide who wins. Same insight, defensible in public, and it doesn't
  hand a critic a screenshot.
- Marketing a pool whose caps make the headline claim false

---

*Companion: [`gtm.md`](./gtm.md) for phase sequencing and competitive analysis.*

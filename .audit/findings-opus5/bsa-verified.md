# Behavioral State Analysis — Verified (Opus 5)

**Date:** 2026-07-27
**Method:** classify the contract type, model its state machine, and run only the
threat engines that apply to that shape.

```
0 CRITICAL | 0 HIGH | 0 MEDIUM | 1 LOW | 2 INFO
```

## Contract classification

`EXNIHILOPool` is a **single-LP synthetic derivatives AMM** — an unusual hybrid:

| Dimension | Classification | Consequence for threat selection |
|---|---|---|
| Custody | Holds both underlying and USDC | Custody/solvency engines apply |
| Liquidity | **Single LP per pool**, identified by NFT | Share-accounting engines **do not** apply — there are no shares |
| Pricing | Self-referential constant-product | Oracle engines do not apply |
| Positions | Synthetic, minted against reserves | Debt/solvency engines apply |
| Upgradeability | None | Proxy engines do not apply |
| Authorization | Direct `msg.sender` only | Signature engines do not apply |

The single-LP model is the most consequential classification. It removes an
entire family of threats that dominate normal AMM audits: no share price to
inflate, no first-depositor donation attack, no proportional-withdrawal rounding
exploit, no dilution. `addLiquidity` enforces the existing reserve ratio to 1bp
and `removeLiquidity` is all-or-nothing.

## State machine

```
        createMarket
             │
             ▼
    ┌──────────────┐  addLiquidity / swap / openLong / openShort
    │     OPEN     │◄──────────────────────────────────────┐
    │ closeDate==0 │                                        │
    └──────┬───────┘                                        │
           │ closePool()                          renew / settle
           ▼                                                │
    ┌──────────────┐                                        │
    │   CLOSING    │  no new opens; renewals capped ────────┘
    │ closeDate!=0 │  at closeDate
    └──────┬───────┘
           │ all positions settled (openPositionCount == 0)
           ▼
    ┌──────────────┐
    │  DRAINABLE   │  removeLiquidity()
    └──────────────┘
```

Transitions are one-way: `closeDate` can only be set once (`PoolAlreadyClosed`)
and never cleared. There is no path back from CLOSING to OPEN, so the wind-down
is monotonic — an LP cannot be trapped indefinitely by a counterparty, and a
trader cannot have a live position rugged mid-flight.

**Per-position sub-machine:** `open → (renew)* → settled`. `renew` extends the
deadline; `settle` is terminal and burns the NFT. `openPositionCount` is the link
between the two machines and gates the DRAINABLE transition.

## Threat engines run

**Custody / solvency** — see `state-invariant-verified.md`. Invariant I4 is now
an exact conservation law covering backed reserves, short collateral, unclaimed
fees, and credited payouts. Asserted at 7 sites. `slack = 0` empirically.

**Debt accounting** — synthetic supply (`airTokenSupply`, `airUsdSupply`) versus
real backing (`backedAirToken`, `backedAirUsd`). I1/I2 enforce
`backed <= supply` on every path. The gap between them *is* the outstanding
synthetic debt, so the invariant directly encodes "the pool never owes more
backing than it holds".

**Authorization state** — every transition is gated on live ownership
(`lpNftContract.ownerOf`, `positionNFT.ownerOf`) rather than a cached address, so
transferring the LP NFT or a position NFT transfers control atomically with no
stale-authority window. This is the correct pattern and is applied consistently.

**Lifecycle ordering** — keeper actions require `block.timestamp >= pos.deadline`;
renewals require the new deadline to fall within `closeDate`. No state can be
reached where a position outlives its pool.

**Economic state** — fee parameters are immutable per pool
(`swapFeeBps`, `positionDuration` set at construction). `setPositionCaps` is the
only mutable economic knob and is LP-only, bounded 10–9900 bps. An LP tightening
caps cannot retroactively affect open positions — `_checkLeverageCap` is
evaluated only at open.

## LOW-BSA-1 — the DRAINABLE transition depends on counterparty cooperation

`removeLiquidity` requires `openPositionCount == 0`. An LP wanting to exit must
wait for every position to settle. Holders can renew their own positions
indefinitely, each time paying the dynamic renewal fee.

Mitigated, not eliminated: `closePool()` bounds the wait to one
`positionDuration` (renewals past `closeDate` revert), and the LP continues
earning fees throughout. Prior finding NM-004 — which made this *worse* by
letting anyone renew anyone's position — is closed, since `renewPosition` now
requires `ownerOf(nftId) == msg.sender`.

Residual: an LP cannot exit instantly. That is inherent to writing derivatives
against your own liquidity, and is disclosed behaviour rather than a defect.

## INFO-BSA-1 — emergency deployer is a state-machine actor

`closePool()` accepts `factory.deployer()` as well as the LP holder, so a
protocol-level EOA can force any pool from OPEN into CLOSING. It moves no value
and cannot prevent settlement or withdrawal, but it is an out-of-band transition
authority over every market. Same substance as NM-OP5-002 / LOW-DOS-2.

## INFO-BSA-2 — auto-renew is holder-authorized, keeper-executed

The most behaviourally complex path in the protocol: a third party (keeper)
triggers a state transition that spends the *holder's* equity. Verified safe —
requires holder opt-in (`getAutoRenew`), respects the holder's `maxFee` cap,
requires `surplus >= totalFee + KEEPER_BOUNTY`, and refuses if the new deadline
would exceed `closeDate`. The keeper's only reward is the flat bounty, clamped to
available funds.

Worth continued attention on any future change: it is the one place where an
unprivileged caller moves another user's money.

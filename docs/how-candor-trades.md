# How Candor decides to trade

This is the orientation document for the strategy layer: how a stream tick becomes a
position, written for someone reading the code for the first time. The parameter values
referenced here live in `src/strategy/params.ts` (the frozen object whose hash is embedded
in every on-chain commit), and their derivation, including the dead ends, is in
`docs/params-tuning.md`.

The one-sentence version: Candor does not pick markets; it prices the entire quoted board
from the board itself, and acts only where one line disagrees with all its siblings by more
than the engine's own measured noise.

## 1. The board

For each live fixture, TxLINE's StablePrice consensus quotes three market types: match
result (1X2), goal totals (over/under), and Asian handicap, across two scopes we trade
(full match and first half), with totals and handicaps at several lines each. That is
typically 15 to 30 distinct lines per fixture, most updating several times a minute. The
worker holds the latest quote per line in memory (`src/worker/engine.ts`) and feeds every
tick to the movement detector.

Each quote carries demargined probabilities (the `Pct` array), which matters twice: it
means entries are priced against a vig-free consensus, and it means quarter lines, which
never carry probabilities in this feed, can never be signal targets.

## 2. The model (src/model/fairprice.ts)

Every five seconds, per scope:

1. **Invert the totals lines.** A quote like "under 1.5 first-half goals at 73%" implies a
   goal expectation. Solving that inversion across every fresh over/under line at once,
   weighted toward the most balanced lines, yields lambda: the expected remaining goals in
   scope. This reads the remaining expectation off the live lines directly; it is never
   "pre-match mean minus goals scored", which breaks late in matches.
2. **Split lambda between the teams** with a one-parameter least-squares fit anchored to
   the quoted 1X2 (most balanced handicap as fallback).

The result is a Poisson model of the remainder of the match as the market itself implies
it, able to price any line on the board, including lines that were not used in the fit.
Cross-validated on full recordings, its prices agree with the consensus within about one
probability point on average; that measured disagreement is the noise floor everything
below is calibrated against.

Two empirically established conventions are baked in, both discovered by testing against
recorded matches with known outcomes: in-running Asian handicap lines apply to the goals
scored from entry onward (the current score never enters the handicap arithmetic), and
totals lines refer to final scope totals.

## 3. The scan (src/strategy/divergence.ts)

The model price minus the demargined market price, per line and side, is the edge. Because
the model was built from the market complex, an edge on one line means that line disagrees
with all the other lines: an internal inconsistency of the consensus. The scan produces
candidates; the gates then kill almost all of them:

- **Honest fill:** the quote must be at most 20 seconds old AND must postdate the last
  score change. Lines suspend around goals; comparing a post-goal model against a frozen
  pre-goal quote manufactures a huge fictional edge on a price that no longer exists.
- **No longshots, no near-dead lines:** both probabilities within 0.20 to 0.85 and the
  price at most 3.5. A raw Poisson systematically finds fake "value" on longshots
  (favorite-longshot bias), so that region is excluded by construction.
- **Per-market thresholds above the noise floor:** 2.5 points for totals and 1X2 (above
  the p90 cross-line disagreement of every such bucket in validation), 6.0 for Asian
  handicap (the model's weakest bucket; in the first tuning sweep every AH "edge" below
  that was model error, and every one lost).
- **Fit quality:** at least two totals lines inverted and an anchor residual under 3
  points, or the whole scope is untradable this cycle.
- **Phase and clock:** open regulation play only (first or second half), no new entries
  after the 85th minute, never at halftime, never in extra time.
- **Cooldown and exposure:** one entry per line per ten minutes; at most 2 concurrent
  positions per match, 4 overall, 6 lifetime per match.

The anchor line itself is excluded (its divergence is near zero by construction).

## 4. The movement family (src/strategy/movement.ts)

Same scan, different trigger. Every line's tick-to-tick moves feed a rolling distribution;
a move that is both large (4+ points) and statistically exceptional for that line (z-score
3.5 against its own recent history) arms the fixture for 45 seconds. During that window the
divergence scan runs tagged as `movement`, restricted to lines that have re-quoted after
the trigger: the genuine laggards still digesting whatever the jumped line already knows.
The jumped line itself is excluded, and the honest-fill rule still applies, so suspended
quotes can never be "filled".

## 5. Sizing (src/strategy/sizing.ts)

Quarter-Kelly on the model's claimed edge at the quoted price, capped at 2% of the current
bankroll, floored at 1 unit (below the floor, no trade). The bankroll is 1,000.00 paper
units at genesis and moves only on settlement.

## 6. What happens after the decision

The ledger opens the position with a canonical JSON payload and its sha256; the commit
layer broadcasts that hash to Solana mainnet in a memo within seconds, chained to the
previous commit, before the outcome exists. Settlement happens autonomously at the feed's
`game_finalised` record using the empirically verified period bands (regulation is the
1000 band plus the 3000 band; extra time lives in the 4000 and 7000 bands). Each settled
position is then proven on-chain via the oracle's validate_stat call (`validate_stat_v3`
multiproofs since TxODDS's 2026-07-13 mainnet promotion, `validate_stat_v2` as the
automatic fallback): the position's exact win condition compiled to predicates over the
certified stats, or, for full-match markets in extra-time matches, exact certification of
the regulation components. Closing-line value is measured
at a fixed 10-minute horizon, and calibration (Brier) is published model-versus-market.

Every position, and every candidate the scan flags but the sizing or exposure gates turn
down, lands in the signal log with its reason; each UTC day's log is committed to mainnet
as a Merkle root, so nothing logged can be altered after the day closes. And because every
trade is a commit on-chain, the agent that trades twice a night cannot hide a hundred
others: a hundred trades would be a hundred commits.

## 7. Why so few trades

The consensus is internally consistent to about one probability point almost all the time.
Genuine multi-point inconsistencies on capped-price markets are rare, and the thresholds
are deliberately set above everything the engine's own error can explain. Selectivity is
the model being honest about what it knows. The record, win or lose, is the product; the
strategy's job is to be defensible, disciplined, and fully accounted for.

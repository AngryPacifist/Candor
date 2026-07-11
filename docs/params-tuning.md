# Strategy parameter derivation (replay-driven, pre-deploy)

This document records how Candor's frozen strategy parameters were derived, including the
dead ends. It exists because the parameters are part of the agent's verifiable identity:
their hash is embedded in every on-chain position commit, and this file is the paper trail
for how they were chosen before being frozen.

Data: two full World Cup matches recorded from the live TxLINE mainnet streams, both with
complete odds streams (about 72k odds ticks total). Harness: `src/replay/simulate.ts`, which
runs the exact production stack (state fold, fair-price fit, gates, both signal families,
cooldowns, Kelly sizing) against a recording deterministically.

## Step 1: measure the engine's noise floor

`scripts/validate-fairprice.ts` fits the fair-price engine every 30 seconds of stream time
and prices every fresh quoted line against the demargined consensus. Result across both
matches: mean absolute disagreement 0.3 to 1.5 probability points per market bucket, p90
between 0.6 and 2.8 points. The worst bucket (integer Asian handicap lines at very low
remaining-goals expectation, where push probability dominates) is also where an independent
Poisson model is structurally weakest.

A divergence signal below this floor is indistinguishable from model error. Any edge
threshold therefore has to clear the p90 of its market bucket.

## Step 2: the first sweep, and what it exposed

The first parameter sweep (edge thresholds 3.0 to 5.0 points, uniform across market types)
produced 1 to 13 entries over the two matches, and every single graded entry lost. Zero wins
is not variance; forensics on the entry list showed two distinct pathologies:

1. **Every entry was an Asian handicap at longshot prices (3.3 to 5.9 decimal).** The
   uniform threshold selected exactly the market where the model's residual tail is fattest,
   and the favorite-longshot bias means raw Poisson "value" on longshots is fictional. The
   scanner was not finding market mistakes; it was finding its own.
2. **Some entries filled on quotes that predated the current score.** Lines suspend around
   goals; a frozen pre-goal quote compared against a post-goal model produces a huge fake
   edge, and "filling" it is fictional because that price no longer existed.

## Step 3: the structural fixes (not threshold tweaks)

- **Honest-fill rule:** a quote is only takeable if its timestamp postdates the last score
  change. For movement-triggered scans, the quote must additionally postdate the trigger
  jump (only lines that re-quoted after the information arrived are genuine laggards).
- **Per-market thresholds:** OU and 1X2 use `minEdgePts`; AH requires `minEdgePtsAH`, set
  far above the AH bucket's p90, because that is where model error masquerades as edge.
- **Price cap (`maxPrice` 3.5) and probability band (0.20 to 0.85):** no longshots, no
  near-dead lines, on favorite-longshot grounds.

## Step 4: the re-sweep, and the honest conclusion

With the fixes in place, the sweep (edge 2.5 to 3.5, AH bar 5/6/off, price cap 3.0/3.5)
produces zero to two entries across the two matches. The conclusion we accept rather than
tune away: **the StablePrice demargined consensus is efficient with respect to a
market-anchored Poisson model.** It is internally consistent to about one probability point,
and genuine multi-point inconsistencies on capped-price markets are rare events. A backtest
that showed anything else from this data would be manufacturing edge, which is precisely the
industry disease this product exists to expose.

What that means for the agent's behavior: it trades sparingly, only on inconsistencies its
own measured noise cannot explain, sizes them with capped fractional Kelly, and lets the
measurement layer (closing-line value and Brier calibration, both on-chain-anchored) tell
the truth about whether the edges were real. Selectivity is the strategy being correct, not
the strategy failing. Note that entries are taken at demargined (vig-free) consensus prices,
so even a zero-information model is approximately EV-neutral there; the thresholds exist to
ensure we only act when the model claims information, and the record proves how those claims
performed.

## Frozen values and their rationale

- `divergence.minEdgePts = 2.5`: above the p90 cross-line disagreement of every tradable
  OU/1X2 bucket (max 2.0 excluding AH).
- `divergence.minEdgePtsAH = 6.0`: more than double the AH bucket p90 (2.55), reflecting the
  documented AH weakness.
- `divergence.maxPrice = 3.5`, `minProb 0.20 / maxProb 0.85`: favorite-longshot exclusion.
- `movement.zEnter = 3.5`, `minJumpPts = 4.0`: a jump must be both statistically exceptional
  for its line (z-score vs the line's own tick distribution) and materially large.
- `sizing`: quarter Kelly, capped at 2% of bankroll per position, exposure limits in
  `params.ts`.

## Freeze plan

Two more full matches (the Jul 11-12 quarterfinals) are being recorded. The tuning pass will
be re-run on all four recordings before deployment, any change to the values above will be
recorded here with its reasoning, and the parameters freeze at deploy time (before the first
semifinal). After that, the params hash in every on-chain commit proves they never moved.

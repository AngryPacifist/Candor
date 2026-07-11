// THE FROZEN STRATEGY PARAMETERS.
// Every threshold the agent trades with lives here and nowhere else. The hash
// of this object is embedded in every on-chain position commit, so "the
// parameters never changed mid-run" is a verifiable claim, not an assertion.
// Tuning happens ONLY on the replay recordings before deploy; the tuning run
// and its results are documented in the repo. After deploy: no changes.
// (Values marked provisional until the replay tuning pass — roadmap phase 3.)

import { canonicalJson, sha256Hex } from "../lib/canonical.js";
import { DEFAULT_FAIRPRICE_CONFIG } from "../model/fairprice.js";

export const STRATEGY_PARAMS = {
  version: "candor-params-v1",

  fairprice: { ...DEFAULT_FAIRPRICE_CONFIG },

  /** Signal family A: model-vs-consensus divergence. */
  divergence: {
    /**
     * Minimum edge for OU and 1X2 (model minus market, probability points).
     * Set above the p90 cross-line disagreement of every tradable market
     * bucket measured on the recordings (1.3-2.0pts) — we only trade
     * inconsistencies the engine's own noise cannot explain.
     * See docs/params-tuning.md for the full derivation.
     */
    minEdgePts: 2.5,
    /**
     * AH gets its own, much higher bar: replay forensics showed the model's
     * AH residual tail masquerades as edge (every graded AH entry lost in the
     * first sweep) — AH is also where independent-Poisson is weakest.
     */
    minEdgePtsAH: 6.0,
    /** both model and market prob must be inside this window */
    minProb: 0.2,
    maxProb: 0.85,
    /** never buy longshots: favorite-longshot bias makes model "value" there fictional */
    maxPrice: 3.5,
    /** fit quality gates */
    minOuLinesUsed: 2,
    maxAnchorResidualPts: 3.0,
    /** the quote being taken must be at most this old */
    maxQuoteAgeMs: 20_000,
    /** one entry per market line per this window */
    lineCooldownMs: 10 * 60_000,
  },

  /** Signal family B: sharp movement (jump detection -> divergence on lagging lines). */
  movement: {
    /** rolling window per line over which velocity is measured */
    windowMs: 150_000,
    /** minimum ticks in window before a z-score is meaningful */
    minTicks: 6,
    /** z-score of the latest move vs the window's tick-to-tick distribution */
    zEnter: 3.5,
    /** and the move itself must be at least this big, in probability points */
    minJumpPts: 4.0,
    /** a jump arms the movement scan for this long */
    armWindowMs: 45_000,
    /** floor for the tick-to-tick std, in points (avoids z explosions on flat lines) */
    stdFloorPts: 0.35,
    lineCooldownMs: 10 * 60_000,
  },

  /** Sizing: capped fractional Kelly on a paper bankroll of units. */
  sizing: {
    startingBankrollUnits: 1000.0,
    kellyFraction: 0.25,
    maxStakePctOfBankroll: 2.0,
    minStakeUnits: 1.0,
    maxConcurrentPositions: 4,
    maxConcurrentPerMatch: 2,
    maxPositionsPerMatch: 6,
  },

  /** Measurement layer. */
  measurement: {
    /**
     * CLV horizon: compare the entry prob to the line's demargined prob this
     * long after the decision. In-play lines converge to the outcome, so a
     * "last quote" close would restate the result; the horizon isolates
     * near-term market agreement with the position.
     */
    clvHorizonMs: 10 * 60_000,
  },

  /** Phase gates: trade only in open play of regulation time. */
  gates: {
    tradableStatusIds: [2, 4],
    /** no NEW entries after this many seconds of match clock (thin, wild markets) */
    latestEntryClockSeconds: 85 * 60,
  },
} as const;

export type StrategyParams = typeof STRATEGY_PARAMS;

export const STRATEGY_PARAMS_CANONICAL = canonicalJson(STRATEGY_PARAMS);
export const STRATEGY_PARAMS_HASH = sha256Hex(STRATEGY_PARAMS_CANONICAL);

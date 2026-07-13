// The fair-price engine. From the LIVE quoted markets of one scope (full match
// or a period), fit a Poisson model of the REMAINING goals, then price any
// market in that scope. Deterministic: caller supplies the clock (nowTs).
//
// Method (a hard-won late-game lesson): the remaining-goals expectation is
// read off the live O/U lines by inversion — never "pre-match mean minus
// goals scored". The team split is anchored to the quoted 1X2 (AH fallback) by
// a one-parameter least-squares fit.
//
// Push conventions (verified against feed data in the Session-1 validation):
// the demargined Pct on integer lines is push-excluded 2-way; quarter lines are
// priced as the stake-split average of the adjacent half/int lines.

import { marginDistribution, poissonPmf, poissonSf } from "./poisson.js";
import { lineClass, type ParsedLine } from "./markets.js";

export interface FairPriceConfig {
  /** a quote older than this (vs nowTs) is not used for fitting or comparison */
  maxStalenessMs: number;
  lambdaMin: number;
  lambdaMax: number;
  /** weight floor for O/U lines far from 50/50 */
  minBalanceWeight: number;
}

export const DEFAULT_FAIRPRICE_CONFIG: FairPriceConfig = {
  maxStalenessMs: 45_000,
  lambdaMin: 0.01,
  lambdaMax: 12,
  minBalanceWeight: 0.1,
};

// ── Pricing primitives (model side) ────────────────────────────────

/**
 * P(over wins | no push) for an O/U goal line, given goals already scored in
 * scope and remaining-goals mean lambda. Returns null when degenerate.
 */
export function probOver(lambda: number, goalsSoFar: number, line: number): number | null {
  const need = line - goalsSoFar;
  const cls = lineClass(line);
  if (cls === "quarter") {
    const lo = probOver(lambda, goalsSoFar, line - 0.25);
    const hi = probOver(lambda, goalsSoFar, line + 0.25);
    return lo === null || hi === null ? null : (lo + hi) / 2;
  }
  if (cls === "half") {
    if (need < 0) return 1;
    return poissonSf(lambda, Math.floor(need));
  }
  // integer line: push at exactly `need` remaining goals
  if (need <= 0) return 1;
  const win = poissonSf(lambda, need);
  const push = poissonPmf(lambda, need);
  const denom = 1 - push;
  return denom <= 1e-12 ? null : Math.min(1, win / denom);
}

export interface TeamLambdas {
  lambda1: number;
  lambda2: number;
}

export function price1X2(
  tl: TeamLambdas,
  goals1: number,
  goals2: number
): { part1: number; draw: number; part2: number } {
  const dist = marginDistribution(tl.lambda1, tl.lambda2);
  const lead = goals1 - goals2;
  let part1 = 0;
  let draw = 0;
  let part2 = 0;
  for (const [d, p] of dist) {
    const m = lead + d;
    if (m > 0) part1 += p;
    else if (m === 0) draw += p;
    else part2 += p;
  }
  const sum = part1 + draw + part2;
  return { part1: part1 / sum, draw: draw / sum, part2: part2 / sum };
}

/**
 * P(part1 covers | no push) for an Asian handicap `line` applied to part1.
 *
 * CONVENTION (established empirically, Session 1 backtest forensics): in-running
 * AH lines apply to the REMAINING-goals margin, not the full-match margin —
 * part1 covers when (remainingGoals1 - remainingGoals2) + line > 0. The current
 * score therefore does not enter the handicap arithmetic at all (it enters the
 * model only through the lambda fit). Pre-match quotes are the same convention
 * with nothing scored yet. Verified: Spain 2-1 late, line=-0.5 quoted 0.177 ==
 * P(part1 outscores part2 from now) at the fitted lambdas; a final-margin
 * reading would price it ~0.91.
 */
export function probAHPart1(tl: TeamLambdas, line: number): number | null {
  const cls = lineClass(line);
  if (cls === "quarter") {
    const lo = probAHPart1(tl, line - 0.25);
    const hi = probAHPart1(tl, line + 0.25);
    return lo === null || hi === null ? null : (lo + hi) / 2;
  }
  const dist = marginDistribution(tl.lambda1, tl.lambda2);
  let win = 0;
  let push = 0;
  let total = 0;
  for (const [d, p] of dist) {
    const adj = d + line;
    total += p;
    if (adj > 1e-9) win += p;
    else if (Math.abs(adj) <= 1e-9) push += p;
  }
  if (cls === "half") return win / total;
  const denom = total - push;
  return denom <= 1e-12 ? null : win / denom;
}

// ── Fitting ────────────────────────────────────────────────────────

/** Invert a quoted P(over) into the remaining-goals mean. Null if uninformative. */
export function invertOverLine(
  pOver: number,
  goalsSoFar: number,
  line: number,
  cfg: FairPriceConfig = DEFAULT_FAIRPRICE_CONFIG
): number | null {
  const f = (lambda: number) => probOver(lambda, goalsSoFar, line);
  const pLo = f(cfg.lambdaMin);
  const pHi = f(cfg.lambdaMax);
  if (pLo === null || pHi === null) return null;
  if (pOver <= pLo + 1e-6 || pOver >= pHi - 1e-6) return null; // dead / out of range
  let lo = cfg.lambdaMin;
  let hi = cfg.lambdaMax;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const p = f(mid);
    if (p === null) return null;
    if (p < pOver) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export interface ScopeInputs {
  goals1: number;
  goals2: number;
  lines: ParsedLine[];
  nowTs: number;
}

export interface FairFit {
  lambda1: number;
  lambda2: number;
  lambdaTotal: number;
  share: number;
  ouLinesUsed: number;
  anchor: "1X2" | "AH";
  anchorKey: string;
  /** root-mean-square residual of the anchor fit, in probability points */
  anchorResidual: number;
}

export function fitFairPrices(
  inputs: ScopeInputs,
  cfg: FairPriceConfig = DEFAULT_FAIRPRICE_CONFIG
): FairFit | null {
  const goalsSoFar = inputs.goals1 + inputs.goals2;
  const fresh = inputs.lines.filter(
    (l) => l.probs !== null && inputs.nowTs - l.ts <= cfg.maxStalenessMs
  );

  // 1. lambdaTotal: weighted inversion of the O/U lines (balance-weighted).
  let wSum = 0;
  let lamSum = 0;
  let ouUsed = 0;
  for (const l of fresh) {
    if (l.type !== "OU") continue;
    const pOver = l.probs!["over"];
    if (pOver === undefined) continue;
    const lam = invertOverLine(pOver, goalsSoFar, l.line!, cfg);
    if (lam === null) continue;
    const w = Math.max(cfg.minBalanceWeight, 1 - Math.abs(pOver - 0.5) * 2);
    wSum += w;
    lamSum += w * lam;
    ouUsed++;
  }
  if (ouUsed === 0 || wSum <= 0) return null;
  const lambdaTotal = lamSum / wSum;

  // 2. Team split share anchored to 1X2 (fallback: most balanced AH line).
  const anchor1x2 = fresh
    .filter((l) => l.type === "1X2")
    .sort((a, b) => b.ts - a.ts)[0];
  let anchorType: "1X2" | "AH";
  let anchorKey: string;
  let objective: (s: number) => number;

  if (anchor1x2) {
    const q = anchor1x2.probs!;
    const q1 = q["part1"] ?? 0;
    const qd = q["draw"] ?? 0;
    const q2 = q["part2"] ?? 0;
    anchorType = "1X2";
    anchorKey = anchor1x2.key;
    objective = (s) => {
      const m = price1X2(
        { lambda1: s * lambdaTotal, lambda2: (1 - s) * lambdaTotal },
        inputs.goals1,
        inputs.goals2
      );
      return (m.part1 - q1) ** 2 + (m.draw - qd) ** 2 + (m.part2 - q2) ** 2;
    };
  } else {
    const anchorAh = fresh
      .filter((l) => l.type === "AH")
      .sort((a, b) => {
        const balA = Math.abs((a.probs!["part1"] ?? 0.5) - 0.5);
        const balB = Math.abs((b.probs!["part1"] ?? 0.5) - 0.5);
        return balA - balB || b.ts - a.ts;
      })[0];
    if (!anchorAh) return null;
    const q1 = anchorAh.probs!["part1"] ?? 0.5;
    anchorType = "AH";
    anchorKey = anchorAh.key;
    objective = (s) => {
      const m = probAHPart1(
        { lambda1: s * lambdaTotal, lambda2: (1 - s) * lambdaTotal },
        anchorAh.line!
      );
      return m === null ? 1 : (m - q1) ** 2;
    };
  }

  // Coarse grid then golden-section refinement (objective is unimodal in s).
  let bestS = 0.5;
  let bestJ = Infinity;
  for (let s = 0.03; s <= 0.9701; s += 0.01) {
    const j = objective(s);
    if (j < bestJ) {
      bestJ = j;
      bestS = s;
    }
  }
  let lo = Math.max(0.03, bestS - 0.01);
  let hi = Math.min(0.97, bestS + 0.01);
  const PHI = (Math.sqrt(5) - 1) / 2;
  for (let i = 0; i < 40; i++) {
    const a = hi - PHI * (hi - lo);
    const b = lo + PHI * (hi - lo);
    if (objective(a) < objective(b)) hi = b;
    else lo = a;
  }
  const share = (lo + hi) / 2;
  const residual = Math.sqrt(objective(share) / (anchorType === "1X2" ? 3 : 1)) * 100;

  return {
    lambda1: share * lambdaTotal,
    lambda2: (1 - share) * lambdaTotal,
    lambdaTotal,
    share,
    ouLinesUsed: ouUsed,
    anchor: anchorType,
    anchorKey,
    anchorResidual: residual,
  };
}

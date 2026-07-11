// Signal family A: model-vs-consensus divergence.
// The fair-price engine is fitted FROM the market complex (O/U total + 1X2
// anchor), so an edge on any single line is an internal inconsistency of the
// market complex — the defensible kind of divergence. The anchor line itself
// is excluded (its divergence is ~0 by construction).

import { price1X2, probAHPart1, probOver, type FairFit } from "../model/fairprice.js";
import type { ParsedLine } from "../model/markets.js";
import type { StrategyParams } from "./params.js";
import type { SignalCandidate, SignalFamily } from "./signals.js";

export interface DivergenceInputs {
  fixtureId: number;
  /** goals so far in the scope being priced */
  goals1: number;
  goals2: number;
  fit: FairFit;
  /** latest lines of the SAME scope as the fit */
  lines: ParsedLine[];
  nowTs: number;
  /**
   * Honest-fill rule: a quote is only takeable if it postdates this timestamp.
   * Callers pass the last score-change ts (a quote from before the current
   * score is a suspended/dead price — "filling" it is fictional), and for
   * movement-armed scans additionally the jump trigger ts (only lines that
   * re-quoted AFTER the information arrived are real laggards).
   */
  minQuoteTs: number;
}

/** Model probabilities per outcome name for one line; null = not priceable. */
export function modelProbsForLine(
  fit: FairFit,
  goals1: number,
  goals2: number,
  line: ParsedLine
): Record<string, number> | null {
  if (line.type === "OU") {
    const over = probOver(fit.lambdaTotal, goals1 + goals2, line.line!);
    if (over === null) return null;
    return { over, under: 1 - over };
  }
  if (line.type === "AH") {
    const part1 = probAHPart1(fit, line.line!);
    if (part1 === null) return null;
    return { part1, part2: 1 - part1 };
  }
  const m = price1X2(fit, goals1, goals2);
  return { part1: m.part1, draw: m.draw, part2: m.part2 };
}

export function scanDivergence(
  inputs: DivergenceInputs,
  params: StrategyParams,
  family: SignalFamily = "divergence",
  reasonPrefix = ""
): SignalCandidate[] {
  const p = params.divergence;
  const out: SignalCandidate[] = [];
  for (const line of inputs.lines) {
    if (line.probs === null) continue;
    if (line.key === inputs.fit.anchorKey) continue;
    if (line.ts <= inputs.minQuoteTs) continue;
    const quoteAgeMs = inputs.nowTs - line.ts;
    if (quoteAgeMs > p.maxQuoteAgeMs) continue;
    const minEdge = line.type === "AH" ? p.minEdgePtsAH : p.minEdgePts;
    const model = modelProbsForLine(inputs.fit, inputs.goals1, inputs.goals2, line);
    if (model === null) continue;
    for (const [side, marketProb] of Object.entries(line.probs)) {
      const modelProb = model[side];
      if (modelProb === undefined) continue;
      if (modelProb < p.minProb || modelProb > p.maxProb) continue;
      if (marketProb < p.minProb || marketProb > p.maxProb) continue;
      const edgePts = (modelProb - marketProb) * 100;
      if (edgePts < minEdge) continue;
      const price = line.prices[side];
      if (price === undefined || price <= 1 || price > p.maxPrice) continue;
      out.push({
        family,
        fixtureId: inputs.fixtureId,
        lineKey: line.key,
        side,
        price,
        marketProb,
        modelProb,
        edgePts,
        quoteAgeMs,
        ts: inputs.nowTs,
        fit: inputs.fit,
        reason:
          `${reasonPrefix}model ${(modelProb * 100).toFixed(1)}% vs market ${(marketProb * 100).toFixed(1)}% ` +
          `(+${edgePts.toFixed(1)}pts) on ${line.key} ${side} @ ${price.toFixed(3)}; ` +
          `fit: λT=${inputs.fit.lambdaTotal.toFixed(2)} share=${inputs.fit.share.toFixed(2)} ` +
          `ou=${inputs.fit.ouLinesUsed} resid=${inputs.fit.anchorResidual.toFixed(1)}pts`,
      });
    }
  }
  return out.sort((a, b) => b.edgePts - a.edgePts);
}

/** Fit-quality gate shared by both families. */
export function fitIsTradable(fit: FairFit, params: StrategyParams): string | null {
  if (fit.ouLinesUsed < params.divergence.minOuLinesUsed)
    return `fit not tradable: only ${fit.ouLinesUsed} O/U lines`;
  if (fit.anchorResidual > params.divergence.maxAnchorResidualPts)
    return `fit not tradable: anchor residual ${fit.anchorResidual.toFixed(1)}pts`;
  return null;
}

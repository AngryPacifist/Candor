// Capped fractional Kelly on the paper bankroll.

import type { StrategyParams } from "./params.js";
import type { SignalCandidate } from "./signals.js";

export interface SizingResult {
  stakeUnits: number;
  kellyFraction: number;
  reason: string;
}

/**
 * Kelly for a binary bet at decimal odds `price` with win probability `p`:
 * f* = (p * price - 1) / (price - 1). We stake kellyFraction * f*, capped at
 * maxStakePctOfBankroll, floored at minStakeUnits (below the floor: no bet).
 */
export function sizePosition(
  candidate: SignalCandidate,
  bankrollUnits: number,
  params: StrategyParams
): SizingResult | null {
  const s = params.sizing;
  const b = candidate.price - 1;
  if (b <= 0) return null;
  const fullKelly = (candidate.modelProb * candidate.price - 1) / b;
  if (fullKelly <= 0) return null;
  const fraction = fullKelly * s.kellyFraction;
  const uncapped = bankrollUnits * fraction;
  const cap = bankrollUnits * (s.maxStakePctOfBankroll / 100);
  const stake = Math.min(uncapped, cap);
  if (stake < s.minStakeUnits) return null;
  const rounded = Math.round(stake * 100) / 100;
  return {
    stakeUnits: rounded,
    kellyFraction: fraction,
    reason:
      `kelly f*=${fullKelly.toFixed(4)} × ${s.kellyFraction} → ${(fraction * 100).toFixed(2)}% ` +
      `of ${bankrollUnits.toFixed(2)}u${uncapped > cap ? ` (capped at ${s.maxStakePctOfBankroll}%)` : ""}`,
  };
}

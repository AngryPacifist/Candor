// Parse raw odds records into typed market lines with demargined probabilities.
// Ground truth (scanned from our recordings, Session 1): PriceNames are exactly
// part1/draw/part2 (1X2), part1/part2 (AH), over/under (OU); MarketPeriod values:
// null, "half=1", "et", "et,half=1", "penalties".

import type { OddsRecord } from "../txline/types.js";

export type MarketScope = "full" | "half1" | "et" | "et_half1" | "penalties";
export type MarketType = "1X2" | "OU" | "AH";

export interface ParsedLine {
  /** market identity: type|period|params (matches the DB line key) */
  key: string;
  type: MarketType;
  scope: MarketScope;
  /** goal line (OU) or handicap applied to part1 (AH); null for 1X2 */
  line: number | null;
  ts: number;
  inRunning: boolean;
  /** name -> demargined probability summing to 1; null when the feed quotes NA */
  probs: Record<string, number> | null;
  /** name -> decimal odds */
  prices: Record<string, number>;
}

const TYPE_BY_SUPER: Record<string, MarketType> = {
  "1X2_PARTICIPANT_RESULT": "1X2",
  OVERUNDER_PARTICIPANT_GOALS: "OU",
  ASIANHANDICAP_PARTICIPANT_GOALS: "AH",
};

const SCOPE_BY_PERIOD: Record<string, MarketScope> = {
  "": "full",
  "half=1": "half1",
  et: "et",
  "et,half=1": "et_half1",
  penalties: "penalties",
};

export function parseOddsRecord(rec: OddsRecord): ParsedLine | null {
  const type = TYPE_BY_SUPER[rec.SuperOddsType];
  if (!type) return null;
  const scope = SCOPE_BY_PERIOD[rec.MarketPeriod ?? ""];
  if (!scope) return null;

  let line: number | null = null;
  if (rec.MarketParameters) {
    const m = /line=(-?\d+(?:\.\d+)?)/.exec(rec.MarketParameters);
    if (m) line = Number(m[1]);
  }
  if ((type === "OU" || type === "AH") && line === null) return null;

  const prices: Record<string, number> = {};
  const raw: Record<string, number> = {};
  let anyNA = false;
  for (let i = 0; i < rec.PriceNames.length; i++) {
    const name = rec.PriceNames[i]!;
    prices[name] = (rec.Prices[i] ?? 0) / 1000;
    const pct = rec.Pct?.[i];
    if (pct === undefined || pct === "NA") anyNA = true;
    else raw[name] = Number(pct) / 100;
  }
  let probs: Record<string, number> | null = null;
  if (!anyNA) {
    const sum = Object.values(raw).reduce((a, b) => a + b, 0);
    if (sum > 0.9 && sum < 1.1) {
      probs = {};
      for (const [k, v] of Object.entries(raw)) probs[k] = v / sum;
    }
  }
  return {
    key: `${rec.SuperOddsType}|${rec.MarketPeriod ?? ""}|${rec.MarketParameters ?? ""}`,
    type,
    scope,
    line,
    ts: rec.Ts,
    inRunning: rec.InRunning,
    probs,
    prices,
  };
}

/** half/int/quarter classification of a goal or handicap line. */
export function lineClass(line: number): "half" | "int" | "quarter" {
  const frac = ((line % 1) + 1) % 1;
  if (frac === 0.5) return "half";
  if (frac === 0) return "int";
  return "quarter";
}

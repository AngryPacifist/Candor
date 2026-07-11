// Shared signal types. A candidate is a fully-reasoned potential entry; the
// engine turns candidates into positions after sizing and exposure checks, and
// logs everything (including passes) to the signals table.

import type { FairFit } from "../model/fairprice.js";

export type SignalFamily = "divergence" | "movement";

export interface SignalCandidate {
  family: SignalFamily;
  fixtureId: number;
  /** market line identity: type|period|params (matches odds_latest / ParsedLine.key) */
  lineKey: string;
  /** outcome name within the line: part1 | draw | part2 | over | under */
  side: string;
  /** decimal odds quoted for that side at evaluation time */
  price: number;
  /** demargined consensus probability of the side */
  marketProb: number;
  /** our fair probability of the side */
  modelProb: number;
  /** modelProb - marketProb, in probability points (0-100 scale) */
  edgePts: number;
  /** age of the quote being taken, ms */
  quoteAgeMs: number;
  /** evaluation clock (stream time) */
  ts: number;
  /** the fit backing this candidate */
  fit: FairFit;
  /** human-readable reasoning, shown verbatim in the signal log and dashboard */
  reason: string;
}

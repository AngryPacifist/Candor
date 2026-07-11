// Deterministic replay simulation: one recorded match through the full
// strategy stack (state fold -> fair-price fit -> gates -> divergence +
// movement -> cooldowns -> Kelly sizing) with grading against what actually
// happened. Used by the tuning sweep, the signal validation script, and the
// determinism test (same recording + same params => byte-identical output).

import { fitFairPrices } from "../model/fairprice.js";
import { parseOddsRecord, type ParsedLine } from "../model/markets.js";
import { fitIsTradable, scanDivergence } from "../strategy/divergence.js";
import { MovementDetector } from "../strategy/movement.js";
import type { StrategyParams } from "../strategy/params.js";
import { sizePosition } from "../strategy/sizing.js";
import type { OddsRecord, ScoreRecord } from "../txline/types.js";

export interface SimState {
  ts: number;
  statusId: number | null;
  clockSeconds: number;
  goals1: number;
  goals2: number;
  h1goals1: number;
  h1goals2: number;
}

export interface SimEntry {
  family: string;
  scope: "full" | "half1";
  lineKey: string;
  side: string;
  price: number;
  modelProb: number;
  marketProb: number;
  edgePts: number;
  stakeUnits: number;
  ts: number;
  entryGoals1: number;
  entryGoals2: number;
  outcome: "won" | "lost" | "push";
  pnlUnits: number;
  reason: string;
}

export interface SimAggregate {
  n: number;
  won: number;
  lost: number;
  push: number;
  stakedUnits: number;
  pnlUnits: number;
}

export interface SimResult {
  fixtureId: number;
  final: SimState;
  jumps: number;
  gateSkips: number;
  entries: SimEntry[];
  byFamilyScope: Record<string, SimAggregate>;
}

export function buildSimStates(scoreRecords: ScoreRecord[]): SimState[] {
  const sorted = [...scoreRecords].sort((a, b) => a.Seq - b.Seq || a.Ts - b.Ts);
  const out: SimState[] = [];
  let cur: SimState = { ts: 0, statusId: null, clockSeconds: 0, goals1: 0, goals2: 0, h1goals1: 0, h1goals2: 0 };
  for (const rec of sorted) {
    cur = { ...cur, ts: rec.Ts };
    if (rec.StatusId !== undefined) cur.statusId = rec.StatusId;
    if (rec.Clock?.Seconds !== undefined) cur.clockSeconds = rec.Clock.Seconds;
    const s = rec.Score as any;
    if (s?.Participant1?.Total?.Goals !== undefined) cur.goals1 = s.Participant1.Total.Goals;
    if (s?.Participant2?.Total?.Goals !== undefined) cur.goals2 = s.Participant2.Total.Goals;
    if (s?.Participant1?.H1?.Goals !== undefined) cur.h1goals1 = s.Participant1.H1.Goals;
    if (s?.Participant2?.H1?.Goals !== undefined) cur.h1goals2 = s.Participant2.H1.Goals;
    out.push(cur);
  }
  return out;
}

function grade(
  entry: Omit<SimEntry, "outcome" | "pnlUnits">,
  final: SimState
): { outcome: "won" | "lost" | "push"; pnlUnits: number } {
  const type = entry.lineKey.split("|")[0]!;
  const lineMatch = /line=(-?\d+(?:\.\d+)?)/.exec(entry.lineKey);
  const line = lineMatch ? Number(lineMatch[1]) : null;
  const fg1 = entry.scope === "full" ? final.goals1 : final.h1goals1;
  const fg2 = entry.scope === "full" ? final.goals2 : final.h1goals2;

  let outcome: "won" | "lost" | "push";
  if (type === "OVERUNDER_PARTICIPANT_GOALS") {
    const total = fg1 + fg2;
    if (total === line) outcome = "push";
    else if ((entry.side === "over") === total > line!) outcome = "won";
    else outcome = "lost";
  } else if (type === "ASIANHANDICAP_PARTICIPANT_GOALS") {
    // remaining-goals convention: handicap applies to goals after entry
    const remMargin = (fg1 - entry.entryGoals1) - (fg2 - entry.entryGoals2);
    const adj = remMargin + line!;
    const sideAdj = entry.side === "part1" ? adj : -adj;
    if (Math.abs(sideAdj) < 1e-9) outcome = "push";
    else if (sideAdj > 0) outcome = "won";
    else outcome = "lost";
  } else {
    const margin = fg1 - fg2;
    const winner = margin > 0 ? "part1" : margin < 0 ? "part2" : "draw";
    outcome = entry.side === winner ? "won" : "lost";
  }
  const pnlUnits =
    outcome === "won" ? entry.stakeUnits * (entry.price - 1) : outcome === "push" ? 0 : -entry.stakeUnits;
  return { outcome, pnlUnits: Math.round(pnlUnits * 100) / 100 };
}

export function simulateMatch(input: {
  fixtureId: number;
  scoreRecords: ScoreRecord[];
  oddsRecords: OddsRecord[];
  params: StrategyParams;
  evalMs?: number;
}): SimResult {
  const { fixtureId, params: P } = input;
  const evalMs = input.evalMs ?? 10_000;
  const states = buildSimStates(input.scoreRecords);
  const final = states[states.length - 1] ?? {
    ts: 0, statusId: null, clockSeconds: 0, goals1: 0, goals2: 0, h1goals1: 0, h1goals2: 0,
  };
  const ticks = input.oddsRecords
    .map((r) => parseOddsRecord(r))
    .filter((l): l is ParsedLine => l !== null)
    .sort((a, b) => a.ts - b.ts);

  // score-change timestamps (for the honest-fill rule: quotes must postdate the current score)
  const goalChanges: number[] = [];
  {
    let prevScore = "";
    for (const st of states) {
      const s = `${st.goals1}-${st.goals2}`;
      if (prevScore !== "" && s !== prevScore) goalChanges.push(st.ts);
      prevScore = s;
    }
  }

  const detector = new MovementDetector(P);
  const latest = new Map<string, ParsedLine>();
  const cooldown = new Map<string, number>();
  const entries: SimEntry[] = [];
  let jumps = 0;
  let gateSkips = 0;
  let statePtr = 0;
  let goalPtr = 0;
  let nextEval = ticks.length > 0 ? ticks[0]!.ts : 0;

  for (const tick of ticks) {
    latest.set(tick.key, tick);
    if (detector.addTick(fixtureId, tick)) jumps++;
    if (tick.ts < nextEval) continue;
    nextEval = tick.ts + evalMs;

    while (statePtr + 1 < states.length && states[statePtr + 1]!.ts <= tick.ts) statePtr++;
    const st = states[statePtr]!;
    if (st.statusId === null || !(P.gates.tradableStatusIds as readonly number[]).includes(st.statusId)) continue;
    if (st.clockSeconds > P.gates.latestEntryClockSeconds) continue;

    while (goalPtr < goalChanges.length && goalChanges[goalPtr]! <= tick.ts) goalPtr++;
    const lastGoalTs = goalPtr > 0 ? goalChanges[goalPtr - 1]! : 0;

    const trigger = detector.armedTrigger(fixtureId, tick.ts);

    for (const scope of ["full", "half1"] as const) {
      if (scope === "half1" && st.statusId !== 2) continue;
      const goals1 = scope === "full" ? st.goals1 : st.h1goals1;
      const goals2 = scope === "full" ? st.goals2 : st.h1goals2;
      const scopeLines = [...latest.values()].filter((l) => l.scope === scope);
      const fit = fitFairPrices({ goals1, goals2, lines: scopeLines, nowTs: tick.ts }, P.fairprice);
      if (!fit) continue;
      if (fitIsTradable(fit, P)) {
        gateSkips++;
        continue;
      }
      const family = trigger ? "movement" : "divergence";
      const prefix = trigger
        ? `jump ${trigger.movePts.toFixed(1)}pts z=${trigger.z.toFixed(1)} on ${trigger.lineKey}; `
        : "";
      const cands = scanDivergence(
        {
          fixtureId,
          goals1,
          goals2,
          fit,
          lines: scopeLines,
          nowTs: tick.ts,
          minQuoteTs: Math.max(lastGoalTs, trigger?.ts ?? 0),
        },
        P,
        family,
        prefix
      );
      for (const cand of cands) {
        if (trigger && cand.lineKey === trigger.lineKey) continue;
        const cdKey = `${cand.lineKey}|${cand.side}`;
        const last = cooldown.get(cdKey);
        const cdMs = family === "movement" ? P.movement.lineCooldownMs : P.divergence.lineCooldownMs;
        if (last !== undefined && cand.ts - last < cdMs) continue;
        const sized = sizePosition(cand, P.sizing.startingBankrollUnits, P);
        if (!sized) continue;
        cooldown.set(cdKey, cand.ts);
        const base = {
          family,
          scope,
          lineKey: cand.lineKey,
          side: cand.side,
          price: cand.price,
          modelProb: cand.modelProb,
          marketProb: cand.marketProb,
          edgePts: cand.edgePts,
          stakeUnits: sized.stakeUnits,
          ts: cand.ts,
          entryGoals1: goals1,
          entryGoals2: goals2,
          reason: cand.reason,
        };
        entries.push({ ...base, ...grade(base, final) });
      }
    }
  }

  const byFamilyScope: Record<string, SimAggregate> = {};
  for (const e of entries) {
    const k = `${e.family}:${e.scope}`;
    const a = (byFamilyScope[k] ??= { n: 0, won: 0, lost: 0, push: 0, stakedUnits: 0, pnlUnits: 0 });
    a.n++;
    a.stakedUnits += e.stakeUnits;
    a.pnlUnits += e.pnlUnits;
    if (e.outcome === "won") a.won++;
    else if (e.outcome === "lost") a.lost++;
    else a.push++;
  }
  return { fixtureId, final, jumps, gateSkips, entries, byFamilyScope };
}

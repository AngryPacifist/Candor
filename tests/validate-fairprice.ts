// Fair-price engine validation.
// Part 1: numeric self-tests (inversion round-trip, symmetry, monotonicity, push math).
// Part 2: replay backtest — every 30s of stream time in the Spain (18218149) and
// Portugal (18198205) recordings, fit the engine from fresh O/U + 1X2 quotes and
// price EVERY fresh line in scope; report |model - quoted| per market bucket.
// Run: npx tsx tests/validate-fairprice.ts

import { readFileSync } from "node:fs";
import {
  DEFAULT_FAIRPRICE_CONFIG,
  fitFairPrices,
  invertOverLine,
  price1X2,
  probAHPart1,
  probOver,
} from "../src/model/fairprice.js";
import { lineClass, parseOddsRecord, type ParsedLine } from "../src/model/markets.js";
import type { OddsRecord, ScoreRecord } from "../src/txline/types.js";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

// ── Part 1: self-tests ─────────────────────────────────────────────

function selfTests(): void {
  console.log("— self-tests —");
  for (const lambda of [0.4, 1.3, 2.7]) {
    for (const line of [1.5, 2, 2.5, 3.25]) {
      const p = probOver(lambda, 1, line);
      if (p === null || p <= 0.001 || p >= 0.999) continue;
      const inv = invertOverLine(p, 1, line);
      check(
        `inversion round-trip λ=${lambda} line=${line}`,
        inv !== null && Math.abs(inv - lambda) < 1e-5,
        `recovered ${inv}`
      );
    }
  }
  const sym = price1X2({ lambda1: 1.1, lambda2: 1.1 }, 0, 0);
  check("1X2 sums to 1", Math.abs(sym.part1 + sym.draw + sym.part2 - 1) < 1e-9);
  check("1X2 symmetric when equal", Math.abs(sym.part1 - sym.part2) < 1e-9);
  const ah0 = probAHPart1({ lambda1: 0.9, lambda2: 0.9 }, 0);
  check("AH line=0 equal lambdas is a coin flip (push-excluded)", ah0 !== null && Math.abs(ah0 - 0.5) < 1e-9);
  const ahLo = probAHPart1({ lambda1: 1.2, lambda2: 0.8 }, -0.5)!;
  const ahHi = probAHPart1({ lambda1: 1.2, lambda2: 0.8 }, 0.5)!;
  check("AH monotone in line", ahHi > ahLo, `${ahLo.toFixed(4)} < ${ahHi.toFixed(4)}`);
  const pLo = probOver(0.8, 0, 2.5)!;
  const pHi = probOver(2.4, 0, 2.5)!;
  check("probOver monotone in λ", pHi > pLo, `${pLo.toFixed(4)} < ${pHi.toFixed(4)}`);
}

// ── Part 2: replay backtest ────────────────────────────────────────

interface StatePoint {
  seq: number;
  ts: number;
  statusId: number | null;
  goals1: number;
  goals2: number;
  h1goals1: number;
  h1goals2: number;
}

function buildStateTimeline(file: string): StatePoint[] {
  const records = readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as ScoreRecord)
    .sort((a, b) => a.Seq - b.Seq || a.Ts - b.Ts);
  const timeline: StatePoint[] = [];
  let cur: StatePoint = { seq: 0, ts: 0, statusId: null, goals1: 0, goals2: 0, h1goals1: 0, h1goals2: 0 };
  for (const rec of records) {
    cur = { ...cur, seq: rec.Seq, ts: rec.Ts };
    if (rec.StatusId !== undefined) cur.statusId = rec.StatusId;
    const s = rec.Score as any;
    if (s?.Participant1?.Total?.Goals !== undefined) cur.goals1 = s.Participant1.Total.Goals;
    if (s?.Participant2?.Total?.Goals !== undefined) cur.goals2 = s.Participant2.Total.Goals;
    if (s?.Participant1?.H1?.Goals !== undefined) cur.h1goals1 = s.Participant1.H1.Goals;
    if (s?.Participant2?.H1?.Goals !== undefined) cur.h1goals2 = s.Participant2.H1.Goals;
    timeline.push(cur);
  }
  return timeline;
}

interface Bucket {
  errors: number[];
}

function backtest(fixtureId: number): void {
  console.log(`\n— backtest ${fixtureId} —`);
  const states = buildStateTimeline(`resources/replays/${fixtureId}.jsonl`);
  const oddsTicks = readFileSync(`resources/replays/${fixtureId}.odds.jsonl`, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => parseOddsRecord(JSON.parse(l) as OddsRecord))
    .filter((l): l is ParsedLine => l !== null)
    .sort((a, b) => a.ts - b.ts);

  const SAMPLE_MS = 30_000;
  const latest = new Map<string, ParsedLine>();
  const buckets = new Map<string, Bucket>();
  const worst: { bucket: string; err: number; detail: string }[] = [];
  const record = (bucket: string, err: number, detail = "") => {
    if (!buckets.has(bucket)) buckets.set(bucket, { errors: [] });
    buckets.get(bucket)!.errors.push(err * 100);
    if (detail) {
      worst.push({ bucket, err: err * 100, detail });
      worst.sort((a, b) => b.err - a.err);
      if (worst.length > 10) worst.pop();
    }
  };

  let statePtr = 0;
  let nextSample = oddsTicks.length > 0 ? oddsTicks[0]!.ts : 0;
  let fits = 0;
  let fitFailures = 0;
  const lambdaTrail: string[] = [];

  for (const tick of oddsTicks) {
    latest.set(tick.key, tick);
    if (tick.ts < nextSample) continue;
    nextSample = tick.ts + SAMPLE_MS;

    while (statePtr + 1 < states.length && states[statePtr + 1]!.ts <= tick.ts) statePtr++;
    const st = states[statePtr]!;
    if (st.statusId === null || ![2, 3, 4].includes(st.statusId)) continue;

    for (const scope of ["full", "half1"] as const) {
      if (scope === "half1" && st.statusId !== 2) continue;
      const goals1 = scope === "full" ? st.goals1 : st.h1goals1;
      const goals2 = scope === "full" ? st.goals2 : st.h1goals2;
      const scopeLines = [...latest.values()].filter((l) => l.scope === scope);
      const fit = fitFairPrices({ goals1, goals2, lines: scopeLines, nowTs: tick.ts }, DEFAULT_FAIRPRICE_CONFIG);
      if (!fit) {
        fitFailures++;
        continue;
      }
      fits++;
      if (scope === "full" && fits % 40 === 1) {
        lambdaTrail.push(
          `status=${st.statusId} score=${goals1}-${goals2} λT=${fit.lambdaTotal.toFixed(2)} share=${fit.share.toFixed(2)} resid=${fit.anchorResidual.toFixed(2)}pts`
        );
      }
      const fresh = scopeLines.filter(
        (l) => l.probs !== null && tick.ts - l.ts <= DEFAULT_FAIRPRICE_CONFIG.maxStalenessMs
      );
      for (const l of fresh) {
        if (l.type === "OU") {
          const m = probOver(fit.lambdaTotal, goals1 + goals2, l.line!);
          const q = l.probs!["over"];
          if (m !== null && q !== undefined && m > 0.02 && m < 0.98)
            record(`${scope}:OU:${lineClass(l.line!)}`, Math.abs(m - q));
        } else if (l.type === "AH") {
          const m = probAHPart1(fit, l.line!);
          const q = l.probs!["part1"];
          if (m !== null && q !== undefined && m > 0.02 && m < 0.98)
            record(
              `${scope}:AH:${lineClass(l.line!)}`,
              Math.abs(m - q),
              `line=${l.line} score=${goals1}-${goals2} status=${st.statusId} λT=${fit.lambdaTotal.toFixed(2)} model=${m.toFixed(3)} quoted=${q.toFixed(3)} quoteAge=${((tick.ts - l.ts) / 1000).toFixed(0)}s`
            );
        } else {
          const m = price1X2(fit, goals1, goals2);
          const q = l.probs!;
          const err =
            (Math.abs(m.part1 - (q["part1"] ?? 0)) +
              Math.abs(m.draw - (q["draw"] ?? 0)) +
              Math.abs(m.part2 - (q["part2"] ?? 0))) /
            3;
          record(`${scope}:1X2`, err);
        }
      }
    }
  }

  console.log(`fits: ${fits} (failed: ${fitFailures})`);
  for (const line of lambdaTrail) console.log(`  ${line}`);
  const sorted = [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [name, b] of sorted) {
    const e = b.errors.sort((x, y) => x - y);
    const mean = e.reduce((a, v) => a + v, 0) / e.length;
    const med = e[Math.floor(e.length / 2)]!;
    const p90 = e[Math.floor(e.length * 0.9)]!;
    console.log(
      `  ${name.padEnd(18)} n=${String(e.length).padStart(5)}  mean=${mean.toFixed(2)}pts  median=${med.toFixed(2)}pts  p90=${p90.toFixed(2)}pts`
    );
  }
  console.log("  worst AH cases:");
  for (const w of worst) console.log(`    ${w.err.toFixed(1).padStart(5)}pts ${w.bucket} ${w.detail}`);
}

selfTests();
backtest(18218149);
backtest(18198205);
if (failures > 0) {
  console.error(`\n${failures} self-test failure(s)`);
  process.exit(1);
}

// Signal-family validation over the recorded matches (thin wrapper around the
// replay harness in src/replay/simulate.ts). Reports entries, grading, and
// sample reasons under the FROZEN params.
// Run: npx tsx tests/validate-signals.ts

import "dotenv/config";
import { readFileSync } from "node:fs";
import { simulateMatch } from "../src/replay/simulate.js";
import { STRATEGY_PARAMS, STRATEGY_PARAMS_HASH } from "../src/strategy/params.js";
import type { OddsRecord, ScoreRecord } from "../src/txline/types.js";

const REPLAYS = process.env.CANDOR_REPLAYS_DIR ?? "replays";

console.log(`params ${STRATEGY_PARAMS.version} hash=${STRATEGY_PARAMS_HASH.slice(0, 16)}`);

for (const fixtureId of [18218149, 18198205]) {
  const scoreRecords = readFileSync(`${REPLAYS}/${fixtureId}.jsonl`, "utf8")
    .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as ScoreRecord);
  const oddsRecords = readFileSync(`${REPLAYS}/${fixtureId}.odds.jsonl`, "utf8")
    .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as OddsRecord);

  const r = simulateMatch({ fixtureId, scoreRecords, oddsRecords, params: STRATEGY_PARAMS, evalMs: 5_000 });
  console.log(`\n═══ ${fixtureId} ═══`);
  console.log(
    `final: ${r.final.goals1}-${r.final.goals2} (H1 ${r.final.h1goals1}-${r.final.h1goals2}) · jumps=${r.jumps} gateSkips=${r.gateSkips} entries=${r.entries.length}`
  );
  for (const [k, a] of Object.entries(r.byFamilyScope).sort()) {
    console.log(
      `  ${k.padEnd(18)} n=${String(a.n).padStart(3)} W/L/P=${a.won}/${a.lost}/${a.push} staked=${a.stakedUnits.toFixed(1)}u pnl=${a.pnlUnits >= 0 ? "+" : ""}${a.pnlUnits.toFixed(2)}u`
    );
  }
  for (const e of r.entries.slice(0, 8)) {
    console.log(
      `    [${e.family}/${e.scope}] ${e.outcome.toUpperCase().padEnd(4)} ${e.stakeUnits}u ${e.lineKey} ${e.side} @${e.price.toFixed(2)} entry=${e.entryGoals1}-${e.entryGoals2} :: ${e.reason.slice(0, 130)}`
    );
  }
}

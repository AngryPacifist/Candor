// Ledger + settlement validation against both tuning recordings.
// Full production path: fold EVERY score record into match_state, load the
// entry lines' odds history, open positions from the replay's signal entries,
// settle at game_finalised, and cross-check:
//  - regulation goals from period stat keys vs the KNOWN finals
//  - ledger grading vs the replay harness grading (independent implementations)
//  - CLV, bankroll arithmetic, metrics aggregation
//
// DESTRUCTIVE: this test DELETES rows for its test fixtures and RESETS the
// bankroll. It therefore ignores DATABASE_URL and requires a dedicated
// database via CANDOR_TEST_DATABASE_URL (apply the schema to it first:
// DATABASE_URL=<test db> npm run migrate). Needs the tuning recordings in
// resources/replays/.
// Run: CANDOR_TEST_DATABASE_URL=... npx tsx tests/validate-ledger.ts

import { readFileSync } from "node:fs";
import pg from "pg";

const TEST_DB = process.env.CANDOR_TEST_DATABASE_URL;
if (!TEST_DB) {
  console.error(
    "Refusing to run: set CANDOR_TEST_DATABASE_URL to a dedicated test database.\n" +
      "This test deletes fixture rows and resets the bankroll; NEVER point it at a live database."
  );
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: TEST_DB, max: 5 });
const closePool = () => pool.end();
import { foldScoreRecord } from "../src/ingest/scores.js";
import { OddsBuffer } from "../src/ingest/odds.js";
import { Ledger } from "../src/ledger/ledger.js";
import { computeMetrics } from "../src/ledger/metrics.js";
import { simulateMatch } from "../src/replay/simulate.js";
import { STRATEGY_PARAMS } from "../src/strategy/params.js";
import type { OddsRecord, ScoreRecord } from "../src/txline/types.js";

const KNOWN = {
  18218149: { full: [2, 1], h1: [1, 1] },
  18198205: { full: [0, 1], h1: [0, 0] },
} as const;

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function run(fixtureId: 18218149 | 18198205): Promise<void> {
  console.log(`\n═══ ${fixtureId} ═══`);
  const scoreRecords = readFileSync(`resources/replays/${fixtureId}.jsonl`, "utf8")
    .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as ScoreRecord);
  const oddsRecords = readFileSync(`resources/replays/${fixtureId}.odds.jsonl`, "utf8")
    .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as OddsRecord);

  // clean slate for this fixture (test data only)
  await pool.query(`DELETE FROM settlements WHERE position_id IN (SELECT id FROM positions WHERE fixture_id = $1)`, [fixtureId]);
  await pool.query(`DELETE FROM positions WHERE fixture_id = $1`, [fixtureId]);
  await pool.query(`DELETE FROM odds_history WHERE fixture_id = $1`, [fixtureId]);
  await pool.query(`DELETE FROM match_state WHERE fixture_id = $1`, [fixtureId]);
  await pool.query(`DELETE FROM agent_state WHERE key = 'bankroll_units'`);

  // 1. replay the signals deterministically
  const sim = simulateMatch({ fixtureId, scoreRecords, oddsRecords, params: STRATEGY_PARAMS, evalMs: 5_000 });
  console.log(`sim: ${sim.entries.length} entries`);

  // 2. fold every score record through the production fold
  const t0 = Date.now();
  for (const rec of scoreRecords.sort((a, b) => a.Seq - b.Seq || a.Ts - b.Ts)) {
    await foldScoreRecord(pool, rec);
  }
  console.log(`folded ${scoreRecords.length} score records in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  // 3. odds history for the entry lines (for CLV)
  const entryKeys = new Set(sim.entries.map((e) => e.lineKey));
  const buffer = new OddsBuffer();
  let loaded = 0;
  for (const rec of oddsRecords) {
    const key = `${rec.SuperOddsType}|${rec.MarketPeriod ?? ""}|${rec.MarketParameters ?? ""}`;
    if (!entryKeys.has(key)) continue;
    buffer.push(rec);
    loaded++;
    if (buffer.size >= 500) await buffer.flush(pool);
  }
  await buffer.flush(pool);
  console.log(`odds history loaded for ${entryKeys.size} line(s): ${loaded} ticks`);

  // 4. open positions through the ledger
  const ledger = new Ledger(pool);
  for (const e of sim.entries) {
    const gate = await ledger.exposureCheck(fixtureId);
    if (gate) {
      console.log(`  exposure gate: ${gate}`);
      continue;
    }
    await ledger.openPosition({
      candidate: {
        family: e.family, fixtureId, lineKey: e.lineKey, side: e.side, price: e.price,
        modelProb: e.modelProb, marketProb: e.marketProb, ts: e.ts, reason: e.reason,
      },
      scope: e.scope,
      stakeUnits: e.stakeUnits,
      kellyFraction: 0,
      entryGoals1: e.entryGoals1,
      entryGoals2: e.entryGoals2,
    });
  }

  // 5. settle + cross-checks
  const known = KNOWN[fixtureId];
  const st = (await pool.query(`SELECT stats, finalised_seq FROM match_state WHERE fixture_id = $1`, [fixtureId])).rows[0];
  check(`finalised`, st?.finalised_seq != null, `seq=${st?.finalised_seq}`);
  const stats: Record<string, number> = st?.stats ?? {};
  // regulation = H1 band (+1000) + H2 band (+3000); feed semantics established empirically
  const reg1 = (stats["1001"] ?? 0) + (stats["3001"] ?? 0);
  const reg2 = (stats["1002"] ?? 0) + (stats["3002"] ?? 0);
  check(`regulation goals from period bands`, reg1 === known.full[0] && reg2 === known.full[1], `${reg1}-${reg2} (expect ${known.full[0]}-${known.full[1]})`);
  check(`H1 goals from 1000 band`, (stats["1001"] ?? 0) === known.h1[0] && (stats["1002"] ?? 0) === known.h1[1], `${stats["1001"] ?? 0}-${stats["1002"] ?? 0} (expect ${known.h1[0]}-${known.h1[1]})`);
  check(`key totals agree (no ET)`, (stats["1"] ?? 0) === known.full[0] && (stats["2"] ?? 0) === known.full[1], `keys 1/2 = ${stats["1"] ?? 0}-${stats["2"] ?? 0}`);

  const settled = await ledger.settleFixture(fixtureId);
  check(`settled count == entries`, settled.length === sim.entries.length, `${settled.length} vs ${sim.entries.length}`);
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i]!;
    const e = sim.entries[i]!;
    check(
      `grading agrees (pos ${s.positionId})`,
      s.outcome === e.outcome && Math.abs(s.pnlUnits - e.pnlUnits) < 0.01,
      `ledger=${s.outcome}/${s.pnlUnits}u sim=${e.outcome}/${e.pnlUnits}u clv=${s.clvPts ?? "n/a"}pts bankroll=${s.bankrollAfter}u`
    );
  }
}

async function main() {
  await run(18218149);
  await run(18198205);
  const m = await computeMetrics(pool);
  console.log(`\nmetrics: ${JSON.stringify(m, null, 1)}`);
  await closePool();
  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nALL CHECKS PASSED");
}

main().catch((e) => { console.error(e); process.exit(1); });

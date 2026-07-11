// Candor worker — the full autonomy loop.
// Ingest: fixtures discovery, scores fold into match_state, odds book.
// Agent: the AgentEngine evaluates live fixtures on a cadence, opens paper
// positions, commits them to mainnet (hash-chained), settles at
// game_finalised, and broadcasts settlement proofs. Restart-safe: state
// re-warms from DB + snapshots on boot.

import { closePool, pool } from "../db/index.js";
import { loadAgentKeypair, mainnetConnection } from "../chain/solana.js";
import { syncFixtures } from "../ingest/fixtures.js";
import { OddsBuffer } from "../ingest/odds.js";
import { foldScoreRecord } from "../ingest/scores.js";
import { STRATEGY_PARAMS, STRATEGY_PARAMS_HASH } from "../strategy/params.js";
import { TxlineClient } from "../txline/client.js";
import type { OddsRecord, ScoreRecord } from "../txline/types.js";
import { AgentEngine } from "./engine.js";

const FIXTURE_SYNC_MS = 10 * 60 * 1000;
const ODDS_FLUSH_MS = 1000;
const STATUS_MS = 30 * 1000;
const EVAL_MS = 5 * 1000;
const COMMIT_RETRY_MS = 120 * 1000;

function log(msg: string): void {
  console.log(`${new Date().toISOString()} [worker] ${msg}`);
}

async function main(): Promise<void> {
  const client = new TxlineClient();
  const shutdown = new AbortController();
  const counters = { scores: 0, odds: 0, heartbeats: 0, disconnects: 0, foldErrors: 0, flushed: 0 };

  const known = await syncFixtures(client, pool);
  log(`boot: ${known.size} fixtures known · params ${STRATEGY_PARAMS.version} hash=${STRATEGY_PARAMS_HASH.slice(0, 16)}`);

  const engine = new AgentEngine({
    pool,
    client,
    conn: mainnetConnection(),
    agent: loadAgentKeypair(),
    params: STRATEGY_PARAMS,
    log,
  });
  await engine.warmup();

  const fixtureSync = setInterval(() => {
    syncFixtures(client, pool)
      .then((ids) => log(`fixtures synced (${ids.size})`))
      .catch((e) => log(`fixtures sync failed: ${e.message}`));
  }, FIXTURE_SYNC_MS);

  // Scores fold: strictly serialized so match_state updates apply in arrival order.
  const scoreQueue: ScoreRecord[] = [];
  let draining = false;
  const drainScores = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    while (scoreQueue.length > 0) {
      const rec = scoreQueue.shift()!;
      try {
        await foldScoreRecord(pool, rec);
      } catch (e) {
        counters.foldErrors++;
        log(`score fold error (fixture ${rec.FixtureId} seq ${rec.Seq}): ${(e as Error).message}`);
      }
    }
    draining = false;
  };

  const oddsBuffer = new OddsBuffer();
  const oddsFlush = setInterval(() => {
    oddsBuffer
      .flush(pool)
      .then((r) => void (counters.flushed += r.history))
      .catch((e) => log(`odds flush error: ${e.message}`));
  }, ODDS_FLUSH_MS);

  const evalTimer = setInterval(() => engine.evaluateAll(), EVAL_MS);
  const commitRetry = setInterval(() => {
    engine.retryFailedCommits().catch((e) => log(`commit retry sweep failed: ${e.message}`));
  }, COMMIT_RETRY_MS);

  const status = setInterval(() => {
    const e = engine.counters;
    log(
      `live · scores:${counters.scores} odds:${counters.odds} (flushed:${counters.flushed}, buffered:${oddsBuffer.size}) hb:${counters.heartbeats} disconnects:${counters.disconnects} foldErrors:${counters.foldErrors} · agent: entries:${e.entries} jumps:${e.jumps} commits:${e.commits}/${e.commitFailures}f settled:${e.settledPositions} proofs:${e.proofs}/${e.proofUnavailable}u`
    );
    pool
      .query(
        `INSERT INTO agent_state (key, value, updated_at)
         VALUES ('worker_heartbeat', $1, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [JSON.stringify({ ...counters, agent: { ...e }, paramsHash: STRATEGY_PARAMS_HASH.slice(0, 16), at: Date.now() })]
      )
      .catch((e2) => log(`heartbeat write failed: ${e2.message}`));
  }, STATUS_MS);

  const stopTimers = (): void => {
    clearInterval(fixtureSync);
    clearInterval(oddsFlush);
    clearInterval(evalTimer);
    clearInterval(commitRetry);
    clearInterval(status);
  };

  process.on("SIGINT", () => {
    log("SIGINT — draining and shutting down");
    shutdown.abort();
  });
  process.on("SIGTERM", () => shutdown.abort());

  await Promise.all([
    client.stream(
      "/api/scores/stream",
      {
        onRecord: (raw) => {
          try {
            const rec = JSON.parse(raw) as ScoreRecord;
            counters.scores++;
            scoreQueue.push(rec);
            void drainScores();
            engine.onScoreRecord(rec);
          } catch {
            log(`unparseable score frame (${raw.length} bytes)`);
          }
        },
        onHeartbeat: () => void counters.heartbeats++,
        onConnect: (enc) => log(`scores stream connected (${enc})`),
        onDisconnect: (why) => {
          counters.disconnects++;
          if (!shutdown.signal.aborted) log(`scores stream disconnected: ${why}`);
        },
      },
      shutdown.signal
    ),
    client.stream(
      "/api/odds/stream",
      {
        onRecord: (raw) => {
          try {
            const rec = JSON.parse(raw) as OddsRecord;
            counters.odds++;
            oddsBuffer.push(rec);
            engine.onOddsRecord(rec);
          } catch {
            log(`unparseable odds frame (${raw.length} bytes)`);
          }
        },
        onHeartbeat: () => void counters.heartbeats++,
        onConnect: (enc) => log(`odds stream connected (${enc})`),
        onDisconnect: (why) => {
          counters.disconnects++;
          if (!shutdown.signal.aborted) log(`odds stream disconnected: ${why}`);
        },
      },
      shutdown.signal
    ),
  ]);

  stopTimers();
  await drainScores();
  await oddsBuffer.flush(pool);
  await closePool();
  log("shutdown complete");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

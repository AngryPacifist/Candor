// Candor ingest worker — phase 1 of the autonomy loop.
// Discovers fixtures, folds the scores firehose into match_state, and keeps
// the odds book (odds_latest + odds_history) current. Strategy, ledger, and
// the commit/proof layers plug into this loop next.

import { closePool, pool } from "../db/index.js";
import { syncFixtures } from "../ingest/fixtures.js";
import { OddsBuffer } from "../ingest/odds.js";
import { foldScoreRecord } from "../ingest/scores.js";
import { TxlineClient } from "../txline/client.js";
import type { OddsRecord, ScoreRecord } from "../txline/types.js";

const FIXTURE_SYNC_MS = 10 * 60 * 1000;
const ODDS_FLUSH_MS = 1000;
const STATUS_MS = 30 * 1000;

function log(msg: string): void {
  console.log(`${new Date().toISOString()} [worker] ${msg}`);
}

async function main(): Promise<void> {
  const client = new TxlineClient();
  const shutdown = new AbortController();
  const counters = { scores: 0, odds: 0, heartbeats: 0, disconnects: 0, foldErrors: 0, flushed: 0 };

  const known = await syncFixtures(client, pool);
  log(`boot: ${known.size} fixtures known`);

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

  const status = setInterval(() => {
    log(
      `live · scores:${counters.scores} odds:${counters.odds} (flushed:${counters.flushed}, buffered:${oddsBuffer.size}) hb:${counters.heartbeats} disconnects:${counters.disconnects} foldErrors:${counters.foldErrors}`
    );
    pool
      .query(
        `INSERT INTO agent_state (key, value, updated_at)
         VALUES ('worker_heartbeat', $1, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [JSON.stringify({ ...counters, at: Date.now() })]
      )
      .catch((e) => log(`heartbeat write failed: ${e.message}`));
  }, STATUS_MS);

  const stopTimers = (): void => {
    clearInterval(fixtureSync);
    clearInterval(oddsFlush);
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

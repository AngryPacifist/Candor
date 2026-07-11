import type pg from "pg";
import type { ScoreRecord } from "../txline/types.js";
import { ensureFixtureStub } from "./fixtures.js";

/**
 * Fold one scores-stream record into match_state. Stale records (Seq lower
 * than what's already applied) are skipped via the ON CONFLICT guard.
 * Finalisation marker: action=game_finalised / StatusId=100 (settlement-grade
 * per the TxLINE troubleshooting guide).
 */
export async function foldScoreRecord(pool: pg.Pool, rec: ScoreRecord): Promise<void> {
  if (!rec.FixtureId || rec.Seq === undefined) return;
  await ensureFixtureStub(pool, rec);

  const finalised = rec.Action === "game_finalised" || rec.StatusId === 100;
  await pool.query(
    `INSERT INTO match_state (fixture_id, status_id, game_state, clock_seconds,
       last_seq, score, stats, finalised_seq, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (fixture_id) DO UPDATE SET
       status_id = COALESCE(EXCLUDED.status_id, match_state.status_id),
       game_state = COALESCE(EXCLUDED.game_state, match_state.game_state),
       clock_seconds = COALESCE(EXCLUDED.clock_seconds, match_state.clock_seconds),
       last_seq = EXCLUDED.last_seq,
       score = COALESCE(EXCLUDED.score, match_state.score),
       stats = COALESCE(EXCLUDED.stats, match_state.stats),
       finalised_seq = COALESCE(EXCLUDED.finalised_seq, match_state.finalised_seq),
       updated_at = now()
     WHERE EXCLUDED.last_seq >= match_state.last_seq`,
    [
      rec.FixtureId,
      rec.StatusId ?? null,
      rec.GameState ?? null,
      rec.Clock?.Seconds ?? null,
      rec.Seq,
      rec.Score ? JSON.stringify(rec.Score) : null,
      rec.Stats && Object.keys(rec.Stats).length > 0 ? JSON.stringify(rec.Stats) : null,
      finalised ? rec.Seq : null,
    ]
  );
}

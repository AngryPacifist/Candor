import type pg from "pg";
import { epochDayNow, TxlineClient } from "../txline/client.js";
import type { Fixture, ScoreRecord } from "../txline/types.js";

/** Upsert the fixtures snapshot (today onward). Returns known fixture ids. */
export async function syncFixtures(client: TxlineClient, pool: pg.Pool): Promise<Set<number>> {
  const fixtures = await client.fixturesSnapshot(epochDayNow());
  for (const f of fixtures) {
    await pool.query(
      `INSERT INTO fixtures (fixture_id, start_time, competition, competition_id,
         participant1, participant1_id, participant2, participant2_id, p1_is_home, last_update)
       VALUES ($1, to_timestamp($2 / 1000.0), $3, $4, $5, $6, $7, $8, $9, now())
       ON CONFLICT (fixture_id) DO UPDATE SET
         start_time = EXCLUDED.start_time,
         competition = EXCLUDED.competition,
         competition_id = EXCLUDED.competition_id,
         participant1 = EXCLUDED.participant1,
         participant1_id = EXCLUDED.participant1_id,
         participant2 = EXCLUDED.participant2,
         participant2_id = EXCLUDED.participant2_id,
         p1_is_home = EXCLUDED.p1_is_home,
         last_update = now()`,
      [
        f.FixtureId,
        f.StartTime,
        f.Competition,
        f.CompetitionId,
        f.Participant1,
        f.Participant1Id,
        f.Participant2,
        f.Participant2Id,
        f.Participant1IsHome,
      ]
    );
  }
  const res = await pool.query(`SELECT fixture_id FROM fixtures`);
  return new Set(res.rows.map((r) => Number(r.fixture_id)));
}

/**
 * Stream records can reference a fixture the snapshot has rotated past (or that
 * arrived before the next sync). Create a stub row so FKs hold; the discovery
 * sync overwrites names on its next pass.
 */
export async function ensureFixtureStub(pool: pg.Pool, rec: ScoreRecord): Promise<void> {
  await pool.query(
    `INSERT INTO fixtures (fixture_id, start_time, competition, competition_id,
       participant1, participant1_id, participant2, participant2_id, p1_is_home)
     VALUES ($1, to_timestamp($2 / 1000.0), '', $3, '', $4, '', $5, $6)
     ON CONFLICT (fixture_id) DO NOTHING`,
    [
      rec.FixtureId,
      rec.StartTime ?? rec.Ts,
      rec.CompetitionId ?? 0,
      rec.Participant1Id ?? 0,
      rec.Participant2Id ?? 0,
      rec.Participant1IsHome ?? true,
    ]
  );
}

export type { Fixture };

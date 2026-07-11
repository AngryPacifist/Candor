import type pg from "pg";
import type { OddsRecord } from "../txline/types.js";

const HISTORY_CHUNK = 200;

export function lineKey(rec: OddsRecord): string {
  return `${rec.FixtureId}|${rec.SuperOddsType}|${rec.MarketPeriod ?? ""}|${rec.MarketParameters ?? ""}`;
}

/**
 * Buffers odds ticks and flushes them in batches: every tick appends to
 * odds_history; odds_latest gets one coalesced upsert per market line
 * (newest Ts wins, guarded server-side too). Live odds run to ~200 ticks/s
 * per match in bursts — per-tick round-trips to Neon would not keep up.
 */
export class OddsBuffer {
  private pending: OddsRecord[] = [];

  push(rec: OddsRecord): void {
    if (!rec.FixtureId || !rec.MessageId) return;
    this.pending.push(rec);
  }

  get size(): number {
    return this.pending.length;
  }

  async flush(pool: pg.Pool): Promise<{ history: number; latest: number }> {
    if (this.pending.length === 0) return { history: 0, latest: 0 };
    const batch = this.pending;
    this.pending = [];

    for (let i = 0; i < batch.length; i += HISTORY_CHUNK) {
      const chunk = batch.slice(i, i + HISTORY_CHUNK);
      const cols = 9;
      const placeholders = chunk
        .map((_, r) => `(${Array.from({ length: cols }, (_, c) => `$${r * cols + c + 1}`).join(",")})`)
        .join(",");
      const values = chunk.flatMap((rec) => [
        rec.FixtureId,
        rec.Ts,
        rec.MessageId,
        rec.SuperOddsType,
        rec.MarketPeriod ?? "",
        rec.MarketParameters ?? "",
        rec.InRunning,
        rec.Prices,
        rec.Pct ?? [],
      ]);
      await pool.query(
        `INSERT INTO odds_history (fixture_id, ts, message_id, super_odds_type,
           market_period, market_parameters, in_running, prices, pct)
         VALUES ${placeholders}`,
        values
      );
    }

    const newestPerLine = new Map<string, OddsRecord>();
    for (const rec of batch) {
      const key = lineKey(rec);
      const prev = newestPerLine.get(key);
      if (!prev || rec.Ts >= prev.Ts) newestPerLine.set(key, rec);
    }
    for (const rec of newestPerLine.values()) {
      await pool.query(
        `INSERT INTO odds_latest (fixture_id, super_odds_type, market_period,
           market_parameters, ts, message_id, in_running, price_names, prices, pct)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (fixture_id, super_odds_type, market_period, market_parameters)
         DO UPDATE SET
           ts = EXCLUDED.ts,
           message_id = EXCLUDED.message_id,
           in_running = EXCLUDED.in_running,
           price_names = EXCLUDED.price_names,
           prices = EXCLUDED.prices,
           pct = EXCLUDED.pct
         WHERE EXCLUDED.ts >= odds_latest.ts`,
        [
          rec.FixtureId,
          rec.SuperOddsType,
          rec.MarketPeriod ?? "",
          rec.MarketParameters ?? "",
          rec.Ts,
          rec.MessageId,
          rec.InRunning,
          rec.PriceNames,
          rec.Prices,
          rec.Pct ?? [],
        ]
      );
    }
    return { history: batch.length, latest: newestPerLine.size };
  }
}

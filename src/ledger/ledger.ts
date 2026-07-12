// The paper ledger — Candor's engine of record.
// Positions open from sized signal candidates (canonical payload + sha256 at
// open time, ready for the commit layer), and settle at game_finalised from
// match_state period stats. Bankroll lives in agent_state and only moves on
// settlement (stakes are exposure, not spend).
//
// Settlement conventions (locked):
// - Full-match markets resolve on REGULATION = H1 band + H2 band. EMPIRICAL
//   (both recordings, game_finalised records): the feed's goal period bands
//   are +1000 = H1, +2000 = halftime CUMULATIVE, +3000 = H2 — the docs' table
//   (+2000 = H2, +3000 = ET1) does NOT match the live feed. Regulation is
//   therefore keys 1001+3001 vs 1002+3002; totals (keys 1/2) are cross-checked
//   and must agree when no extra time occurred. First-half markets use the
//   1000 band alone (verified).
// - AH grades on the remaining-goals convention (goals after entry).
// - CLV is FIXED-HORIZON: the line's demargined prob `clvHorizonMs` after the
//   decision vs the entry prob. A last-quote "close" would just restate the
//   outcome (in-play lines converge to the result); the horizon isolates
//   whether the market moved toward the position while it still traded.

import type pg from "pg";
import { canonicalJson, sha256Hex } from "../lib/canonical.js";
import { STRATEGY_PARAMS, STRATEGY_PARAMS_HASH } from "../strategy/params.js";

const BANKROLL_KEY = "bankroll_units";

/** The slice of a signal candidate the ledger needs (SignalCandidate satisfies it). */
export interface PositionCandidate {
  family: string;
  fixtureId: number;
  lineKey: string;
  side: string;
  price: number;
  modelProb: number;
  marketProb: number;
  ts: number;
  reason: string;
}

export interface OpenedPosition {
  id: number;
  payloadHash: string;
  payloadCanonical: string;
}

export interface SettledPosition {
  positionId: number;
  outcome: "won" | "lost" | "push" | "void";
  pnlUnits: number;
  clvPts: number | null;
  bankrollAfter: number;
}

/**
 * The canonical position payload — the exact bytes whose sha256 goes on-chain.
 * Pure so the replay dry-run produces byte-identical artifacts to production.
 */
export function buildPositionPayload(input: {
  candidate: PositionCandidate;
  scope: "full" | "half1";
  stakeUnits: number;
  entryGoals1: number;
  entryGoals2: number;
  bankrollBefore: number;
}): { payload: { modelProb: number; marketProb: number }; payloadCanonical: string; payloadHash: string } {
  const { candidate: c } = input;
  const payload = {
    schema: "candor.position.v1",
    fixtureId: c.fixtureId,
    marketKey: c.lineKey,
    scope: input.scope,
    side: c.side,
    family: c.family,
    priceTaken: c.price,
    modelProb: Math.round(c.modelProb * 1e6) / 1e6,
    marketProb: Math.round(c.marketProb * 1e6) / 1e6,
    stakeUnits: input.stakeUnits,
    bankrollBefore: input.bankrollBefore,
    entryGoals1: input.entryGoals1,
    entryGoals2: input.entryGoals2,
    decidedTs: c.ts,
    paramsHash: STRATEGY_PARAMS_HASH,
  };
  const payloadCanonical = canonicalJson(payload);
  return { payload, payloadCanonical, payloadHash: sha256Hex(payloadCanonical) };
}

export class Ledger {
  constructor(private pool: pg.Pool) {}

  async getBankroll(): Promise<number> {
    const res = await this.pool.query(`SELECT value FROM agent_state WHERE key = $1`, [BANKROLL_KEY]);
    if (res.rows[0]) return Number(res.rows[0].value);
    const start = STRATEGY_PARAMS.sizing.startingBankrollUnits;
    await this.pool.query(
      `INSERT INTO agent_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
      [BANKROLL_KEY, JSON.stringify(start)]
    );
    return start;
  }

  private async setBankroll(units: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_state (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [BANKROLL_KEY, JSON.stringify(Math.round(units * 100) / 100)]
    );
  }

  /** Exposure gates from the frozen params. Returns a rejection reason or null. */
  async exposureCheck(fixtureId: number): Promise<string | null> {
    const s = STRATEGY_PARAMS.sizing;
    const res = await this.pool.query(
      `SELECT
         count(*) FILTER (WHERE status = 'open')::int AS open_total,
         count(*) FILTER (WHERE status = 'open' AND fixture_id = $1)::int AS open_match,
         count(*) FILTER (WHERE fixture_id = $1)::int AS all_match
       FROM positions`,
      [fixtureId]
    );
    const r = res.rows[0]!;
    if (r.open_total >= s.maxConcurrentPositions) return `exposure: ${r.open_total} open positions (max ${s.maxConcurrentPositions})`;
    if (r.open_match >= s.maxConcurrentPerMatch) return `exposure: ${r.open_match} open on fixture (max ${s.maxConcurrentPerMatch})`;
    if (r.all_match >= s.maxPositionsPerMatch) return `exposure: ${r.all_match} total on fixture (max ${s.maxPositionsPerMatch})`;
    return null;
  }

  async openPosition(input: {
    candidate: PositionCandidate;
    scope: "full" | "half1";
    stakeUnits: number;
    kellyFraction: number;
    entryGoals1: number;
    entryGoals2: number;
  }): Promise<OpenedPosition> {
    const { candidate: c } = input;
    const bankroll = await this.getBankroll();
    const { payload, payloadCanonical, payloadHash } = buildPositionPayload({
      candidate: c,
      scope: input.scope,
      stakeUnits: input.stakeUnits,
      entryGoals1: input.entryGoals1,
      entryGoals2: input.entryGoals2,
      bankrollBefore: bankroll,
    });
    const res = await this.pool.query(
      `INSERT INTO positions (fixture_id, market_key, scope, side, family, price_taken,
         model_prob, market_prob, stake_units, kelly_fraction, bankroll_before,
         entry_goals1, entry_goals2, decided_ts, reason, payload_canonical, payload_hash, params_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING id`,
      [
        c.fixtureId, c.lineKey, input.scope, c.side, c.family, c.price,
        payload.modelProb, payload.marketProb, input.stakeUnits, input.kellyFraction, bankroll,
        input.entryGoals1, input.entryGoals2, c.ts, c.reason, payloadCanonical, payloadHash,
        STRATEGY_PARAMS_HASH,
      ]
    );
    return { id: Number(res.rows[0].id), payloadHash, payloadCanonical };
  }

  /**
   * Settle all open positions of a finalised fixture from match_state stats.
   * Returns settlements in position-id order (deterministic).
   */
  async settleFixture(fixtureId: number): Promise<SettledPosition[]> {
    const stateRes = await this.pool.query(
      `SELECT stats, finalised_seq FROM match_state WHERE fixture_id = $1`,
      [fixtureId]
    );
    const state = stateRes.rows[0];
    if (!state?.finalised_seq) throw new Error(`fixture ${fixtureId} is not finalised`);
    const stats: Record<string, number> = state.stats ?? {};
    const stat = (key: number) => stats[String(key)] ?? 0;
    // regulation goals: H1 band (+1000) plus H2 band (+3000) — see header note
    const goals = {
      full1: stat(1001) + stat(3001),
      full2: stat(1002) + stat(3002),
      half11: stat(1001),
      half12: stat(1002),
    };
    const totalsAgree = goals.full1 === stat(1) && goals.full2 === stat(2);

    const open = await this.pool.query(
      `SELECT id, market_key, scope, side, price_taken, market_prob, stake_units,
              entry_goals1, entry_goals2, decided_ts
       FROM positions WHERE fixture_id = $1 AND status = 'open' ORDER BY id`,
      [fixtureId]
    );

    const out: SettledPosition[] = [];
    for (const row of open.rows) {
      const scope: "full" | "half1" = row.scope;
      const fg1 = scope === "full" ? goals.full1 : goals.half11;
      const fg2 = scope === "full" ? goals.full2 : goals.half12;
      const outcome = gradePosition({
        marketKey: row.market_key,
        side: row.side,
        entryGoals1: Number(row.entry_goals1),
        entryGoals2: Number(row.entry_goals2),
        finalGoals1: fg1,
        finalGoals2: fg2,
      });
      const stake = Number(row.stake_units);
      const price = Number(row.price_taken);
      const pnl = outcome === "won" ? Math.round(stake * (price - 1) * 100) / 100 : outcome === "push" ? 0 : -stake;

      const close = await this.horizonQuote(
        fixtureId,
        row.market_key,
        row.side,
        Number(row.decided_ts) + STRATEGY_PARAMS.measurement.clvHorizonMs
      );
      const clvPts = close === null ? null : Math.round((close.prob - Number(row.market_prob)) * 10000) / 100;

      const bankroll = await this.getBankroll();
      const bankrollAfter = Math.round((bankroll + pnl) * 100) / 100;
      await this.pool.query(
        `INSERT INTO settlements (position_id, outcome, pnl_units, bankroll_after,
           closing_price, closing_prob, clv, evidence)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          row.id, outcome, pnl, bankrollAfter,
          close?.price ?? null, close?.prob ?? null, clvPts,
          JSON.stringify({
            finalisedSeq: Number(state.finalised_seq),
            regulation: goals,
            statBands: { h1: [1001, 1002], h2: [3001, 3002] },
            keyTotals: [stat(1), stat(2)],
            totalsAgree,
          }),
        ]
      );
      await this.pool.query(`UPDATE positions SET status = 'settled' WHERE id = $1`, [row.id]);
      await this.setBankroll(bankrollAfter);
      out.push({ positionId: Number(row.id), outcome, pnlUnits: pnl, clvPts, bankrollAfter });
    }
    return out;
  }

  /**
   * Void every open position of a fixture (abandoned, cancelled, postponed,
   * or coverage-cancelled matches). Stakes return: pnl 0, bankroll unchanged.
   */
  async voidFixture(fixtureId: number, reason: string): Promise<SettledPosition[]> {
    const open = await this.pool.query(
      `SELECT id FROM positions WHERE fixture_id = $1 AND status = 'open' ORDER BY id`,
      [fixtureId]
    );
    const out: SettledPosition[] = [];
    const bankroll = await this.getBankroll();
    for (const row of open.rows) {
      await this.pool.query(
        `INSERT INTO settlements (position_id, outcome, pnl_units, bankroll_after, evidence)
         VALUES ($1, 'void', 0, $2, $3)`,
        [row.id, bankroll, JSON.stringify({ reason })]
      );
      await this.pool.query(`UPDATE positions SET status = 'void' WHERE id = $1`, [row.id]);
      out.push({ positionId: Number(row.id), outcome: "void", pnlUnits: 0, clvPts: null, bankrollAfter: bankroll });
    }
    return out;
  }

  /**
   * The line's demargined quote at (or nearest before) `atTs`: first valid
   * quote at/after the horizon, else the last valid quote before it (the line
   * died first). Empty-array ticks are line-death notices and are excluded.
   */
  private async horizonQuote(
    fixtureId: number,
    marketKey: string,
    side: string,
    atTs: number
  ): Promise<{ prob: number; price: number } | null> {
    const [type, period, params] = splitMarketKey(marketKey);
    const valid = `cardinality(pct) > 0 AND NOT ('NA' = ANY(pct))`;
    const res = await this.pool.query(
      `(SELECT prices, pct FROM odds_history
        WHERE fixture_id = $1 AND super_odds_type = $2 AND market_period = $3 AND market_parameters = $4
          AND ts >= $5 AND ${valid}
        ORDER BY ts ASC LIMIT 1)
       UNION ALL
       (SELECT prices, pct FROM odds_history
        WHERE fixture_id = $1 AND super_odds_type = $2 AND market_period = $3 AND market_parameters = $4
          AND ts < $5 AND ${valid}
        ORDER BY ts DESC LIMIT 1)
       LIMIT 1`,
      [fixtureId, type, period, params, atTs]
    );
    const row = res.rows[0];
    if (!row) return null;
    const idx = sideIndex(type!, side);
    if (idx === null || row.pct[idx] === undefined) return null;
    const probs = (row.pct as string[]).map(Number);
    const sum = probs.reduce((a, v) => a + v, 0);
    if (!(sum > 90 && sum < 110)) return null;
    return { prob: probs[idx]! / sum, price: Number(row.prices[idx]) / 1000 };
  }
}

export function splitMarketKey(marketKey: string): [string, string, string] {
  const parts = marketKey.split("|");
  return [parts[0] ?? "", parts[1] ?? "", parts[2] ?? ""];
}

/** PriceNames orders are fixed per market type (ground-truthed from the feed). */
export function sideIndex(superOddsType: string, side: string): number | null {
  const order =
    superOddsType === "1X2_PARTICIPANT_RESULT"
      ? ["part1", "draw", "part2"]
      : superOddsType === "OVERUNDER_PARTICIPANT_GOALS"
        ? ["over", "under"]
        : superOddsType === "ASIANHANDICAP_PARTICIPANT_GOALS"
          ? ["part1", "part2"]
          : null;
  if (!order) return null;
  const idx = order.indexOf(side);
  return idx >= 0 ? idx : null;
}

export function gradePosition(input: {
  marketKey: string;
  side: string;
  entryGoals1: number;
  entryGoals2: number;
  finalGoals1: number;
  finalGoals2: number;
}): "won" | "lost" | "push" {
  const [type, , params] = splitMarketKey(input.marketKey);
  const lineMatch = /line=(-?\d+(?:\.\d+)?)/.exec(params);
  const line = lineMatch ? Number(lineMatch[1]) : null;

  if (type === "OVERUNDER_PARTICIPANT_GOALS") {
    const total = input.finalGoals1 + input.finalGoals2;
    if (total === line) return "push";
    return (input.side === "over") === total > line! ? "won" : "lost";
  }
  if (type === "ASIANHANDICAP_PARTICIPANT_GOALS") {
    const remMargin = (input.finalGoals1 - input.entryGoals1) - (input.finalGoals2 - input.entryGoals2);
    const adj = remMargin + line!;
    const sideAdj = input.side === "part1" ? adj : -adj;
    if (Math.abs(sideAdj) < 1e-9) return "push";
    return sideAdj > 0 ? "won" : "lost";
  }
  const margin = input.finalGoals1 - input.finalGoals2;
  const winner = margin > 0 ? "part1" : margin < 0 ? "part2" : "draw";
  return input.side === winner ? "won" : "lost";
}

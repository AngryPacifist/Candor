// Aggregate measurement over the settled record: P&L, Brier calibration
// (model vs market, per market family), CLV, drawdown. These are the numbers
// the dashboard shows — every one derivable by a third party from the public
// record export plus the chain.

import type pg from "pg";

export interface FamilyBrier {
  family: string;
  n: number;
  brierModel: number;
  brierMarket: number;
}

export interface LedgerMetrics {
  bankrollUnits: number;
  openPositions: number;
  settled: number;
  won: number;
  lost: number;
  push: number;
  totalStakedUnits: number;
  pnlUnits: number;
  roiPct: number | null;
  clvMeanPts: number | null;
  clvPositiveShare: number | null;
  maxDrawdownUnits: number;
  brierByFamily: FamilyBrier[];
}

export async function computeMetrics(pool: pg.Pool): Promise<LedgerMetrics> {
  const bankrollRes = await pool.query(`SELECT value FROM agent_state WHERE key = 'bankroll_units'`);
  const openRes = await pool.query(`SELECT count(*)::int AS n FROM positions WHERE status = 'open'`);

  const rows = (
    await pool.query(
      `SELECT p.family, p.market_key, p.model_prob, p.market_prob, p.stake_units,
              s.outcome, s.pnl_units, s.clv, s.bankroll_after, s.position_id
       FROM settlements s JOIN positions p ON p.id = s.position_id
       ORDER BY s.position_id`
    )
  ).rows;

  let won = 0, lost = 0, push = 0, staked = 0, pnl = 0;
  let clvSum = 0, clvN = 0, clvPos = 0;
  let peak = -Infinity, maxDrawdown = 0;
  const fam = new Map<string, { n: number; model: number; market: number }>();

  for (const r of rows) {
    staked += Number(r.stake_units);
    pnl += Number(r.pnl_units);
    if (r.outcome === "won") won++;
    else if (r.outcome === "lost") lost++;
    else push++;
    if (r.clv !== null) {
      clvSum += Number(r.clv);
      clvN++;
      if (Number(r.clv) > 0) clvPos++;
    }
    const bank = Number(r.bankroll_after);
    if (bank > peak) peak = bank;
    else maxDrawdown = Math.max(maxDrawdown, peak - bank);
    if (r.outcome !== "push") {
      const y = r.outcome === "won" ? 1 : 0;
      const family = `${r.family}:${String(r.market_key).split("|")[0]}`;
      const f = fam.get(family) ?? { n: 0, model: 0, market: 0 };
      f.n++;
      f.model += (Number(r.model_prob) - y) ** 2;
      f.market += (Number(r.market_prob) - y) ** 2;
      fam.set(family, f);
    }
  }

  return {
    bankrollUnits: bankrollRes.rows[0] ? Number(bankrollRes.rows[0].value) : NaN,
    openPositions: openRes.rows[0].n,
    settled: rows.length,
    won,
    lost,
    push,
    totalStakedUnits: Math.round(staked * 100) / 100,
    pnlUnits: Math.round(pnl * 100) / 100,
    roiPct: staked > 0 ? Math.round((pnl / staked) * 10000) / 100 : null,
    clvMeanPts: clvN > 0 ? Math.round((clvSum / clvN) * 100) / 100 : null,
    clvPositiveShare: clvN > 0 ? Math.round((clvPos / clvN) * 10000) / 10000 : null,
    maxDrawdownUnits: Math.round(maxDrawdown * 100) / 100,
    brierByFamily: [...fam.entries()].map(([family, f]) => ({
      family,
      n: f.n,
      brierModel: Math.round((f.model / f.n) * 10000) / 10000,
      brierMarket: Math.round((f.market / f.n) * 10000) / 10000,
    })),
  };
}

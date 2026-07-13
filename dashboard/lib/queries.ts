import { pool } from "./db";

export interface PositionRow {
  id: number;
  opened_at: string;
  decided_ts: string;
  fixture_id: string;
  participant1: string;
  participant2: string;
  market_key: string;
  scope: string;
  side: string;
  family: string;
  price_taken: string;
  model_prob: string;
  market_prob: string;
  stake_units: string;
  bankroll_before: string;
  entry_goals1: number;
  entry_goals2: number;
  status: string;
  commit_sig: string | null;
  prev_commit_sig: string | null;
  commit_status: string;
  payload_hash: string;
  params_hash: string;
  outcome: string | null;
  pnl_units: string | null;
  clv: string | null;
  settlement_evidence: {
    finalisedSeq?: number;
    regulation?: { full1: number; full2: number; half11: number; half12: number };
    statBands?: Record<string, number[]>;
    reason?: string;
  } | null;
  proof_status: string | null;
  proof_result: boolean | null;
  proof_sig: string | null;
  proof_method: string | null;
  proof_error: string | null;
}

export async function fetchPositions(limit = 200): Promise<PositionRow[]> {
  const res = await pool.query(
    `SELECT p.id, p.opened_at, p.decided_ts, p.fixture_id, f.participant1, f.participant2,
            p.market_key, p.scope, p.side, p.family, p.price_taken, p.model_prob,
            p.market_prob, p.stake_units, p.bankroll_before, p.entry_goals1, p.entry_goals2,
            p.status, p.commit_sig, p.prev_commit_sig, p.commit_status,
            p.payload_hash, p.params_hash,
            s.outcome, s.pnl_units, s.clv, s.evidence AS settlement_evidence,
            pr.status AS proof_status, pr.result AS proof_result,
            pr.broadcast_sig AS proof_sig, pr.method AS proof_method, pr.error AS proof_error
     FROM positions p
     JOIN fixtures f ON f.fixture_id = p.fixture_id
     LEFT JOIN settlements s ON s.position_id = p.id
     LEFT JOIN LATERAL (
       SELECT status, result, broadcast_sig, method, error FROM proofs
       WHERE position_id = p.id ORDER BY id DESC LIMIT 1
     ) pr ON true
     ORDER BY p.id DESC LIMIT $1`,
    [limit]
  );
  return res.rows;
}

/** The attestation strip: the chain state every page carries. */
export interface Attest {
  paramsHash: string | null;
  frozen: boolean;
  ceremonySig: string | null;
  ceremonyHash: string | null;
  chainTip: string | null;
  settled: number;
  proven: number;
  heartbeatAt: string | null;
}

export async function fetchAttest(): Promise<Attest> {
  const [state, counts] = await Promise.all([
    pool.query(
      `SELECT key, value, updated_at FROM agent_state
       WHERE key IN ('params_freeze', 'last_commit_sig', 'worker_heartbeat')`
    ),
    pool.query(
      `SELECT count(DISTINCT s.position_id)::int AS settled,
              count(DISTINCT pr.position_id)::int AS proven
       FROM settlements s
       LEFT JOIN proofs pr ON pr.position_id = s.position_id AND pr.status = 'proven'`
    ),
  ]);
  const a: Attest = {
    paramsHash: null, frozen: false, ceremonySig: null, ceremonyHash: null,
    chainTip: null, settled: counts.rows[0]?.settled ?? 0, proven: counts.rows[0]?.proven ?? 0,
    heartbeatAt: null,
  };
  for (const row of state.rows) {
    if (row.key === "params_freeze") {
      a.frozen = true;
      a.ceremonySig = row.value?.sig ?? null;
      a.ceremonyHash = row.value?.hash ?? null;
    }
    if (row.key === "last_commit_sig") a.chainTip = row.value;
    if (row.key === "worker_heartbeat") {
      a.heartbeatAt = row.updated_at;
      a.paramsHash = row.value?.paramsHash ?? null;
    }
  }
  return a;
}

/** Settlement series for the bankroll curve and CLV bars (chronological). */
export interface SettlementPoint {
  positionId: number;
  settledAt: string;
  bankrollAfter: number | null;
  pnl: number;
  clv: number | null;
  outcome: string;
}

export async function fetchSettlementSeries(): Promise<SettlementPoint[]> {
  const res = await pool.query(
    `SELECT s.position_id, s.settled_at, s.bankroll_after, s.pnl_units, s.clv, s.outcome
     FROM settlements s ORDER BY s.settled_at, s.position_id`
  );
  return res.rows.map((r) => ({
    positionId: Number(r.position_id),
    settledAt: r.settled_at,
    bankrollAfter: r.bankroll_after === null ? null : Number(r.bankroll_after),
    pnl: Number(r.pnl_units),
    clv: r.clv === null ? null : Number(r.clv),
    outcome: r.outcome,
  }));
}

/** Daily decisions-root commits, for the signal feed. */
export interface DecisionsRoot {
  date: string;
  n: number;
  root: string;
  sig: string;
  at: string;
}

export async function fetchDecisionsRoots(): Promise<DecisionsRoot[]> {
  const res = await pool.query(
    `SELECT key, value, updated_at FROM agent_state WHERE key LIKE 'decisions_root_%' ORDER BY key DESC`
  );
  return res.rows.map((r) => ({
    date: String(r.key).replace("decisions_root_", ""),
    n: Number(r.value?.n ?? 0),
    root: String(r.value?.root ?? ""),
    sig: String(r.value?.sig ?? ""),
    at: r.updated_at,
  }));
}

export interface SignalRow {
  id: number;
  ts: string;
  fixture_id: string;
  participant1: string | null;
  participant2: string | null;
  family: string;
  market_key: string;
  side: string;
  edge: string | null;
  decision: string;
  reason: string;
  position_id: string | null;
}

export async function fetchSignals(limit = 200): Promise<SignalRow[]> {
  const res = await pool.query(
    `SELECT g.id, g.ts, g.fixture_id, f.participant1, f.participant2, g.family,
            g.market_key, g.side, g.edge, g.decision, g.reason, g.position_id
     FROM signals g LEFT JOIN fixtures f ON f.fixture_id = g.fixture_id
     ORDER BY g.id DESC LIMIT $1`,
    [limit]
  );
  return res.rows;
}

/** The paper bankroll every record starts from (locked decision 13; presentation only). */
export const STARTING_BANKROLL = 1000;

export interface Overview {
  bankroll: number | null;
  heartbeatAt: string | null;
  heartbeat: Record<string, unknown> | null;
  paramsHash: string | null;
  openPositions: PositionRow[];
  settled: number;
  won: number;
  lost: number;
  push: number;
  pnl: number;
  staked: number;
  clvMean: number | null;
  exposure: ExposureStats;
  latest: PositionRow | null;
  nextFixture: { participant1: string; participant2: string; competition: string; start_time: string } | null;
  upcoming: { fixture_id: string; participant1: string; participant2: string; competition: string; start_time: string }[];
}

export async function fetchOverview(): Promise<Overview> {
  const [state, agg, open, upcoming, latest, posRes] = await Promise.all([
    pool.query(`SELECT key, value, updated_at FROM agent_state WHERE key IN ('bankroll_units','worker_heartbeat')`),
    pool.query(
      `SELECT count(*)::int AS settled,
              count(*) FILTER (WHERE s.outcome = 'won')::int AS won,
              count(*) FILTER (WHERE s.outcome = 'lost')::int AS lost,
              count(*) FILTER (WHERE s.outcome = 'push')::int AS push,
              COALESCE(sum(s.pnl_units), 0) AS pnl,
              COALESCE(sum(p.stake_units), 0) AS staked,
              avg(s.clv) AS clv_mean
       FROM settlements s JOIN positions p ON p.id = s.position_id`
    ),
    fetchOpenPositions(),
    pool.query(
      `SELECT fixture_id, participant1, participant2, competition, start_time FROM fixtures
       WHERE start_time > now() - interval '3 hours' AND competition <> ''
       ORDER BY start_time LIMIT 4`
    ),
    fetchPositions(1),
    pool.query(
      `SELECT p.stake_units, p.bankroll_before, p.opened_at, p.status, s.settled_at
       FROM positions p LEFT JOIN settlements s ON s.position_id = p.id ORDER BY p.id`
    ),
  ]);

  let bankroll: number | null = null;
  let heartbeatAt: string | null = null;
  let heartbeat: Record<string, unknown> | null = null;
  for (const row of state.rows) {
    if (row.key === "bankroll_units") bankroll = Number(row.value);
    if (row.key === "worker_heartbeat") {
      heartbeatAt = row.updated_at;
      heartbeat = row.value;
    }
  }
  const a = agg.rows[0];
  const upcomingRows = upcoming.rows;
  return {
    bankroll,
    heartbeatAt,
    heartbeat,
    paramsHash: (heartbeat?.paramsHash as string | undefined) ?? null,
    openPositions: open,
    settled: a.settled,
    won: a.won,
    lost: a.lost,
    push: a.push,
    pnl: Number(a.pnl),
    staked: Number(a.staked),
    clvMean: a.clv_mean === null ? null : Number(a.clv_mean),
    exposure: computeExposure(posRes.rows, bankroll),
    latest: latest[0] ?? null,
    nextFixture: upcomingRows.find((f) => new Date(f.start_time).getTime() > Date.now()) ?? null,
    upcoming: upcomingRows,
  };
}

export async function fetchOpenPositions(): Promise<PositionRow[]> {
  const res = await pool.query(
    `SELECT p.id, p.opened_at, p.decided_ts, p.fixture_id, f.participant1, f.participant2,
            p.market_key, p.scope, p.side, p.family, p.price_taken, p.model_prob,
            p.market_prob, p.stake_units, p.bankroll_before, p.entry_goals1, p.entry_goals2,
            p.status, p.commit_sig, p.prev_commit_sig, p.commit_status,
            p.payload_hash, p.params_hash,
            NULL AS outcome, NULL AS pnl_units, NULL AS clv, NULL AS settlement_evidence,
            NULL AS proof_status, NULL AS proof_result, NULL AS proof_sig,
            NULL AS proof_method, NULL AS proof_error
     FROM positions p JOIN fixtures f ON f.fixture_id = p.fixture_id
     WHERE p.status = 'open' ORDER BY p.id DESC`
  );
  return res.rows;
}

export interface ExposureStats {
  openUnits: number;
  openCount: number;
  openPctOfBankroll: number | null;
  peakUnits: number;
  peakConcurrent: number;
  largestStakePct: number | null;
}

export interface Metrics {
  settled: number;
  won: number;
  lost: number;
  push: number;
  staked: number;
  pnl: number;
  roiPct: number | null;
  clvMean: number | null;
  clvPositiveShare: number | null;
  maxDrawdown: number;
  brier: { family: string; n: number; model: number; market: number }[];
  exposure: ExposureStats;
}

/**
 * Exposure measured from the position record: what is at risk now, the most
 * that was ever at risk at once (interval sweep over open->settle windows),
 * and the largest single stake relative to the bankroll it was sized on.
 */
function computeExposure(
  positions: { stake_units: string; bankroll_before: string; opened_at: string; status: string; settled_at: string | null }[],
  bankroll: number | null
): ExposureStats {
  let openUnits = 0;
  let openCount = 0;
  let largestStakePct: number | null = null;
  const events: { t: number; delta: number }[] = [];
  for (const p of positions) {
    const stake = Number(p.stake_units);
    const before = Number(p.bankroll_before);
    if (before > 0) {
      const pct = (stake / before) * 100;
      if (largestStakePct === null || pct > largestStakePct) largestStakePct = pct;
    }
    if (p.status === "open") {
      openUnits += stake;
      openCount++;
    }
    events.push({ t: new Date(p.opened_at).getTime(), delta: stake });
    if (p.settled_at) events.push({ t: new Date(p.settled_at).getTime(), delta: -stake });
  }
  // closes sort before opens at identical timestamps: touching windows do not overlap
  events.sort((a, b) => a.t - b.t || a.delta - b.delta);
  let units = 0, count = 0, peakUnits = 0, peakConcurrent = 0;
  for (const e of events) {
    units += e.delta;
    count += e.delta > 0 ? 1 : -1;
    if (units > peakUnits) peakUnits = units;
    if (count > peakConcurrent) peakConcurrent = count;
  }
  return {
    openUnits: Math.round(openUnits * 100) / 100,
    openCount,
    openPctOfBankroll: bankroll && bankroll > 0 ? (openUnits / bankroll) * 100 : null,
    peakUnits: Math.round(peakUnits * 100) / 100,
    peakConcurrent,
    largestStakePct,
  };
}

export async function fetchMetrics(): Promise<Metrics> {
  const [settledRes, posRes, bankRes] = await Promise.all([
    pool.query(
      `SELECT p.family, p.market_key, p.model_prob, p.market_prob, p.stake_units,
              s.outcome, s.pnl_units, s.clv, s.bankroll_after
       FROM settlements s JOIN positions p ON p.id = s.position_id
       ORDER BY s.position_id`
    ),
    pool.query(
      `SELECT p.stake_units, p.bankroll_before, p.opened_at, p.status, s.settled_at
       FROM positions p LEFT JOIN settlements s ON s.position_id = p.id
       ORDER BY p.id`
    ),
    pool.query(`SELECT value FROM agent_state WHERE key = 'bankroll_units'`),
  ]);
  const rows = settledRes.rows;
  const bankroll = bankRes.rows[0] ? Number(bankRes.rows[0].value) : null;
  const exposure = computeExposure(posRes.rows, bankroll);
  let won = 0, lost = 0, push = 0, staked = 0, pnl = 0, clvSum = 0, clvN = 0, clvPos = 0;
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
      const key = `${r.family} · ${String(r.market_key).split("|")[0]}`;
      const f = fam.get(key) ?? { n: 0, model: 0, market: 0 };
      f.n++;
      f.model += (Number(r.model_prob) - y) ** 2;
      f.market += (Number(r.market_prob) - y) ** 2;
      fam.set(key, f);
    }
  }
  return {
    settled: rows.length,
    won, lost, push, staked, pnl,
    roiPct: staked > 0 ? (pnl / staked) * 100 : null,
    clvMean: clvN > 0 ? clvSum / clvN : null,
    clvPositiveShare: clvN > 0 ? clvPos / clvN : null,
    maxDrawdown,
    brier: [...fam.entries()].map(([family, f]) => ({
      family,
      n: f.n,
      model: f.model / f.n,
      market: f.market / f.n,
    })),
    exposure,
  };
}

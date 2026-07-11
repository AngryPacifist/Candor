// The autonomy engine: the live counterpart of src/replay/simulate.ts, kept
// semantically identical to it (same gates, same honest-fill rule, same
// stream-time clock) so replay results transfer to live behavior. Composes the
// already-verified parts: fair-price fit -> signal scans -> sizing -> ledger
// -> hash-chained commit -> settle at game_finalised -> on-chain proof.

import type { Connection, Keypair } from "@solana/web3.js";
import type pg from "pg";
import { commitPosition } from "../chain/commit.js";
import { proveSettlement } from "../chain/proof.js";
import { fitFairPrices } from "../model/fairprice.js";
import { parseOddsRecord, type ParsedLine } from "../model/markets.js";
import { Ledger } from "../ledger/ledger.js";
import { fitIsTradable, scanDivergence } from "../strategy/divergence.js";
import { MovementDetector } from "../strategy/movement.js";
import type { StrategyParams } from "../strategy/params.js";
import type { SignalCandidate } from "../strategy/signals.js";
import { sizePosition } from "../strategy/sizing.js";
import type { TxlineClient } from "../txline/client.js";
import type { OddsRecord, ScoreRecord } from "../txline/types.js";

interface FixtureLive {
  lines: Map<string, ParsedLine>;
  statusId: number | null;
  clockSeconds: number;
  goals1: number;
  goals2: number;
  h1goals1: number;
  h1goals2: number;
  lastGoalTs: number;
  lastDataTs: number;
  finalised: boolean;
  settling: boolean;
  busy: boolean;
}

export interface EngineDeps {
  pool: pg.Pool;
  client: TxlineClient;
  conn: Connection;
  agent: Keypair;
  params: StrategyParams;
  log: (msg: string) => void;
}

export class AgentEngine {
  private live = new Map<number, FixtureLive>();
  private detector: MovementDetector;
  private cooldowns = new Map<string, number>();
  private ledger: Ledger;
  private bankrollCache: number | null = null;
  readonly counters = {
    entries: 0,
    passes: 0,
    jumps: 0,
    commits: 0,
    commitFailures: 0,
    settledPositions: 0,
    proofs: 0,
    proofUnavailable: 0,
  };

  constructor(private deps: EngineDeps) {
    this.detector = new MovementDetector(deps.params);
    this.ledger = new Ledger(deps.pool);
  }

  private fx(fixtureId: number): FixtureLive {
    let f = this.live.get(fixtureId);
    if (!f) {
      f = {
        lines: new Map(),
        statusId: null,
        clockSeconds: 0,
        goals1: 0,
        goals2: 0,
        h1goals1: 0,
        h1goals2: 0,
        lastGoalTs: 0,
        lastDataTs: 0,
        finalised: false,
        settling: false,
        busy: false,
      };
      this.live.set(fixtureId, f);
    }
    return f;
  }

  onOddsRecord(rec: OddsRecord): void {
    const parsed = parseOddsRecord(rec);
    if (!parsed || !rec.FixtureId) return;
    const f = this.fx(rec.FixtureId);
    f.lines.set(parsed.key, parsed);
    f.lastDataTs = Math.max(f.lastDataTs, parsed.ts);
    const jump = this.detector.addTick(rec.FixtureId, parsed);
    if (jump) {
      this.counters.jumps++;
      this.deps.log(
        `jump: fixture ${jump.fixtureId} ${jump.lineKey} moved ${jump.movePts.toFixed(1)}pts z=${jump.z.toFixed(1)} — movement scan armed`
      );
    }
  }

  onScoreRecord(rec: ScoreRecord): void {
    if (!rec.FixtureId) return;
    const f = this.fx(rec.FixtureId);
    f.lastDataTs = Math.max(f.lastDataTs, rec.Ts);
    if (rec.StatusId !== undefined) f.statusId = rec.StatusId;
    if (rec.Clock?.Seconds !== undefined) f.clockSeconds = rec.Clock.Seconds;
    const s = rec.Score as any;
    if (s?.Participant1?.Total?.Goals !== undefined || s?.Participant2?.Total?.Goals !== undefined) {
      const g1 = s?.Participant1?.Total?.Goals ?? f.goals1;
      const g2 = s?.Participant2?.Total?.Goals ?? f.goals2;
      if (g1 !== f.goals1 || g2 !== f.goals2) f.lastGoalTs = rec.Ts;
      f.goals1 = g1;
      f.goals2 = g2;
    }
    if (s?.Participant1?.H1?.Goals !== undefined) f.h1goals1 = s.Participant1.H1.Goals;
    if (s?.Participant2?.H1?.Goals !== undefined) f.h1goals2 = s.Participant2.H1.Goals;
    if ((rec.Action === "game_finalised" || rec.StatusId === 100) && !f.finalised) {
      f.finalised = true;
      this.deps.log(`fixture ${rec.FixtureId} finalised at seq ${rec.Seq} — settlement scheduled`);
      void this.settleAndProve(rec.FixtureId);
    }
    // Abandoned (15), Cancelled (16), coverage-cancelled (17), Postponed (19):
    // the match will not produce a settlement-grade record — void open positions.
    if (rec.StatusId !== undefined && [15, 16, 17, 19].includes(rec.StatusId) && !f.finalised) {
      f.finalised = true;
      void this.voidFixture(rec.FixtureId, `match status ${rec.StatusId} (abandoned/cancelled/postponed)`);
    }
  }

  private async voidFixture(fixtureId: number, reason: string): Promise<void> {
    try {
      const voided = await this.ledger.voidFixture(fixtureId, reason);
      this.counters.settledPositions += voided.length;
      this.bankrollCache = null;
      if (voided.length > 0)
        this.deps.log(`VOIDED fixture ${fixtureId}: ${voided.length} position(s) — ${reason}`);
      for (const v of voided) {
        await this.deps.pool.query(
          `INSERT INTO proofs (position_id, status, stat_keys, strategy, error)
           VALUES ($1, 'proof_unavailable', '{}', 'null', $2)`,
          [v.positionId, `voided: ${reason}`]
        );
      }
      this.detector.forget(fixtureId);
      this.live.delete(fixtureId);
    } catch (e) {
      this.deps.log(`void failed for fixture ${fixtureId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Watchdog: open positions on fixtures whose state stopped updating are a
   * production hazard (coverage died before game_finalised). Returns the
   * count for the heartbeat; logs loudly when nonzero.
   */
  async staleOpenPositions(): Promise<number> {
    const res = await this.deps.pool.query(
      `SELECT count(*)::int AS n
       FROM positions p
       JOIN fixtures f ON f.fixture_id = p.fixture_id
       LEFT JOIN match_state m ON m.fixture_id = p.fixture_id
       WHERE p.status = 'open'
         AND f.start_time < now() - interval '4 hours'
         AND (m.updated_at IS NULL OR m.updated_at < now() - interval '30 minutes')`
    );
    const n: number = res.rows[0].n;
    if (n > 0) this.deps.log(`ALARM: ${n} open position(s) on stale fixtures — coverage may have died before finalisation`);
    return n;
  }

  /** Called on a timer; evaluates every fixture currently in a tradable phase. */
  evaluateAll(): void {
    for (const fixtureId of this.live.keys()) void this.evaluate(fixtureId);
  }

  private async evaluate(fixtureId: number): Promise<void> {
    const P = this.deps.params;
    const f = this.live.get(fixtureId);
    if (!f || f.busy || f.finalised || f.settling) return;
    if (f.statusId === null || !(P.gates.tradableStatusIds as readonly number[]).includes(f.statusId)) return;
    if (f.clockSeconds > P.gates.latestEntryClockSeconds) return;
    if (f.lastDataTs === 0) return;
    f.busy = true;
    try {
      const nowTs = f.lastDataTs;
      const trigger = this.detector.armedTrigger(fixtureId, nowTs);
      for (const scope of ["full", "half1"] as const) {
        if (scope === "half1" && f.statusId !== 2) continue;
        const goals1 = scope === "full" ? f.goals1 : f.h1goals1;
        const goals2 = scope === "full" ? f.goals2 : f.h1goals2;
        const scopeLines = [...f.lines.values()].filter((l) => l.scope === scope);
        if (scopeLines.length === 0) continue;
        const fit = fitFairPrices({ goals1, goals2, lines: scopeLines, nowTs }, P.fairprice);
        if (!fit || fitIsTradable(fit, P)) continue;
        const family = trigger ? "movement" : "divergence";
        const prefix = trigger
          ? `jump ${trigger.movePts.toFixed(1)}pts z=${trigger.z.toFixed(1)} on ${trigger.lineKey}; `
          : "";
        const cands = scanDivergence(
          { fixtureId, goals1, goals2, fit, lines: scopeLines, nowTs, minQuoteTs: Math.max(f.lastGoalTs, trigger?.ts ?? 0) },
          P,
          family,
          prefix
        );
        for (const cand of cands) {
          if (trigger && cand.lineKey === trigger.lineKey) continue;
          const cdKey = `${fixtureId}|${cand.lineKey}|${cand.side}`;
          const last = this.cooldowns.get(cdKey);
          const cdMs = family === "movement" ? P.movement.lineCooldownMs : P.divergence.lineCooldownMs;
          if (last !== undefined && cand.ts - last < cdMs) continue;

          const bankroll = await this.bankroll();
          const sized = sizePosition(cand, bankroll, P);
          if (!sized) {
            await this.logSignal(cand, scope, "pass", "stake below floor after Kelly sizing");
            continue;
          }
          const exposure = await this.ledger.exposureCheck(fixtureId);
          if (exposure) {
            this.counters.passes++;
            await this.logSignal(cand, scope, "pass", exposure);
            continue;
          }
          const opened = await this.ledger.openPosition({
            candidate: cand,
            scope,
            stakeUnits: sized.stakeUnits,
            kellyFraction: sized.kellyFraction,
            entryGoals1: goals1,
            entryGoals2: goals2,
          });
          this.cooldowns.set(cdKey, cand.ts);
          this.counters.entries++;
          this.bankrollCache = null;
          await this.logSignal(cand, scope, "enter", `${sized.reason} -> position ${opened.id}`, opened.id);
          this.deps.log(
            `ENTER [${family}/${scope}] position ${opened.id}: ${cand.lineKey} ${cand.side} @${cand.price.toFixed(3)} stake ${sized.stakeUnits}u — ${cand.reason.slice(0, 120)}`
          );
          void this.commitWithLogging(opened.id);
        }
      }
    } catch (e) {
      this.deps.log(`evaluate error (fixture ${fixtureId}): ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      f.busy = false;
    }
  }

  private async commitWithLogging(positionId: number): Promise<void> {
    const r = await commitPosition(this.deps.pool, this.deps.conn, this.deps.agent, positionId);
    if (r.status === "committed") {
      this.counters.commits++;
      this.deps.log(`committed position ${positionId}: ${r.sig}`);
    } else if (r.status === "failed") {
      this.counters.commitFailures++;
      this.deps.log(`COMMIT FAILED position ${positionId}: ${r.error} (will retry)`);
    }
  }

  /** Retry any commits that previously failed (called on a timer). */
  async retryFailedCommits(): Promise<void> {
    const res = await this.deps.pool.query(`SELECT id FROM positions WHERE commit_status = 'failed' ORDER BY id`);
    for (const row of res.rows) await this.commitWithLogging(Number(row.id));
  }

  /**
   * Retry proofs that failed for transient reasons (called on a timer).
   * TxODDS anchors score batches in windows, so stat-validation 404s for a
   * freshly finalised record — observed live on the agent's first settlement.
   * Structural reasons (extra time, void, result mismatch) are not retried.
   */
  async retryPendingProofs(): Promise<void> {
    const res = await this.deps.pool.query(
      `SELECT DISTINCT ON (pr.position_id) pr.position_id, pr.status, pr.error
       FROM proofs pr JOIN settlements s ON s.position_id = pr.position_id
       WHERE s.settled_at > now() - interval '24 hours'
       ORDER BY pr.position_id, pr.id DESC`
    );
    for (const row of res.rows) {
      if (row.status !== "proof_unavailable") continue;
      const err: string = row.error ?? "";
      if (!/HTTP 404|HTTP 5\d\d|HTTP 429|fetch|network|timeout|unreachable|blockhash/i.test(err)) continue;
      const proof = await proveSettlement(this.deps.pool, this.deps.client, Number(row.position_id));
      if (proof.status === "proven") {
        this.counters.proofs++;
        this.deps.log(`PROVEN (retry) position ${row.position_id}: result=${proof.result} tx ${proof.broadcastSig}`);
      }
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }

  private async settleAndProve(fixtureId: number): Promise<void> {
    const f = this.fx(fixtureId);
    if (f.settling) return;
    f.settling = true;
    // let the scores fold and odds flush land in the DB first
    await new Promise((r) => setTimeout(r, 30_000));
    let settled: Awaited<ReturnType<Ledger["settleFixture"]>> = [];
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        settled = await this.ledger.settleFixture(fixtureId);
        break;
      } catch (e) {
        if (attempt === 5) {
          this.deps.log(`SETTLEMENT FAILED fixture ${fixtureId}: ${e instanceof Error ? e.message : String(e)}`);
          f.settling = false;
          return;
        }
        await new Promise((r) => setTimeout(r, 10_000));
      }
    }
    this.counters.settledPositions += settled.length;
    this.bankrollCache = null;
    this.deps.log(
      `settled fixture ${fixtureId}: ${settled.length} position(s) ${settled.map((s) => `#${s.positionId} ${s.outcome} ${s.pnlUnits >= 0 ? "+" : ""}${s.pnlUnits}u clv=${s.clvPts ?? "n/a"}`).join(" · ")}`
    );
    for (const s of settled) {
      const proof = await proveSettlement(this.deps.pool, this.deps.client, s.positionId);
      if (proof.status === "proven") {
        this.counters.proofs++;
        this.deps.log(`PROVEN position ${s.positionId}: result=${proof.result} tx ${proof.broadcastSig}`);
      } else {
        this.counters.proofUnavailable++;
        this.deps.log(`proof unavailable for position ${s.positionId}: ${proof.reason}`);
      }
      await new Promise((r) => setTimeout(r, 2_000));
    }
    this.detector.forget(fixtureId);
    this.live.delete(fixtureId);
  }

  /** Warm in-memory state from snapshots after a (re)start. */
  async warmup(): Promise<void> {
    const fixtures = await this.deps.pool.query(
      `SELECT fixture_id FROM fixtures WHERE start_time BETWEEN now() - interval '6 hours' AND now() + interval '36 hours'`
    );
    for (const row of fixtures.rows) {
      const fixtureId = Number(row.fixture_id);
      try {
        const scores = await this.deps.client.scoresSnapshot(fixtureId);
        for (const rec of [...scores].sort((a, b) => a.Seq - b.Seq)) this.onScoreRecord(rec);
        const odds = await this.deps.client.oddsSnapshot(fixtureId);
        for (const rec of odds) this.onOddsRecord(rec);
        this.deps.log(`warmup fixture ${fixtureId}: ${scores.length} score records, ${odds.length} odds lines`);
      } catch (e) {
        this.deps.log(`warmup fixture ${fixtureId} skipped: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // rebuild recent cooldowns so a restart cannot double-enter a line
    const cds = await this.deps.pool.query(
      `SELECT fixture_id, market_key, side, decided_ts FROM positions WHERE opened_at > now() - interval '30 minutes'`
    );
    for (const r of cds.rows) {
      this.cooldowns.set(`${r.fixture_id}|${r.market_key}|${r.side}`, Number(r.decided_ts));
    }
    if (cds.rows.length > 0) this.deps.log(`warmup: ${cds.rows.length} cooldown(s) rebuilt`);
  }

  private async bankroll(): Promise<number> {
    if (this.bankrollCache === null) this.bankrollCache = await this.ledger.getBankroll();
    return this.bankrollCache;
  }

  private async logSignal(
    cand: SignalCandidate,
    scope: string,
    decision: "enter" | "pass",
    reason: string,
    positionId?: number
  ): Promise<void> {
    try {
      await this.deps.pool.query(
        `INSERT INTO signals (fixture_id, family, market_key, side, model_price, market_price,
           edge, decision, reason, inputs, position_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          cand.fixtureId,
          cand.family,
          `${cand.lineKey}|scope=${scope}`,
          cand.side,
          cand.modelProb,
          cand.marketProb,
          cand.edgePts,
          decision,
          `${reason} :: ${cand.reason}`.slice(0, 900),
          JSON.stringify({
            price: cand.price,
            quoteAgeMs: cand.quoteAgeMs,
            fit: {
              lambdaTotal: cand.fit.lambdaTotal,
              share: cand.fit.share,
              ouLinesUsed: cand.fit.ouLinesUsed,
              anchorResidual: cand.fit.anchorResidual,
            },
          }),
          positionId ?? null,
        ]
      );
    } catch (e) {
      this.deps.log(`signal log failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

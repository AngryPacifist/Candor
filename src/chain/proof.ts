// Prove-at-settlement: each settled position's exact market condition is
// compiled to a validate_stat_v2 strategy and certified against TxODDS's
// on-chain Merkle root — first as a free simulation (result must match our
// settlement), then broadcast as a real transaction for permanence.
//
// Key choices (all empirically grounded, Session 1):
// - Full-match (regulation) conditions use total-goal keys 1/2, valid when no
//   extra time occurred (verified totals == H1 band + H2 band on both
//   recordings). If ET markers are present, the proof degrades HONESTLY to
//   proof_unavailable (the feed's ET period bands are unverified — docs table
//   is wrong for the bands we could verify).
// - First-half conditions use the 1000 band (verified).
// - AH conditions fold the committed entry score into the threshold:
//   part1 covers iff (K1 - K2) > entry1 - entry2 - line.
// - Non-integer thresholds floor/ceil to the equivalent integer comparison.

import BN from "bn.js";
import { ComputeBudgetProgram } from "@solana/web3.js";
import type pg from "pg";
import type { TxlineClient } from "../txline/client.js";
import { splitMarketKey } from "../ledger/ledger.js";
import { dailyScoresPda, loadAgentKeypair, mainnetConnection, mapProof, parseHash, txoracleProgram } from "./solana.js";

const VALIDATE_CU = 1_400_000;
const CU_PRICE_MICROLAMPORTS = 5_000;

type Cmp = { greaterThan: {} } | { lessThan: {} } | { equalTo: {} };
const gt = (threshold: number): { threshold: number; comparison: Cmp } => ({ threshold, comparison: { greaterThan: {} } });
const lt = (threshold: number): { threshold: number; comparison: Cmp } => ({ threshold, comparison: { lessThan: {} } });
const eq = (threshold: number): { threshold: number; comparison: Cmp } => ({ threshold, comparison: { equalTo: {} } });

export interface WinCondition {
  statKeys: [number, number];
  strategy: {
    geometricTargets: never[];
    distancePredicate: null;
    discretePredicates: unknown[];
  };
  /** what the on-chain result should be, given our settlement outcome */
  expected: boolean;
  description: string;
}

export type ConditionResult = { ok: true; condition: WinCondition } | { ok: false; reason: string };

/**
 * Compile a settled position into the on-chain claim to verify.
 * The claim encodes the SIDE'S WIN condition (or the push condition for a
 * push), so: won -> expected true, lost -> expected false, push -> true.
 */
export function buildWinCondition(position: {
  marketKey: string;
  scope: string;
  side: string;
  entryGoals1: number;
  entryGoals2: number;
  outcome: "won" | "lost" | "push" | "void";
}): ConditionResult {
  const [type, , params] = splitMarketKey(position.marketKey);
  const lineMatch = /line=(-?\d+(?:\.\d+)?)/.exec(params);
  const line = lineMatch ? Number(lineMatch[1]) : null;
  const keys: [number, number] = position.scope === "half1" ? [1001, 1002] : [1, 2];
  if (position.outcome === "void") return { ok: false, reason: "void positions carry no claim" };

  const binary = (op: "add" | "subtract", predicate: { threshold: number; comparison: Cmp }) => ({
    binary: { indexA: 0, indexB: 1, op: { [op]: {} }, predicate },
  });
  const finish = (predicates: unknown[], expected: boolean, description: string): ConditionResult => ({
    ok: true,
    condition: {
      statKeys: keys,
      strategy: { geometricTargets: [], distancePredicate: null, discretePredicates: predicates },
      expected,
      description,
    },
  });

  if (type === "1X2_PARTICIPANT_RESULT") {
    const pred = position.side === "part1" ? gt(0) : position.side === "part2" ? lt(0) : eq(0);
    return finish(
      [binary("subtract", pred)],
      position.outcome === "won",
      `1X2 ${position.side}: goal margin ${position.side === "part1" ? ">" : position.side === "part2" ? "<" : "="} 0`
    );
  }

  if (type === "OVERUNDER_PARTICIPANT_GOALS") {
    if (line === null) return { ok: false, reason: "OU without a line" };
    if (position.outcome === "push") {
      return finish([binary("add", eq(line))], true, `OU push: total = ${line}`);
    }
    const isInt = Number.isInteger(line);
    const pred =
      position.side === "over"
        ? gt(isInt ? line : Math.floor(line))
        : lt(isInt ? line : Math.ceil(line));
    return finish(
      [binary("add", pred)],
      position.outcome === "won",
      `OU ${position.side} ${line}: total ${position.side === "over" ? ">" : "<"} ${line}`
    );
  }

  if (type === "ASIANHANDICAP_PARTICIPANT_GOALS") {
    if (line === null) return { ok: false, reason: "AH without a line" };
    // part1 covers iff (K1 - K2) > c, with c = entry1 - entry2 - line
    const c = position.entryGoals1 - position.entryGoals2 - line;
    const isInt = Number.isInteger(c);
    if (position.outcome === "push") {
      if (!isInt) return { ok: false, reason: "push on non-integer AH threshold is impossible" };
      return finish([binary("subtract", eq(c))], true, `AH push: margin = ${c}`);
    }
    const pred =
      position.side === "part1"
        ? gt(isInt ? c : Math.floor(c))
        : lt(isInt ? c : Math.ceil(c));
    return finish(
      [binary("subtract", pred)],
      position.outcome === "won",
      `AH ${position.side} line ${line} from ${position.entryGoals1}-${position.entryGoals2}: margin ${position.side === "part1" ? ">" : "<"} ${c}`
    );
  }

  return { ok: false, reason: `unknown market type ${type}` };
}

export type ProofOutcome =
  | { status: "proven"; result: boolean; broadcastSig: string; statKeys: number[] }
  | { status: "proof_unavailable"; reason: string };

/**
 * Prove one settled position on mainnet and record it in the proofs table.
 * Simulation first (must agree with our settlement), then real broadcast.
 */
export async function proveSettlement(
  pool: pg.Pool,
  client: TxlineClient,
  positionId: number
): Promise<ProofOutcome> {
  const record = async (outcome: ProofOutcome, extra: Record<string, unknown> = {}) => {
    await pool.query(
      `INSERT INTO proofs (position_id, status, stat_keys, target_ts, strategy, result, broadcast_sig, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        positionId,
        outcome.status,
        outcome.status === "proven" ? outcome.statKeys : (extra.statKeys as number[] | undefined) ?? [],
        (extra.targetTs as number | undefined) ?? null,
        JSON.stringify(extra.strategy ?? null),
        outcome.status === "proven" ? outcome.result : null,
        outcome.status === "proven" ? outcome.broadcastSig : null,
        outcome.status === "proven" ? null : outcome.reason,
      ]
    );
    return outcome;
  };

  const posRes = await pool.query(
    `SELECT p.fixture_id, p.market_key, p.scope, p.side, p.entry_goals1, p.entry_goals2,
            s.outcome, m.finalised_seq, m.stats
     FROM positions p
     JOIN settlements s ON s.position_id = p.id
     JOIN match_state m ON m.fixture_id = p.fixture_id
     WHERE p.id = $1`,
    [positionId]
  );
  const pos = posRes.rows[0];
  if (!pos) return record({ status: "proof_unavailable", reason: "position/settlement not found" });
  if (!pos.finalised_seq) return record({ status: "proof_unavailable", reason: "fixture not finalised" });

  // ET guard for full-scope claims (regulation != totals when ET happened)
  const stats: Record<string, number> = pos.stats ?? {};
  const stat = (k: number) => stats[String(k)] ?? 0;
  if (pos.scope !== "half1") {
    const etMarkers =
      stat(4001) + stat(4002) + stat(5001) + stat(5002) + stat(6001) + stat(6002) + stat(7001) + stat(7002);
    const totalsAgree = stat(1) === stat(1001) + stat(3001) && stat(2) === stat(1002) + stat(3002);
    if (etMarkers > 0 || !totalsAgree) {
      return record({
        status: "proof_unavailable",
        reason: "extra time detected: full-match regulation split is not on-chain-provable until ET period-band semantics are verified",
      });
    }
  }

  const built = buildWinCondition({
    marketKey: pos.market_key,
    scope: pos.scope,
    side: pos.side,
    entryGoals1: Number(pos.entry_goals1),
    entryGoals2: Number(pos.entry_goals2),
    outcome: pos.outcome,
  });
  if (!built.ok) return record({ status: "proof_unavailable", reason: built.reason });
  const { condition } = built;

  try {
    const val = await client.statValidation(Number(pos.fixture_id), Number(pos.finalised_seq), condition.statKeys);
    const targetTs = val.summary.updateStats.minTimestamp;
    const payload = {
      ts: new BN(targetTs),
      fixtureSummary: {
        fixtureId: new BN(val.summary.fixtureId),
        updateStats: {
          updateCount: val.summary.updateStats.updateCount,
          minTimestamp: new BN(val.summary.updateStats.minTimestamp),
          maxTimestamp: new BN(val.summary.updateStats.maxTimestamp),
        },
        eventsSubTreeRoot: parseHash(val.summary.eventStatsSubTreeRoot),
      },
      fixtureProof: mapProof(val.subTreeProof as any),
      mainTreeProof: mapProof(val.mainTreeProof as any),
      eventStatRoot: parseHash(val.eventStatRoot),
      stats: val.statsToProve.map((s, i) => ({ stat: s, statProof: mapProof(val.statProofs[i] as any) })),
    };

    const conn = mainnetConnection();
    const agent = loadAgentKeypair();
    const { program } = txoracleProgram(conn, agent);
    const pda = dailyScoresPda(targetTs, program.programId);
    const cuLimit = ComputeBudgetProgram.setComputeUnitLimit({ units: VALIDATE_CU });
    const cuPrice = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CU_PRICE_MICROLAMPORTS });

    const method = () =>
      (program.methods as any)
        .validateStatV2(payload, condition.strategy)
        .accounts({ dailyScoresMerkleRoots: pda })
        .preInstructions([cuLimit, cuPrice]);

    const simulated: boolean = await method().view();
    if (simulated !== condition.expected) {
      return record(
        {
          status: "proof_unavailable",
          reason: `on-chain result ${simulated} does not match settlement expectation ${condition.expected} — investigate before trusting either`,
        },
        { statKeys: condition.statKeys, targetTs, strategy: condition.strategy }
      );
    }
    const broadcastSig: string = await method().rpc();
    return record(
      { status: "proven", result: simulated, broadcastSig, statKeys: condition.statKeys },
      { targetTs, strategy: condition.strategy }
    );
  } catch (e) {
    return record(
      { status: "proof_unavailable", reason: e instanceof Error ? e.message.slice(0, 400) : String(e) },
      { statKeys: condition.statKeys, strategy: condition.strategy }
    );
  }
}

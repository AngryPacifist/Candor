// Prove-at-settlement: each settled position's exact market condition is
// compiled to an on-chain validation strategy and certified against TxODDS's
// Merkle root — first as a free simulation (result must match our
// settlement), then broadcast as a real transaction for permanence.
//
// Method: validate_stat_v3 (Merkle multiproof) is primary since 2026-07-13,
// the day TxODDS promoted it to the mainnet cluster (probed and adopted the
// same day); validate_stat_v2 is the automatic fallback when the V3 leg
// throws (endpoint / transport / program errors). A simulated verdict that
// contradicts our settlement is TERMINAL and never falls back: both methods
// read the same certified stats, so a mismatch is a truth problem, not a
// transport problem. Every proof row records the method that produced it.
// The strategy (win condition) is IDENTICAL across methods — only the API
// endpoint and payload shape differ; every comparison × op combination the
// compiler can emit was simulated through BOTH methods on mainnet before
// adoption.
//
// Key choices (all empirically grounded, Sessions 1-3):
// - Full-match (regulation) conditions use total-goal keys 1/2, valid when no
//   extra time occurred (verified totals == H1 band + H2 band on both
//   recordings). If ET markers are present, the proof switches to the
//   regulation-component path (bands verified live 2026-07-12).
// - First-half conditions use the 1000 band (verified).
// - AH conditions fold the committed entry score into the threshold:
//   part1 covers iff (K1 - K2) > entry1 - entry2 - line.
// - Non-integer thresholds floor/ceil to the equivalent integer comparison.

import BN from "bn.js";
import { ComputeBudgetProgram } from "@solana/web3.js";
import type pg from "pg";
import type { TxlineClient } from "../txline/client.js";
import type { StatValidationResponse, StatValidationV3Response } from "../txline/types.js";
import { splitMarketKey } from "../ledger/ledger.js";
import { dailyScoresPda, loadAgentKeypair, mainnetConnection, mapProof, parseHash, txoracleProgram } from "./solana.js";

const VALIDATE_CU = 1_400_000;
const CU_PRICE_MICROLAMPORTS = 5_000;

type Cmp = { greaterThan: {} } | { lessThan: {} } | { equalTo: {} };
const gt = (threshold: number): { threshold: number; comparison: Cmp } => ({ threshold, comparison: { greaterThan: {} } });
const lt = (threshold: number): { threshold: number; comparison: Cmp } => ({ threshold, comparison: { lessThan: {} } });
const eq = (threshold: number): { threshold: number; comparison: Cmp } => ({ threshold, comparison: { equalTo: {} } });

export interface WinCondition {
  statKeys: number[];
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

export type ProofMethod = "validate_stat_v3" | "validate_stat_v2";

export type ProofOutcome =
  | { status: "proven"; result: boolean; broadcastSig: string; statKeys: number[]; method: ProofMethod }
  | { status: "proof_unavailable"; reason: string };

/** The head fields shared by both validation response shapes. */
type ValidationHead = Pick<
  StatValidationResponse,
  "summary" | "eventStatRoot" | "subTreeProof" | "mainTreeProof"
>;

function payloadHead(val: ValidationHead) {
  return {
    ts: new BN(val.summary.updateStats.minTimestamp),
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
  };
}

/** The exact bytes sent to validate_stat_v2 (exported so tests share them). */
export function buildV2Payload(val: StatValidationResponse) {
  return {
    ...payloadHead(val),
    stats: val.statsToProve.map((s, i) => ({ stat: s, statProof: mapProof(val.statProofs[i] as any) })),
  };
}

/**
 * The exact bytes sent to validate_stat_v3 (exported so tests share them).
 * `stat ?? l` mirrors TxODDS's own example: defensive against the leaf
 * arriving flat instead of nested. multiproof fields pass through verbatim.
 */
export function buildV3Payload(val: StatValidationV3Response) {
  return {
    ...payloadHead(val),
    leaves: val.statsToProve.map((l) => ({
      stat: (l as { stat?: unknown }).stat ?? l,
      statProof: mapProof(l.statProof as any),
    })),
    leafIndices: val.multiproof.indices,
    multiproofHashes: mapProof(val.multiproof.hashes as any),
  };
}

/**
 * Prove one settled position on mainnet and record it in the proofs table.
 * Simulation first (must agree with our settlement), then real broadcast.
 * validate_stat_v3 first; validate_stat_v2 when the V3 leg throws.
 */
export async function proveSettlement(
  pool: pg.Pool,
  client: TxlineClient,
  positionId: number
): Promise<ProofOutcome> {
  const record = async (outcome: ProofOutcome, extra: Record<string, unknown> = {}) => {
    await pool.query(
      `INSERT INTO proofs (position_id, status, stat_keys, target_ts, strategy, result, broadcast_sig, error, method)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        positionId,
        outcome.status,
        outcome.status === "proven" ? outcome.statKeys : (extra.statKeys as number[] | undefined) ?? [],
        (extra.targetTs as number | undefined) ?? null,
        JSON.stringify(extra.strategy ?? null),
        outcome.status === "proven" ? outcome.result : null,
        outcome.status === "proven" ? outcome.broadcastSig : null,
        outcome.status === "proven" ? null : outcome.reason,
        outcome.status === "proven" ? outcome.method : ((extra.method as string | undefined) ?? null),
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

  // ET handling for full-scope claims: totals keys include extra-time goals,
  // so the win condition cannot use them directly. Instead we certify the
  // exact REGULATION COMPONENTS on-chain (bands verified live 2026-07-12:
  // 1000=H1, 3000=H2, 4000=ET1, 7000=ET cumulative; regulation = 1000+3000)
  // and the market outcome is public arithmetic over the certified values.
  const stats: Record<string, number> = pos.stats ?? {};
  const stat = (k: number) => stats[String(k)] ?? 0;
  let condition: WinCondition | null = null;
  if (pos.scope !== "half1") {
    const etMarkers =
      stat(4001) + stat(4002) + stat(5001) + stat(5002) + stat(6001) + stat(6002) + stat(7001) + stat(7002);
    const totalsAgree = stat(1) === stat(1001) + stat(3001) && stat(2) === stat(1002) + stat(3002);
    if (etMarkers > 0 || !totalsAgree) {
      const eqAt = (v: number) => ({ threshold: v, comparison: { equalTo: {} } });
      condition = {
        statKeys: [1001, 1002, 3001, 3002],
        strategy: {
          geometricTargets: [],
          distancePredicate: null,
          discretePredicates: [
            { single: { index: 0, predicate: eqAt(stat(1001)) } },
            { single: { index: 1, predicate: eqAt(stat(1002)) } },
            { single: { index: 2, predicate: eqAt(stat(3001)) } },
            { single: { index: 3, predicate: eqAt(stat(3002)) } },
          ],
        },
        expected: true,
        description: `ET match: regulation components certified exactly (H1 ${stat(1001)}-${stat(1002)}, H2 ${stat(3001)}-${stat(3002)}); the market outcome follows by public arithmetic`,
      };
    }
  }

  if (!condition) {
    const built = buildWinCondition({
      marketKey: pos.market_key,
      scope: pos.scope,
      side: pos.side,
      entryGoals1: Number(pos.entry_goals1),
      entryGoals2: Number(pos.entry_goals2),
      outcome: pos.outcome,
    });
    if (!built.ok) return record({ status: "proof_unavailable", reason: built.reason });
    condition = built.condition;
  }

  const conn = mainnetConnection();
  const agent = loadAgentKeypair();
  const { program } = txoracleProgram(conn, agent);
  const cuLimit = ComputeBudgetProgram.setComputeUnitLimit({ units: VALIDATE_CU });
  const cuPrice = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CU_PRICE_MICROLAMPORTS });

  // One leg: fetch the method's payload, simulate, then broadcast. Throws on
  // transport/program errors (the caller falls back); a verdict is returned
  // either way and judged by the caller.
  const attempt = async (methodName: ProofMethod) => {
    const fixtureId = Number(pos.fixture_id);
    const seq = Number(pos.finalised_seq);
    let payload: unknown;
    let targetTs: number;
    if (methodName === "validate_stat_v3") {
      const val = await client.statValidationV3(fixtureId, seq, condition.statKeys);
      targetTs = val.summary.updateStats.minTimestamp;
      payload = buildV3Payload(val);
    } else {
      const val = await client.statValidation(fixtureId, seq, condition.statKeys);
      targetTs = val.summary.updateStats.minTimestamp;
      payload = buildV2Payload(val);
    }
    const pda = dailyScoresPda(targetTs, program.programId);
    const anchorMethod = methodName === "validate_stat_v3" ? "validateStatV3" : "validateStatV2";
    const call = () =>
      (program.methods as any)[anchorMethod](payload, condition.strategy)
        .accounts({ dailyScoresMerkleRoots: pda })
        .preInstructions([cuLimit, cuPrice]);
    const simulated: boolean = await call().view();
    if (simulated !== condition.expected) return { verdict: "mismatch" as const, simulated, targetTs };
    const broadcastSig: string = await call().rpc();
    return { verdict: "proven" as const, simulated, broadcastSig, targetTs };
  };

  const judge = (methodName: ProofMethod, r: Awaited<ReturnType<typeof attempt>>): Promise<ProofOutcome> => {
    if (r.verdict === "mismatch") {
      // Terminal, never falls back: both methods read the same certified
      // stats, so a contradiction with our settlement is a truth problem.
      return record(
        {
          status: "proof_unavailable",
          reason: `on-chain result ${r.simulated} does not match settlement expectation ${condition.expected} — investigate before trusting either`,
        },
        { statKeys: condition.statKeys, targetTs: r.targetTs, strategy: condition.strategy, method: methodName }
      );
    }
    return record(
      { status: "proven", result: r.simulated, broadcastSig: r.broadcastSig, statKeys: condition.statKeys, method: methodName },
      { targetTs: r.targetTs, strategy: condition.strategy }
    );
  };

  // The fallback boundary wraps ONLY the on-chain attempts. Recording happens
  // outside it, so a database failure propagates loudly (as it always did)
  // instead of masquerading as a V3 transport error and double-broadcasting.
  let legMethod: ProofMethod;
  let legResult: Awaited<ReturnType<typeof attempt>>;
  try {
    legMethod = "validate_stat_v3";
    legResult = await attempt("validate_stat_v3");
  } catch (e3) {
    const v3Msg = e3 instanceof Error ? e3.message : String(e3);
    try {
      legMethod = "validate_stat_v2";
      legResult = await attempt("validate_stat_v2");
    } catch (e2) {
      const v2Msg = e2 instanceof Error ? e2.message : String(e2);
      return record(
        { status: "proof_unavailable", reason: `v3: ${v3Msg.slice(0, 190)} | v2: ${v2Msg.slice(0, 190)}` },
        { statKeys: condition.statKeys, strategy: condition.strategy, method: "validate_stat_v2" }
      );
    }
  }
  return judge(legMethod, legResult);
}

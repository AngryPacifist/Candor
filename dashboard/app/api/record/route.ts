import { NextResponse } from "next/server";
import { pool } from "../../../lib/db";

export const dynamic = "force-dynamic";

// The machine-readable record: everything needed to independently verify the
// agent. No auth, no cookies, cache briefly at the edge.
export async function GET() {
  const [positions, state] = await Promise.all([
    pool.query(
      `SELECT p.id, p.opened_at, p.fixture_id, f.participant1, f.participant2,
              p.market_key, p.scope, p.side, p.family, p.price_taken, p.model_prob,
              p.market_prob, p.stake_units, p.kelly_fraction, p.bankroll_before,
              p.entry_goals1, p.entry_goals2, p.decided_ts, p.status,
              p.payload_canonical, p.payload_hash, p.params_hash,
              p.prev_commit_sig, p.commit_sig, p.commit_status,
              s.outcome, s.pnl_units, s.bankroll_after, s.closing_prob, s.clv,
              s.evidence AS settlement_evidence,
              pr.status AS proof_status, pr.result AS proof_result,
              pr.broadcast_sig AS proof_sig, pr.stat_keys AS proof_stat_keys,
              pr.strategy AS proof_strategy, pr.error AS proof_error
       FROM positions p
       JOIN fixtures f ON f.fixture_id = p.fixture_id
       LEFT JOIN settlements s ON s.position_id = p.id
       LEFT JOIN LATERAL (
         SELECT status, result, broadcast_sig, stat_keys, strategy, error FROM proofs
         WHERE position_id = p.id ORDER BY id DESC LIMIT 1
       ) pr ON true
       ORDER BY p.id`
    ),
    pool.query(`SELECT key, value, updated_at FROM agent_state WHERE key IN ('bankroll_units','worker_heartbeat','last_commit_sig')`),
  ]);

  const agentState: Record<string, unknown> = {};
  for (const row of state.rows) agentState[row.key] = row.value;

  return NextResponse.json(
    {
      schema: "candor.record.v1",
      generatedAt: new Date().toISOString(),
      agentWallet: process.env.NEXT_PUBLIC_AGENT_WALLET ?? "DKdqzAhvYMB3TZFZSM7M6JA3nQqmsjk5W9Smo6vq7xrE",
      network: "mainnet-beta",
      oracleProgram: "9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA",
      howToVerify:
        "sha256(payloadCanonical) must equal payloadHash, which is committed in the memo tx commitSig; prevCommitSig chains the record; proofSig certifies the settlement on-chain via validate_stat_v2.",
      state: agentState,
      positions: positions.rows,
    },
    { headers: { "cache-control": "public, max-age=30" } }
  );
}

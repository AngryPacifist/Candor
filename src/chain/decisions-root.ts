// Daily decisions-root commit: once per completed UTC day, the Merkle root of
// EVERY signal the agent logged (entries and passes alike) goes on mainnet in
// one memo. Even the decisions not to trade become tamper-evident. Chained
// like position commits. Third parties recompute the root from the signals in
// the public record export.

import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  sendAndConfirmTransaction,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import type pg from "pg";
import { canonicalJson, sha256Hex } from "../lib/canonical.js";
import { MEMO_PROGRAM_ID } from "./solana.js";

const LAST_ROOT_KEY = "last_decisions_sig";

export function merkleRoot(leaves: string[]): string {
  if (leaves.length === 0) return sha256Hex("");
  let level = leaves;
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i]!;
      const b = level[i + 1] ?? a; // duplicate the last node on odd levels
      next.push(sha256Hex(a + b));
    }
    level = next;
  }
  return level[0]!;
}

export function signalLeaf(row: {
  id: number | string;
  ts: string | Date;
  fixture_id: number | string;
  family: string;
  market_key: string;
  side: string | null;
  edge: string | null;
  decision: string;
  reason: string;
}): string {
  return sha256Hex(
    canonicalJson({
      id: Number(row.id),
      ts: new Date(row.ts).toISOString(),
      fixtureId: Number(row.fixture_id),
      family: row.family,
      marketKey: row.market_key,
      side: row.side,
      edge: row.edge === null ? null : Number(row.edge),
      decision: row.decision,
      reason: row.reason,
    })
  );
}

/** Commit the decisions root for one UTC date (YYYY-MM-DD) if not already done. */
export async function commitDecisionsRoot(
  pool: pg.Pool,
  conn: Connection,
  agent: Keypair,
  date: string
): Promise<{ status: "committed"; sig: string; n: number } | { status: "skipped"; reason: string } | { status: "failed"; error: string }> {
  const stateKey = `decisions_root_${date}`;
  const existing = await pool.query(`SELECT value FROM agent_state WHERE key = $1`, [stateKey]);
  if (existing.rows[0]) return { status: "skipped", reason: "already committed" };

  const signals = await pool.query(
    `SELECT id, ts, fixture_id, family, market_key, side, edge, decision, reason
     FROM signals WHERE ts >= $1::date AND ts < ($1::date + interval '1 day') ORDER BY id`,
    [date]
  );
  if (signals.rows.length === 0) return { status: "skipped", reason: "no signals that day" };

  const root = merkleRoot(signals.rows.map(signalLeaf));
  const prevRes = await pool.query(`SELECT value FROM agent_state WHERE key = $1`, [LAST_ROOT_KEY]);
  const prev: string = prevRes.rows[0] ? JSON.parse(JSON.stringify(prevRes.rows[0].value)) : "genesis";
  const memo = `candor|v1|decisions|${date}|root:${root}|n:${signals.rows.length}|prev:${prev}`;

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20_000 }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: 140_000 }),
    new TransactionInstruction({
      keys: [{ pubkey: agent.publicKey, isSigner: true, isWritable: false }],
      programId: MEMO_PROGRAM_ID,
      data: Buffer.from(memo, "utf8"),
    })
  );
  try {
    const sig = await sendAndConfirmTransaction(conn, tx, [agent], { commitment: "confirmed" });
    await pool.query(
      `INSERT INTO agent_state (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [stateKey, JSON.stringify({ sig, root, n: signals.rows.length })]
    );
    await pool.query(
      `INSERT INTO agent_state (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [LAST_ROOT_KEY, JSON.stringify(sig)]
    );
    return { status: "committed", sig, n: signals.rows.length };
  } catch (e) {
    return { status: "failed", error: e instanceof Error ? e.message : String(e) };
  }
}

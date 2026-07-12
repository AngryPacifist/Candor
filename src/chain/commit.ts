// Commit-at-decision-time: one mainnet memo per position, hash-chained.
// Memo format: candor|v1|commit|<payload sha256>|params:<params hash prefix>|prev:<prev sig|genesis>
// The chain makes the record append-only: any deleted position leaves a hole a
// verifier can see. Commits are strictly serialized so the chain stays linear.

import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  sendAndConfirmTransaction,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import type pg from "pg";
import { MEMO_PROGRAM_ID } from "./solana.js";

const LAST_COMMIT_KEY = "last_commit_sig";
const MEMO_CU = 140_000; // signed memo: ed25519 signer verification is expensive (measured Step 0)
const CU_PRICE_MICROLAMPORTS = 20_000;
const ATTEMPTS = 3;

export type CommitResult =
  | { status: "committed"; sig: string; memo: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; error: string };

/** The exact memo bytes a position commit broadcasts. Pure so the replay dry-run can reproduce them. */
export function buildCommitMemo(payloadHash: string, paramsHash: string, prev: string): string {
  return `candor|v1|commit|${payloadHash}|params:${paramsHash.slice(0, 16)}|prev:${prev}`;
}

let chainLock: Promise<unknown> = Promise.resolve();

/** Commit a position's payload hash to mainnet. Serialized across callers. */
export function commitPosition(
  pool: pg.Pool,
  conn: Connection,
  agent: Keypair,
  positionId: number
): Promise<CommitResult> {
  const run = chainLock.then(() => doCommit(pool, conn, agent, positionId));
  chainLock = run.catch(() => undefined);
  return run;
}

async function doCommit(
  pool: pg.Pool,
  conn: Connection,
  agent: Keypair,
  positionId: number
): Promise<CommitResult> {
  const res = await pool.query(
    `SELECT payload_hash, params_hash, commit_status FROM positions WHERE id = $1`,
    [positionId]
  );
  const row = res.rows[0];
  if (!row) return { status: "skipped", reason: `position ${positionId} not found` };
  if (row.commit_status === "committed") return { status: "skipped", reason: "already committed" };

  const prevRes = await pool.query(`SELECT value FROM agent_state WHERE key = $1`, [LAST_COMMIT_KEY]);
  const prev: string = prevRes.rows[0] ? JSON.parse(JSON.stringify(prevRes.rows[0].value)) : "genesis";

  const memo = buildCommitMemo(row.payload_hash, String(row.params_hash), prev);
  const ix = new TransactionInstruction({
    keys: [{ pubkey: agent.publicKey, isSigner: true, isWritable: false }],
    programId: MEMO_PROGRAM_ID,
    data: Buffer.from(memo, "utf8"),
  });
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CU_PRICE_MICROLAMPORTS }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: MEMO_CU }),
    ix
  );

  let lastError = "";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const sig = await sendAndConfirmTransaction(conn, tx, [agent], { commitment: "confirmed" });
      await pool.query(
        `UPDATE positions SET commit_sig = $1, prev_commit_sig = $2, commit_status = 'committed' WHERE id = $3`,
        [sig, prev, positionId]
      );
      await pool.query(
        `INSERT INTO agent_state (key, value, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [LAST_COMMIT_KEY, JSON.stringify(sig)]
      );
      return { status: "committed", sig, memo };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, attempt * 2_000));
    }
  }
  await pool.query(`UPDATE positions SET commit_status = 'failed' WHERE id = $1`, [positionId]);
  return { status: "failed", error: lastError };
}

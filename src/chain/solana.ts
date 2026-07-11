// Shared Solana plumbing: agent wallet, mainnet connection, txoracle program.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { config } from "../config.js";

export const MEMO_PROGRAM_ID = new PublicKey(config.solana.memoProgramId);

export function loadAgentKeypair(): Keypair {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(config.solana.keypairPath, "utf8")))
  );
}

export function mainnetConnection(): Connection {
  return new Connection(config.solana.rpcUrl, "confirmed");
}

/**
 * The txoracle program bound to MAINNET. The published v1.5.6 IDL file carries
 * the devnet address; we override it (see txline-v1.5.6-findings.md §3).
 */
export function txoracleProgram(conn: Connection, keypair: Keypair) {
  const idl = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "txoracle-idl.json"), "utf8")
  );
  idl.address = config.solana.programId;
  const provider = new AnchorProvider(conn, new Wallet(keypair), { commitment: "confirmed" });
  return { program: new Program(idl, provider), provider };
}

export function dailyScoresPda(targetTs: number, programId: PublicKey): PublicKey {
  const epochDay = Math.floor(targetTs / 86_400_000);
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(epochDay);
  return PublicKey.findProgramAddressSync([Buffer.from("daily_scores_roots"), buf], programId)[0];
}

/** Proof hashes arrive as byte arrays, hex, or base64 depending on endpoint. */
export function parseHash(h: unknown): number[] {
  if (typeof h === "string") {
    const buf = h.length === 64 ? Buffer.from(h, "hex") : Buffer.from(h, "base64");
    return Array.from(buf);
  }
  return Array.from(h as number[]);
}

export function mapProof(proof: { hash: unknown; isRightSibling?: boolean }[] | undefined) {
  if (!proof) return [];
  return proof.map((n) => ({
    hash: parseHash((n as any).hash ?? n),
    isRightSibling: (n as any).isRightSibling ?? false,
  }));
}

"use client";

// One-click, in-browser verification of a single position. Nothing is taken
// on trust from this site: the browser recomputes the payload hash with
// WebCrypto and reads the commit transaction from a public Solana RPC.

import { useState } from "react";

type StepState = "pending" | "running" | "ok" | "fail";
interface Step {
  label: string;
  state: StepState;
  detail?: string;
}

// Public, CORS-friendly RPCs tried in order. The visitor's browser talks to
// the chain directly; this site is not in the trust path.
const RPCS = ["https://solana-rpc.publicnode.com", "https://api.mainnet-beta.solana.com"];

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function VerifyButton({ positionId, commitSig }: { positionId: number; commitSig: string | null }) {
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [running, setRunning] = useState(false);

  if (!commitSig) return null;

  const run = async () => {
    setRunning(true);
    const s: Step[] = [
      { label: "Fetch the public record export", state: "running" },
      { label: "Recompute sha256 of the canonical payload in this browser", state: "pending" },
      { label: "Fetch the commit transaction from a public Solana RPC", state: "pending" },
      { label: "Match the on-chain memo to the recomputed hash", state: "pending" },
    ];
    const push = () => setSteps([...s]);
    push();
    try {
      const record = await (await fetch("/api/record")).json();
      const pos = record.positions.find((p: { id: number | string }) => Number(p.id) === Number(positionId));
      if (!pos) throw new Error("position missing from export");
      s[0] = { ...s[0]!, state: "ok", detail: `position ${positionId} found` };
      s[1] = { ...s[1]!, state: "running" };
      push();

      const hash = await sha256Hex(pos.payload_canonical);
      const hashMatches = hash === pos.payload_hash;
      s[1] = {
        ...s[1]!,
        state: hashMatches ? "ok" : "fail",
        detail: `${hash.slice(0, 16)}... ${hashMatches ? "matches the recorded hash" : "DOES NOT match"}`,
      };
      s[2] = { ...s[2]!, state: "running" };
      push();

      let tx: any = null;
      let lastRpcError = "no public RPC reachable";
      for (const rpc of RPCS) {
        try {
          const txRes = await fetch(rpc, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "getTransaction",
              params: [commitSig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }],
            }),
          });
          const body = await txRes.json();
          if (body.result) {
            tx = body.result;
            break;
          }
          lastRpcError = body.error ? `RPC error: ${body.error.message}` : `not served by ${new URL(rpc).host}`;
        } catch {
          lastRpcError = `${new URL(rpc).host} unreachable from this browser`;
        }
      }
      if (!tx) throw new Error(lastRpcError);
      const when = tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : "unknown time";
      s[2] = { ...s[2]!, state: "ok", detail: `confirmed on-chain at ${when}` };
      s[3] = { ...s[3]!, state: "running" };
      push();

      const memoIx = tx.transaction.message.instructions.find(
        (ix: { program?: string }) => ix.program === "spl-memo"
      );
      const memo: string = typeof memoIx?.parsed === "string" ? memoIx.parsed : "";
      const memoHasHash = memo.includes(hash);
      const memoHasPrev = pos.prev_commit_sig ? memo.includes(`prev:${pos.prev_commit_sig}`) : true;
      s[3] = {
        ...s[3]!,
        state: memoHasHash && memoHasPrev ? "ok" : "fail",
        detail: memoHasHash
          ? `memo carries the hash${memoHasPrev ? " and the chain link" : ", but the chain link differs"}`
          : "memo does not contain the recomputed hash",
      };
      push();
    } catch (e) {
      const idx = s.findIndex((step) => step.state === "running" || step.state === "pending");
      if (idx >= 0) s[idx] = { ...s[idx]!, state: "fail", detail: e instanceof Error ? e.message : String(e) };
      push();
    } finally {
      setRunning(false);
    }
  };

  const icon = (st: StepState) => (st === "ok" ? "✓" : st === "fail" ? "✗" : st === "running" ? "…" : "·");
  const tone = (st: StepState) =>
    st === "ok" ? "text-pos" : st === "fail" ? "text-neg" : "text-faint";

  return (
    <div>
      <button
        onClick={run}
        disabled={running}
        className="rounded border border-accent/50 px-2 py-1 text-xs font-medium text-accent hover:bg-panel-2 disabled:opacity-50"
      >
        {steps ? "Verify again" : "Verify"}
      </button>
      {steps ? (
        <ul className="mt-2 flex w-64 flex-col gap-1">
          {steps.map((step) => (
            <li key={step.label} className="text-xs">
              <span className={`font-mono ${tone(step.state)}`} aria-hidden>
                {icon(step.state)}
              </span>{" "}
              <span className="text-muted">{step.label}</span>
              {step.detail ? <span className={`block pl-4 ${tone(step.state)}`}>{step.detail}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

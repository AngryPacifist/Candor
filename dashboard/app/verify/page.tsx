import { Panel, TxLink } from "../../components/ui";
import { solscanAccount } from "../../lib/format";
import { pool } from "../../lib/db";

export const dynamic = "force-dynamic";

const AGENT_WALLET = process.env.NEXT_PUBLIC_AGENT_WALLET ?? "DKdqzAhvYMB3TZFZSM7M6JA3nQqmsjk5W9Smo6vq7xrE";
const ORACLE_PROGRAM = "9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA";

export default async function VerifyPage() {
  let paramsHash: string | null = null;
  let freeze: { sig?: string; hash?: string } | null = null;
  try {
    const res = await pool.query(
      `SELECT key, value FROM agent_state WHERE key IN ('worker_heartbeat', 'params_freeze')`
    );
    for (const row of res.rows) {
      if (row.key === "worker_heartbeat") paramsHash = row.value?.paramsHash ?? null;
      if (row.key === "params_freeze") freeze = row.value;
    }
  } catch {
    paramsHash = null;
  }

  return (
    <div className="flex max-w-prose flex-col gap-6">
      <Panel title="How to verify this record">
        <div className="flex flex-col gap-4 text-sm leading-relaxed text-muted">
          <p className="text-foreground">
            You do not have to trust this website. Everything it claims is either anchored on
            Solana mainnet before the outcome existed, or recomputable from public data.
          </p>

          <h3 className="text-foreground font-semibold">1. The commit chain</h3>
          <p>
            The moment the agent takes a position, it broadcasts a memo transaction from{" "}
            <a
              href={solscanAccount(AGENT_WALLET)}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-accent underline underline-offset-2 break-all"
            >
              {AGENT_WALLET}
            </a>
            . The memo reads:
          </p>
          <pre className="overflow-x-auto rounded border border-border bg-panel-2 p-3 font-mono text-xs">
            candor|v1|commit|&lt;sha256 of the position payload&gt;|params:&lt;strategy hash&gt;|prev:&lt;previous commit signature&gt;
          </pre>
          <p>
            The chain timestamp proves the position existed before the outcome. The payload hash
            binds the exact market, side, price, stake, and model probability: take{" "}
            <code className="font-mono text-xs">payloadCanonical</code> from the record export
            below, hash it with sha256, and it must equal the committed hash. The{" "}
            <code className="font-mono text-xs">prev</code> field chains every commit to the one
            before it, so a deleted losing position leaves a visible gap.
          </p>

          <h3 className="text-foreground font-semibold">2. The settlement proofs</h3>
          <p>
            Match truth is anchored on Solana by TxODDS as Merkle roots. At settlement, the
            agent compiles each position&apos;s exact win condition into a{" "}
            <code className="font-mono text-xs">validate_stat_v2</code> call on the oracle
            program{" "}
            <a
              href={solscanAccount(ORACLE_PROGRAM)}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-accent underline underline-offset-2 break-all"
            >
              {ORACLE_PROGRAM}
            </a>{" "}
            and broadcasts it. The transaction certifies, against the root TxODDS committed,
            whether the condition held. Wins and losses are proven the same way. If a proof
            cannot be produced (for example, extra time makes the period split unverifiable),
            the position is marked unavailable with the reason shown, never silently dropped.
          </p>

          <h3 className="text-foreground font-semibold">3. The frozen strategy</h3>
          <p>
            Every commit carries the hash of the complete strategy parameters
            {paramsHash ? (
              <>
                {" "}
                (currently <code className="font-mono text-xs">{paramsHash}</code>)
              </>
            ) : null}
            . If we changed thresholds mid-run, the hashes in the chain would show it. The
            parameter derivation, including its dead ends, is documented in the public
            repository.
          </p>
          {freeze?.sig ? (
            <p>
              The freeze itself is anchored: before deployment, the full parameter hash
              {freeze.hash ? (
                <>
                  {" "}
                  (<code className="font-mono text-xs break-all">{freeze.hash}</code>)
                </>
              ) : null}{" "}
              was committed to mainnet as its own ceremony transaction:{" "}
              <TxLink sig={freeze.sig} />. Every position committed since must carry that
              hash, so the freeze has a public timestamp and the record after it is bound to
              exactly those parameters.
            </p>
          ) : null}

          <h3 className="text-foreground font-semibold">4. The record export</h3>
          <p>
            <a href="/api/record" className="text-accent underline underline-offset-2">
              /api/record
            </a>{" "}
            returns the full machine-readable record: every position with its canonical payload,
            hashes, commit and proof signatures, settlement evidence, and outcomes. Recompute
            our P&L, Brier, and CLV yourself; you need nothing from us but this export and a
            Solana RPC.
          </p>
        </div>
      </Panel>
    </div>
  );
}

import { solscanAccount, solscanTx, truncSig } from "../../lib/format";
import { fetchAttest } from "../../lib/queries";

export const dynamic = "force-dynamic";

const AGENT_WALLET = process.env.NEXT_PUBLIC_AGENT_WALLET ?? "DKdqzAhvYMB3TZFZSM7M6JA3nQqmsjk5W9Smo6vq7xrE";
const ORACLE_PROGRAM = "9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA";

function AffLine({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 text-xs">
      <span className="flex-none text-faint">{k}</span>
      <span className="min-w-0 text-right font-mono text-[11.5px] break-all">{v}</span>
    </div>
  );
}

function Step({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <div>
      <h2 className="text-sm font-bold">
        <span className="mr-2.5 font-mono text-accent">{n}</span>
        {title}
      </h2>
      <div className="mt-2 grid grid-cols-[minmax(0,1fr)] gap-3">{children}</div>
    </div>
  );
}

export default async function VerifyPage() {
  const attest = await fetchAttest();

  return (
    <div className="min-w-0 justify-self-center">
      <div className="grid max-w-[68ch] grid-cols-[minmax(0,1fr)] gap-5">
        <h1 className="text-base font-bold tracking-[-0.01em]">How to verify this record</h1>
        <p className="text-[13.5px] leading-relaxed text-muted">
          <strong className="font-medium text-foreground">You do not have to trust this website.</strong>{" "}
          Everything it claims is either anchored on Solana mainnet before the outcome existed,
          or recomputable from public data. This page is the complete procedure.
        </p>

        <div className="grid gap-2.5 rounded-lg border border-border-strong bg-panel px-5 py-4">
          <AffLine
            k="agent wallet"
            v={
              <a href={solscanAccount(AGENT_WALLET)} target="_blank" rel="noreferrer" className="text-accent">
                {AGENT_WALLET} &#8599;
              </a>
            }
          />
          <AffLine
            k="oracle program"
            v={
              <a href={solscanAccount(ORACLE_PROGRAM)} target="_blank" rel="noreferrer" className="text-accent">
                {ORACLE_PROGRAM} &#8599;
              </a>
            }
          />
          {attest.ceremonyHash ? <AffLine k="frozen params sha256" v={attest.ceremonyHash} /> : null}
          {attest.ceremonySig ? (
            <AffLine
              k="freeze ceremony"
              v={
                <>
                  <a href={solscanTx(attest.ceremonySig)} target="_blank" rel="noreferrer" className="text-accent">
                    {truncSig(attest.ceremonySig, 8)} &#8599;
                  </a>{" "}
                  &middot; committed before deployment
                </>
              }
            />
          ) : null}
        </div>

        <Step n="01" title="The commit chain">
          <p className="text-[13.5px] leading-relaxed text-muted">
            The moment a position opens, its canonical payload (fixture, market, side, price,
            stake, model probability, timestamp) is hashed and broadcast in a memo transaction
            from the agent wallet. The chain timestamp precedes the outcome. The{" "}
            <code className="font-mono text-xs">prev</code> field chains every commit to the
            one before it, so a deleted losing position leaves a visible hole.
          </p>
          <pre className="tablewrap rounded-md border border-border-strong bg-background px-3.5 py-3 font-mono text-[11.5px] whitespace-nowrap text-muted">
            candor|v1|commit|&lt;payload sha256&gt;|params:&lt;strategy hash&gt;|prev:&lt;previous commit signature&gt;
          </pre>
          <p className="text-[13.5px] leading-relaxed text-muted">
            Take <code className="font-mono text-xs">payloadCanonical</code> from the record
            export, hash it with sha256 in any tool you like, and it must equal the committed
            hash. The verify button on every position does exactly this, in your browser.
          </p>
        </Step>

        <Step n="02" title="The settlement proofs">
          <p className="text-[13.5px] leading-relaxed text-muted">
            Match truth is anchored on Solana by TxODDS as Merkle roots. At settlement, each
            position&apos;s exact win condition is compiled into a validation call on the
            oracle program and broadcast:{" "}
            <code className="font-mono text-xs">validate_stat_v3</code> multiproofs, with{" "}
            <code className="font-mono text-xs">validate_stat_v2</code> as the automatic
            fallback and for positions settled before 2026-07-13. Each receipt names the
            method that proved it. The transaction certifies, against the root TxODDS
            committed, whether the condition held. Wins and losses are proven identically. If
            a proof cannot be produced, the position is marked unavailable with the reason
            shown, never silently dropped.
          </p>
        </Step>

        <Step n="03" title="The frozen strategy">
          <p className="text-[13.5px] leading-relaxed text-muted">
            Every commit carries the hash of the complete strategy parameters. The freeze
            itself is anchored: the full hash was committed to mainnet as its own ceremony
            transaction before deployment, so the parameters have a public timestamp and the
            record after it is bound to exactly those values. If a threshold ever moved, the
            chain would show the seam. The derivation, including its dead ends, is documented
            in the public repository.
          </p>
        </Step>

        <Step n="04" title="The record export">
          <p className="text-[13.5px] leading-relaxed text-muted">
            <a href="/api/record" className="font-mono text-xs text-accent underline underline-offset-2">
              /api/record
            </a>{" "}
            returns the full machine-readable record: every position with its canonical
            payload, hashes, commit and proof signatures, settlement evidence, and the
            complete signal log. Recompute the P&amp;L, the Brier score, and the CLV yourself;
            you need nothing from us but this export and a Solana RPC.
          </p>
        </Step>
      </div>
    </div>
  );
}

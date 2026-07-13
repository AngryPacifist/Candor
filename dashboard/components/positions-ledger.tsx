"use client";

// The positions ledger: a compact comparative table (desktop) or cards
// (mobile), where each position expands into its receipt — the proof
// artifact with canonical hashes, both transactions, settlement evidence,
// and the in-browser verifier.

import { useState } from "react";
import type { PositionRow } from "../lib/queries";
import { fmtPct, fmtPrice, fmtPts, fmtUnits, humanMarket, solscanTx, timeAgo, truncSig } from "../lib/format";
import { Badge, TxLink, outcomeTone } from "./ui";
import { VerifyButton } from "./verify-button";

function ResultBadge({ p }: { p: PositionRow }) {
  if (p.status === "open") return <Badge tone="accent">open</Badge>;
  if (p.outcome === "void") return <Badge tone="muted">void</Badge>;
  if (!p.outcome) return <Badge tone="muted">settling</Badge>;
  return (
    <Badge tone={outcomeTone(p.outcome)}>
      {p.outcome} {p.pnl_units !== null ? fmtUnits(p.pnl_units, true) : ""}
    </Badge>
  );
}

function ProofBadge({ p }: { p: PositionRow }) {
  if (p.status === "open") return <span className="text-xs text-faint">at settlement</span>;
  if (p.proof_status === "proven")
    return (
      <span className="inline-flex items-center gap-1.5">
        <Badge tone="proof">&#10003; proven</Badge>
        {p.proof_sig ? <TxLink sig={p.proof_sig} /> : null}
      </span>
    );
  if (p.proof_status === "proof_unavailable") return <Badge tone="warn">unavailable</Badge>;
  if (p.outcome === "void") return <span className="text-xs text-faint">n/a</span>;
  return <Badge tone="muted">pending</Badge>;
}

function decidedLine(p: PositionRow): string {
  const t = new Date(Number(p.decided_ts));
  const when = isNaN(t.getTime()) ? timeAgo(p.opened_at) : t.toISOString().slice(0, 16).replace("T", " ") + " UTC";
  return `${when} · score ${p.entry_goals1}-${p.entry_goals2}`;
}

function settledLine(p: PositionRow): string | null {
  const ev = p.settlement_evidence;
  if (!p.outcome) return null;
  if (p.outcome === "void") return `void · ${ev?.reason ?? "stakes returned"}`;
  const reg = ev?.regulation;
  const score = reg
    ? p.scope === "half1"
      ? `H1 ${reg.half11}-${reg.half12}`
      : `regulation ${reg.full1}-${reg.full2}`
    : null;
  return `${score ? score + " · " : ""}${p.outcome}${p.pnl_units !== null ? ` · ${fmtUnits(p.pnl_units, true)}u` : ""}`;
}

function Receipt({ p }: { p: PositionRow }) {
  const edge = (Number(p.model_prob) - Number(p.market_prob)) * 100;
  const stakePct = Number(p.bankroll_before) > 0 ? (Number(p.stake_units) / Number(p.bankroll_before)) * 100 : null;
  const line = (k: string, v: React.ReactNode) => (
    <div className="flex justify-between gap-4 text-xs">
      <span className="flex-none text-faint">{k}</span>
      <span className="min-w-0 text-right font-mono text-[11.5px] break-words">{v}</span>
    </div>
  );
  return (
    <div className="overflow-hidden rounded-lg border border-border-strong bg-background">
      <div className="flex items-baseline justify-between border-b border-dashed border-border-strong px-4 py-3">
        <b className="text-[13px]">Position #{p.id} &middot; the receipt</b>
        <span className="font-mono text-[10.5px] text-faint">candor.position.v1</span>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)] md:grid-cols-2">
        <div className="grid grid-cols-[minmax(0,1fr)] content-start gap-2 px-4 py-3.5">
          {line("decided", decidedLine(p))}
          {line("model / market", `${fmtPct(p.model_prob)} / ${fmtPct(p.market_prob)} (${fmtPts(edge)} pts)`)}
          {line("stake", `${fmtUnits(p.stake_units)}u${stakePct !== null ? ` · ${stakePct.toFixed(2)}% of ${fmtUnits(p.bankroll_before)}` : ""}`)}
          {line("payload sha256", `${p.payload_hash.slice(0, 16)}…`)}
          {line("params hash", `${p.params_hash.slice(0, 16)}…`)}
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)] content-start gap-2 border-t border-dashed border-border-strong px-4 py-3.5 md:border-t-0 md:border-l">
          {line(
            "commit tx",
            p.commit_sig ? (
              <a href={solscanTx(p.commit_sig)} target="_blank" rel="noreferrer" className="text-accent">
                {truncSig(p.commit_sig, 8)} &#8599;
              </a>
            ) : (
              p.commit_status
            )
          )}
          {line(
            "chained to",
            p.prev_commit_sig ? (
              <a href={solscanTx(p.prev_commit_sig)} target="_blank" rel="noreferrer" className="text-accent">
                {truncSig(p.prev_commit_sig, 8)} &#8599;
              </a>
            ) : (
              "genesis"
            )
          )}
          {settledLine(p) ? line("settled", settledLine(p)) : null}
          {p.proof_status === "proven" && p.proof_sig
            ? line(
                "proof tx",
                <>
                  <a href={solscanTx(p.proof_sig)} target="_blank" rel="noreferrer" className="text-accent">
                    {truncSig(p.proof_sig, 8)} &#8599;
                  </a>{" "}
                  result={String(p.proof_result)}
                  {p.proof_method ? <> &middot; {p.proof_method}</> : null}
                </>
              )
            : null}
          {p.proof_status === "proof_unavailable" ? line("proof", p.proof_error ?? "unavailable, reason recorded") : null}
          {p.settlement_evidence?.finalisedSeq
            ? line("evidence", `bands ${Object.values(p.settlement_evidence.statBands ?? {}).flat().join("/") || "1001/1002"} · seq ${p.settlement_evidence.finalisedSeq}`)
            : null}
        </div>
      </div>
      {p.commit_sig ? (
        <div className="border-t border-dashed border-border-strong px-4 py-3">
          <VerifyButton positionId={p.id} commitSig={p.commit_sig} />
        </div>
      ) : null}
    </div>
  );
}

export function PositionsLedger({ rows, showResult = true }: { rows: PositionRow[]; showResult?: boolean }) {
  const [openId, setOpenId] = useState<number | null>(null);

  if (rows.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-faint">
        No positions yet. The agent only enters when a market inconsistency exceeds its
        measured noise floor, and it proves every entry either way.
      </p>
    );
  }

  const toggle = (id: number) => setOpenId(openId === id ? null : id);

  return (
    <>
      {/* desktop: the comparative ledger */}
      <div className="tablewrap hidden md:block">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="text-[10.5px] font-medium tracking-[0.07em] text-faint uppercase">
              <th className="pb-2.5 font-medium whitespace-nowrap">Opened</th>
              <th className="pb-2.5 pl-[18px] font-medium">Match</th>
              <th className="pb-2.5 pl-[18px] font-medium">Position</th>
              <th className="pb-2.5 pl-[18px] text-right font-medium">Price</th>
              <th className="pb-2.5 pl-[18px] text-right font-medium">Stake</th>
              {showResult ? <th className="pb-2.5 pl-[18px] text-right font-medium">Result</th> : null}
              {showResult ? <th className="pb-2.5 pl-[18px] text-right font-medium">CLV</th> : null}
              <th className="pb-2.5 pl-[18px] font-medium">Proof</th>
              <th className="pb-2.5 pl-[18px] font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <Row key={p.id} p={p} showResult={showResult} open={openId === p.id} onToggle={() => toggle(p.id)} />
            ))}
          </tbody>
        </table>
      </div>

      {/* mobile: cards */}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3.5 md:hidden">
        {rows.map((p) => (
          <div key={p.id} className="grid grid-cols-[minmax(0,1fr)] gap-2">
            <div className="grid gap-2 rounded-lg border border-border bg-panel px-3.5 py-3">
              <div className="flex items-baseline justify-between gap-2.5">
                <b className="text-[13px]">
                  {p.participant1} v {p.participant2}
                </b>
                <ResultBadge p={p} />
              </div>
              <div className="flex justify-between gap-2.5 text-[11.5px] text-faint">
                <span>{humanMarket(p.market_key, p.side, p.participant1, p.participant2)}</span>
                <span className="font-mono text-muted">
                  @{fmtPrice(p.price_taken)} &middot; {fmtUnits(p.stake_units)}u
                </span>
              </div>
              <div className="flex justify-between gap-2.5 text-[11.5px] text-faint">
                <span>
                  CLV <span className="font-mono text-muted">{p.clv === null ? "–" : `${fmtPts(p.clv)} pts`}</span>
                </span>
                <ProofBadge p={p} />
              </div>
              <div className="flex items-center justify-between gap-2.5 border-t border-border pt-2.5">
                {p.commit_sig ? <TxLink sig={p.commit_sig} label={`commit ${truncSig(p.commit_sig)}`} /> : <span className="text-xs text-faint">{p.commit_status}</span>}
                <button
                  type="button"
                  onClick={() => toggle(p.id)}
                  className={`rounded-md border border-accent-dim px-2.5 py-1 text-xs font-medium text-accent ${openId === p.id ? "bg-accent-ink" : ""}`}
                >
                  {openId === p.id ? "hide receipt" : "receipt"}
                </button>
              </div>
            </div>
            {openId === p.id ? <Receipt p={p} /> : null}
          </div>
        ))}
      </div>
    </>
  );
}

function Row({ p, showResult, open, onToggle }: { p: PositionRow; showResult: boolean; open: boolean; onToggle: () => void }) {
  const cols = showResult ? 9 : 7;
  return (
    <>
      <tr className="border-t border-border first:border-t-0">
        <td className="py-2.5 align-baseline font-mono text-[11.5px] whitespace-nowrap text-faint" suppressHydrationWarning>
          {timeAgo(p.opened_at)}
        </td>
        <td className="py-2.5 pl-[18px] align-baseline">
          {p.participant1} v {p.participant2}
        </td>
        <td className="py-2.5 pl-[18px] align-baseline">{humanMarket(p.market_key, p.side, p.participant1, p.participant2)}</td>
        <td className="py-2.5 pl-[18px] text-right align-baseline font-mono tabular-nums">{fmtPrice(p.price_taken)}</td>
        <td className="py-2.5 pl-[18px] text-right align-baseline font-mono tabular-nums">{fmtUnits(p.stake_units)}</td>
        {showResult ? (
          <td className="py-2.5 pl-[18px] text-right align-baseline whitespace-nowrap">
            <ResultBadge p={p} />
          </td>
        ) : null}
        {showResult ? (
          <td className="py-2.5 pl-[18px] text-right align-baseline font-mono tabular-nums">
            {p.clv === null ? "–" : fmtPts(p.clv)}
          </td>
        ) : null}
        <td className="py-2.5 pl-[18px] align-baseline whitespace-nowrap">
          <ProofBadge p={p} />
        </td>
        <td className="py-2.5 pl-[18px] text-right align-baseline">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            className={`rounded-md border border-accent-dim px-2.5 py-1 text-xs font-medium text-accent ${open ? "bg-accent-ink" : ""}`}
          >
            {open ? "hide" : "receipt"}
          </button>
        </td>
      </tr>
      {open ? (
        <tr>
          <td colSpan={cols} className="pt-1.5 pb-4">
            <Receipt p={p} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

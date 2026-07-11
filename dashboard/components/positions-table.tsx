import { fmtPct, fmtPrice, fmtPts, fmtUnits, humanMarket, timeAgo } from "../lib/format";
import type { PositionRow } from "../lib/queries";
import { Badge, Empty, outcomeTone, TxLink } from "./ui";

export function PositionsTable({ rows, showResult = true }: { rows: PositionRow[]; showResult?: boolean }) {
  if (rows.length === 0) {
    return (
      <Empty>
        No positions yet. The agent only enters when a market inconsistency exceeds its
        measured noise floor, and it proves every entry either way.
      </Empty>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[900px] text-left text-sm">
        <thead>
          <tr className="border-b border-border text-xs tracking-wide text-faint uppercase">
            <th className="py-2 pr-3 font-medium">#</th>
            <th className="py-2 pr-3 font-medium">Match</th>
            <th className="py-2 pr-3 font-medium">Position</th>
            <th className="py-2 pr-3 font-medium">Price</th>
            <th className="py-2 pr-3 font-medium">Model / Market</th>
            <th className="py-2 pr-3 font-medium">Stake</th>
            {showResult ? <th className="py-2 pr-3 font-medium">Result</th> : null}
            {showResult ? <th className="py-2 pr-3 font-medium">CLV</th> : null}
            <th className="py-2 pr-3 font-medium">Commit</th>
            <th className="py-2 font-medium">Proof</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id} className="border-b border-border/50 align-top">
              <td className="py-2.5 pr-3 font-mono text-xs text-faint tabular-nums">
                {p.id}
                <span className="block">{timeAgo(p.opened_at)}</span>
              </td>
              <td className="py-2.5 pr-3">
                {p.participant1 && p.participant2 ? `${p.participant1} v ${p.participant2}` : `Fixture ${p.fixture_id}`}
                <span className="block text-xs text-faint">{p.family}</span>
              </td>
              <td className="py-2.5 pr-3">{humanMarket(p.market_key, p.side, p.participant1, p.participant2)}</td>
              <td className="py-2.5 pr-3 font-mono tabular-nums">{fmtPrice(p.price_taken)}</td>
              <td className="py-2.5 pr-3 font-mono text-xs tabular-nums">
                {fmtPct(p.model_prob)} / {fmtPct(p.market_prob)}
              </td>
              <td className="py-2.5 pr-3 font-mono tabular-nums">{fmtUnits(p.stake_units)}</td>
              {showResult ? (
                <td className="py-2.5 pr-3">
                  {p.outcome ? (
                    <Badge tone={outcomeTone(p.outcome)}>
                      {p.outcome} {p.pnl_units !== null ? `${fmtUnits(p.pnl_units, true)}` : ""}
                    </Badge>
                  ) : (
                    <Badge tone="accent">open</Badge>
                  )}
                </td>
              ) : null}
              {showResult ? (
                <td className="py-2.5 pr-3 font-mono text-xs tabular-nums">
                  {p.clv !== null ? `${fmtPts(p.clv)} pts` : "–"}
                </td>
              ) : null}
              <td className="py-2.5 pr-3">
                {p.commit_sig ? (
                  <TxLink sig={p.commit_sig} />
                ) : (
                  <Badge tone={p.commit_status === "failed" ? "warn" : "muted"}>{p.commit_status}</Badge>
                )}
              </td>
              <td className="py-2.5">
                {p.proof_status === "proven" && p.proof_sig ? (
                  <span className="flex flex-col gap-0.5">
                    <Badge tone="pos">proven</Badge>
                    <TxLink sig={p.proof_sig} />
                  </span>
                ) : p.proof_status === "proof_unavailable" ? (
                  <Badge tone="warn">unavailable</Badge>
                ) : p.status === "settled" ? (
                  <Badge tone="muted">pending</Badge>
                ) : (
                  <span className="text-xs text-faint">at settlement</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

import { AutoRefresh } from "../../components/auto-refresh";
import { Badge, Empty, Panel } from "../../components/ui";
import { fmtPts, humanMarket, timeAgo } from "../../lib/format";
import { fetchSignals } from "../../lib/queries";

export const dynamic = "force-dynamic";

export default async function SignalsPage() {
  const rows = await fetchSignals(200);
  return (
    <div className="flex flex-col gap-4">
      <AutoRefresh seconds={30} />
      <Panel title={`Signal log (${rows.length})`}>
        {rows.length === 0 ? (
          <Empty>
            Nothing logged yet. This page shows every decision the agent takes, including the
            trades it declines and why.
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead>
                <tr className="border-b border-border text-xs tracking-wide text-faint uppercase">
                  <th className="py-2 pr-3 font-medium">When</th>
                  <th className="py-2 pr-3 font-medium">Decision</th>
                  <th className="py-2 pr-3 font-medium">Family</th>
                  <th className="py-2 pr-3 font-medium">Market</th>
                  <th className="py-2 pr-3 font-medium">Edge</th>
                  <th className="py-2 font-medium">Reasoning</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id} className="border-b border-border/50 align-top">
                    <td className="py-2.5 pr-3 font-mono text-xs text-faint tabular-nums whitespace-nowrap">
                      {timeAgo(s.ts)}
                    </td>
                    <td className="py-2.5 pr-3">
                      <Badge tone={s.decision === "enter" ? "pos" : "muted"}>{s.decision}</Badge>
                    </td>
                    <td className="py-2.5 pr-3 text-xs text-muted">{s.family}</td>
                    <td className="py-2.5 pr-3">
                      {humanMarket(
                        s.market_key.split("|scope=")[0]!,
                        s.side,
                        s.participant1 ?? undefined,
                        s.participant2 ?? undefined
                      )}
                    </td>
                    <td className="py-2.5 pr-3 font-mono text-xs tabular-nums">
                      {s.edge !== null ? `${fmtPts(s.edge)} pts` : "–"}
                    </td>
                    <td className="max-w-md py-2.5 text-xs text-muted">
                      <span className="line-clamp-3" title={s.reason}>
                        {s.reason}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

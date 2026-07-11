import Link from "next/link";
import { AutoRefresh } from "../components/auto-refresh";
import { PositionsTable } from "../components/positions-table";
import { Badge, Empty, Panel, StatTile } from "../components/ui";
import { fmtPts, fmtUnits, humanMarket, timeAgo } from "../lib/format";
import { fetchOverview, fetchSignals } from "../lib/queries";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const [o, signals] = await Promise.all([fetchOverview(), fetchSignals(8)]);
  const record = `${o.won}W ${o.lost}L ${o.push}P`;

  return (
    <div className="flex flex-col gap-6">
      <AutoRefresh seconds={30} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        <StatTile
          label="Bankroll"
          value={o.bankroll === null ? "1000.00" : fmtUnits(o.bankroll)}
          sub="paper units"
        />
        <StatTile
          label="P&L"
          value={fmtUnits(o.pnl, true)}
          sub={`${o.settled} settled`}
          tone={o.pnl > 0 ? "pos" : o.pnl < 0 ? "neg" : undefined}
        />
        <StatTile label="Record" value={record} sub="won / lost / push" />
        <StatTile
          label="CLV"
          value={o.clvMean === null ? "–" : `${fmtPts(o.clvMean)} pts`}
          sub="10 min horizon, mean"
          tone={o.clvMean !== null && o.clvMean > 0 ? "pos" : undefined}
        />
        <StatTile
          label="Open"
          value={String(o.openPositions.length)}
          sub={o.paramsHash ? `params ${o.paramsHash.slice(0, 8)}` : "positions"}
          tone="accent"
        />
      </div>

      <Panel
        title="Open positions"
        action={
          <Link href="/positions" className="text-xs text-accent underline underline-offset-2">
            all positions
          </Link>
        }
      >
        <PositionsTable rows={o.openPositions} showResult={false} />
      </Panel>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel
          title="Latest decisions"
          action={
            <Link href="/signals" className="text-xs text-accent underline underline-offset-2">
              full log
            </Link>
          }
        >
          {signals.length === 0 ? (
            <Empty>No decisions logged yet. Every entry and every meaningful pass lands here with its reasoning.</Empty>
          ) : (
            <ul className="flex flex-col gap-2">
              {signals.map((s) => (
                <li key={s.id} className="flex items-start gap-2 text-sm">
                  <Badge tone={s.decision === "enter" ? "pos" : "muted"}>{s.decision}</Badge>
                  <div className="min-w-0">
                    <p className="truncate">
                      {humanMarket(s.market_key.split("|scope=")[0]!, s.side, s.participant1 ?? undefined, s.participant2 ?? undefined)}
                      {s.edge !== null ? (
                        <span className="ml-1 font-mono text-xs text-muted tabular-nums">{fmtPts(s.edge)} pts</span>
                      ) : null}
                    </p>
                    <p className="truncate text-xs text-faint" title={s.reason}>
                      {timeAgo(s.ts)} · {s.reason}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Upcoming coverage">
          {o.upcoming.length === 0 ? (
            <Empty>No upcoming fixtures in the feed window.</Empty>
          ) : (
            <ul className="flex flex-col gap-2">
              {o.upcoming.map((f) => (
                <li key={f.fixture_id} className="flex items-baseline justify-between gap-3 text-sm">
                  <span>
                    {f.participant1 || "TBD"} v {f.participant2 || "TBD"}
                  </span>
                  <span className="font-mono text-xs text-faint tabular-nums">
                    {new Date(f.start_time).toISOString().slice(0, 16).replace("T", " ")} UTC
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-4 border-t border-border pt-3 text-xs text-faint">
            The agent arms itself at kickoff, trades only in open play, settles at the final
            whistle, and proves every settlement on Solana. No human input.
          </p>
        </Panel>
      </div>
    </div>
  );
}

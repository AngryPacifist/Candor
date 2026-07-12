import Link from "next/link";
import { AutoRefresh } from "../components/auto-refresh";
import { BankrollCurve } from "../components/charts";
import { PositionsLedger } from "../components/positions-ledger";
import { Badge, Empty, Panel, StatTile } from "../components/ui";
import { competitionLabel, fmtKickoff, fmtPts, fmtUnits, humanMarket, solscanTx, timeAgo, truncSig } from "../lib/format";
import { STARTING_BANKROLL, fetchAttest, fetchOverview, fetchSettlementSeries, fetchSignals } from "../lib/queries";

export const dynamic = "force-dynamic";

function shortTeam(name: string): string {
  return name.slice(0, 3).toUpperCase();
}

function ProofLine({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-[12.5px]">
      <span className="text-muted">{k}</span>
      <span className="text-right font-mono text-[11.5px]">{v}</span>
    </div>
  );
}

export default async function OverviewPage() {
  const [o, signals, series, attest] = await Promise.all([
    fetchOverview(),
    fetchSignals(4),
    fetchSettlementSeries(),
    fetchAttest(),
  ]);
  const bankroll = o.bankroll ?? STARTING_BANKROLL;
  const pnlPct = ((bankroll - STARTING_BANKROLL) / STARTING_BANKROLL) * 100;
  const roiPct = o.staked > 0 ? (o.pnl / o.staked) * 100 : null;
  const latest = o.latest;

  return (
    <>
      <AutoRefresh seconds={30} />

      {/* the hero record band */}
      <section className="grid grid-cols-[minmax(0,1fr)] overflow-hidden rounded-lg border border-border md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div className="bg-panel px-4 py-5 md:px-7 md:py-[26px]">
          <p className="text-[11px] font-medium tracking-[0.08em] text-muted uppercase">
            Bankroll &middot; paper units
          </p>
          <p className="mt-1 font-mono text-[38px] font-bold tracking-[-0.03em] tabular-nums md:text-[56px] md:leading-[1.05]">
            {fmtUnits(bankroll)}
          </p>
          <p className="mt-1.5 font-mono text-[13px] md:text-[15px]">
            <span className={o.pnl > 0 ? "text-pos" : o.pnl < 0 ? "text-neg" : "text-muted"}>
              {fmtUnits(o.pnl, true)} ({pnlPct >= 0 ? "+" : ""}
              {pnlPct.toFixed(2)}%)
            </span>
            <span className="mt-1 block text-muted md:mt-0 md:ml-3.5 md:inline">
              {o.won}W {o.lost}L {o.push}P &middot; {o.settled} settled &middot; {o.openPositions.length} open
            </span>
          </p>
          <div className="mt-4 hidden md:block">
            <BankrollCurve series={series} height={56} caption={false} />
            <p className="mt-2 font-mono text-[11px] text-faint">
              {fmtUnits(STARTING_BANKROLL)}
              {series.map((s) => ` → #${s.positionId} ${s.pnl >= 0 ? "+" : ""}${s.pnl.toFixed(2)}`).join("")}
            </p>
          </div>
        </div>
        <div className="flex flex-col gap-3 border-t border-border bg-background px-4 py-5 md:border-t-0 md:border-l md:px-7 md:py-[26px]">
          <p className="text-[11px] font-medium tracking-[0.08em] text-muted uppercase">
            This record cannot be faked
          </p>
          <ProofLine k="Every position committed" v="before its outcome existed" />
          {latest?.commit_sig ? (
            <ProofLine
              k={`#${latest.id} commit${latest.status === "open" ? " (open)" : ""}`}
              v={
                <>
                  <a href={solscanTx(latest.commit_sig)} target="_blank" rel="noreferrer" className="text-accent">
                    {truncSig(latest.commit_sig)}&#8599;
                  </a>{" "}
                  {new Date(latest.opened_at).toISOString().slice(11, 19)}
                </>
              }
            />
          ) : null}
          {latest?.proof_status === "proven" && latest.proof_sig ? (
            <ProofLine
              k={`#${latest.id} outcome, proven on-chain`}
              v={
                <>
                  <a href={solscanTx(latest.proof_sig)} target="_blank" rel="noreferrer" className="text-accent">
                    {truncSig(latest.proof_sig)}&#8599;
                  </a>{" "}
                  result={String(latest.proof_result)}
                </>
              }
            />
          ) : null}
          {attest.ceremonySig ? (
            <ProofLine
              k="Strategy frozen pre-deploy"
              v={
                <a href={solscanTx(attest.ceremonySig)} target="_blank" rel="noreferrer" className="text-accent">
                  ceremony tx&#8599;
                </a>
              }
            />
          ) : null}
          <Link
            href="/verify"
            className="mt-auto flex items-center justify-center gap-2 rounded-md border border-accent-dim bg-accent-ink px-4 py-2.5 text-[13px] font-medium text-accent"
          >
            Verify this record yourself &#8594;
          </Link>
        </div>
      </section>

      {o.openPositions.length > 0 ? (
        <Panel title="Open positions">
          <PositionsLedger rows={o.openPositions} showResult={false} />
        </Panel>
      ) : null}

      <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-4">
        <StatTile
          label="CLV mean"
          value={o.clvMean === null ? "–" : `${fmtPts(o.clvMean)} pts`}
          sub="10 min horizon"
        />
        <StatTile
          label="ROI"
          value={roiPct === null ? "–" : `${roiPct >= 0 ? "+" : ""}${roiPct.toFixed(1)}%`}
          sub={`on ${fmtUnits(o.staked)}u staked`}
          tone={roiPct !== null && roiPct > 0 ? "pos" : roiPct !== null && roiPct < 0 ? "neg" : undefined}
        />
        <StatTile
          label="Exposure now"
          value={fmtUnits(o.exposure.openUnits)}
          sub={`${o.exposure.openCount} open · peak ${fmtUnits(o.exposure.peakUnits)}u`}
        />
        {o.nextFixture ? (
          <StatTile
            label="Next assignment"
            value={`${shortTeam(o.nextFixture.participant1)} v ${shortTeam(o.nextFixture.participant2)}`}
            sub={`${competitionLabel(o.nextFixture.competition)} · ${fmtKickoff(o.nextFixture.start_time)} UTC · armed`}
            tone="accent"
          />
        ) : (
          <StatTile label="Next assignment" value="–" sub="no fixture in the feed window" />
        )}
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Panel
          title="Latest decisions"
          action={
            <Link href="/signals" className="text-xs text-accent">
              full signal log &#8594;
            </Link>
          }
        >
          {signals.length === 0 ? (
            <Empty>No decisions logged yet. Every entry and every meaningful pass lands here with its reasoning.</Empty>
          ) : (
            <div>
              {signals.map((s) => (
                <div key={s.id} className="grid grid-cols-[minmax(0,1fr)] gap-1 border-t border-border py-[13px] first:border-t-0 first:pt-0 last:pb-0 md:grid-cols-[84px_minmax(0,1fr)] md:gap-4">
                  <span className="pt-0.5 font-mono text-[11px] text-faint">{timeAgo(s.ts)}</span>
                  <div className="min-w-0">
                    <p className="text-[13.5px]">
                      <Badge tone={s.decision === "enter" ? "pos" : "muted"}>{s.decision}</Badge>{" "}
                      {humanMarket(s.market_key.split("|scope=")[0]!, s.side, s.participant1 ?? undefined, s.participant2 ?? undefined)}
                      {s.edge !== null ? (
                        <span className="ml-2 font-mono text-xs text-accent">{fmtPts(s.edge)} pts</span>
                      ) : null}
                    </p>
                    <p className="mt-1 font-mono text-[11.5px] leading-relaxed break-words text-faint">{s.reason}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Coverage" action={<span className="text-[11.5px] text-faint">auto-discovered</span>}>
          {o.upcoming.length === 0 ? (
            <Empty>No upcoming fixtures in the feed window.</Empty>
          ) : (
            <div>
              {o.upcoming.map((f) => (
                <div
                  key={f.fixture_id}
                  className="flex items-baseline justify-between gap-4 border-t border-border py-2.5 first:border-t-0 first:pt-0"
                >
                  <span className="min-w-0 text-[13px]">
                    {f.participant1 || "TBD"} v {f.participant2 || "TBD"}
                    <span className="block text-[11px] text-faint">{competitionLabel(f.competition)}</span>
                  </span>
                  <span className="font-mono text-xs whitespace-nowrap text-muted tabular-nums">
                    {fmtKickoff(f.start_time)}
                  </span>
                </div>
              ))}
            </div>
          )}
          <p className="mt-3 border-t border-border pt-3 text-xs leading-relaxed text-faint">
            Arms at kickoff, trades open play only, settles at the whistle, proves every
            settlement on Solana. No human input.
          </p>
        </Panel>
      </div>
    </>
  );
}

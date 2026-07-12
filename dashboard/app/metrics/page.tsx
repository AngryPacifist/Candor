import { AutoRefresh } from "../../components/auto-refresh";
import { BankrollCurve, ClvBars } from "../../components/charts";
import { Empty, Panel, StatTile } from "../../components/ui";
import { fmtPts, fmtUnits } from "../../lib/format";
import { fetchMetrics, fetchSettlementSeries } from "../../lib/queries";

export const dynamic = "force-dynamic";

export default async function MetricsPage() {
  const [m, series] = await Promise.all([fetchMetrics(), fetchSettlementSeries()]);

  return (
    <>
      <AutoRefresh seconds={60} />
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="text-base font-bold tracking-[-0.01em]">Metrics</h1>
        <span className="text-xs text-faint">every figure recomputable from the record export</span>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-1">
          <StatTile
            label="P&L"
            value={fmtUnits(m.pnl, true)}
            sub={`${m.settled} settled · ${fmtUnits(m.staked)}u staked`}
            tone={m.pnl > 0 ? "pos" : m.pnl < 0 ? "neg" : undefined}
          />
          <StatTile
            label="ROI"
            value={m.roiPct === null ? "–" : `${m.roiPct >= 0 ? "+" : ""}${m.roiPct.toFixed(1)}%`}
            sub="small sample, stated plainly"
            tone={m.roiPct !== null && m.roiPct > 0 ? "pos" : m.roiPct !== null && m.roiPct < 0 ? "neg" : undefined}
          />
          <StatTile
            label="CLV mean"
            value={m.clvMean === null ? "–" : `${fmtPts(m.clvMean)} pts`}
            sub={
              m.clvPositiveShare === null
                ? "10 min horizon"
                : `10 min horizon · ${Math.round(m.clvPositiveShare * 100)}% positive`
            }
          />
          <StatTile label="Max drawdown" value={fmtUnits(m.maxDrawdown)} sub="units from peak" />
          <StatTile
            label="Peak exposure"
            value={fmtUnits(m.exposure.peakUnits)}
            sub={`${m.exposure.peakConcurrent} concurrent · largest stake ${
              m.exposure.largestStakePct === null ? "–" : m.exposure.largestStakePct.toFixed(2) + "%"
            }`}
          />
          <StatTile
            label="At risk now"
            value={fmtUnits(m.exposure.openUnits)}
            sub={
              m.exposure.openPctOfBankroll === null
                ? `${m.exposure.openCount} open`
                : `${m.exposure.openCount} open · ${m.exposure.openPctOfBankroll.toFixed(1)}% of bankroll`
            }
          />
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
          <Panel
            title="Bankroll curve"
            action={
              series.length > 0 ? (
                <span className="font-mono text-[11.5px] text-faint">
                  1000.00 &#8594; {series[series.length - 1]!.bankrollAfter?.toFixed(2) ?? "…"}
                </span>
              ) : undefined
            }
          >
            <BankrollCurve series={series} />
          </Panel>

          <Panel title="Closing line value per position" action={<span className="text-[11.5px] text-faint">10 min horizon &middot; pts</span>}>
            <ClvBars series={series} />
          </Panel>

          <Panel title="Calibration (Brier score, lower is better)">
            {m.brier.length === 0 ? (
              <Empty>Calibration appears after the first settled positions.</Empty>
            ) : (
              <div className="tablewrap">
                <table className="w-full min-w-[520px] border-collapse text-left text-sm">
                  <thead>
                    <tr className="text-[10.5px] font-medium tracking-[0.07em] text-faint uppercase">
                      <th className="pb-2.5 font-medium">Family &middot; market</th>
                      <th className="pb-2.5 pl-[18px] text-right font-medium">N</th>
                      <th className="pb-2.5 pl-[18px] text-right font-medium">Model</th>
                      <th className="pb-2.5 pl-[18px] text-right font-medium">Market</th>
                      <th className="pb-2.5 pl-[18px] font-medium">Verdict</th>
                    </tr>
                  </thead>
                  <tbody>
                    {m.brier.map((b) => (
                      <tr key={b.family} className="border-t border-border">
                        <td className="py-2.5">{b.family}</td>
                        <td className="py-2.5 pl-[18px] text-right font-mono tabular-nums">{b.n}</td>
                        <td className="py-2.5 pl-[18px] text-right font-mono tabular-nums">{b.model.toFixed(4)}</td>
                        <td className="py-2.5 pl-[18px] text-right font-mono tabular-nums">{b.market.toFixed(4)}</td>
                        <td className="py-2.5 pl-[18px] text-xs text-faint">
                          {b.n < 20
                            ? "sample too small to judge"
                            : b.model < b.market
                              ? "model better calibrated than consensus"
                              : "consensus better calibrated"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-4 border-t border-border pt-3 text-xs leading-relaxed text-faint">
              Brier score is the mean squared error of stated probabilities against outcomes.
              We publish ours next to the market consensus on the same positions, so you can
              see whether the agent&apos;s claimed probabilities carried information or just
              noise. Small samples prove nothing; that is stated here rather than hidden.
            </p>
          </Panel>
        </div>
      </div>
    </>
  );
}

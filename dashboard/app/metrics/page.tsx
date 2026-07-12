import { AutoRefresh } from "../../components/auto-refresh";
import { Empty, Panel, StatTile } from "../../components/ui";
import { fmtPts, fmtUnits } from "../../lib/format";
import { fetchMetrics } from "../../lib/queries";

export const dynamic = "force-dynamic";

function ExposureStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <p className="text-xs font-medium tracking-wide text-muted uppercase">{label}</p>
      <p className="mt-1 font-mono text-2xl font-semibold tabular-nums text-foreground">{value}</p>
      {sub ? <p className="mt-0.5 text-xs text-faint">{sub}</p> : null}
    </div>
  );
}

export default async function MetricsPage() {
  const m = await fetchMetrics();
  return (
    <div className="flex flex-col gap-6">
      <AutoRefresh seconds={60} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <StatTile label="Settled" value={String(m.settled)} sub={`${m.won}W ${m.lost}L ${m.push}P`} />
        <StatTile label="Staked" value={fmtUnits(m.staked)} sub="units" />
        <StatTile
          label="P&L"
          value={fmtUnits(m.pnl, true)}
          sub="units"
          tone={m.pnl > 0 ? "pos" : m.pnl < 0 ? "neg" : undefined}
        />
        <StatTile
          label="ROI"
          value={m.roiPct === null ? "–" : `${m.roiPct.toFixed(1)}%`}
          tone={m.roiPct !== null && m.roiPct > 0 ? "pos" : m.roiPct !== null && m.roiPct < 0 ? "neg" : undefined}
        />
        <StatTile
          label="CLV mean"
          value={m.clvMean === null ? "–" : `${fmtPts(m.clvMean)} pts`}
          sub={m.clvPositiveShare === null ? "10 min horizon" : `${Math.round(m.clvPositiveShare * 100)}% positive`}
        />
        <StatTile label="Max drawdown" value={fmtUnits(m.maxDrawdown)} sub="units from peak" />
      </div>

      <Panel title="Exposure">
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-4">
          <ExposureStat
            label="At risk now"
            value={fmtUnits(m.exposure.openUnits)}
            sub={
              m.exposure.openPctOfBankroll === null
                ? `${m.exposure.openCount} open`
                : `${m.exposure.openCount} open · ${m.exposure.openPctOfBankroll.toFixed(1)}% of bankroll`
            }
          />
          <ExposureStat label="Peak at risk" value={fmtUnits(m.exposure.peakUnits)} sub="most units staked at once" />
          <ExposureStat label="Peak concurrent" value={String(m.exposure.peakConcurrent)} sub="positions open at once" />
          <ExposureStat
            label="Largest stake"
            value={m.exposure.largestStakePct === null ? "–" : `${m.exposure.largestStakePct.toFixed(2)}%`}
            sub="of bankroll at entry"
          />
        </div>
        <p className="mt-4 border-t border-border pt-3 text-xs text-faint">
          Measured from the position record itself. Stakes are capped fractional Kelly, and the
          frozen parameter set enforces per-position, per-match, and concurrency limits; the
          peak figures show the most the agent ever had at risk at one time.
        </p>
      </Panel>

      <Panel title="Calibration (Brier score, lower is better)">
        {m.brier.length === 0 ? (
          <Empty>Calibration appears after the first settled positions.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead>
                <tr className="border-b border-border text-xs tracking-wide text-faint uppercase">
                  <th className="py-2 pr-3 font-medium">Family · market</th>
                  <th className="py-2 pr-3 font-medium">N</th>
                  <th className="py-2 pr-3 font-medium">Model Brier</th>
                  <th className="py-2 pr-3 font-medium">Market Brier</th>
                  <th className="py-2 font-medium">Verdict</th>
                </tr>
              </thead>
              <tbody>
                {m.brier.map((b) => (
                  <tr key={b.family} className="border-b border-border/50">
                    <td className="py-2.5 pr-3">{b.family}</td>
                    <td className="py-2.5 pr-3 font-mono tabular-nums">{b.n}</td>
                    <td className="py-2.5 pr-3 font-mono tabular-nums">{b.model.toFixed(4)}</td>
                    <td className="py-2.5 pr-3 font-mono tabular-nums">{b.market.toFixed(4)}</td>
                    <td className="py-2.5 text-xs text-muted">
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
        <p className="mt-4 border-t border-border pt-3 text-xs text-faint">
          Brier score is the mean squared error of stated probabilities against outcomes. We
          publish ours next to the market consensus on the same positions, so you can see
          whether the agent's claimed probabilities carried information or just noise. CLV
          measures whether the market moved toward the position within 10 minutes of entry, the
          skill metric professionals actually respect. Small samples prove nothing; that is
          stated here rather than hidden.
        </p>
      </Panel>
    </div>
  );
}

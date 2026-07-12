// Fluid, server-rendered charts. The bankroll curve is an SVG step line with
// non-scaling strokes plus HTML dot overlays (round at every width); the CLV
// chart is pure HTML rows, fluid by construction. One data series (accent),
// settlement markers ringed with the surface, native tooltips, nothing smoothed.

import { STARTING_BANKROLL, type SettlementPoint } from "../lib/queries";

export function BankrollCurve({
  series,
  height = 130,
  caption = true,
}: {
  series: SettlementPoint[];
  height?: number;
  caption?: boolean;
}) {
  const points = series.filter((s) => s.bankrollAfter !== null);
  if (points.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-faint">
        The curve appears at the first certified settlement.
      </p>
    );
  }
  const H = height;
  const PAD_TOP = 12;
  const PAD_BOTTOM = 14;
  const values = [STARTING_BANKROLL, ...points.map((p) => p.bankrollAfter!)];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(max - min, 1);
  const y = (v: number) => PAD_TOP + (1 - (v - min) / span) * (H - PAD_TOP - PAD_BOTTOM);
  const x = (i: number) => (i / values.length) * 100; // percent

  let d = `M 0 ${y(values[0]!)}`;
  for (let i = 1; i < values.length; i++) {
    d += ` H ${x(i)} V ${y(values[i]!)}`;
  }
  d += ` H 100`;

  return (
    <div>
      <div className="relative" style={{ height: H }}>
        <svg
          width="100%"
          height={H}
          viewBox={`0 0 100 ${H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`Bankroll from ${STARTING_BANKROLL.toFixed(2)} to ${values[values.length - 1]!.toFixed(2)} units across ${points.length} settlements`}
        >
          <line x1="0" y1={y(min)} x2="100" y2={y(min)} stroke="var(--color-border)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          {max !== min ? (
            <line x1="0" y1={y(max)} x2="100" y2={y(max)} stroke="var(--color-border)" strokeWidth="1" strokeDasharray="3 5" vectorEffect="non-scaling-stroke" />
          ) : null}
          <path d={d} fill="none" stroke="var(--color-accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        </svg>
        {points.map((p, i) => (
          <span
            key={p.positionId}
            className="absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-panel bg-pos"
            style={{ left: `${x(i + 1)}%`, top: y(p.bankrollAfter!) }}
            title={`#${p.positionId} ${p.outcome} ${p.pnl >= 0 ? "+" : ""}${p.pnl.toFixed(2)}u — bankroll ${p.bankrollAfter!.toFixed(2)}`}
          />
        ))}
      </div>
      {caption ? (
        <p className="mt-3 text-[11.5px] leading-relaxed text-faint">
          Steps at settlements only: the bankroll moves when an outcome is certified, never
          between. Every step carries a proof transaction.
        </p>
      ) : null}
    </div>
  );
}

export function ClvBars({ series }: { series: SettlementPoint[] }) {
  const points = series.filter((s) => s.clv !== null);
  if (points.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-faint">
        Closing line value appears with the first settled positions.
      </p>
    );
  }
  const maxAbs = Math.max(...points.map((p) => Math.abs(p.clv!)), 1);

  return (
    <div>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-2">
        {points.map((p) => {
          const pct = (Math.abs(p.clv!) / maxAbs) * 100;
          const negative = p.clv! < 0;
          return (
            <div
              key={p.positionId}
              className="grid grid-cols-[minmax(64px,auto)_minmax(0,1fr)] items-center gap-3"
              title={`#${p.positionId}: CLV ${negative ? "" : "+"}${p.clv!.toFixed(1)} pts (10 min horizon)`}
            >
              <span className="text-right font-mono text-[11px] whitespace-nowrap text-muted tabular-nums">
                #{p.positionId} &middot; {negative ? "" : "+"}
                {p.clv!.toFixed(1)}
              </span>
              <div className="grid grid-cols-2">
                {/* negative side grows leftward from the zero axis */}
                <div className="flex justify-end border-r border-border-strong py-0.5">
                  {negative ? (
                    <span
                      className="h-4 rounded-l-[3px] border border-r-0 border-border-strong bg-panel-3"
                      style={{ width: `${pct}%` }}
                    />
                  ) : null}
                </div>
                <div className="flex justify-start py-0.5">
                  {!negative ? (
                    <span
                      className="h-4 rounded-r-[3px] border border-l-0 border-border-strong bg-panel-3"
                      style={{ width: `${pct}%` }}
                    />
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
        <div className="grid grid-cols-[minmax(64px,auto)_minmax(0,1fr)] gap-3">
          <span />
          <div className="grid grid-cols-2 font-mono text-[10px] text-faint">
            <span className="pr-1.5 text-right">&minus;{maxAbs.toFixed(0)}</span>
            <span className="pl-1.5">0 &#8594; +{maxAbs.toFixed(0)} pts</span>
          </div>
        </div>
      </div>
      <p className="mt-3 text-[11.5px] leading-relaxed text-faint">
        CLV is the skill metric, deliberately kept out of profit and loss colors. Bars grow
        from the record export; nothing is smoothed.
      </p>
    </div>
  );
}

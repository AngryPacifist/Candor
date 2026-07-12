// Server-rendered SVG charts. One data series (the accent), settlement
// markers with a surface ring, native <title> tooltips, recessive grid.
// Bankroll steps ONLY at certified settlements; nothing is smoothed.

import { STARTING_BANKROLL, type SettlementPoint } from "../lib/queries";

const ACCENT = "var(--color-accent)";
const POS = "var(--color-pos)";
const GRID = "var(--color-border)";
const SURFACE = "var(--color-panel)";
const BAR = "var(--color-panel-3)";
const BAR_EDGE = "var(--color-border-strong)";

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
  const W = 620;
  const H = height;
  const PAD_TOP = 12;
  const PAD_BOTTOM = 14;
  const values = [STARTING_BANKROLL, ...points.map((p) => p.bankrollAfter!)];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(max - min, 1);
  const y = (v: number) => PAD_TOP + (1 - (v - min) / span) * (H - PAD_TOP - PAD_BOTTOM);
  const x = (i: number) => (i / values.length) * W;

  // step path: hold each level, jump at the settlement
  let d = `M 0 ${y(values[0]!)}`;
  for (let i = 1; i < values.length; i++) {
    d += ` H ${x(i)} V ${y(values[i]!)}`;
  }
  d += ` H ${W}`;

  return (
    <div>
      <svg
        width="100%"
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Bankroll from ${STARTING_BANKROLL.toFixed(2)} to ${values[values.length - 1]!.toFixed(2)} units across ${points.length} settlements`}
      >
        <line x1="0" y1={y(min)} x2={W} y2={y(min)} stroke={GRID} strokeWidth="1" />
        {max !== min ? (
          <line x1="0" y1={y(max)} x2={W} y2={y(max)} stroke={GRID} strokeWidth="1" strokeDasharray="3 5" />
        ) : null}
        <path d={d} fill="none" stroke={ACCENT} strokeWidth="2" />
        {points.map((p, i) => (
          <circle key={p.positionId} cx={x(i + 1)} cy={y(p.bankrollAfter!)} r="4" fill={POS} stroke={SURFACE} strokeWidth="2">
            <title>
              {`#${p.positionId} ${p.outcome} ${p.pnl >= 0 ? "+" : ""}${p.pnl.toFixed(2)}u — bankroll ${p.bankrollAfter!.toFixed(2)}`}
            </title>
          </circle>
        ))}
      </svg>
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
  const W = 620;
  const ROW = 30;
  const PAD_TOP = 8;
  const H = PAD_TOP + points.length * ROW + 8;
  const maxAbs = Math.max(...points.map((p) => Math.abs(p.clv!)), 1);
  const zeroX = W * 0.76;
  const scale = (zeroX - 130) / maxAbs; // label gutter on the left

  return (
    <div>
      <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Closing line value per position, ${points.length} positions`}>
        <line x1={zeroX} y1={PAD_TOP - 2} x2={zeroX} y2={H - 6} stroke={BAR_EDGE} strokeWidth="1" />
        <text x={zeroX + 8} y={PAD_TOP + 6} fill="var(--color-faint)" fontSize="10" fontFamily="var(--font-mono)">
          0
        </text>
        {points.map((p, i) => {
          const w = Math.max(Math.abs(p.clv!) * scale, 2);
          const bx = p.clv! < 0 ? zeroX - w : zeroX;
          const by = PAD_TOP + i * ROW + 4;
          const labelX = p.clv! < 0 ? bx - 8 : bx + w + 8;
          const anchor = p.clv! < 0 ? "end" : "start";
          return (
            <g key={p.positionId}>
              <rect x={bx} y={by} width={w} height="16" rx="3" fill={BAR} stroke={BAR_EDGE} strokeWidth="1">
                <title>{`#${p.positionId}: CLV ${p.clv! >= 0 ? "+" : ""}${p.clv!.toFixed(1)} pts (10 min horizon)`}</title>
              </rect>
              <text x={labelX} y={by + 12} fill="var(--color-muted)" fontSize="11" fontFamily="var(--font-mono)" textAnchor={anchor}>
                {`#${p.positionId} · ${p.clv! >= 0 ? "+" : ""}${p.clv!.toFixed(1)}`}
              </text>
            </g>
          );
        })}
      </svg>
      <p className="mt-3 text-[11.5px] leading-relaxed text-faint">
        CLV is the skill metric, deliberately kept out of profit and loss colors. Bars grow
        from the record export; nothing is smoothed.
      </p>
    </div>
  );
}

"use client";

// The signal log as a readable timeline: decisions as prose with their mono
// reasoning underneath, daily Merkle-root commits interleaved, filter pills
// on top. Passes matter as much as entries here.

import { useState } from "react";
import type { DecisionsRoot, SignalRow } from "../lib/queries";
import { fmtPts, humanMarket, solscanTx, truncSig } from "../lib/format";
import { Badge, Empty } from "./ui";

type Filter = "all" | "enter" | "pass" | "root";

interface FeedItem {
  key: string;
  ts: number;
  kind: "enter" | "pass" | "root";
  signal?: SignalRow;
  root?: DecisionsRoot;
}

function whenLabel(ts: number): { day: string; time: string } {
  const d = new Date(ts);
  return {
    day: d.toISOString().slice(5, 10).replace("-", " "),
    time: d.toISOString().slice(11, 19),
  };
}

export function SignalFeed({ signals, roots }: { signals: SignalRow[]; roots: DecisionsRoot[] }) {
  const [filter, setFilter] = useState<Filter>("all");

  const items: FeedItem[] = [
    ...signals.map((s) => ({
      key: `s${s.id}`,
      ts: new Date(s.ts).getTime(),
      kind: (s.decision === "enter" ? "enter" : "pass") as FeedItem["kind"],
      signal: s,
    })),
    ...roots.map((r) => ({
      key: `r${r.date}`,
      ts: new Date(r.at).getTime(),
      kind: "root" as const,
      root: r,
    })),
  ].sort((a, b) => b.ts - a.ts);

  const shown = items.filter((i) => filter === "all" || i.kind === filter);
  const pills: { id: Filter; label: string }[] = [
    { id: "all", label: "all" },
    { id: "enter", label: "enters" },
    { id: "pass", label: "passes" },
    { id: "root", label: "daily roots" },
  ];

  return (
    <>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter decisions">
        {pills.map((p) => (
          <button
            key={p.id}
            type="button"
            aria-pressed={filter === p.id}
            onClick={() => setFilter(p.id)}
            className={`rounded-full border px-3 py-1 text-[11.5px] ${
              filter === p.id
                ? "border-accent-dim bg-accent-ink text-accent"
                : "border-border-strong text-muted hover:text-foreground"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <Empty>Nothing under this filter yet.</Empty>
      ) : (
        <div>
          {shown.map((item) => {
            const w = whenLabel(item.ts);
            return (
              <div
                key={item.key}
                className="grid grid-cols-[minmax(0,1fr)] gap-1 border-t border-border py-[13px] first:border-t-0 first:pt-1 md:grid-cols-[92px_minmax(0,1fr)] md:gap-4"
              >
                <span className="pt-0.5 font-mono text-[11px] leading-snug text-faint">
                  {w.day}
                  <span className="md:block"> {w.time}</span>
                </span>
                {item.signal ? (
                  <div className="min-w-0">
                    <p className="text-[13.5px]">
                      <Badge tone={item.kind === "enter" ? "pos" : "muted"}>{item.signal.decision}</Badge>{" "}
                      {humanMarket(
                        item.signal.market_key.split("|scope=")[0]!,
                        item.signal.side,
                        item.signal.participant1 ?? undefined,
                        item.signal.participant2 ?? undefined
                      )}
                      {item.signal.participant1 ? (
                        <span className="text-muted">
                          {" "}
                          &middot; {item.signal.participant1} v {item.signal.participant2}
                        </span>
                      ) : null}
                      {item.signal.edge !== null ? (
                        <span className="ml-2 font-mono text-xs text-accent">{fmtPts(item.signal.edge)} pts</span>
                      ) : null}
                    </p>
                    <p className="mt-1 font-mono text-[11.5px] leading-relaxed break-words text-faint">
                      {item.signal.reason}
                    </p>
                  </div>
                ) : item.root ? (
                  <div className="min-w-0">
                    <p className="text-[13.5px]">
                      <Badge tone="muted">daily root</Badge> decisions Merkle root committed
                      <span className="ml-2 font-mono text-xs text-accent">n={item.root.n}</span>
                    </p>
                    <p className="mt-1 font-mono text-[11.5px] leading-relaxed break-words text-faint">
                      root {item.root.root.slice(0, 16)}&hellip; &#8594;{" "}
                      <a href={solscanTx(item.root.sig)} target="_blank" rel="noreferrer" className="text-accent">
                        {truncSig(item.root.sig)}&#8599;
                      </a>{" "}
                      &middot; every signal of {item.root.date}, provably unedited
                    </p>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

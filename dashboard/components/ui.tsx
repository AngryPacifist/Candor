import type { ReactNode } from "react";
import { solscanTx, truncSig } from "../lib/format";

export function Panel({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-panel">
      <header className="flex items-baseline justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold tracking-wide text-muted uppercase">{title}</h2>
        {action}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

export function StatTile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "pos" | "neg" | "accent" }) {
  const toneClass = tone === "pos" ? "text-pos" : tone === "neg" ? "text-neg" : tone === "accent" ? "text-accent" : "text-foreground";
  return (
    <div className="rounded-lg border border-border bg-panel px-4 py-3">
      <p className="text-xs font-medium tracking-wide text-muted uppercase">{label}</p>
      <p className={`mt-1 font-mono text-2xl font-semibold tabular-nums ${toneClass}`}>{value}</p>
      {sub ? <p className="mt-0.5 text-xs text-faint">{sub}</p> : null}
    </div>
  );
}

export function Badge({ children, tone = "muted" }: { children: ReactNode; tone?: "pos" | "neg" | "warn" | "accent" | "muted" }) {
  const tones: Record<string, string> = {
    pos: "border-pos/40 text-pos",
    neg: "border-neg/40 text-neg",
    warn: "border-warn/40 text-warn",
    accent: "border-accent/40 text-accent",
    muted: "border-border text-muted",
  };
  return (
    <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

export function TxLink({ sig, label }: { sig: string; label?: string }) {
  return (
    <a
      href={solscanTx(sig)}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 font-mono text-xs text-accent underline decoration-accent-dim underline-offset-2 hover:decoration-accent"
      title={sig}
    >
      {label ?? truncSig(sig)}
      <span aria-hidden>↗</span>
    </a>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-faint">{children}</p>;
}

export function outcomeTone(outcome: string | null): "pos" | "neg" | "muted" {
  if (outcome === "won") return "pos";
  if (outcome === "lost") return "neg";
  return "muted";
}

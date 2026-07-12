import type { ReactNode } from "react";
import { solscanTx, truncSig } from "../lib/format";

export function Panel({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-panel">
      <header className="flex items-baseline justify-between gap-4 border-b border-border px-[18px] py-[13px]">
        <h2 className="text-xs font-semibold tracking-[0.07em] text-muted uppercase">{title}</h2>
        {action ? <span className="whitespace-nowrap">{action}</span> : null}
      </header>
      <div className="px-[18px] py-4">{children}</div>
    </section>
  );
}

export function StatTile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "pos" | "neg" | "accent" }) {
  const toneClass = tone === "pos" ? "text-pos" : tone === "neg" ? "text-neg" : tone === "accent" ? "text-accent" : "text-foreground";
  return (
    <div className="rounded-lg border border-border bg-panel px-4 py-3.5">
      <p className="text-[11px] font-medium tracking-[0.07em] text-muted uppercase">{label}</p>
      <p className={`mt-1 font-mono text-[19px] font-medium tabular-nums md:text-2xl ${toneClass}`}>{value}</p>
      {sub ? <p className="mt-0.5 text-[11.5px] text-faint">{sub}</p> : null}
    </div>
  );
}

export function Badge({ children, tone = "muted" }: { children: ReactNode; tone?: "pos" | "neg" | "warn" | "accent" | "muted" | "proof" }) {
  const tones: Record<string, string> = {
    pos: "border-transparent bg-pos-dim text-pos",
    neg: "border-transparent bg-neg-dim text-neg",
    warn: "border-warn/40 text-warn",
    accent: "border-accent/40 text-accent",
    muted: "border-transparent bg-panel-2 text-muted",
    proof: "border-pos/40 text-pos",
  };
  return (
    <span className={`inline-flex items-center gap-1 rounded-[5px] border px-2 py-0.5 text-[11px] font-medium ${tones[tone]}`}>
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

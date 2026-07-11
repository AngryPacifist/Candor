import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import Link from "next/link";
import { pool } from "../lib/db";
import { timeAgo } from "../lib/format";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const jetbrains = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains" });

export const metadata: Metadata = {
  title: "Candor",
  description: "The trading agent that cannot lie about its record.",
};

export const dynamic = "force-dynamic";

async function AgentStatus() {
  try {
    const res = await pool.query(`SELECT updated_at FROM agent_state WHERE key = 'worker_heartbeat'`);
    const at: string | undefined = res.rows[0]?.updated_at;
    const fresh = at !== undefined && Date.now() - new Date(at).getTime() < 90_000;
    return (
      <span
        className={`inline-flex items-center gap-1.5 rounded border px-2 py-1 text-xs font-medium ${
          fresh ? "border-pos/40 text-pos" : "border-warn/40 text-warn"
        }`}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${fresh ? "bg-pos motion-safe:animate-pulse" : "bg-warn"}`} aria-hidden />
        {fresh ? "agent live" : at ? `last seen ${timeAgo(at)}` : "agent offline"}
      </span>
    );
  } catch {
    return (
      <span className="inline-flex items-center gap-1.5 rounded border border-warn/40 px-2 py-1 text-xs font-medium text-warn">
        <span className="h-1.5 w-1.5 rounded-full bg-warn" aria-hidden />
        status unknown
      </span>
    );
  }
}

const NAV = [
  { href: "/", label: "Overview" },
  { href: "/positions", label: "Positions" },
  { href: "/signals", label: "Signal log" },
  { href: "/metrics", label: "Metrics" },
  { href: "/verify", label: "Verify me" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrains.variable}`}>
      <body className="min-h-screen font-sans">
        <header className="border-b border-border bg-panel/60">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 md:px-6">
            <div className="flex items-baseline gap-3">
              <Link href="/" className="text-lg font-bold tracking-tight text-foreground">
                CANDOR
              </Link>
              <span className="hidden text-xs text-faint sm:inline">
                the trading agent that cannot lie about its record
              </span>
            </div>
            <nav className="flex flex-1 flex-wrap items-center gap-1 text-sm" aria-label="Main">
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="rounded px-2.5 py-1.5 text-muted hover:bg-panel-2 hover:text-foreground"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
            <AgentStatus />
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-6 md:px-6">{children}</main>
        <footer className="mx-auto max-w-7xl px-4 pb-8 text-xs text-faint md:px-6">
          <p>
            Paper trading in units. No real money is wagered or custodied. Every number on this
            site carries an on-chain verify link or is recomputable from the{" "}
            <a href="/api/record" className="text-accent underline underline-offset-2">
              public record export
            </a>
            . Data: TxLINE by TxODDS, anchored on Solana.
          </p>
        </footer>
      </body>
    </html>
  );
}

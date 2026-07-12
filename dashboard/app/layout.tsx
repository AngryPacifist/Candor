import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import Link from "next/link";
import { DesktopNav, MobileMenu } from "../components/shell-nav";
import { solscanTx, timeAgo, truncSig } from "../lib/format";
import { fetchAttest } from "../lib/queries";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const jetbrains = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains" });

export const metadata: Metadata = {
  title: "Candor",
  description: "The trading agent that cannot lie about its record.",
};

export const dynamic = "force-dynamic";

function LogoGlyph() {
  return (
    <span aria-hidden className="relative inline-block h-[22px] w-[22px] rounded-[5px] border-[1.5px] border-accent">
      <span className="absolute inset-[4px] translate-y-[-2px] rotate-[-45deg] scale-90 rounded-[1px] border-b-[1.5px] border-l-[1.5px] border-accent" />
    </span>
  );
}

function AgentStatus({ heartbeatAt }: { heartbeatAt: string | null }) {
  const fresh = heartbeatAt !== null && Date.now() - new Date(heartbeatAt).getTime() < 90_000;
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${fresh ? "text-pos" : "text-warn"}`}>
      <span className={`h-[7px] w-[7px] rounded-full ${fresh ? "bg-pos motion-safe:animate-pulse" : "bg-warn"}`} aria-hidden />
      {fresh ? "agent live" : heartbeatAt ? `last seen ${timeAgo(heartbeatAt)}` : "agent offline"}
      {fresh && heartbeatAt ? <span className="font-normal text-faint">&middot; {timeAgo(heartbeatAt)}</span> : null}
    </span>
  );
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  let attest = null;
  try {
    attest = await fetchAttest();
  } catch {
    attest = null;
  }

  return (
    <html lang="en" className={`${inter.variable} ${jetbrains.variable}`}>
      <body className="min-h-screen font-sans text-sm">
        <header className="border-b border-border">
          <div className="relative mx-auto flex h-[53px] max-w-7xl items-center justify-between px-4 md:px-6">
            <Link href="/" className="flex items-center gap-2.5">
              <LogoGlyph />
              <span className="text-sm font-bold tracking-[0.1em] text-foreground">CANDOR</span>
            </Link>
            <DesktopNav />
            <div className="flex items-center gap-4">
              <AgentStatus heartbeatAt={attest?.heartbeatAt ?? null} />
              <MobileMenu
                attest={{
                  paramsHash: attest?.ceremonyHash ?? attest?.paramsHash ?? null,
                  ceremonySig: attest?.ceremonySig ?? null,
                  chainTip: attest?.chainTip ?? null,
                  settled: attest?.settled ?? 0,
                  proven: attest?.proven ?? 0,
                }}
              />
            </div>
          </div>
        </header>

        {/* The attestation strip: the chain state, on every page. */}
        <div className="border-b border-border bg-panel">
          <div className="mx-auto flex max-w-7xl flex-wrap justify-center gap-x-6 gap-y-1 px-4 py-2 font-mono text-[11px] text-faint md:px-6">
            <span>
              <span className="text-muted">params</span>{" "}
              {attest?.paramsHash ? `${attest.paramsHash.slice(0, 8)}…` : "…"}{" "}
              {attest?.frozen ? <span className="text-pos">frozen</span> : null}
            </span>
            {attest?.ceremonySig ? (
              <span className="hidden sm:inline">
                <span className="text-muted">ceremony</span>{" "}
                <a href={solscanTx(attest.ceremonySig)} target="_blank" rel="noreferrer" className="text-accent">
                  {truncSig(attest.ceremonySig)}&#8599;
                </a>
              </span>
            ) : null}
            {attest?.chainTip ? (
              <span className="hidden sm:inline">
                <span className="text-muted">chain tip</span>{" "}
                <a href={solscanTx(attest.chainTip)} target="_blank" rel="noreferrer" className="text-accent">
                  {truncSig(attest.chainTip)}&#8599;
                </a>
              </span>
            ) : null}
            <span>
              <span className="text-muted">proofs</span>{" "}
              <span className={attest && attest.settled > 0 && attest.proven === attest.settled ? "text-pos" : ""}>
                {attest ? `${attest.proven} of ${attest.settled} positions proven` : "…"}
              </span>
            </span>
            <span className="hidden md:inline">
              <span className="text-muted">record export</span>{" "}
              <a href="/api/record" className="text-accent">
                /api/record
              </a>
            </span>
          </div>
        </div>

        <main className="mx-auto grid max-w-7xl grid-cols-[minmax(0,1fr)] gap-6 px-4 py-6 md:px-6 md:py-7">
          {children}
        </main>
        <footer className="mx-auto max-w-3xl px-4 pt-2 pb-9 text-center text-xs leading-relaxed text-faint md:px-6">
          <p>
            Paper trading in units. No real money is wagered or custodied. Every number on this
            site carries an on-chain verify link or is recomputable from the{" "}
            <a href="/api/record" className="text-accent underline underline-offset-2">
              public record export
            </a>
            .
          </p>
          <p className="mt-2 font-mono text-[11px]">Data: TxLINE by TxODDS, anchored on Solana.</p>
        </footer>
      </body>
    </html>
  );
}

"use client";

// Navigation: centered underline tabs on desktop, a hamburger opening a
// full sheet on mobile. The sheet carries the attestation block so the trust
// surface is one tap away on every page.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { solscanTx, truncSig } from "../lib/format";

const NAV = [
  { href: "/", label: "Overview" },
  { href: "/positions", label: "Positions" },
  { href: "/signals", label: "Signals" },
  { href: "/metrics", label: "Metrics" },
  { href: "/verify", label: "Verify me" },
];

export interface NavAttest {
  paramsHash: string | null;
  ceremonySig: string | null;
  chainTip: string | null;
  settled: number;
  proven: number;
}

export function DesktopNav() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Main"
      className="absolute left-1/2 hidden h-full -translate-x-1/2 items-center gap-0.5 md:flex"
    >
      {NAV.map((item) => {
        const active = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`-mb-px flex h-full items-center border-b-2 px-3.5 text-[13px] ${
              active
                ? "border-accent text-foreground"
                : "border-transparent text-muted hover:text-foreground"
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function MobileMenu({ attest }: { attest: NavAttest }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    document.documentElement.style.overflow = open ? "hidden" : "";
    return () => {
      document.documentElement.style.overflow = "";
    };
  }, [open]);

  return (
    <div className="md:hidden">
      <button
        type="button"
        aria-label={open ? "Close menu" : "Open menu"}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="grid w-9 justify-items-center gap-[4.5px] py-2"
      >
        {open ? (
          <span aria-hidden className="text-xl leading-none text-muted">
            &times;
          </span>
        ) : (
          <>
            <i aria-hidden className="block h-[1.5px] w-5 rounded bg-muted" />
            <i aria-hidden className="block h-[1.5px] w-5 rounded bg-muted" />
            <i aria-hidden className="block h-[1.5px] w-5 rounded bg-muted" />
          </>
        )}
      </button>

      {open ? (
        <div className="fixed inset-x-0 top-[53px] bottom-0 z-50 flex flex-col overflow-y-auto bg-background px-4 pt-1 pb-6">
          <nav aria-label="Main" className="flex flex-col">
            {NAV.map((item) => {
              const active = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={`flex items-baseline justify-between border-b border-border py-4 text-[16.5px] font-medium ${
                    active ? "text-accent" : "text-foreground"
                  }`}
                >
                  {item.label}
                  {item.href === "/positions" ? (
                    <span className="font-mono text-[11px] font-normal text-faint">
                      {attest.settled} settled &middot; {attest.proven} proven
                    </span>
                  ) : null}
                </Link>
              );
            })}
          </nav>
          <div className="mt-auto grid gap-3 pt-6">
            <div className="grid gap-2 rounded-lg border border-border-strong bg-panel px-4 py-3.5 font-mono text-[11.5px]">
              <div className="flex justify-between gap-4">
                <span className="text-faint">params</span>
                <span>
                  {attest.paramsHash ? `${attest.paramsHash.slice(0, 8)}…` : "…"}{" "}
                  <span className="text-pos">frozen</span>
                </span>
              </div>
              {attest.ceremonySig ? (
                <div className="flex justify-between gap-4">
                  <span className="text-faint">ceremony</span>
                  <a href={solscanTx(attest.ceremonySig)} target="_blank" rel="noreferrer" className="text-accent">
                    {truncSig(attest.ceremonySig)} &#8599;
                  </a>
                </div>
              ) : null}
              {attest.chainTip ? (
                <div className="flex justify-between gap-4">
                  <span className="text-faint">chain tip</span>
                  <a href={solscanTx(attest.chainTip)} target="_blank" rel="noreferrer" className="text-accent">
                    {truncSig(attest.chainTip)} &#8599;
                  </a>
                </div>
              ) : null}
              <div className="flex justify-between gap-4">
                <span className="text-faint">record export</span>
                <a href="/api/record" className="text-accent">
                  /api/record
                </a>
              </div>
            </div>
            <Link
              href="/verify"
              className="flex items-center justify-center gap-2 rounded-md border border-accent-dim bg-accent-ink px-4 py-2.5 text-[13px] font-medium text-accent"
            >
              Verify this record &#8594;
            </Link>
            <p className="text-[10.5px] leading-relaxed text-faint">
              Paper trading in units. No real money is wagered or custodied.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

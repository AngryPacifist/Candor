import { AutoRefresh } from "../../components/auto-refresh";
import { PositionsLedger } from "../../components/positions-ledger";
import { Panel } from "../../components/ui";
import { fetchPositions } from "../../lib/queries";

export const dynamic = "force-dynamic";

export default async function PositionsPage() {
  const rows = await fetchPositions(200);
  const settled = rows.filter((r) => r.status === "settled").length;
  const open = rows.filter((r) => r.status === "open").length;

  return (
    <>
      <AutoRefresh seconds={30} />
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="text-base font-bold tracking-[-0.01em]">Positions</h1>
        <span className="text-xs text-faint">
          {settled} settled &middot; {open} open &middot; every one committed pre-outcome
        </span>
      </div>
      <Panel title={`Ledger (${rows.length})`}>
        <PositionsLedger rows={rows} />
      </Panel>
      <p className="text-xs leading-relaxed text-faint">
        Commits are hash chained: each memo carries the previous commit signature, so a
        deleted position leaves a visible hole. Settled positions end in exactly one proof
        state: proven, unavailable (with the reason shown), or void. The receipt shows the
        exact artifacts; the verify button re-checks them in your own browser.
      </p>
    </>
  );
}

import { AutoRefresh } from "../../components/auto-refresh";
import { PositionsTable } from "../../components/positions-table";
import { Panel } from "../../components/ui";
import { fetchPositions } from "../../lib/queries";

export const dynamic = "force-dynamic";

export default async function PositionsPage() {
  const rows = await fetchPositions(200);
  return (
    <div className="flex flex-col gap-4">
      <AutoRefresh seconds={30} />
      <Panel title={`Positions (${rows.length})`}>
        <PositionsTable rows={rows} />
      </Panel>
      <p className="text-xs text-faint">
        Every position is hashed and committed to Solana mainnet the moment it is taken, before
        the outcome exists. Commits are hash chained: each memo carries the previous commit
        signature, so a deleted position leaves a visible hole. Settled positions end in exactly
        one proof state: proven, unavailable (with the reason), or void.
      </p>
    </div>
  );
}

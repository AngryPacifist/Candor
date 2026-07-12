import { AutoRefresh } from "../../components/auto-refresh";
import { SignalFeed } from "../../components/signal-feed";
import { Panel } from "../../components/ui";
import { fetchDecisionsRoots, fetchSignals } from "../../lib/queries";

export const dynamic = "force-dynamic";

export default async function SignalsPage() {
  const [signals, roots] = await Promise.all([fetchSignals(200), fetchDecisionsRoots()]);

  return (
    <>
      <AutoRefresh seconds={30} />
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="text-base font-bold tracking-[-0.01em]">Signal log</h1>
        <span className="text-xs text-faint">every decision, including the ones not taken</span>
      </div>
      <Panel title={`Decisions (${signals.length})`}>
        <div className="grid gap-4">
          <SignalFeed signals={signals} roots={roots} />
        </div>
      </Panel>
      <p className="text-xs leading-relaxed text-faint">
        Each day&apos;s full signal log is sealed into a Merkle root and committed to mainnet,
        so the reasoning trail is provably unedited after the fact.
      </p>
    </>
  );
}

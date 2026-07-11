"use client";

export default function Error({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 rounded-lg border border-border bg-panel px-6 py-10 text-center">
      <p className="text-sm font-semibold">Could not load this page.</p>
      <p className="text-xs text-muted">
        The database may be briefly unreachable. The agent itself runs independently of this
        dashboard; the on-chain record is unaffected.
      </p>
      <button
        onClick={reset}
        className="rounded-md border border-accent/50 px-4 py-2 text-sm font-medium text-accent hover:bg-panel-2"
      >
        Try again
      </button>
    </div>
  );
}

export default function Loading() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-20 rounded-lg border border-border bg-panel motion-safe:animate-pulse" />
        ))}
      </div>
      <div className="h-48 rounded-lg border border-border bg-panel motion-safe:animate-pulse" />
      <div className="h-64 rounded-lg border border-border bg-panel motion-safe:animate-pulse" />
    </div>
  );
}

export default function Loading() {
  return (
    <main className="mx-auto max-w-6xl px-6 py-8" role="status" aria-live="polite" aria-busy="true">
      <p className="text-foreground font-medium">Loading current dashboard data</p>
      <p className="text-muted-foreground mt-2 max-w-2xl text-sm">Policy, cached metrics, and bounded live observations are being read. Unknown values will remain unavailable.</p>
      <span className="sr-only">Loading</span>
      <div aria-hidden="true" className="mt-6 space-y-3">
        <div className="bg-muted h-6 w-1/3 rounded-sm" />
        <div className="bg-muted h-4 w-2/3 rounded-sm" />
        <div className="bg-muted h-24 w-full rounded-md" />
      </div>
    </main>
  )
}

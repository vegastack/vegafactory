import type { Freshness } from '@/lib/freshness'

// Shown only when a live source failed on this request. The clone's age is always true and is
// rendered by the shell; this banner is the narrower claim that what you are looking at is not
// live, and it names how stale the cached half is so the reader can judge.
export function OfflineBanner({ freshness, reasons = [] }: { freshness: Freshness; reasons?: string[] }) {
  if (!freshness.offline) return null
  const safeReasons = [...new Set(reasons.map(reason => /[\r\n\0]|\/Users\/|\/home\/|gh[pousr]_|github_pat_|Bearer |sk-(?:ant-|proj-)/i.test(reason)
    ? 'A live source returned an unavailable diagnostic.'
    : reason))]
  return (
    <div className="border-border bg-muted text-muted-foreground mb-6 rounded-lg border px-4 py-3 text-sm">
      <p className="text-foreground font-medium">Live data is unavailable. Showing the control-room clone, {freshness.label}.</p>
      {safeReasons.length > 0 && (
        <ul className="mt-2 list-disc space-y-1 pl-5">
          {safeReasons.map((reason) => <li key={reason}>{reason}</li>)}
        </ul>
      )}
    </div>
  )
}

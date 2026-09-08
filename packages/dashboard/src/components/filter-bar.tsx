import Link from 'next/link'

import type { FilterOptions, Filters } from '@/lib/cache/filters'

const KEYS = ['month', 'repo', 'group', 'harness', 'model'] as const
type Key = (typeof KEYS)[number]

const LABELS: Record<Key, string> = {
  month: 'Month', repo: 'Repo', group: 'Group', harness: 'Harness', model: 'Model',
}

function href(base: string, filters: Filters, key: Key, value: string | null, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams()
  for (const [name, preserved] of Object.entries(extra)) if (preserved) params.set(name, preserved)
  for (const other of KEYS) {
    const current = other === key ? value : filters[other]
    if (current) params.set(other, current)
  }
  const query = params.toString()
  return query ? `${base}?${query}` : base
}

// Links, not a form: every filtered view is a URL a reader can bookmark, share in an issue, or
// reload after a rebuild. The month control has no "all" because the data model is per-month.
export function FilterBar({ base, options, filters, extra }: { base: string; options: FilterOptions; filters: Filters; extra?: Record<string, string> }) {
  const lists: Record<Key, string[]> = {
    month: options.months, repo: options.repos, group: options.groups,
    harness: options.harnesses, model: options.models,
  }
  return (
    <nav aria-label="Filters" className="border-border mb-6 flex flex-wrap gap-x-6 gap-y-3 border-b pb-4 text-sm">
      {KEYS.map((key) => {
        const values = lists[key]
        if (values.length === 0) return null
        const active = filters[key]
        return (
          <div key={key} className="flex flex-wrap items-baseline gap-2">
            <span className="text-muted-foreground">{LABELS[key]}</span>
            {key !== 'month' && (
              <Link
                href={href(base, filters, key, null, extra)}
                className={active === null ? 'text-foreground font-medium' : 'text-muted-foreground hover:text-foreground underline-offset-4 hover:underline'}
              >
                all
              </Link>
            )}
            {values.map((value) => (
              <Link
                key={value}
                href={href(base, filters, key, value, extra)}
                className={active === value ? 'text-foreground font-medium' : 'text-muted-foreground hover:text-foreground underline-offset-4 hover:underline'}
              >
                {value}
              </Link>
            ))}
          </div>
        )
      })}
    </nav>
  )
}

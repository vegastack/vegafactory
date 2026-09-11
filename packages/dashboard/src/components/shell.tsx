import Link from 'next/link'

import type { Filters } from '@/lib/cache/filters'
import type { Freshness } from '@/lib/freshness'

const PRIMARY_VIEWS = [
  { href: '/', label: 'Attention' },
  { href: '/performance', label: 'Performance' },
  { href: '/activity', label: 'Activity' },
] as const

const SECONDARY_VIEWS = [
  { href: '/people', label: 'People' },
  { href: '/skills', label: 'Skills' },
  { href: '/board', label: 'Board' },
  { href: '/dispatcher', label: 'Dispatcher' },
] as const

function reportQuery(filters?: Filters, extra?: Record<string, string | null | undefined>): string {
  const query = new URLSearchParams()
  if (filters) {
    for (const key of ['month', 'repo', 'group', 'harness', 'model'] as const) {
      const value = filters[key]
      if (value) query.set(key, value)
    }
  }
  for (const [key, value] of Object.entries(extra ?? {})) if (value) query.set(key, value)
  return query.toString()
}

function currentSection(pathname: string): string {
  if (pathname.startsWith('/people/')) return '/people'
  if (pathname.startsWith('/repo/')) return '/'
  return pathname
}

export function Navigation({ pathname, filters, extra }: {
  pathname: string
  filters?: Filters
  extra?: Record<string, string | null | undefined>
}) {
  const current = currentSection(pathname)
  const query = reportQuery(filters, extra)
  const links = (views: typeof PRIMARY_VIEWS | typeof SECONDARY_VIEWS) => views.map(view => {
    const active = current === view.href
    return (
      <li key={view.href}>
        <Link
          href={`${view.href}${query ? `?${query}` : ''}`}
          aria-current={active ? 'page' : undefined}
          className={active
            ? 'text-foreground font-medium underline decoration-2 underline-offset-4'
            : 'text-muted-foreground hover:text-foreground underline-offset-4 hover:underline'}
        >
          {view.label}
        </Link>
      </li>
    )
  })
  return (
    <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3 text-sm">
      <nav aria-label="Primary navigation"><ul className="flex flex-wrap gap-4">{links(PRIMARY_VIEWS)}</ul></nav>
      <nav aria-label="Secondary navigation"><ul className="flex flex-wrap gap-4">{links(SECONDARY_VIEWS)}</ul></nav>
    </div>
  )
}

export function Shell({ title, freshness, pathname, filters, navigationExtra, children }: {
  title: string
  freshness: Freshness
  pathname: string
  filters?: Filters
  navigationExtra?: Record<string, string | null | undefined>
  children: React.ReactNode
}) {
  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <header className="mb-8">
        <div className="flex flex-wrap items-baseline justify-between gap-4">
          <h1 className="text-2xl font-medium tracking-tight">{title}</h1>
          <p className="text-muted-foreground text-sm">{freshness.label}</p>
        </div>
        <Navigation pathname={pathname} filters={filters} extra={navigationExtra} />
      </header>
      <main>{children}</main>
    </div>
  )
}

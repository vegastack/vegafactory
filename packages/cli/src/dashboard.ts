// `vegafactory dashboard` — one self-contained HTML file built from the collected and pushed
// turns. No server, no network, no CDN: the file opens from disk and works offline.
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import {
  compact, duration, loadEvents, parseSince, summarize, totalTokens,
  type Bucket, type StatsEvent, type Summary, type Tokens,
} from './stats.ts'
import { makeFactoryHome, statsHtmlPath } from './home.ts'

const escape = (text: string) => text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!))

export function expandHome(path: string, home = homedir()): string {
  if (path === '~') return home
  if (path.startsWith('~/')) return join(home, path.slice(2))
  return isAbsolute(path) ? path : resolve(path)
}

const issueLink = (key: string) => {
  const [repo, number] = key.split('#')
  return repo && /^[\w.-]+\/[\w.-]+$/.test(repo) && number ? `https://github.com/${repo}/issues/${number}` : null
}

const cells = (values: Array<string | number>) => values.map((value) => `<td>${escape(String(value))}</td>`).join('')

function tokenCells(tokens: Tokens): string {
  return cells([compact(tokens.input), compact(tokens.output), compact(tokens.cacheRead), compact(tokens.cacheWrite), compact(totalTokens(tokens))])
}

function table(caption: string, headers: string[], rows: string[]): string {
  if (!rows.length) return `<section><h2>${escape(caption)}</h2><p class="empty">nothing collected yet</p></section>`
  return `<section><h2>${escape(caption)}</h2><table><thead><tr>${headers.map((header) => `<th>${escape(header)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></section>`
}

const TOKEN_HEADERS = ['in', 'out', 'cache read', 'cache write', 'total']

function usageTable(caption: string, first: string, buckets: Bucket[], extra?: { header: string; of: (bucket: Bucket) => string }): string {
  const rows = buckets.map((bucket) => `<tr><th scope="row">${escape(bucket.key)}</th>${cells([bucket.turns])}${tokenCells(bucket.tokens)}${cells([duration(bucket.durationMs)])}${extra ? `<td>${escape(extra.of(bucket))}</td>` : ''}</tr>`)
  return table(caption, [first, 'turns', ...TOKEN_HEADERS, 'time', ...(extra ? [extra.header] : [])], rows)
}

function issuesTable(buckets: Bucket[]): string {
  const rows = buckets.map((bucket) => {
    const link = issueLink(bucket.key)
    const label = link ? `<a href="${escape(link)}">${escape(bucket.key)}</a>` : escape(bucket.key)
    return `<tr><th scope="row">${label}</th>${cells([bucket.state ?? '—', bucket.operators.join(', '), bucket.harnesses.join(', '), bucket.models.join(', '), bucket.turns, compact(totalTokens(bucket.tokens)), duration(bucket.durationMs), bucket.last.slice(0, 10)])}</tr>`
  })
  return table('Issues', ['issue', 'state', 'operator', 'harness', 'model', 'turns', 'tokens', 'time', 'last'], rows)
}

function bars(caption: string, buckets: Bucket[]): string {
  if (!buckets.length) return table(caption, [], [])
  const peak = Math.max(...buckets.map((bucket) => totalTokens(bucket.tokens)), 1)
  const rows = buckets.map((bucket) => {
    const width = Math.max(1, Math.round((totalTokens(bucket.tokens) / peak) * 100))
    return `<tr><th scope="row">${escape(bucket.key)}</th><td class="bar"><span style="width:${width}%"></span></td>${cells([bucket.turns, compact(totalTokens(bucket.tokens)), duration(bucket.durationMs)])}</tr>`
  })
  return table(caption, ['day', 'tokens', 'turns', 'total', 'time'], rows)
}

const STYLE = `:root{color-scheme:light dark;--line:#d5d8de;--muted:#5d6470;--bar:#2f6feb;--head:#f4f5f7}
@media (prefers-color-scheme:dark){:root{--line:#333a45;--muted:#9aa3b2;--bar:#5b8dff;--head:#1b1f27}}
*{box-sizing:border-box}
body{margin:0 auto;padding:24px 16px 64px;max-width:1100px;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
h1{font-size:22px;margin:0 0 4px}
h2{font-size:16px;margin:32px 0 8px;font-weight:600}
p.sub,p.empty{color:var(--muted);margin:0}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:right;white-space:nowrap}
th[scope=row],thead th:first-child{text-align:left;font-weight:500;white-space:normal}
thead th{background:var(--head);color:var(--muted);font-weight:600;font-size:13px}
td.bar{width:40%}
td.bar span{display:block;height:10px;background:var(--bar);border-radius:2px}
a{color:inherit}
footer{margin-top:40px;color:var(--muted);font-size:13px}`

export function renderDashboard(events: StatsEvent[], { generatedAt = new Date().toISOString() } = {}): string {
  const summary: Summary = summarize(events)
  const head = summary.turns
    ? `${summary.turns} turns · ${compact(totalTokens(summary.tokens))} tokens · ${duration(summary.durationMs)} · ${summary.from?.slice(0, 10)} to ${summary.to?.slice(0, 10)} · ${summary.operators.length} operators · ${summary.projects.length} projects`
    : 'no turns collected yet'
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>VegaFactory stats</title><style>${STYLE}</style></head>
<body>
<h1>VegaFactory stats</h1>
<p class="sub">${escape(head)}</p>
${usageTable('Operators', 'operator', summary.operators, { header: 'projects', of: (bucket) => bucket.repos.join(', ') })}
${usageTable('Projects', 'project', summary.projects, { header: 'operators', of: (bucket) => bucket.operators.join(', ') })}
${issuesTable(summary.issues)}
${usageTable('Models', 'harness · model', summary.models, { header: 'operators', of: (bucket) => bucket.operators.join(', ') })}
${usageTable('Model use per operator', 'operator · model', summary.operatorModels)}
${usageTable('Model use per project', 'project · model', summary.projectModels)}
${bars('By day', summary.days)}
${usageTable('Time per stage', 'stage', summary.stages)}
${usageTable('Skills', 'skill', summary.skills)}
<footer>Generated ${escape(generatedAt)} by vegafactory dashboard — counts only, no prompts or code.</footer>
</body></html>
`
}

export function dashboardUsage(): string {
  return `Usage: vegafactory dashboard [options]

Writes one self-contained HTML file from the collected and pushed turns — operators, projects,
issues, models, days and stages. No server and no network.

Options:
  --out PATH        where to write it (default ${statsHtmlPath()})
  --since 7d        only turns since then (7d, 12h, 30m or a date)
  --local           only this machine's own turns, not the control room
  --open            open the file afterwards
`
}

export function runDashboard(argv: string[], options: { home?: string; now?: () => number; out?: (text: string) => void; open?: (path: string) => void } = {}): number {
  const home = options.home ?? homedir()
  const now = options.now ?? Date.now
  const out = options.out ?? ((text: string) => process.stdout.write(text + '\n'))
  if (argv.some((argument) => ['help', '--help', '-h'].includes(argument))) { out(dashboardUsage()); return 0 }
  const value = (flag: string) => {
    const at = argv.indexOf(flag)
    if (at === -1) return null
    const given = argv[at + 1]
    if (!given || given.startsWith('-')) throw new Error(`${flag} requires a value`)
    return given
  }
  const since = value('--since') ? parseSince(value('--since')!, now()) : null
  const target = expandHome(value('--out') ?? statsHtmlPath({ home }), home)
  const events = loadEvents(home, { since, shared: !argv.includes('--local') })
  makeFactoryHome({ home })
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, renderDashboard(events, { generatedAt: new Date(now()).toISOString() }))
  out(`${target} — ${events.length} turns`)
  if (argv.includes('--open')) {
    const open = options.open ?? ((path: string) => {
      const child = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [path], { stdio: 'ignore', detached: true })
      child.on('error', () => {})
      child.unref()
    })
    open(target)
  }
  return 0
}

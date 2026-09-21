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

export type DashboardEvent = Pick<StatsEvent, 'id' | 'at' | 'owner' | 'node' | 'repo' | 'issue' | 'state' | 'harness' | 'model' | 'skill' | 'tokens' | 'durationMs'>
export interface DashboardFilters { repo: string; owner: string; node: string; from: string; to: string }

const dashboardEvents = (events: StatsEvent[]): DashboardEvent[] => events.map((event) => ({
  id: event.id, at: event.at, owner: event.owner, node: event.node, repo: event.repo,
  issue: event.issue, state: event.state, harness: event.harness, model: event.model,
  skill: event.skill, tokens: event.tokens, durationMs: event.durationMs,
}))

export function filterDashboardEvents(events: DashboardEvent[], filters: DashboardFilters): DashboardEvent[] {
  return events.filter((event) => {
    const day = event.at.slice(0, 10)
    return (!filters.repo || event.repo === filters.repo)
      && (!filters.owner || event.owner === filters.owner)
      && (!filters.node || event.node === filters.node)
      && (!filters.from || day >= filters.from)
      && (!filters.to || day <= filters.to)
  })
}

export const dashboardData = (events: StatsEvent[]): string => JSON.stringify(dashboardEvents(events)).replace(/[<>&\u2028\u2029]/g, (character) =>
  `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)

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
    return `<tr><th scope="row">${label}</th>${cells([bucket.state ?? '—', bucket.owners.join(', '), bucket.harnesses.join(', '), bucket.models.join(', '), bucket.turns, compact(totalTokens(bucket.tokens)), duration(bucket.durationMs), bucket.last.slice(0, 10)])}</tr>`
  })
  return table('Issues', ['issue', 'state', 'owner', 'harness', 'model', 'turns', 'tokens', 'time', 'last'], rows)
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
.filters{display:grid;grid-template-columns:repeat(5,minmax(120px,1fr));gap:10px;margin:18px 0 8px}
.filters label{color:var(--muted);font-size:13px}.filters select,.filters input{display:block;width:100%;margin-top:3px;padding:6px;border:1px solid var(--line);border-radius:4px;background:Canvas;color:CanvasText}
@media (max-width:760px){.filters{grid-template-columns:repeat(2,minmax(120px,1fr))}}
footer{margin-top:40px;color:var(--muted);font-size:13px}`

const select = (id: string, label: string, values: string[]) => `<label>${escape(label)}<select id="${id}"><option value="">all</option>${values.map((value) => `<option value="${escape(value)}">${escape(value)}</option>`).join('')}</select></label>`

function controls(events: DashboardEvent[]): string {
  const values = (of: (event: DashboardEvent) => string | null) => [...new Set(events.map(of).filter((value): value is string => !!value))].sort()
  return `<div class="filters" aria-label="Dashboard filters">
${select('filter-repo', 'repository', values((event) => event.repo))}
${select('filter-owner', 'owner', values((event) => event.owner))}
${select('filter-node', 'node', values((event) => event.node))}
<label>from<input id="filter-from" type="date"></label>
<label>to<input id="filter-to" type="date"></label>
</div>`
}

function sections(summary: Summary): string {
  return `${usageTable('Owners', 'owner', summary.owners, { header: 'projects', of: (bucket) => bucket.repos.join(', ') })}
${usageTable('Nodes', 'node', summary.nodes, { header: 'projects', of: (bucket) => bucket.repos.join(', ') })}
${usageTable('Projects', 'project', summary.projects, { header: 'owners', of: (bucket) => bucket.owners.join(', ') })}
${issuesTable(summary.issues)}
${usageTable('Models', 'harness · model', summary.models, { header: 'owners', of: (bucket) => bucket.owners.join(', ') })}
${usageTable('Model use per owner', 'owner · model', summary.ownerModels)}
${usageTable('Model use per project', 'project · model', summary.projectModels)}
${bars('By day', summary.days)}
${usageTable('Time per stage', 'stage', summary.stages)}
${usageTable('Skills', 'skill', summary.skills)}`
}

// Kept as ordinary browser JavaScript: the generated file opens directly from disk, with no
// module resolver or dependency. Values enter it only through `dashboardData` above; rendered
// values leave through textContent and validated href properties, never markup strings.
const CLIENT_RUNTIME = String.raw`
(()=>{
  const byId=id=>document.getElementById(id);
  const zero=()=>({input:0,output:0,cacheRead:0,cacheWrite:0});
  const add=(into,from)=>{for(const key of Object.keys(into))into[key]+=from&&from[key]||0;return into};
  const total=t=>t.input+t.output+t.cacheRead+t.cacheWrite;
  const compact=n=>n>=1e9?(n/1e9).toFixed(1)+'G':n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(1)+'k':String(Math.round(n));
  const duration=ms=>{const minutes=Math.round(ms/60000);return minutes<60?minutes+'m':Math.floor(minutes/60)+'h '+String(minutes%60).padStart(2,'0')+'m'};
  const group=(events,keyOf)=>{
    const found=new Map();
    for(const event of events){
      const key=keyOf(event);if(key===null)continue;
      let bucket=found.get(key);
      if(!bucket){bucket={key,turns:0,tokens:zero(),durationMs:0,state:null,last:event.at,sets:{owners:new Set(),nodes:new Set(),harnesses:new Set(),models:new Set(),repos:new Set(),issues:new Set(),skills:new Set()}};found.set(key,bucket)}
      bucket.turns++;add(bucket.tokens,event.tokens);bucket.durationMs+=event.durationMs||0;
      bucket.sets.owners.add(event.owner);bucket.sets.nodes.add(event.node);bucket.sets.harnesses.add(event.harness);bucket.sets.models.add(event.model);
      if(event.repo)bucket.sets.repos.add(event.repo);if(event.issue)bucket.sets.issues.add((event.repo||'?')+'#'+event.issue);if(event.skill)bucket.sets.skills.add(event.skill);
      if(event.at>=bucket.last){bucket.last=event.at;if(event.state)bucket.state=event.state}
    }
    return Array.from(found.values(),bucket=>{for(const key of Object.keys(bucket.sets))bucket[key]=Array.from(bucket.sets[key]).sort();delete bucket.sets;return bucket})
      .sort((a,b)=>b.turns-a.turns||a.key.localeCompare(b.key));
  };
  const summarize=events=>{const tokens=zero();let durationMs=0;for(const event of events){add(tokens,event.tokens);durationMs+=event.durationMs||0}return{
    from:events[0]&&events[0].at||null,to:events.at(-1)&&events.at(-1).at||null,turns:events.length,tokens,durationMs,
    owners:group(events,event=>event.owner||'unknown'),nodes:group(events,event=>event.node||'unknown'),projects:group(events,event=>event.repo),
    issues:group(events,event=>event.issue?(event.repo||'?')+'#'+event.issue:null),models:group(events,event=>event.harness+' · '+event.model),
    skills:group(events,event=>event.skill),days:group(events,event=>event.at.slice(0,10)).sort((a,b)=>a.key.localeCompare(b.key)),stages:group(events,event=>event.state),
    ownerModels:group(events,event=>event.owner+' · '+event.model),projectModels:group(events,event=>event.repo?event.repo+' · '+event.model:null)
  }};
  const element=(tag,text)=>{const value=document.createElement(tag);if(text!==undefined)value.textContent=String(text);return value};
  const makeTable=(caption,headers,rows)=>{const section=element('section');section.append(element('h2',caption));if(!rows.length){const empty=element('p','nothing collected yet');empty.className='empty';section.append(empty);return section}
    const table=element('table'),thead=element('thead'),headRow=element('tr'),tbody=element('tbody');
    for(const header of headers)headRow.append(element('th',header));thead.append(headRow);
    for(const values of rows){const tr=element('tr');values.forEach((value,index)=>{const cell=element(index?'td':'th');if(!index)cell.scope='row';if(value instanceof Node){if(value.dataset.bar)cell.className='bar';cell.append(value)}else cell.textContent=String(value);tr.append(cell)});tbody.append(tr)}
    table.append(thead,tbody);section.append(table);return section};
  const tokenValues=bucket=>[compact(bucket.tokens.input),compact(bucket.tokens.output),compact(bucket.tokens.cacheRead),compact(bucket.tokens.cacheWrite),compact(total(bucket.tokens))];
  const usage=(caption,first,buckets,extraHeader,extra)=>makeTable(caption,[first,'turns','in','out','cache read','cache write','total','time'].concat(extraHeader?[extraHeader]:[]),buckets.map(bucket=>[bucket.key,bucket.turns].concat(tokenValues(bucket),[duration(bucket.durationMs)],extra?[extra(bucket)]:[])));
  const issues=buckets=>makeTable('Issues',['issue','state','owner','harness','model','turns','tokens','time','last'],buckets.map(bucket=>{let label=bucket.key;const match=/^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(bucket.key);if(match){label=element('a',bucket.key);label.href='https://github.com/'+match[1]+'/issues/'+match[2]}return[label,bucket.state||'—',bucket.owners.join(', '),bucket.harnesses.join(', '),bucket.models.join(', '),bucket.turns,compact(total(bucket.tokens)),duration(bucket.durationMs),bucket.last.slice(0,10)]}));
  const days=buckets=>{const peak=Math.max(1,...buckets.map(bucket=>total(bucket.tokens)));return makeTable('By day',['day','tokens','turns','total','time'],buckets.map(bucket=>{const bar=element('span');bar.dataset.bar='true';bar.style.width=Math.max(1,Math.round(total(bucket.tokens)/peak*100))+'%';return[bucket.key,bar,bucket.turns,compact(total(bucket.tokens)),duration(bucket.durationMs)]}))};
  const render=()=>{
    const filters={repo:byId('filter-repo').value,owner:byId('filter-owner').value,node:byId('filter-node').value,from:byId('filter-from').value,to:byId('filter-to').value};
    const events=dashboardEvents.filter(event=>{const day=event.at.slice(0,10);return(!filters.repo||event.repo===filters.repo)&&(!filters.owner||event.owner===filters.owner)&&(!filters.node||event.node===filters.node)&&(!filters.from||day>=filters.from)&&(!filters.to||day<=filters.to)});
    const summary=summarize(events),headline=byId('dashboard-summary');
    headline.textContent=summary.turns?summary.turns+' turns · '+compact(total(summary.tokens))+' tokens · '+duration(summary.durationMs)+' · '+summary.from.slice(0,10)+' to '+summary.to.slice(0,10)+' · '+summary.owners.length+' owners · '+summary.nodes.length+' nodes · '+summary.projects.length+' projects':'no turns collected yet';
    byId('dashboard-sections').replaceChildren(
      usage('Owners','owner',summary.owners,'projects',bucket=>bucket.repos.join(', ')),usage('Nodes','node',summary.nodes,'projects',bucket=>bucket.repos.join(', ')),
      usage('Projects','project',summary.projects,'owners',bucket=>bucket.owners.join(', ')),issues(summary.issues),usage('Models','harness · model',summary.models,'owners',bucket=>bucket.owners.join(', ')),
      usage('Model use per owner','owner · model',summary.ownerModels),usage('Model use per project','project · model',summary.projectModels),days(summary.days),
      usage('Time per stage','stage',summary.stages),usage('Skills','skill',summary.skills));
  };
  for(const id of ['filter-repo','filter-owner','filter-node','filter-from','filter-to'])byId(id).addEventListener('change',render);
})();`

export function renderDashboard(events: StatsEvent[], { generatedAt = new Date().toISOString() } = {}): string {
  const summary: Summary = summarize(events)
  const embedded = dashboardEvents(events)
  const head = summary.turns
    ? `${summary.turns} turns · ${compact(totalTokens(summary.tokens))} tokens · ${duration(summary.durationMs)} · ${summary.from?.slice(0, 10)} to ${summary.to?.slice(0, 10)} · ${summary.owners.length} owners · ${summary.nodes.length} nodes · ${summary.projects.length} projects`
    : 'no turns collected yet'
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>VegaFactory stats</title><style>${STYLE}</style></head>
<body>
<h1>VegaFactory stats</h1>
<p class="sub" id="dashboard-summary">${escape(head)}</p>
${controls(embedded)}
<div id="dashboard-sections">${sections(summary)}</div>
<script>const dashboardEvents=${dashboardData(events)};${CLIENT_RUNTIME}</script>
<footer>Generated ${escape(generatedAt)} by vegafactory dashboard — counts only, no prompts or code.</footer>
</body></html>
`
}

export function dashboardUsage(): string {
  return `Usage: vegafactory dashboard [options]

Writes one self-contained HTML file from the collected and pushed turns — owners, nodes,
projects, issues, models, days and stages. No server and no network.

Options:
  --out PATH        where to write it (default ${statsHtmlPath()})
  --since 7d        only turns since then (7d, 12h, 30m or a date)
  --local           only this node's own turns, not the control room
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
  // Only when the page is going to its default place, which is inside the home this product owns.
  // A `--out` somewhere else is the caller's directory and takes the caller's mode.
  if (target === statsHtmlPath({ home })) makeFactoryHome({ home })
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

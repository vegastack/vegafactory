// One profile out of three layers of Markdown: the org's `org.md`, its `groups/<g>/group.md`, and
// the repo's `.vegastack/dev.md`. Nearest wins, so a repo that answers nothing still resolves to a
// complete profile. The one exception is a line `org.md` marks `# locked`: no later layer may
// change it. Resolution is pure — the caller reads the files and hands over three strings.

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const forbidden = new Set(['constructor', 'prototype'])
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const unique = values => [...new Set(values)]
const stages = ['intake', 'plan', 'implement', 'review', 'status', 'chronicle']
const enums = {
  stats: ['on', 'off'], 'stats-people': ['on', 'off'], 'stats-export': ['off', 'non-attributed', 'attributed'],
  tests: ['required', 'logic-only', 'best-effort', 'none'], chronicle: ['on', 'off'],
  changelog: ['changesets', 'keep-a-changelog', 'pubspec+changelog', 'none'],
  merge: ['rebase', 'squash', 'merge'], dispatch: ['off', 'local'], 'provider-mode': ['subscription-only'],
  learning: ['normal-work', 'off'], 'learning-adoption': ['scoped-reversible', 'propose-only'],
}
const known = new Set([...Object.keys(enums), 'gates', 'operators', 'harness-policy', 'branch', 'labels',
  'workflow-labels', 'control-room', 'stats-local-retention-days', 'stats-shared-retention-months', 'stats-spool-warning-mib'])
const loginPattern = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i

/** @typedef {'needsOperator'|'needsPlan'|'ready'|'working'|'forOperator'} State */
/** @typedef {Record<State,string>} LabelMap */
/** @type {LabelMap} */
export const DEFAULT_LABELS = Object.freeze({ needsOperator: 'waiting-on-operator', needsPlan: 'planning', ready: 'queued', working: 'in-progress', forOperator: 'ready-to-ship' })
export const WORKFLOW_STATES = Object.freeze(Object.keys(DEFAULT_LABELS))

// The plain `labels:` list may reorder and add scope labels, but renaming a state there is
// ambiguous: the explicit five-key `workflow-labels` mapping is the only way to say which is which.
/** @param {unknown} value @returns {LabelMap} */
export function resolveLabels(value) {
  if (value === undefined) return { ...DEFAULT_LABELS }
  if (typeof value === 'string' || Array.isArray(value)) {
    const names = typeof value === 'string' ? value.trim().split(/[,\s]+/) : value
    if (!names.length || names.some(name => typeof name !== 'string' || !name.trim())
      || new Set(names).size !== names.length || !Object.values(DEFAULT_LABELS).every(name => names.includes(name))) {
      throw new Error('ambiguous labels: name the five states in workflow-labels; no labels changed')
    }
    return { ...DEFAULT_LABELS }
  }
  if (!object(value) || Object.keys(value).length !== WORKFLOW_STATES.length
    || !WORKFLOW_STATES.every(key => Object.hasOwn(value, key) && typeof value[key] === 'string' && value[key].trim() === value[key]
      && value[key].length > 0 && value[key].length <= 50 && !/[\x00-\x1f\x7f]/.test(value[key]))
    || new Set(Object.values(value).map(name => name.toLowerCase())).size !== WORKFLOW_STATES.length) {
    throw new Error('workflow-labels requires exactly five semantic keys with distinct nonempty label names')
  }
  return Object.fromEntries(WORKFLOW_STATES.map(key => [key, value[key]]))
}

/** @param {string[]} labels @param {LabelMap} map @returns {{state:State|null,blocks:string[]}} */
export function resolveState(labels, map) {
  if (map === undefined || map === null) return { state: null, blocks: ['workflow label map unavailable'] }
  try { map = resolveLabels(map) } catch (error) { return { state: null, blocks: [error.message] } }
  if (!Array.isArray(labels) || labels.some(label => typeof label !== 'string')) return { state: null, blocks: ['unreadable issue labels'] }
  const states = WORKFLOW_STATES.filter(key => labels.includes(map[key]))
  return states.length === 1 ? { state: states[0], blocks: [] }
    : { state: null, blocks: [states.length ? 'conflicting state labels: ' + states.map(key => map[key]).join(', ') : 'no known workflow state label'] }
}

function labelsFrom(values) {
  const map = resolveLabels(values['workflow-labels'] ?? values.labels)
  if (values['workflow-labels'] !== undefined && values.labels !== undefined && !same(map, resolveLabels(values.labels))) throw new Error('labels and workflow-labels disagree')
  return map
}

// Just the label contract, for read-only board and status tooling.
export function readWorkflowLabels(text = '') {
  const layer = parsePolicy(text)
  if (layer.blocks.length) throw new Error(layer.blocks.join('; '))
  return labelsFrom(layer.values)
}

// Reasoning-effort levels each harness takes, read off `claude --help` and the Codex binary's own
// enum on 18-09-2026. A level neither accepts is a typo that would fail at run time instead.
const efforts = { claude: ['low', 'medium', 'high', 'xhigh', 'max'], codex: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] }

// `<harness> <model> <effort>`, where the model `default` means the tool's own default — nothing
// pinned, because a pinned id the account cannot use fails the whole run. A pinned id stays legal.
export function parseStage(value) {
  const [harness, model, effort, ...rest] = value.trim().split(/\s+/)
  if (rest.length || !harness || !model || !effort) return null
  if (!efforts[harness]?.includes(effort)) return null
  return { harness, model: model === 'default' ? null : model, effort }
}

function knobValue(key, text) {
  if (enums[key]) return enums[key].includes(text) ? text : undefined
  if (key === 'gates') return /^[123]$/.test(text) ? Number(text) : undefined
  if (key === 'operators') return text && text.split(/[,\s]+/).every(login => loginPattern.test(login)) ? unique(text.toLowerCase().split(/[,\s]+/)) : undefined
  if (key.startsWith('stats-')) return /^[1-9]\d*$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : undefined
  if (key === 'control-room') return text === 'none' || /^[a-z\d][a-z\d-]*\/[a-z\d_.-]+(?:#[a-z\d-]+)?(?:@[a-f\d]{7,40})?$/i.test(text) ? text : undefined
  if (key === 'branch') return text && /^[a-z\d_/-]+$/i.test(text.replace(/<(?:type|issue|slug)>/g, 'value')) ? text : undefined
  if (key === 'labels') return text && text.split(/[,\s]+/).every(label => /^[\w-]+$/.test(label)) ? text.split(/[,\s]+/) : undefined
  if (key === 'workflow-labels') {
    try { return resolveLabels(JSON.parse(text)) } catch { return undefined }
  }
  return undefined
}

/**
 * One layer of Markdown. A knob is a line at column zero, `key: value`, with an optional trailing
 * `# comment`; a comment beginning `locked` marks the line, which only `org.md` may do. Fenced and
 * indented lines are prose, so an example in a code block never becomes policy, and a key nothing
 * here knows stays an inert extension rather than a refusal.
 */
export function parsePolicy(text = '', scope = 'repo') {
  const layer = { scope, values: {}, locked: [], extensions: {}, blocks: [] }
  if (typeof text !== 'string' || !['org', 'group', 'repo'].includes(scope)) {
    layer.blocks.push('policy layer needs Markdown and a known scope'); return layer
  }
  const seen = new Set()
  let fence = null
  for (const line of text.split(/\r?\n/)) {
    const boundary = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (boundary) {
      if (!fence) fence = boundary[1]
      else if (boundary[1][0] === fence[0] && boundary[1].length >= fence.length && !boundary[2].trim()) fence = null
      continue
    }
    if (fence) continue
    const match = /^([a-z][a-z0-9-]*):[ \t]*(.*)$/.exec(line)
    if (!match) continue
    const key = match[1], comment = /\s+#\s*(.*)$/.exec(match[2])
    const value = (comment ? match[2].slice(0, comment.index) : match[2]).trim()
    const locked = /^locked\b/.test(comment?.[1] ?? '')
    // The `review:` knob is retired — reviews always run cross-tool — so an old profile's line is
    // ignored. `review <harness> <model> <effort>` is still that stage's harness-policy line.
    if (key === 'review' && !parseStage(value)) continue
    const stageLine = stages.includes(key) && !enums[key]?.includes(value)
    if (forbidden.has(key)) { layer.blocks.push(`unusable policy key: ${key}`); continue }
    if (!known.has(key) && !stageLine) { layer.extensions[key] = value; continue }
    if (seen.has(key)) layer.blocks.push(`duplicate policy key: ${key}`)
    seen.add(key)
    if (locked && scope !== 'org') { layer.blocks.push(`only org.md can lock a line: ${key}`); continue }
    if (key === 'harness-policy' || stageLine) {
      layer.values.stages ??= {}
      for (const segment of key === 'harness-policy' ? value.split('·') : [key + ' ' + value]) {
        const parts = segment.trim().split(/\s+/), name = parts.shift(), parsed = parseStage(parts.join(' '))
        if (!stages.includes(name) || !parsed || Object.hasOwn(layer.values.stages, name)) layer.blocks.push(`invalid or duplicate harness stage: ${name}`)
        else layer.values.stages[name] = parsed
      }
      if (locked) layer.locked.push('harness-policy')
      continue
    }
    const parsed = knobValue(key, value)
    if (parsed === undefined) layer.blocks.push(`invalid ${key} value`)
    else { layer.values[key] = parsed; if (locked) layer.locked.push(key) }
  }
  return layer
}

/**
 * @param {{org?:string,group?:string,repo?:string}} input
 * @returns {{ok:boolean,values:Record<string,any>,locked:string[],sources:Record<string,string>,blocks:string[]}}
 */
export function resolvePolicy({ org = '', group = '', repo = '' } = {}) {
  const layers = [parsePolicy(org, 'org'), parsePolicy(group, 'group'), parsePolicy(repo, 'repo')]
  const blocks = layers.flatMap(layer => layer.blocks.map(block => layer.scope + ': ' + block))
  const locked = new Set(layers[0].locked)
  const values = { stats: 'on', 'stats-people': 'off', dispatch: 'off', stages: {} }
  const sources = {}
  const refuse = (scope, key) => blocks.push(`${scope}: ${key} is locked in org.md and cannot be overridden`)
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer.values)) {
      // `dispatch: local` is a local opt-in, never something an org or a group turns on for a repo.
      if (key === 'dispatch' && layer.scope !== 'repo') continue
      if (key === 'stages') {
        for (const [name, stage] of Object.entries(value)) {
          if (layer.scope !== 'org' && locked.has('harness-policy') && !same(stage, values.stages[name])) { refuse(layer.scope, 'harness-policy'); continue }
          values.stages[name] = stage; sources['stages.' + name] = layer.scope
        }
        continue
      }
      if (layer.scope !== 'org' && locked.has(key) && !same(value, values[key])) { refuse(layer.scope, key); continue }
      values[key] = value; sources[key] = layer.scope
    }
  }
  try { values['workflow-labels'] = labelsFrom(values) } catch (error) { blocks.push(error.message) }
  return { ok: blocks.length === 0, values, locked: [...locked], sources, blocks }
}

// `control-room: <org>/<repo>#<group>@<sha7>` — group and sha are both optional.
export function parseControlRoomReference(text) {
  const value = parsePolicy(text, 'repo').values['control-room']
  if (!value || value === 'none') return null
  const [room, suffix = ''] = value.split('#')
  const [group, sha] = suffix.split('@')
  return { org: room.split('/')[0], repo: room, group: group || null, sha: sha || null }
}

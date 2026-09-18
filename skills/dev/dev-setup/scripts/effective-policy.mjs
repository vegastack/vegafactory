import { createHash } from 'node:crypto'
// One profile out of three layers of Markdown: the org's `org.md`, its `groups/<g>/group.md`, and
// the repo's `.vegastack/dev.md`. Nearest wins, so a repo that answers nothing still resolves to a
// complete profile. The one exception is a line `org.md` marks `# locked`: no later layer may
// change it. Resolution is pure — the caller reads the files and hands over three strings.

const own = (value, key) => Object.hasOwn(value, key)
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const forbidden = new Set(['constructor', 'prototype'])
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const unique = values => [...new Set(values)]
const stages = ['intake', 'plan', 'implement', 'review', 'status', 'chronicle']
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted)
  if (!object(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]))
}
export const policyHash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(sorted(value))).digest('hex')

// JSON.parse accepts duplicate object keys. Authority cannot choose the last self-grant, so
// validate the already syntax-checked token stream before accepting the parsed document.
function policyJson(text) {
  const parsed = JSON.parse(text)
  const tokens = text.match(/"(?:\\.|[^"\\])*"|[{}\[\],:]|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g) ?? []
  let at = 0
  function value(depth = 0) {
    if (depth > 64) throw new Error('policy nesting exceeds 64 levels')
    const token = tokens[at++]
    if (token === '{') {
      const keys = new Set()
      while (tokens[at] !== '}') {
        const key = JSON.parse(tokens[at++])
        if (keys.has(key) || forbidden.has(key)) throw new Error('duplicate or prototype policy key')
        keys.add(key); at++; value(depth + 1)
        if (tokens[at] === ',') at++
      }
      at++
    } else if (token === '[') {
      while (tokens[at] !== ']') { value(depth + 1); if (tokens[at] === ',') at++ }
      at++
    }
  }
  value()
  return parsed
}

const enums = {
  stats: ['on', 'off'], 'stats-people': ['on', 'off'], 'stats-export': ['off', 'non-attributed', 'attributed'],
  tests: ['required', 'logic-only', 'best-effort', 'none'], chronicle: ['on', 'off'],
  changelog: ['changesets', 'keep-a-changelog', 'pubspec+changelog', 'none'],
  merge: ['rebase', 'squash', 'merge'], dispatch: ['off', 'local'], 'provider-mode': ['subscription-only'],
  learning: ['normal-work', 'off'], 'learning-adoption': ['scoped-reversible', 'propose-only'],
}
const known = new Set([...Object.keys(enums), 'operators', 'harness-policy', 'branch', 'labels',
  'control-room', 'stats-local-retention-days', 'stats-shared-retention-months', 'stats-spool-warning-mib'])
const loginPattern = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i

// The five state labels, in order, and the rest of the set dev-setup creates. These are the
// names themselves — there is no second semantic vocabulary to keep in step, and no knob that
// renames them, because every skill, script and board option spells them the same way.
/** @typedef {'waiting-on-operator'|'planning'|'queued'|'in-progress'|'ready-to-ship'} State */
export const WORKFLOW_STATES = Object.freeze(['waiting-on-operator', 'planning', 'queued', 'in-progress', 'ready-to-ship'])
export const WORKFLOW_LABELS = Object.freeze([...WORKFLOW_STATES, 'small', 'medium', 'large', 'risky', 'epic', 'research'])

/** @param {string[]} labels @returns {{state:State|null,blocks:string[]}} */
export function resolveState(labels) {
  if (!Array.isArray(labels) || labels.some(label => typeof label !== 'string')) return { state: null, blocks: ['unreadable issue labels'] }
  const states = WORKFLOW_STATES.filter(state => labels.includes(state))
  return states.length === 1 ? { state: states[0], blocks: [] }
    : { state: null, blocks: [states.length ? 'conflicting state labels: ' + states.join(', ') : 'no known workflow state label'] }
}

// Resolve just the local label contract for read-only profile tooling. Runtime admission
// supplies the complete configured policy separately; this helper grants no authority.
export function readWorkflowStates(text = '') {
  const layer = parsePolicy(text)
  if (layer.blocks.length) throw new Error(layer.blocks.join('; '))
  return workflowStatesFromValues(layer.values)
}
function workflowStatesFromValues(values) {
  if (values.labels === undefined) return [...WORKFLOW_STATES]
  const names = String(values.labels).trim().split(/[,\s]+/).filter(Boolean)
  if (new Set(names).size !== names.length) throw new Error('labels: repeats a name')
  const stale = names.filter(name => own(SUPERSEDED, name))
  if (stale.length) throw new Error('labels: still carries superseded names (' + stale.join(', ') + '); run the dev-setup label migration, which maps each to its replacement')
  if (!WORKFLOW_STATES.every(state => names.includes(state))) throw new Error('labels: is missing a state label; the set is ' + WORKFLOW_STATES.join(' '))
  return [...WORKFLOW_STATES]
}

export const labelsDigest = labels => policyHash([...new Set(labels)].sort())

// The one old-to-new map. Every superseded name has a replacement, so a migration never drops
// an issue's state or size on the floor — it moves it. The map is also what the resolver reads
// to refuse a profile still carrying an old name.
const SUPERSEDED = Object.freeze({ // the superseded names and what each becomes
  'needs-operator': 'waiting-on-operator', 'needs-plan': 'planning', ready: 'queued',
  working: 'in-progress', 'for-operator': 'ready-to-ship',
  'quick-build': 'small', 'deep-build': 'medium',
})
// Keys a profile may no longer carry at all, with the sentence that says what to do instead.
const RETIRED_KEYS = Object.freeze({
  'workflow-labels': 'workflow-labels was removed with the label-renaming knob; delete the line and run the dev-setup label migration',
  gates: 'gates was removed; the operator gives two words per issue, an ack and "ship it"',
})

// The five semantic keys the retired `workflow-labels` knob used, and the fixed name each one
// stands for now. A repo that renamed its labels through that knob calls them anything at all,
// so the knob's own line is the only place its names can be read from — once, as migration
// input, and never written back.
const RENAMED_STATES = Object.freeze({ // the superseded semantic keys and what each becomes
  needsOperator: 'waiting-on-operator', needsPlan: 'planning', ready: 'queued',
  working: 'in-progress', forOperator: 'ready-to-ship',
})

/**
 * The old-to-new steps for one repo: the former default names, plus whatever the profile's
 * `workflow-labels:` line called them. Reading that line is the one-time migration input a repo
 * on custom names needs — without it its labels are invisible to the migration while its
 * profile is blocked, which is the worst of both.
 */
export function migrationMap(profileText = '') {
  const map = { ...SUPERSEDED }
  const line = /^workflow-labels:\s*(\{.*?\})\s*(?:#.*)?$/m.exec(String(profileText ?? '')) // migration input only
  if (!line) return map
  let configured
  try { configured = policyJson(line[1]) } catch { return map }
  if (!object(configured)) return map
  for (const [key, to] of Object.entries(RENAMED_STATES)) {
    const from = configured[key]
    // A configured name equal to its own replacement is already migrated. A name that is some
    // OTHER state's fixed name is not skipped — that is exactly the collision the ordering
    // below exists to survive, and skipping it merged two states under one label.
    if (typeof from !== 'string' || !from.trim() || from === to) continue
    map[from] = to
  }
  return map
}

/**
 * Orders the moves so each state lands on its own name, and says when it cannot.
 *
 * A legacy mapping may call one state by another state's fixed name — `needsOperator: "queued"`
 * beside `ready: "go"`. Running the steps in declaration order renames `go` onto the `queued`
 * that still holds waiting-on-operator issues, merging two states under one label. So a step
 * whose target is still occupied by a label that will itself move waits for that move; a cycle
 * that leaves nothing free is broken by parking one label under a temporary name first.
 *
 * @param {Array<[string,string]>} steps @param {Set<string>} present
 * @returns {{rename: Array<{from,to}>, transfer: Array<{from,to}>, remove: string[], blocks: string[]}}
 */
export function orderMoves(steps, present) {
  const pending = new Map(steps.filter(([from]) => present.has(from)))
  const rename = []
  const transfer = []
  const remove = []
  const blocks = []
  // Each pass either moves something or parks one label, so the loop shrinks `pending` every
  // time; the counter is a backstop, not the logic.
  for (let guard = pending.size * 2 + 2; pending.size && guard > 0; guard--) {
    let moved = false
    for (const [from, to] of [...pending]) {
      if (pending.has(to) && to !== from) continue
      if (present.has(to)) {
        transfer.push({ from, to })
        remove.push(from)
      } else {
        rename.push({ from, to })
        present.add(to)
      }
      present.delete(from)
      pending.delete(from)
      moved = true
    }
    if (moved || !pending.size) continue
    // Nothing is free: every remaining target is occupied by another mover. Park the first one
    // under a name no state can claim, which frees its target for the state that wants it.
    const [from, to] = [...pending][0]
    const parked = from + '-migrating'
    if (present.has(parked)) { blocks.push('cannot free ' + to + ': ' + parked + ' is taken'); break }
    rename.push({ from, to: parked })
    present.delete(from); present.add(parked)
    pending.delete(from); pending.set(parked, to)
  }
  for (const [from, to] of pending) blocks.push('cannot move ' + from + ' to ' + to + ' without merging two states')
  return { rename, transfer, remove, blocks }
}

/**
 * The migration dev-setup shows before it touches an existing repo. Every step preserves what
 * the old label carried: a rename keeps the issues and their history, a transfer copies the new
 * label onto each issue that has the old one before the old one is deleted, and the board's
 * Status options move with their cards. Unrelated labels are never touched. Presentation only —
 * `writes: false` — and nothing here records an old name anywhere but the repo it read it from.
 *
 * @param {{labels?: string[], issues?: Array<{number: number, labels: string[]}>,
 *          boardStatus?: string[], boardItems?: Array<{id?: string|number, status: string}>,
 *          profile?: string}} repo
 */
export function planLabelMigration(repo = {}) {
  const labels = (Array.isArray(repo.labels) ? repo.labels : []).filter(name => typeof name === 'string')
  const issues = (Array.isArray(repo.issues) ? repo.issues : []).filter(object)
  const boardItems = (Array.isArray(repo.boardItems) ? repo.boardItems : []).filter(object)
  const boardStatus = (Array.isArray(repo.boardStatus) ? repo.boardStatus : [])
    .filter(name => typeof name === 'string')
  const steps = Object.entries(migrationMap(repo.profile))
  const superseded = new Set(steps.map(([from]) => from))

  // The replacement is free → rename in place, which keeps every issue's label and its history.
  // It is already taken by a label that is not itself moving → copy it onto each issue that
  // carries the old one, then drop the old. `orderMoves` decides which, and in what order.
  const present = new Set(labels)
  const moves = orderMoves(steps, present)
  const rename = moves.rename
  const remove = moves.remove
  const transfer = moves.transfer.map(step => ({
    ...step,
    issues: issues.filter(issue => (issue.labels ?? []).includes(step.from)).map(issue => issue.number),
  }))

  // The board moves the same way, and for the same reason: deleting an option takes its cards
  // with it. A half-migrated board already carrying both names is the case a rename cannot fix —
  // the cards on the old option are moved to the new one, then the stale option is removed.
  const boardPresent = new Set(boardStatus)
  const boardMoves = orderMoves(steps.filter(([, to]) => WORKFLOW_STATES.includes(to)), boardPresent)
  const boardRename = boardMoves.rename
  const boardRemove = boardMoves.remove
  const boardTransfer = boardMoves.transfer.map(step => ({
    ...step,
    items: boardItems.filter(item => item.status === step.from).map(item => item.id ?? null),
  }))

  // A migration that cannot land every state on its own name does not run, and the knob that
  // still tells the states apart is not deleted — the collision is named instead.
  const blocks = [...moves.blocks, ...boardMoves.blocks]

  return {
    blocks,
    rename,
    transfer,
    create: WORKFLOW_LABELS.filter(name => !present.has(name)),
    remove,
    board: {
      rename: boardRename,
      transfer: boardTransfer,
      create: WORKFLOW_STATES.filter(name => boardStatus.length && !boardPresent.has(name)),
      remove: boardRemove,
    },
    // The migration's last step, once nothing depends on the names the knob holds — and never
    // while a collision is unresolved, because that line is the only record of which is which.
    dropKnob: blocks.length === 0 && /^workflow-labels:/m.test(String(repo.profile ?? '')), // migration input only
    keep: labels.filter(name => !superseded.has(name)),
    writes: false,
  }
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
  if (key === 'operators') return text && text.split(/[,\s]+/).every(login => loginPattern.test(login)) ? unique(text.toLowerCase().split(/[,\s]+/)) : undefined
  if (key.startsWith('stats-')) return /^[1-9]\d*$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : undefined
  if (key === 'control-room') return text === 'none' || /^[a-z\d][a-z\d-]*\/[a-z\d_.-]+(?:#[a-z\d-]+)?(?:@[a-f\d]{7,40})?$/i.test(text) ? text : undefined
  if (key === 'branch') return text && /^[a-z\d_/-]+$/i.test(text.replace(/<(?:type|issue|slug)>/g, 'value')) ? text : undefined
  if (key === 'labels') return text && text.split(/[,\s]+/).every(label => /^[\w-]+$/.test(label)) ? text.split(/[,\s]+/) : undefined
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
    // Every other retired key blocks rather than falling through to extensions: an unknown key
    // is inert, and inert is how a profile keeps a removed mechanism without anyone noticing.
    if (own(RETIRED_KEYS, key)) { layer.blocks.push(RETIRED_KEYS[key]); continue }
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
      // The lock covers all six stages at once rather than the stages one line happens to name:
      // a stage-by-stage lock reads as "these five are yours" while silently holding the sixth,
      // and a partial lock would leave a repo unable to supply the stages the org never chose.
      // So an org that locks the line must answer the whole line.
      if (locked && key !== 'harness-policy') layer.blocks.push('lock the whole harness-policy line, not one stage')
      else if (locked && !stages.every(name => Object.hasOwn(layer.values.stages, name))) layer.blocks.push('a locked harness-policy must name every stage')
      else if (locked) layer.locked.push('harness-policy')
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
  try { workflowStatesFromValues(values) } catch (error) { blocks.push(error.message) }
  return { ok: blocks.length === 0, values, locked: [...locked], sources, blocks }
}

/**
 * `control-room: <org>/<repo>#<group>@<sha7>` — group and sha are both optional.
 *
 * Throws when the line itself is unreadable. A bad value would otherwise leave the knob unset and
 * read as "this repo names no control room", and a duplicate line would quietly pick the last one:
 * both are how a profile ends up pointed at the wrong room, or at none, without anyone saying so.
 * A refusal elsewhere in the profile is not this function's business and does not throw here.
 */
export function parseControlRoomReference(text) {
  const layer = parsePolicy(text, 'repo')
  const blocks = layer.blocks.filter(block => block.includes('control-room'))
  if (blocks.length) throw new Error(blocks.join('; '))
  const value = layer.values['control-room']
  if (!value || value === 'none') return null
  const [room, suffix = ''] = value.split('#')
  const [group, sha] = suffix.split('@')
  return { org: room.split('/')[0], repo: room, group: group || null, sha: sha || null }
}

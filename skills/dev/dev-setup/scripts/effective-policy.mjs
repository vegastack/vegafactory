// Canonical, dependency-free policy and authority resolver. Resolution is pure; the explicit
// snapshot read adapters at the end read verified Git objects and never write or fetch.
// Markdown is authored state. Callers supply verified identity/registry/snapshot context, never
// a login claimed in request text. This is a cooperative trusted-host boundary, not authentication.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

const own = (value, key) => Object.hasOwn(value, key)
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const forbidden = new Set(['__proto__', 'prototype', 'constructor'])
const stages = ['intake', 'plan', 'implement', 'review', 'status', 'chronicle']
const enums = {
  stats: ['on', 'off', 'inherit'], 'stats-people': ['on', 'off'], 'stats-override': ['allowed', 'locked'],
  review: ['subagent', 'cross-agent-risky', 'cross-agent'], tests: ['required', 'logic-only', 'best-effort', 'none'],
  changelog: ['changesets', 'keep-a-changelog', 'pubspec+changelog', 'none'], chronicle: ['on', 'off'],
  merge: ['rebase', 'squash', 'merge'], dispatch: ['off', 'local'], 'provider-mode': ['subscription-only'],
  learning: ['normal-work', 'off'], 'learning-adoption': ['scoped-reversible', 'propose-only'],
  'stats-export': ['off', 'non-attributed', 'attributed'],
}
const lockable = new Set(['stats', 'stats-export', 'gates', 'tests', 'review', 'provider-mode', 'learning', 'learning-adoption'])
const ordinary = new Set([...Object.keys(enums), 'operators', 'harness-policy', 'gates', 'branch', 'labels', 'control-room', 'sync-max-age', 'workflow-labels', 'stats-local-retention-days', 'stats-shared-retention-months', 'stats-spool-warning-mib'])
const loginPattern = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i
const groupPattern = /^[a-z0-9][a-z0-9-]{0,63}$/
const repoPattern = /^[a-z\d][a-z\d-]*\/[a-z\d_.-]+$/i
const shaPattern = /^[a-f0-9]{40}$/
const digestPattern = /^[a-f0-9]{64}$/
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted)
  if (!object(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]))
}
export const policyHash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(sorted(value))).digest('hex')
function safeTree(value) {
  if (!value || typeof value !== 'object') return true
  return Object.entries(value).every(([key, child]) => !forbidden.has(key) && safeTree(child))
}
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b))
const strings = (value, pattern) => Array.isArray(value) && value.every(item => typeof item === 'string' && pattern.test(item) && !forbidden.has(item))
const unique = values => [...new Set(values)]

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

function parseStage(value) {
  const parts = value.trim().split(/\s+/)
  return parts.length === 3 && ['claude', 'codex'].includes(parts[0]) && parts.every(Boolean)
    ? { harness: parts[0], model: parts[1], effort: parts[2] } : null
}
function knobValue(key, text) {
  if (enums[key]) return enums[key].includes(text) ? text : undefined
  if (key === 'gates') return /^[123]$/.test(text) ? Number(text) : undefined
  if (key === 'operators') return text && strings(text.split(/[,\s]+/), loginPattern) ? unique(text.toLowerCase().split(/[,\s]+/)) : undefined
  if (key === 'sync-max-age') {
    const m = /^(\d+)([smh])$/.exec(text)
    const seconds = m ? Number(m[1]) * ({ s: 1, m: 60, h: 3600 }[m[2]]) : 0
    return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined
  }
  if (key.startsWith('stats-') && !enums[key]) return /^[1-9]\d*$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : undefined
  if (key === 'control-room') return text === 'none' || /^[a-z\d][a-z\d-]*\/[a-z\d_.-]+(?:#[a-z\d-]+)?(?:@[a-f\d]{7,40})?$/i.test(text) ? text : undefined
  if (key === 'branch') return text && /^[a-z\d_/-]+$/i.test(text.replace(/<(?:type|issue|slug)>/g, 'value')) ? text : undefined
  if (key === 'labels') return text && text.split(/\s+/).every(label => /^[\w-]+$/.test(label)) ? text.split(/\s+/) : undefined
  if (key === 'workflow-labels') {
    try { const parsed = JSON.parse(text); return object(parsed) && safeTree(parsed) && Object.values(parsed).every(v => typeof v === 'string' && v.trim()) ? parsed : undefined } catch { return undefined }
  }
  return undefined
}

export function parsePolicy(text = '', scope = 'repo') {
  const layer = { scope, text, schemaVersion: 1, values: {}, extensions: {}, authority: null, blocks: [], lines: [] }
  if (typeof text !== 'string' || !['org', 'group', 'repo'].includes(scope)) {
    layer.blocks.push('policy layer needs Markdown and a known scope'); return layer
  }
  const seen = new Set()
  let fence = null, policyLines = null
  for (const line of text.split(/\r?\n/)) {
    const boundary = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (boundary) {
      if (!fence) { fence = boundary[1]; policyLines = boundary[2].trim() === 'vsk-policy' ? [] : null }
      else if (boundary[1][0] === fence[0] && boundary[1].length >= fence.length && !boundary[2].trim()) {
        if (policyLines) {
          if (layer.authority) layer.blocks.push('duplicate vsk-policy block')
          try {
            const parsed = policyJson(policyLines.join('\n'))
            if (!object(parsed) || !safeTree(parsed) || parsed.schemaVersion !== 2) layer.blocks.push('invalid vsk-policy schema or prototype key')
            else if (scope !== 'org') layer.blocks.push('authority blocks belong only to the organization')
            else layer.authority = parsed
          } catch { layer.blocks.push('malformed vsk-policy JSON') }
        }
        fence = null; policyLines = null
      }
      continue
    }
    if (fence) { if (policyLines) policyLines.push(line); continue }
    layer.lines.push(line)
    const match = /^([a-z][a-z0-9-]*):\s*(.*?)\s*$/.exec(line)
    if (!match) continue
    const key = match[1], value = match[2].replace(/\s+#.*$/, '').trim()
    if (forbidden.has(key)) { layer.blocks.push('prototype key in policy'); continue }
    const stageLine = stages.includes(key) && !enums[key]?.includes(value)
    if (key === 'policy-schema' || ordinary.has(key) || stageLine) {
      if (seen.has(key)) layer.blocks.push(`duplicate policy key: ${key}`)
      seen.add(key)
    } else { layer.extensions[key] = value; continue }
    if (key === 'policy-schema') {
      if (!['1', '2'].includes(value)) layer.blocks.push('unsupported policy-schema')
      else layer.schemaVersion = Number(value)
      continue
    }
    if (key === 'harness-policy' || stageLine) {
      layer.values.stages ??= {}
      for (const segment of key === 'harness-policy' ? value.split('·') : [key + ' ' + value]) {
        const parts = segment.trim().split(/\s+/), name = parts.shift(), parsed = parseStage(parts.join(' '))
        if (!stages.includes(name) || !parsed || own(layer.values.stages, name)) layer.blocks.push(`invalid or duplicate harness stage: ${name}`)
        else layer.values.stages[name] = parsed
      }
      continue
    }
    const parsed = knobValue(key, value)
    if (parsed === undefined) layer.blocks.push(`invalid ${key} value`)
    else if (!(key === 'stats' && parsed === 'inherit')) layer.values[key] = parsed
  }
  if (fence && policyLines) layer.blocks.push('unclosed vsk-policy block')
  return layer
}

function validateAuthority(layer, blocks) {
  const authority = layer.authority ?? {}, locked = authority.locked ?? {}, delegations = authority.delegations ?? []
  if (!object(locked) || !Array.isArray(delegations)) { blocks.push('malformed locked/delegations'); return { locked: {}, delegations: [] } }
  const validLocked = {}
  for (const [key, value] of Object.entries(locked)) {
    if (!lockable.has(key) || knobValue(key, String(value)) === undefined || value === 'inherit') blocks.push(`invalid locked key/value: ${key}`)
    else validLocked[key] = knobValue(key, String(value))
  }
  const validDelegations = []
  for (const grant of delegations) {
    if (!object(grant) || !lockable.has(grant.key) || !strings(grant.groups, groupPattern) || !strings(grant.repos, repoPattern)
      || grant.groups.length === 0 || grant.repos.length === 0 || !Array.isArray(grant.allowedValues) || !grant.allowedValues.length
      || grant.allowedValues.some(value => knobValue(grant.key, String(value)) === undefined || value === 'inherit')) blocks.push('invalid exact org delegation')
    else validDelegations.push({ ...grant, allowedValues: grant.allowedValues.map(value => knobValue(grant.key, String(value))) })
  }
  if (layer.values['stats-override'] === 'locked') {
    if (layer.values.stats === undefined) blocks.push('legacy stats lock requires an explicit org stats value')
    else if (own(validLocked, 'stats') && validLocked.stats !== layer.values.stats) blocks.push('conflicting legacy stats lock')
    else validLocked.stats = layer.values.stats
  }
  return { locked: validLocked, delegations: validDelegations }
}

/**
 * @param {{org?:string,group?:string,repo?:string,identity?:Record<string,any>,freshness?:Record<string,any>}} input
 * @returns {{ok:boolean,policy:Record<string,any>,blocks:string[]}}
 */
export function resolvePolicy({ org = '', group = '', repo = '', identity = {}, freshness = {} } = {}) {
  const layers = [parsePolicy(org, 'org'), parsePolicy(group, 'group'), parsePolicy(repo, 'repo')]
  const blocks = layers.flatMap(layer => layer.blocks.map(block => layer.scope + ': ' + block))
  const { locked, delegations } = validateAuthority(layers[0], blocks)
  const values = { dispatch: 'off', stats: 'on', 'stats-people': 'off', stages: {} }, sources = {}
  const paths = identity.paths ?? {}
  const source = layer => ({ scope: layer.scope, path: paths[layer.scope] ?? (layer.scope === 'org' ? 'org.md' : layer.scope === 'group' ? 'groups/' + (identity.group ?? 'unselected') + '/group.md' : '.vegastack/dev.md'), revision: layer.scope !== 'repo' && shaPattern.test(identity.roomSha ?? '') ? identity.roomSha : policyHash(layer.text), revisionKind: layer.scope !== 'repo' && shaPattern.test(identity.roomSha ?? '') ? 'git' : 'sha256' })
  for (const layer of layers) {
    if (layer.text.trim()) sources[`layer.${layer.scope}`] = source(layer)
    for (const [key, value] of Object.entries(layer.values)) {
      if (key === 'dispatch' && layer.scope !== 'repo') continue
      if (key === 'stages') { for (const [name, stage] of Object.entries(value)) { values.stages[name] = stage; sources['stages.' + name] = source(layer) }; continue }
      const permitted = delegations.some(grant => grant.key === key && grant.groups.includes(identity.group) && grant.repos.includes(identity.repo) && grant.allowedValues.some(allowed => same(allowed, value)))
      if (layer.scope !== 'org' && own(locked, key) && !same(value, locked[key]) && !permitted) {
        blocks.push(layer.scope + ': ' + key + ' override requires exact org delegation'); continue
      }
      if (key === 'stats-export' && value === 'attributed' && layer.scope !== 'org' && layers[0].values[key] !== 'attributed' && locked[key] !== 'attributed' && !permitted) {
        blocks.push('attributed reporting requires explicit org authorization'); continue
      }
      values[key] = value; sources[key] = source(layer)
    }
    if (layer.scope === 'org') for (const [key, value] of Object.entries(locked)) { values[key] = value; sources[key] = source(layer) }
  }
  const configured = freshness.configured === true || Boolean(values['control-room'] && values['control-room'] !== 'none')
  const now = typeof freshness.now === 'number' ? freshness.now : Date.parse(freshness.now ?? '')
  const validated = Date.parse(freshness.validatedAt ?? '')
  const maxAgeSeconds = values['sync-max-age'] ?? freshness.maxAgeSeconds ?? 1800
  const ageSeconds = Number.isFinite(now) && Number.isFinite(validated) ? (now - validated) / 1000 : null
  let state = 'local'
  if (configured) {
    state = ageSeconds === null || ageSeconds < 0 || !Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds <= 0 ? 'unavailable' : ageSeconds >= maxAgeSeconds ? 'stale' : 'fresh'
    if (!org.trim() || !shaPattern.test(identity.roomSha ?? '')) { state = 'unavailable'; blocks.push('configured organization policy or validated source identity unavailable') }
    if (state !== 'fresh') blocks.push(`mandatory policy ${state}: validated refresh required`)
  }
  const authority = layers[0].authority ?? {}
  const registry = { org: identity.org ?? String(identity.repo ?? '').split('/')[0], peopleByScope: identity.peopleByScope ?? {}, repoGroups: identity.repoGroups ?? {}, repositoryIds: identity.repositoryIds ?? {} }
  if ((authority.administration !== undefined || authority.fleet !== undefined)
    && (!loginPattern.test(registry.org) || Object.keys(registry.repoGroups).some(repo => repo.split('/')[0].toLowerCase() !== registry.org.toLowerCase()))) blocks.push('registry contains an invalid or foreign organization')
  const policy = { schemaVersion: 2, repo: identity.repo ?? null, group: identity.group ?? null, values, sources,
    locked, delegations, administration: null, fleet: null, registry,
    freshness: { configured, state, validatedAt: freshness.validatedAt ?? null, ageSeconds, maxAgeSeconds }, policyDigest: '', blocks }
  if (authority.administration !== undefined) {
    const result = resolveAdministration({ orgLayer: layers[0], peopleByScope: registry.peopleByScope, repoGroups: registry.repoGroups })
    policy.administration = result.administration; blocks.push(...result.blocks)
    sources.administration = source(layers[0])
  }
  if (authority.fleet !== undefined) {
    const result = validateFleet(authority.fleet, registry)
    policy.fleet = result.fleet; blocks.push(...result.blocks)
    sources.fleet = source(layers[0])
  }
  policy.policyDigest = policyHash({ values, sources, locked, delegations, administration: policy.administration, fleet: policy.fleet, registry })
  return { ok: blocks.length === 0, policy, blocks }
}

const capabilities = ['group.members.manage', 'group.repos.manage', 'group.defaults.manage', 'group.people.read']
function directory(peopleByScope, repoGroups) {
  const people = new Map(), groups = new Set(Object.values(repoGroups ?? {}))
  if (!object(peopleByScope) || !object(repoGroups) || !safeTree(peopleByScope) || !safeTree(repoGroups)) return { people, groups, blocks: ['invalid confirmed registry'] }
  const blocks = []
  for (const scope of Object.keys(peopleByScope)) if (scope !== 'org' && groupPattern.test(scope) && !forbidden.has(scope)) groups.add(scope)
  for (const [repo, group] of Object.entries(repoGroups)) if (!repoPattern.test(repo) || !groupPattern.test(group) || forbidden.has(group)) blocks.push('invalid repository/group registration')
  for (const [scope, rows] of Object.entries(peopleByScope)) {
    if (!Array.isArray(rows)) { blocks.push('people registry scope must contain rows'); continue }
    if (scope !== 'org' && (!groupPattern.test(scope) || forbidden.has(scope))) { blocks.push('invalid people group'); continue }
    if (scope !== 'org') groups.add(scope)
    for (const row of rows) {
      if (!object(row) || !loginPattern.test(row.login ?? '') || forbidden.has(row.login) || !strings(row.groups ?? [], groupPattern)) { blocks.push('invalid confirmed person'); continue }
      const login = row.login.toLowerCase()
      const memberships = row.groups ?? []
      if (memberships.some(group => !groups.has(group))) blocks.push(`unregistered person group: ${login}`)
      // Descriptive group rows never replace a person's independent grants or membership evidence.
      const prior = people.get(login) ?? { login, groups: [] }
      people.set(login, { login, groups: unique([...prior.groups, ...memberships, ...(scope === 'org' ? [] : [scope])]) })
    }
  }
  return { people, groups, blocks }
}

export function resolveAdministration({ orgLayer, peopleByScope = {}, repoGroups = {} } = {}) {
  const blocks = [], layer = typeof orgLayer === 'string' ? parsePolicy(orgLayer, 'org') : orgLayer
  if (!layer || layer.scope !== 'org' || layer.blocks?.length) return { ok: false, administration: null, blocks: ['administration needs a valid organization layer'] }
  const raw = layer.authority?.administration
  if (raw === undefined) return { ok: true, administration: null, blocks: [] }
  const registry = directory(peopleByScope, repoGroups)
  blocks.push(...registry.blocks)
  if (!object(raw) || !safeTree(raw) || !strings(raw.orgAdmins, loginPattern) || !raw.orgAdmins.length || !object(raw.groupAdmins) || !object(raw.groupAdminCapabilities)) {
    return { ok: false, administration: null, blocks: [...blocks, 'administration requires at least one confirmed org admin and explicit group maps'] }
  }
  const orgAdmins = unique(raw.orgAdmins.map(login => login.toLowerCase())), groupAdmins = {}, groupAdminCapabilities = {}
  for (const login of orgAdmins) if (!registry.people.has(login)) blocks.push(`unconfirmed org admin: ${login}`)
  for (const [group, logins] of Object.entries(raw.groupAdmins)) {
    if (!registry.groups.has(group) || !strings(logins, loginPattern)) { blocks.push(`invalid group admin assignment: ${group}`); continue }
    groupAdmins[group] = unique(logins.map(login => login.toLowerCase()))
    for (const login of groupAdmins[group]) if (!registry.people.has(login) || !registry.people.get(login).groups.includes(group)) blocks.push(`unconfirmed group admin membership: ${group}/${login}`)
  }
  for (const [group, grants] of Object.entries(raw.groupAdminCapabilities)) {
    if (!registry.groups.has(group) || !Array.isArray(grants) || grants.some(grant => !capabilities.includes(grant))) { blocks.push(`invalid group capability: ${group}`); continue }
    groupAdminCapabilities[group] = unique(grants)
  }
  const administration = { orgAdmins, groupAdmins, groupAdminCapabilities }
  return { ok: blocks.length === 0, administration: blocks.length ? null : administration, blocks }
}

const fleetDefaults = { pollSeconds: 120, maxRuns: 1, childConcurrent: 3, checkpoints: 'task-branch', recovery: 'verified-transfer' }
function validFleetValue(key, value) {
  if (key === 'pollSeconds') return Number.isSafeInteger(value) && value >= 30 && value <= 3600
  if (key === 'maxRuns') return Number.isSafeInteger(value) && value > 0
  if (key === 'childConcurrent') return Number.isSafeInteger(value) && value >= 1 && value <= 16
  if (key === 'checkpoints') return ['off', 'task-branch'].includes(value)
  if (key === 'recovery') return ['original-host', 'verified-transfer'].includes(value)
  return false
}
function validDefaults(value, full = false) {
  return object(value) && safeTree(value) && Object.entries(value).every(([key, entry]) => validFleetValue(key, entry))
    && (!full || Object.keys(fleetDefaults).every(key => own(value, key)))
}
function validDelegation(value) {
  if (!object(value) || !Array.isArray(value.fields) || value.fields.some(key => !own(fleetDefaults, key))) return false
  const fields = new Set(['fields', 'maxRunsMax', 'childConcurrentMax', 'pollSecondsMin', 'pollSecondsMax', 'checkpointValues', 'recoveryValues'])
  if (Object.keys(value).some(key => !fields.has(key))) return false
  for (const [field, key] of [['maxRunsMax', 'maxRuns'], ['childConcurrentMax', 'childConcurrent'], ['pollSecondsMin', 'pollSeconds'], ['pollSecondsMax', 'pollSeconds']]) {
    if (value[field] !== undefined && !validFleetValue(key, value[field])) return false
  }
  if ((value.pollSecondsMin ?? 30) > (value.pollSecondsMax ?? 3600)) return false
  for (const [field, key] of [['checkpointValues', 'checkpoints'], ['recoveryValues', 'recovery']]) {
    if (value[field] !== undefined && (!Array.isArray(value[field]) || !value[field].length || value[field].some(entry => !validFleetValue(key, entry)))) return false
  }
  return true
}
function gitBranch(value) {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('-') && !value.startsWith('/') && !value.endsWith('/')
    && !/[\s~^:?*\[\\]/.test(value) && !value.includes('..') && !value.includes('@{') && value !== '@'
    && value.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock'))
}
function nodeId(value) { return typeof value === 'string' && /^[A-Za-z0-9_=-]{3,200}$/.test(value) }

function validateFleet(raw, registry) {
  const blocks = [], people = directory(registry.peopleByScope, registry.repoGroups)
  blocks.push(...people.blocks)
  if (!object(raw) || !safeTree(raw) || raw.schemaVersion !== 1 || !object(raw.coordination)
    || !validDefaults(raw.defaults, true) || !object(raw.groupDefaults) || !object(raw.machines) || !object(raw.groupDelegations ?? {})) {
    return { fleet: null, blocks: [...blocks, 'invalid fleet schema/defaults/maps'] }
  }
  const localOnly = /^(?:credentials?|secrets?|tokens?|password|privateKey|host(?:name|Id)?|home|(?:local)?path|command|shell)$/i
  function containsLocalData(value) {
    return object(value) && Object.entries(value).some(([key, child]) => localOnly.test(key) || containsLocalData(child))
  }
  if (containsLocalData(raw)) blocks.push('credentials, raw host identifiers, commands and local paths do not belong in fleet policy')
  const c = raw.coordination
  if (!nodeId(c.repositoryId) || !repoPattern.test(c.repository ?? '') || c.repository.split('/')[0].toLowerCase() !== registry.org?.toLowerCase()
    || !gitBranch(c.branch) || !shaPattern.test(c.rootCommit ?? '') || !uuidPattern.test(c.installationId ?? '')) blocks.push('invalid fleet coordination identity')
  for (const [group, defaults] of Object.entries(raw.groupDefaults)) if (!people.groups.has(group) || !validDefaults(defaults)) blocks.push(`invalid fleet group defaults: ${group}`)
  for (const [group, grant] of Object.entries(raw.groupDelegations ?? {})) if (!people.groups.has(group) || !validDelegation(grant)) blocks.push(`invalid fleet group delegation: ${group}`)
  const installations = new Set(), bindings = new Set()
  for (const [id, machine] of Object.entries(raw.machines)) {
    if (!groupPattern.test(id) || forbidden.has(id) || !object(machine) || !uuidPattern.test(machine.installationId ?? '') || !digestPattern.test(machine.hostBindingDigest ?? '')
      || !loginPattern.test(machine.executionLogin ?? '') || !people.people.has(machine.executionLogin?.toLowerCase()) || !people.groups.has(machine.group)
      || !strings(machine.repositories, repoPattern) || !machine.repositories.length || typeof machine.enabled !== 'boolean' || !validDefaults(machine.overrides)) {
      blocks.push(`invalid machine registration: ${id}`); continue
    }
    if (installations.has(machine.installationId.toLowerCase()) || bindings.has(machine.hostBindingDigest)) blocks.push(`duplicate machine identity: ${id}`)
    installations.add(machine.installationId.toLowerCase()); bindings.add(machine.hostBindingDigest)
    if (new Set(machine.repositories).size !== machine.repositories.length) blocks.push(`duplicate machine repositories: ${id}`)
    for (const repo of machine.repositories) if (registry.repoGroups[repo] !== machine.group || !nodeId(registry.repositoryIds[repo])) blocks.push(`unconfirmed or cross-group machine repository: ${id}/${repo}`)
  }
  return { fleet: blocks.length ? null : structuredClone(raw), blocks }
}

function trustedPolicy(policy) {
  return policy?.schemaVersion === 2 && Array.isArray(policy.blocks) && !policy.blocks.length && digestPattern.test(policy.policyDigest ?? '')
    && ['local', 'fresh'].includes(policy.freshness?.state)
    && policy.policyDigest === policyHash({ values: policy.values, sources: policy.sources, locked: policy.locked, delegations: policy.delegations, administration: policy.administration, fleet: policy.fleet, registry: policy.registry })
}
function verifiedLogin(actor, policy) {
  if (!object(actor) || actor.verified !== true || !loginPattern.test(actor.login ?? '')) return null
  const login = actor.login.toLowerCase()
  return directory(policy.registry?.peopleByScope ?? {}, policy.registry?.repoGroups ?? {}).people.has(login) ? login : null
}
const deny = reason => ({ allowed: false, reason })
const allow = () => ({ allowed: true, reason: null })
function delegatedFleetChange(changes, delegation) {
  if (!validDefaults(changes) || !validDelegation(delegation) || Object.keys(changes).length === 0) return false
  return Object.entries(changes).every(([key, value]) => {
    if (!delegation.fields.includes(key)) return false
    if (key === 'maxRuns') return value <= (delegation.maxRunsMax ?? Number.MAX_SAFE_INTEGER)
    if (key === 'childConcurrent') return value <= (delegation.childConcurrentMax ?? 16)
    if (key === 'pollSeconds') return value >= (delegation.pollSecondsMin ?? 30) && value <= (delegation.pollSecondsMax ?? 3600)
    if (key === 'checkpoints') return delegation.checkpointValues === undefined || delegation.checkpointValues.includes(value)
    if (key === 'recovery') return delegation.recoveryValues === undefined || delegation.recoveryValues.includes(value)
    return false
  })
}

// target.changes is the proposed field diff; policy/administration are the PREVIOUS trusted
// configuration. The caller validates/render the resulting complete document before delivery.
export function authorizeAdministration({ actor, action, target, administration, policy } = {}) {
  if (!trustedPolicy(policy)) return deny('current validated policy required')
  if (!administration || !same(administration, policy.administration)) return deny('previous trusted administration required')
  const login = verifiedLogin(actor, policy)
  if (!login) return deny('verified requester identity required; execution identity is not human authority')
  if (!object(target) || !safeTree(target) || target.org !== policy.registry.org) return deny('exact organization target required')
  if (target.changes !== undefined && !object(target.changes)) return deny('administration requires an explicit field diff')
  const registry = directory(policy.registry.peopleByScope, policy.registry.repoGroups)
  if (target.group !== undefined && !registry.groups.has(target.group)) return deny('unregistered group target')
  if (target.repo !== undefined && (!own(policy.registry.repoGroups, target.repo) || (target.group && policy.registry.repoGroups[target.repo] !== target.group))) return deny('unregistered or mixed repository target')
  const actions = ['administration.manage', 'fleet.enroll', 'fleet.configure', 'fleet.machine.settings', 'fleet.group.settings', ...capabilities]
  if (!actions.includes(action)) return deny('unknown administration action; task and shipping authority are separate')
  const isOrg = administration.orgAdmins.includes(login)
  if (action === 'administration.manage') {
    if (!isOrg) return deny('organization-admin appointment authority required')
    if (target.proposedAdministration !== undefined) {
      const result = resolveAdministration({ orgLayer: { scope: 'org', blocks: [], authority: { administration: target.proposedAdministration } }, peopleByScope: policy.registry.peopleByScope, repoGroups: policy.registry.repoGroups })
      if (!result.ok) return deny(result.blocks.join('; '))
    }
    return allow()
  }
  if (['fleet.enroll', 'fleet.configure'].includes(action)) {
    if (!isOrg) return deny('coordination identity and enrollment are organization-admin owned')
    if (target.registration && (target.registration.enabled !== false || policy.fleet?.machines?.[target.machineId])) return deny('new enrollment must be disabled and have a unique machine identity')
    return allow()
  }
  if (!target.group) return deny('exact group target required')
  if (!isOrg && (!administration.groupAdmins[target.group]?.includes(login) || !administration.groupAdminCapabilities[target.group]?.includes(action.startsWith('fleet.') ? 'group.defaults.manage' : action))) return deny('requester lacks this group capability')
  if (action.startsWith('fleet.')) {
    const machine = target.machineId ? policy.fleet?.machines?.[target.machineId] : null
    if (action === 'fleet.machine.settings' && (!machine || machine.group !== target.group)) return deny('settings require an existing machine in this group')
    if (!validDefaults(target.changes)) return deny('settings cannot change enrollment, repositories, group or identity')
    return isOrg || delegatedFleetChange(target.changes, policy.fleet?.groupDelegations?.[target.group]) ? allow() : deny('fleet setting outside previous org delegation')
  }
  if (action === 'group.defaults.manage') {
    if (!object(target.changes) || !Object.keys(target.changes).length) return deny('explicit setting diff required')
    for (const [key, value] of Object.entries(target.changes)) {
      if (!ordinary.has(key) || ['operators', 'dispatch', 'control-room'].includes(key) || knobValue(key, String(value)) === undefined) return deny('group cannot modify protected authority or unknown settings')
      if (own(policy.locked, key) && !same(policy.locked[key], value)) {
        const delegated = policy.delegations.some(grant => grant.key === key && grant.groups.includes(target.group) && target.repo && grant.repos.includes(target.repo) && grant.allowedValues.some(allowed => same(allowed, value)))
        if (!delegated) return deny('group setting requires exact org delegation')
      }
    }
  }
  if (action === 'group.repos.manage') {
    if (!target.repo || policy.registry.repoGroups[target.repo] !== target.group) return deny('repository management is limited to preauthorized registrations')
    if (target.changes && Object.keys(target.changes).some(key => !['board', 'owner'].includes(key))) return deny('group repository edits cannot change registration scope or authority')
    if (target.changes?.owner !== undefined && !registry.people.has(String(target.changes.owner).toLowerCase())) return deny('repository owner must be a confirmed person')
  }
  if (action === 'group.members.manage' && target.changes) {
    if (Object.keys(target.changes).some(key => !['login', 'name', 'role', 'slack', 'timezone', 'groups'].includes(key))) return deny('ordinary membership management cannot change authority')
    if (target.changes.groups !== undefined && (!strings(target.changes.groups, groupPattern) || target.changes.groups.some(group => group !== target.group))) return deny('membership edit crosses the exact group target')
    if (target.changes.login !== undefined && !loginPattern.test(target.changes.login)) return deny('member login must be a validated GitHub identity')
  }
  return allow()
}

/**
 * @param {{viewer?:any,subject?:string|null,requestedRepos?:string[],administration?:any,policy?:any,repoGroups?:Record<string,string>}} input
 * @returns {{allowedRepos:string[],subject:string|null,refusal:string|null}}
 */
export function resolvePeopleReadScope({ viewer, subject = null, requestedRepos, administration, policy, repoGroups } = {}) {
  const refuse = refusal => ({ allowedRepos: [], subject, refusal })
  if (!trustedPolicy(policy)) return refuse('current validated policy required for people data')
  if (!same(repoGroups, policy.registry.repoGroups) || !same(administration ?? null, policy.administration)) return refuse('read scope must use current confirmed registry and administration')
  const login = verifiedLogin(viewer, policy)
  if (!login) return refuse('verified viewer required')
  const registry = directory(policy.registry.peopleByScope, repoGroups)
  if (subject !== null && (typeof subject !== 'string' || !registry.people.has(subject.toLowerCase()))) return refuse('unknown person')
  if (subject !== null) subject = subject.toLowerCase()
  const requested = requestedRepos ?? Object.keys(repoGroups)
  if (!strings(requested, repoPattern) || requested.some(repo => !own(repoGroups, repo))) return refuse('requested repository is unregistered')
  const ownData = subject === login
  if (!ownData && policy.values['stats-people'] !== 'on') return refuse('organization people reporting is off')
  const orgAdmin = administration?.orgAdmins.includes(login) === true
  const groups = Object.keys(administration?.groupAdmins ?? {}).filter(group => administration.groupAdmins[group].includes(login) && administration.groupAdminCapabilities[group]?.includes('group.people.read'))
  const allowedRepos = unique(requested).filter(repo => ownData || orgAdmin || groups.includes(repoGroups[repo]))
  return { allowedRepos, subject, refusal: allowedRepos.length ? null : 'viewer has no permitted repositories for this people query' }
}

export function resolveMachinePolicy({ policy, machineId, installationId, hostBindingDigest, executionLogin } = {}) {
  const refuse = reason => ({ ok: false, machine: null, blocks: [reason] })
  if (!trustedPolicy(policy)) return refuse('current validated policy required for machine resolution')
  if (!policy.fleet) return refuse('no shared fleet configuration; explicit legacy mode must be selected by the caller')
  const checked = validateFleet(policy.fleet, policy.registry)
  if (checked.blocks.length) return { ok: false, machine: null, blocks: checked.blocks }
  if (!groupPattern.test(machineId ?? '') || !own(policy.fleet.machines, machineId)) return refuse('machine is not enrolled')
  const registration = policy.fleet.machines[machineId]
  if (!registration.enabled) return refuse('machine enrollment is disabled')
  if (registration.installationId !== installationId || registration.hostBindingDigest !== hostBindingDigest || registration.executionLogin.toLowerCase() !== executionLogin?.toLowerCase()) return refuse('machine installation, host binding or execution identity mismatch')
  const defaults = { ...policy.fleet.defaults, ...policy.fleet.groupDefaults[registration.group], ...registration.overrides }
  return { ok: true, machine: { id: machineId, ...registration, coordination: policy.fleet.coordination, defaults, allowedRepositories: [...registration.repositories], repositoryIds: Object.fromEntries(registration.repositories.map(repo => [repo, policy.registry.repositoryIds[repo]])), policyDigest: policy.policyDigest }, blocks: [] }
}

// Registry readers share the fixed authored formats. These rows are descriptive input to a
// verified snapshot; parsing a login is not verification of the requester or GitHub account.
export function parsePeopleRegistry(text = '') {
  const lines = String(text).split(/\r?\n/).filter(line => line.trim())
  const blocks = [], people = [], seen = new Set()
  if (lines.shift()?.trim() !== 'login,name,role,slack,timezone,groups') return { people: [], blocks: ['people.csv needs its exact six-column header'] }
  for (const line of lines) {
    const cells = line.split(',').map(cell => cell.trim())
    const [login, name, role, slack, timezone, rawGroups] = cells
    const groups = (rawGroups ?? '').split(/[;|]/).map(group => group.trim()).filter(Boolean)
    if (cells.length !== 6 || !loginPattern.test(login ?? '') || forbidden.has(login) || !strings(groups, groupPattern) || seen.has(login.toLowerCase())) {
      blocks.push('invalid or duplicate people.csv row'); continue
    }
    seen.add(login.toLowerCase())
    people.push({ login: login.toLowerCase(), name, role, slack, timezone, groups: unique(groups) })
  }
  return { people: blocks.length ? [] : people, blocks }
}

/** @returns {{repoGroups:Record<string,string>,repositoryIds:Record<string,string>,blocks:string[]}} */
export function parseRepositoryRegistry(text = '') {
  const repoGroups = {}, repositoryIds = {}, blocks = [], seen = new Set()
  let idColumn = -1
  let fence = false
  for (const line of String(text).split(/\r?\n/)) {
    if (/^\s{0,3}(?:`{3,}|~{3,})/.test(line)) { fence = !fence; continue }
    if (fence || !line.startsWith('|')) continue
    const cells = line.split('|').slice(1, -1).map(cell => cell.trim())
    const [repo, group] = cells
    if (repo === 'repo') { idColumn = cells.indexOf('repository-id'); continue }
    if (!repo?.includes('/')) continue
    if (!repoPattern.test(repo) || !groupPattern.test(group ?? '') || forbidden.has(group) || seen.has(repo)) { blocks.push('invalid or duplicate repository registry row'); continue }
    seen.add(repo); repoGroups[repo] = group
    if (idColumn >= 0 && cells[idColumn]) {
      if (!nodeId(cells[idColumn])) blocks.push('invalid repository node ID')
      else repositoryIds[repo] = cells[idColumn]
    }
  }
  return { repoGroups: blocks.length ? {} : repoGroups, repositoryIds: blocks.length ? {} : repositoryIds, blocks }
}

export function parseControlRoomReference(text) {
  const value = parsePolicy(text, 'repo').values['control-room']
  if (!value || value === 'none') return null
  const [room, suffix = ''] = value.split('#')
  const [group, sha] = suffix.split('@')
  return { org: room.split('/')[0], repo: room, group: group || null, sha: sha || null }
}

function gitRead(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', timeout: 5000, maxBuffer: 4 * 1024 * 1024 })
}

// A per-code-repository pointer is supplied by the snapshot owner. Read authoritative blobs
// from its exact Git commit, not symlink targets or a mutable worktree. No fetch or state write.
/** @param {{snapshot:any,repo:string,devMd:string,room?:any,expectedOrigin?:string,now?:string|number}} input */
export function loadSnapshotPolicy({ snapshot, repo, devMd, room = parseControlRoomReference(devMd), expectedOrigin, now = Date.now() }) {
  const refused = reason => {
    const result = resolvePolicy({ repo: devMd, identity: { repo }, freshness: { configured: true, now } })
    result.blocks.unshift(reason); result.ok = false
    return result
  }
  if (!room || !repoPattern.test(repo) || !object(snapshot) || snapshot.schemaVersion !== 2 || snapshot.org !== room.org
    || snapshot.repository !== room.repo || snapshot.group !== room.group || !shaPattern.test(snapshot.sourceCommit ?? '')
    || !digestPattern.test(snapshot.policyDigest ?? '') || typeof snapshot.contentPath !== 'string' || !isAbsolute(snapshot.contentPath) || typeof snapshot.origin !== 'string') return refused('no matching per-repository validated policy snapshot')
  const canonicalOrigin = 'https://github.com/' + room.repo + '.git'
  if (snapshot.origin !== (expectedOrigin ?? canonicalOrigin)) return refused('snapshot origin does not match the verified control-room connection')
  try {
    const root = lstatSync(snapshot.contentPath)
    if (!root.isDirectory() || root.isSymbolicLink()) return refused('snapshot content path is not an immutable managed directory')
    if (gitRead(snapshot.contentPath, ['rev-parse', 'HEAD']).trim() !== snapshot.sourceCommit
      || gitRead(snapshot.contentPath, ['remote', 'get-url', 'origin']).trim() !== snapshot.origin
      || gitRead(snapshot.contentPath, ['status', '--porcelain', '--untracked-files=all']).trim()) return refused('snapshot content/origin/source identity changed')
    const entries = new Map(gitRead(snapshot.contentPath, ['ls-tree', '-r', '-z', snapshot.sourceCommit]).split('\0').filter(Boolean).map(line => {
      const [metadata, path] = line.split('\t'); return [path, metadata.split(' ')[0]]
    }))
    const read = (path, required = true) => {
      if (!entries.has(path) && !required) return ''
      if (!['100644', '100755'].includes(entries.get(path))) throw new Error(`snapshot policy file is missing or not a regular blob: ${path}`)
      return gitRead(snapshot.contentPath, ['show', snapshot.sourceCommit + ':' + path])
    }
    const org = read('org.md'), group = room.group ? read('groups/' + room.group + '/group.md') : ''
    const registry = parseRepositoryRegistry(read('repos.md'))
    if (registry.blocks.length || !own(registry.repoGroups, repo) || (room.group !== null && registry.repoGroups[repo] !== room.group)) return refused('code repository/group is missing or conflicts with the snapshot registry')
    const peopleByScope = {}
    for (const [path] of entries) {
      if (path !== 'people.csv' && !/^groups\/[a-z0-9][a-z0-9-]{0,63}\/people\.csv$/.test(path)) continue
      const parsed = parsePeopleRegistry(read(path))
      if (parsed.blocks.length) return refused(parsed.blocks.join('; '))
      peopleByScope[path === 'people.csv' ? 'org' : path.split('/')[1]] = parsed.people
    }
    const result = resolvePolicy({ org, group, repo: devMd,
      identity: { org: room.org, repo, group: room.group, roomSha: snapshot.sourceCommit, peopleByScope, repoGroups: registry.repoGroups, repositoryIds: registry.repositoryIds },
      freshness: { configured: true, now, validatedAt: snapshot.validatedAt } })
    if (result.policy.policyDigest !== snapshot.policyDigest) { result.blocks.push('snapshot effective policy digest changed; validate this repository profile again'); result.ok = false }
    return result
  } catch (error) { return refused(`snapshot policy read refused: ${error.message}`) }
}

// Existing settings, separate bindings per code repo. This is a read adapter, not a migration
// or a snapshot publisher. Missing/legacy/foreign slots cannot refresh validation time.
/** @param {{home:string,repo:string,devMd:string,now?:string|number}} input */
export function loadConfiguredPolicy({ home, repo, devMd, now = Date.now() }) {
  const room = parseControlRoomReference(devMd)
  if (!room) return resolvePolicy({ repo: devMd, identity: { repo }, freshness: { configured: false, now } })
  let entry
  try {
    const settings = policyJson(readFileSync(join(home, '.vegastack', 'factory.json'), 'utf8'))
    if (!object(settings) || ![1, 2].includes(settings.schemaVersion)) throw new Error('unknown settings schema')
    entry = settings.controlRooms?.[room.org]
  } catch { /* Missing/malformed settings are an unavailable configured policy, not defaults. */ }
  return loadSnapshotPolicy({ snapshot: entry?.snapshots?.[repo], repo, devMd, room, expectedOrigin: entry?.remote, now })
}

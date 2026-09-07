import { expect, test } from 'bun:test'
import { parsePolicy, resolvePolicy } from '../scripts/effective-policy.mjs'

const identity = { org: 'acme', repo: 'acme/app', group: 'dev', roomSha: 'a'.repeat(40) }
const freshness = { configured: true, validatedAt: '2026-09-06T00:00:00Z', now: '2026-09-06T00:01:00Z', maxAgeSeconds: 7200 }
const authority = (value: unknown) => `policy-schema: 2\n\`\`\`vsk-policy\n${JSON.stringify({ schemaVersion: 2, ...value as object })}\n\`\`\``

test('group cannot unlock organization capture; diagnostic value remains locked', () => {
  const result = resolvePolicy({ org: 'stats: on\nstats-override: locked', group: 'stats-override: allowed', repo: 'stats: off', identity, freshness })
  expect(result.ok).toBe(false)
  expect(result.blocks.join(' ')).toMatch(/delegation/)
  expect(result.policy?.values.stats).toBe('on')
})

test('explicit exact org delegation permits an override, unlike another repo', () => {
  const org = authority({ locked: { stats: 'on' }, delegations: [{ key: 'stats', groups: ['dev'], repos: ['acme/app'], allowedValues: ['off'] }] })
  expect(resolvePolicy({ org, repo: 'stats: off', identity, freshness }).ok).toBe(true)
  expect(resolvePolicy({ org, repo: 'stats: off', identity: { ...identity, repo: 'acme/other' }, freshness }).ok).toBe(false)
})

test('ordinary stages inherit individually, local dispatch cannot be inherited', () => {
  const result = resolvePolicy({ org: 'dispatch: local\nharness-policy: plan codex confirmed high · implement claude confirmed high', group: 'tests: required', repo: 'harness-policy: plan claude chosen high', identity })
  expect(result.ok).toBe(true)
  expect(result.policy?.values.dispatch).toBe('off')
  expect(result.policy?.values.stages).toEqual({ plan: { harness: 'claude', model: 'chosen', effort: 'high' }, implement: { harness: 'claude', model: 'confirmed', effort: 'high' } })
})

test.each(['stats: maybe', 'stats: on\nstats: off', 'policy-schema: 9', 'harness-policy: plan unknown model high', 'review: none', '```vsk-policy\n{bad}\n```'])('known malformed input refuses: %s', text => {
  expect(resolvePolicy({ repo: text, identity }).ok).toBe(false)
})

test('examples and nested lines cannot become policy; unknown extensions remain inert', () => {
  const layer = parsePolicy('```md\nstats: off\n```\n  stats: off\nstats: on\ncustom: keep me', 'repo')
  expect(layer.values.stats).toBe('on')
  expect(layer.extensions.custom).toBe('keep me')
  expect(layer.blocks).toEqual([])
})

test('freshness exact boundary, future and missing validated policy fail closed', () => {
  for (const seconds of [7199, 7200]) {
    const result = resolvePolicy({ org: 'stats: on', repo: 'dispatch: local', identity, freshness: { ...freshness, now: new Date(Date.parse(freshness.validatedAt) + seconds * 1000).toISOString() } })
    expect(result.ok).toBe(seconds === 7199)
  }
  expect(resolvePolicy({ org: '', identity, freshness }).ok).toBe(false)
  expect(resolvePolicy({ org: 'stats: on', identity, freshness: { ...freshness, validatedAt: '2026-09-07T00:00:00Z' } }).ok).toBe(false)
  expect(resolvePolicy({ repo: 'dispatch: local', identity }).ok).toBe(true)
})

test('digest is stable across observation times and changes with resolved policy or sources', () => {
  const input = { org: 'stats: on', identity, freshness }
  const first = resolvePolicy(input).policy!
  const later = resolvePolicy({ ...input, freshness: { ...freshness, now: '2026-09-06T00:02:00Z' } }).policy!
  expect(first.policyDigest).toBe(later.policyDigest)
  expect(resolvePolicy({ ...input, org: 'stats: off' }).policy!.policyDigest).not.toBe(first.policyDigest)
  expect(first.sources.stats.revision).toBe(identity.roomSha)
})

const peopleByScope = { org: [{ login: 'owner', groups: ['dev'] }, { login: 'devadmin', groups: ['dev'] }, { login: 'member', groups: ['dev', 'design'] }, { login: 'designer', groups: ['design'] }] }
const repoGroups = { 'acme/app': 'dev', 'acme/design': 'design' }
const repositoryIds = { 'acme/app': 'R_app', 'acme/design': 'R_design' }
const admin = { orgAdmins: ['owner'], groupAdmins: { dev: ['devadmin'] }, groupAdminCapabilities: { dev: ['group.members.manage', 'group.defaults.manage', 'group.people.read'] } }
const registeredIdentity = { ...identity, peopleByScope, repoGroups, repositoryIds }
const managed = () => resolvePolicy({ org: 'stats-people: on\n' + authority({ administration: admin }), identity: registeredIdentity }).policy!

test('admin grants come only from confirmed org configuration, not descriptive role replacement', async () => {
  const { resolveAdministration, authorizeAdministration } = await import('../scripts/effective-policy.mjs')
  const result = resolveAdministration({ orgLayer: parsePolicy(authority({ administration: admin }), 'org'), peopleByScope, repoGroups })
  expect(result.ok).toBe(true)
  const policy = managed()
  expect(authorizeAdministration({ actor: { login: 'member', verified: true, claimedLogin: 'owner' }, action: 'administration.manage', target: { org: 'acme' }, administration: result.administration, policy }).allowed).toBe(false)
  expect(authorizeAdministration({ actor: { login: 'owner', verified: true, executionLogin: 'bot' }, action: 'administration.manage', target: { org: 'acme' }, administration: result.administration, policy }).allowed).toBe(true)
  expect(authorizeAdministration({ actor: { login: 'devadmin', verified: true }, action: 'group.members.manage', target: { org: 'acme', group: 'design' }, administration: result.administration, policy }).allowed).toBe(false)
  expect(resolveAdministration({ orgLayer: parsePolicy('', 'org'), peopleByScope, repoGroups }).administration).toBeNull()
  expect(resolveAdministration({ orgLayer: parsePolicy(authority({ administration: { ...admin, orgAdmins: [] } }), 'org'), peopleByScope, repoGroups }).ok).toBe(false)
})

test('people visibility intersects exact registered repo scope before reading rows', async () => {
  const { resolvePeopleReadScope } = await import('../scripts/effective-policy.mjs')
  const policy = managed()
  const input = { viewer: { login: 'devadmin', verified: true }, subject: 'member', requestedRepos: ['acme/app', 'acme/design'], administration: policy.administration, policy, repoGroups }
  expect(resolvePeopleReadScope(input).allowedRepos).toEqual(['acme/app'])
  expect(resolvePeopleReadScope({ ...input, requestedRepos: ['acme/design'] }).allowedRepos).toEqual([])
  expect(resolvePeopleReadScope({ ...input, viewer: { login: 'owner', verified: false } }).allowedRepos).toEqual([])
  expect(resolvePeopleReadScope({ ...input, viewer: { login: 'member', verified: true } }).allowedRepos).toEqual(['acme/app', 'acme/design'])
})

const fleet = () => ({ schemaVersion: 1, coordination: { repositoryId: 'R_room', repository: 'acme/control-room', branch: 'factory-state', rootCommit: 'b'.repeat(40), installationId: '12345678-1234-4123-8123-123456789012' }, defaults: { pollSeconds: 120, maxRuns: 1, childConcurrent: 3, checkpoints: 'task-branch', recovery: 'verified-transfer' }, groupDefaults: {}, groupDelegations: { dev: { fields: ['maxRuns'], maxRunsMax: 2 } }, machines: { 'dev-box': { installationId: '12345678-1234-4123-8123-123456789013', hostBindingDigest: 'c'.repeat(64), executionLogin: 'devadmin', group: 'dev', repositories: ['acme/app'], enabled: false, overrides: {} } } })

test('fleet resolution matches all enrolled identity fields and never enables from local config', async () => {
  const { resolveMachinePolicy } = await import('../scripts/effective-policy.mjs')
  const data = fleet()
  const resolve = () => resolvePolicy({ org: authority({ administration: admin, fleet: data }), identity: registeredIdentity })
  expect(resolve().ok).toBe(true)
  const machine = data.machines['dev-box']
  const input = { machineId: 'dev-box', installationId: machine.installationId, hostBindingDigest: machine.hostBindingDigest, executionLogin: 'devadmin' }
  expect(resolveMachinePolicy({ ...input, policy: resolve().policy }).ok).toBe(false)
  machine.enabled = true
  const policy = resolve().policy!
  expect(resolveMachinePolicy({ ...input, policy }).machine?.defaults).toEqual(data.defaults)
  expect(resolveMachinePolicy({ ...input, policy, hostBindingDigest: 'd'.repeat(64) }).ok).toBe(false)
  machine.repositories.push('acme/missing')
  expect(resolve().ok).toBe(false)
})

test('fleet group changes use prior delegation and cannot enroll or enlarge repo scope', async () => {
  const { authorizeAdministration } = await import('../scripts/effective-policy.mjs')
  const data = fleet(); data.machines['dev-box'].enabled = true
  const policy = resolvePolicy({ org: authority({ administration: admin, fleet: data }), identity: registeredIdentity }).policy!
  const input = { actor: { login: 'devadmin', verified: true }, action: 'fleet.machine.settings', target: { org: 'acme', group: 'dev', machineId: 'dev-box', changes: { maxRuns: 2 } }, administration: policy.administration, policy }
  expect(authorizeAdministration(input).allowed).toBe(true)
  expect(authorizeAdministration({ ...input, target: { ...input.target, changes: { maxRuns: 3 } } }).allowed).toBe(false)
  expect(authorizeAdministration({ ...input, target: { ...input.target, changes: { enabled: true } } }).allowed).toBe(false)
  expect(authorizeAdministration({ ...input, action: 'fleet.enroll' }).allowed).toBe(false)
})

test.each([
  '```vsk-policy\n{"schemaVersion":2,"locked":{"stats":"on","stats":"off"}}\n```',
  '```vsk-policy\n{"schemaVersion":2,"administration":{"__proto__":{}}}\n```',
  authority({ locked: { stats: 'on' }, delegations: [{ key: 'stats', groups: ['*'], repos: ['acme/app'], allowedValues: ['off'] }] }),
])('ambiguous authority refuses rather than overwriting a key', org => {
  expect(resolvePolicy({ org, identity }).ok).toBe(false)
})

test('group cannot insert org authority, while learning cannot override a quality lock', () => {
  expect(resolvePolicy({ group: authority({ administration: admin }), identity: registeredIdentity }).ok).toBe(false)
  const org = authority({ locked: { tests: 'required', review: 'cross-agent-risky', 'provider-mode': 'subscription-only' } })
  const result = resolvePolicy({ org, repo: 'tests: none\nlearning: normal-work\nlearning-adoption: scoped-reversible\nexecution-budget-minutes: 120', identity })
  expect(result.ok).toBe(false)
  expect(result.policy?.values.tests).toBe('required')
  expect(result.policy?.values).not.toHaveProperty('execution-budget-minutes')
})

test.each([
  (f: ReturnType<typeof fleet>) => { f.defaults.pollSeconds = 29 },
  (f: ReturnType<typeof fleet>) => { f.defaults.maxRuns = Number.MAX_SAFE_INTEGER + 1 },
  (f: ReturnType<typeof fleet>) => { f.defaults.childConcurrent = 17 },
  (f: ReturnType<typeof fleet>) => { f.machines['dev-box'].repositories = ['acme/design'] },
  (f: ReturnType<typeof fleet>) => { f.groupDelegations.dev.maxRunsMax = 0 },
  (f: ReturnType<typeof fleet>) => { f.machines['other'] = { ...f.machines['dev-box'] } },
  (f: ReturnType<typeof fleet>) => { f.coordination.branch = '../other' },
])('invalid fleet cannot produce an effective registration', mutate => {
  const f = fleet(); mutate(f)
  expect(resolvePolicy({ org: authority({ administration: admin, fleet: f }), identity: registeredIdentity }).ok).toBe(false)
})

test('unregistered admin group and foreign organization repo references refuse', () => {
  const unknown = { ...peopleByScope, org: [...peopleByScope.org, { login: 'outsider', groups: ['missing'] }] }
  expect(resolvePolicy({ org: authority({ administration: { ...admin, groupAdmins: { missing: ['outsider'] } } }), identity: { ...registeredIdentity, peopleByScope: unknown } }).ok).toBe(false)
  expect(resolvePolicy({ org: authority({ administration: admin }), identity: { ...registeredIdentity, repoGroups: { ...repoGroups, 'other/private': 'dev' } } }).ok).toBe(false)
})

test('machine schema refuses credential or host-path fields rather than retaining them in policy', () => {
  const f = fleet() as ReturnType<typeof fleet> & { credentials?: object }
  f.credentials = { token: 'example-credential-value' }
  expect(resolvePolicy({ org: authority({ administration: admin, fleet: f }), identity: registeredIdentity }).ok).toBe(false)
})

test('real Git snapshot bindings are per code repository and reject drift without renewing age', async () => {
  const { execFileSync } = await import('node:child_process')
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { loadConfiguredPolicy, parsePeopleRegistry } = await import('../scripts/effective-policy.mjs')
  const home = await mkdtemp(join(tmpdir(), 'policy-snapshot-'))
  try {
    const content = join(home, 'snapshot')
    const origin = join(home, 'room.git')
    await mkdir(join(content, 'groups/dev'), { recursive: true })
    await mkdir(join(content, 'groups/design'), { recursive: true })
    const git = (...args: string[]) => execFileSync('git', args, { cwd: content, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test'); git('remote', 'add', 'origin', origin)
    const org = 'stats: on\nstats-people: on\ngates: 3\nsync-max-age: 2h\n'
    const csv = 'login,name,role,slack,timezone,groups\nowner,Owner,lead,,UTC,dev;design\n'
    await writeFile(join(content, 'org.md'), org)
    await writeFile(join(content, 'people.csv'), csv)
    await writeFile(join(content, 'repos.md'), '| repo | group | board | owner | repository-id |\n|---|---|---|---|---|\n| acme/app | dev | | owner | R_app |\n| acme/design | design | | owner | R_design |\n')
    await writeFile(join(content, 'groups/dev/group.md'), 'tests: required')
    await writeFile(join(content, 'groups/design/group.md'), 'tests: best-effort')
    git('add', '.'); git('commit', '-qm', 'Fixture policy')
    const sha = git('rev-parse', 'HEAD')
    const profiles = { 'acme/app': 'control-room: acme/room#dev\ndispatch: local', 'acme/design': 'control-room: acme/room#design\ndispatch: local' }
    const snapshots: Record<string, object> = {}
    for (const [repo, devMd] of Object.entries(profiles)) {
      const group = repoGroups[repo as keyof typeof repoGroups]
      const resolved = resolvePolicy({ org, group: group === 'dev' ? 'tests: required' : 'tests: best-effort', repo: devMd,
        identity: { org: 'acme', repo, group, roomSha: sha, peopleByScope: { org: parsePeopleRegistry(csv).people }, repoGroups, repositoryIds },
        freshness: { configured: true, validatedAt: freshness.validatedAt, now: freshness.now } })
      expect(resolved.ok).toBe(true)
      snapshots[repo] = { schemaVersion: 2, org: 'acme', group, repository: 'acme/room', origin, sourceCommit: sha, policyDigest: resolved.policy.policyDigest, validatedAt: freshness.validatedAt, contentPath: content }
    }
    const state = { schemaVersion: 1, controlRooms: { acme: { remote: origin, snapshots } } }
    await mkdir(join(home, '.vegastack'))
    await writeFile(join(home, '.vegastack/factory.json'), JSON.stringify(state))
    const input = { home, repo: 'acme/app', devMd: profiles['acme/app'], now: freshness.now }
    const first = loadConfiguredPolicy(input)
    expect(first.ok).toBe(true)
    expect(loadConfiguredPolicy({ ...input, repo: 'acme/design', devMd: profiles['acme/design'] }).ok).toBe(true)
    expect(loadConfiguredPolicy({ ...input, devMd: input.devMd + '\ngates: 2' }).blocks.join(' ')).toMatch(/digest changed/)
    expect(loadConfiguredPolicy({ ...input, now: '2026-09-06T02:00:00Z' }).ok).toBe(false)
    expect(loadConfiguredPolicy({ ...input, devMd: profiles['acme/design'] }).ok).toBe(false)
    state.controlRooms.acme.remote = join(home, 'foreign.git')
    await writeFile(join(home, '.vegastack/factory.json'), JSON.stringify(state))
    expect(loadConfiguredPolicy(input).blocks.join(' ')).toMatch(/origin/)
    state.controlRooms.acme.remote = origin
    await writeFile(join(home, '.vegastack/factory.json'), JSON.stringify(state))
    await writeFile(join(content, 'org.md'), org + 'stats: off')
    expect(loadConfiguredPolicy(input).blocks.join(' ')).toMatch(/identity changed/)
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('an own-group target cannot smuggle a cross-group member or repository edit', async () => {
  const { authorizeAdministration } = await import('../scripts/effective-policy.mjs')
  const policy = managed()
  const base = { actor: { login: 'devadmin', verified: true }, administration: policy.administration, policy }
  expect(authorizeAdministration({ ...base, action: 'group.members.manage', target: { org: 'acme', group: 'dev', changes: { groups: ['design'] } } }).allowed).toBe(false)
  expect(authorizeAdministration({ ...base, action: 'group.members.manage', target: { org: 'acme', group: 'dev', changes: { administration: { orgAdmins: ['devadmin'] } } } }).allowed).toBe(false)
})

test('machine-local configured:false cannot turn an authored control room into local policy', () => {
  expect(resolvePolicy({ repo: 'control-room: acme/room#dev\ndispatch: local', identity, freshness: { configured: false } }).ok).toBe(false)
})

test('mutating the resolved admin map cannot supply a previous trusted self-grant', async () => {
  const { authorizeAdministration } = await import('../scripts/effective-policy.mjs')
  const policy = managed()
  policy.administration.orgAdmins.push('member')
  expect(authorizeAdministration({ actor: { login: 'member', verified: true }, action: 'administration.manage', target: { org: 'acme' }, administration: policy.administration, policy }).allowed).toBe(false)
})

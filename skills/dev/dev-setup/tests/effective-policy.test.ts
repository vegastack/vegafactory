import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parsePolicy, parseControlRoomReference, resolvePolicy } from '../scripts/effective-policy.mjs'

// A copy of the vegastack control room, so the shipped rules are tested against real authored
// Markdown rather than a hand-made sample. Refreshed by hand when the live room changes.
const room = (path: string) => readFileSync(join(import.meta.dir, 'fixtures/control-room', path), 'utf8')

test('a repo with no lines of its own still resolves to a complete profile', () => {
  const result = resolvePolicy({ org: room('org.md'), group: room('groups/dev/group.md'), repo: '' })
  expect(result.blocks).toEqual([])
  expect(result.ok).toBe(true)
  expect(result.values.tests).toBe('required')
  expect(result.values.merge).toBe('rebase')
  expect(result.values.gates).toBe(3)
  expect(result.values.stats).toBe('on')
  expect(Object.keys(result.values.stages).sort()).toEqual(['chronicle', 'implement', 'intake', 'plan', 'review', 'status'])
  expect(result.values['workflow-labels'].ready).toBe('queued')
  expect(result.sources.tests).toBe('group')
  expect(result.sources['stats-people']).toBe('org')
})

test('the live room validates, and its knobs land where the file that wrote them says', () => {
  for (const [text, scope] of [[room('org.md'), 'org'], [room('groups/dev/group.md'), 'group']] as const) {
    expect(parsePolicy(text, scope).blocks).toEqual([])
  }
  const repo = room('dev.md')
  expect(parsePolicy(repo, 'repo').blocks).toEqual([])
  expect(parseControlRoomReference(repo)).toMatchObject({ org: 'vegastack', repo: 'vegastack/vegafactory-control-room', group: 'dev' })
  const result = resolvePolicy({ org: room('org.md'), group: room('groups/dev/group.md'), repo })
  expect(result.blocks).toEqual([])
  expect(result.values.stages.review.harness).toBe('codex')
})

test('a locked line cannot be overridden by a group or a repo, and keeps its org value', () => {
  const org = 'tests: required   # locked — every repo runs its tests\nmerge: rebase'
  const same = resolvePolicy({ org, group: 'tests: required', repo: 'merge: squash' })
  expect(same.ok).toBe(true)
  expect(same.values.merge).toBe('squash')
  for (const layers of [{ org, group: 'tests: none' }, { org, repo: 'tests: best-effort' }]) {
    const result = resolvePolicy(layers)
    expect(result.ok).toBe(false)
    expect(result.blocks.join(' ')).toMatch(/tests is locked in org\.md/)
    expect(result.values.tests).toBe('required')
  }
})

test('only org.md may lock a line; a group or repo marker refuses rather than being ignored', () => {
  expect(parsePolicy('tests: none   # locked', 'group').blocks).toEqual(['only org.md can lock a line: tests'])
  expect(parsePolicy('tests: none   # locked', 'repo').blocks).toEqual(['only org.md can lock a line: tests'])
  expect(parsePolicy('tests: required   # locked', 'org').locked).toEqual(['tests'])
  // A comment that merely mentions the word later is a comment.
  expect(parsePolicy('tests: required   # not locked', 'org').locked).toEqual([])
})

test('a locked harness-policy holds every stage; an unlocked one inherits stage by stage', () => {
  const org = 'harness-policy: plan claude fable-5-1 high · implement claude fable-5-1 high   # locked'
  const held = resolvePolicy({ org, repo: 'harness-policy: plan codex gpt-5.6 xhigh' })
  expect(held.ok).toBe(false)
  expect(held.values.stages.plan).toEqual({ harness: 'claude', model: 'fable-5-1', effort: 'high' })
  const free = resolvePolicy({ org: org.replace('   # locked', ''), repo: 'harness-policy: plan codex gpt-5.6 xhigh' })
  expect(free.ok).toBe(true)
  expect(free.values.stages).toEqual({
    plan: { harness: 'codex', model: 'gpt-5.6', effort: 'xhigh' },
    implement: { harness: 'claude', model: 'fable-5-1', effort: 'high' },
  })
})

test('ordinary values inherit nearest-wins, and local dispatch cannot be inherited', () => {
  const result = resolvePolicy({ org: 'dispatch: local\ntests: required', group: 'tests: best-effort', repo: 'merge: squash' })
  expect(result.ok).toBe(true)
  expect(result.values.dispatch).toBe('off')
  expect(result.values.tests).toBe('best-effort')
  expect(result.sources.tests).toBe('group')
  expect(resolvePolicy({ repo: 'dispatch: local' }).values.dispatch).toBe('local')
})

test('a stage may pin no model: `default` means the tool\'s own, and an unknown effort refuses', () => {
  const layer = parsePolicy('harness-policy: plan claude default xhigh · review codex gpt-5.6-sol high')
  expect(layer.blocks).toEqual([])
  expect(layer.values.stages).toEqual({
    plan: { harness: 'claude', model: null, effort: 'xhigh' },
    review: { harness: 'codex', model: 'gpt-5.6-sol', effort: 'high' },
  })
  // Claude Code takes five levels, Codex seven; a level its harness does not take is a typo.
  expect(parsePolicy('harness-policy: plan claude default minimal').blocks).toContain('invalid or duplicate harness stage: plan')
  expect(parsePolicy('harness-policy: plan claude default hgih').blocks).toContain('invalid or duplicate harness stage: plan')
  expect(parsePolicy('harness-policy: plan claude default').blocks).toContain('invalid or duplicate harness stage: plan')
  expect(parsePolicy('harness-policy: plan codex default ultra').blocks).toEqual([])
})

test('the retired review knob is ignored, and review stays a harness stage', () => {
  for (const line of ['review: cross-agent-risky', 'review: subagent   # an old profile', 'review: none']) {
    const result = resolvePolicy({ repo: `${line}\ntests: required` })
    expect(result.blocks).toEqual([])
    expect(result.values.review).toBeUndefined()
    expect(result.values.tests).toBe('required')
  }
  const stage = parsePolicy('review: codex fixture-model xhigh')
  expect(stage.blocks).toEqual([])
  expect(stage.values.stages.review).toEqual({ harness: 'codex', model: 'fixture-model', effort: 'xhigh' })
})

test('chronicle on/off remains an ordinary knob alongside its harness stage', () => {
  for (const value of ['on', 'off']) {
    const result = resolvePolicy({ repo: `chronicle: ${value}\nharness-policy: chronicle codex fixture-model high` })
    expect(result.ok).toBe(true)
    expect(result.values.chronicle).toBe(value)
    expect(result.values.stages.chronicle).toEqual({ harness: 'codex', model: 'fixture-model', effort: 'high' })
  }
  expect(parsePolicy('chronicle: maybe').blocks).toContain('invalid or duplicate harness stage: chronicle')
})

test.each(['stats: maybe', 'stats: on\nstats: off', 'harness-policy: plan unknown model high', 'gates: 4', 'operators: not a login!', 'constructor: x'])(
  'known malformed input refuses: %s', text => {
    expect(resolvePolicy({ repo: text }).ok).toBe(false)
  })

test('examples and nested lines cannot become policy; unknown keys remain inert extensions', () => {
  const layer = parsePolicy('```md\nstats: off\n```\n  stats: off\nstats: on\ncustom: keep me', 'repo')
  expect(layer.values.stats).toBe('on')
  expect(layer.extensions.custom).toBe('keep me')
  expect(layer.blocks).toEqual([])
})

test('the control-room knob reads org, repo, group and a drafted-from sha, or nothing', () => {
  expect(parseControlRoomReference('control-room: acme/room#platform@a1b2c3d')).toEqual({ org: 'acme', repo: 'acme/room', group: 'platform', sha: 'a1b2c3d' })
  expect(parseControlRoomReference('control-room: none')).toBeNull()
  expect(parseControlRoomReference('tests: required')).toBeNull()
})

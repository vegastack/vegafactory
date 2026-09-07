import { describe, expect, test } from 'bun:test'
import { mergeRepoPolicy, parseFactoryConfig, parseRepoPolicy, stagePolicy } from '../src/config.ts'

describe('parseFactoryConfig', () => {
  test('applies the documented defaults and resolves ~ against the given home', () => {
    const config = parseFactoryConfig({ repos: [{ path: '~/code/app', repo: 'acme/app', org: 'acme' }] }, '/home/mk')
    expect(config.interval).toBe(120)
    expect(config.maxRuns).toBe(1)
    expect(config.subagents).toEqual({ spawnDepth: 1, concurrent: 3 })
    expect(config.repos[0]!.path).toBe('/home/mk/code/app')
    expect(config.stateFile).toBe('/home/mk/.vegastack/factory/state.json')
    expect(config.logRoot).toBe('/home/mk/.vegastack/factory/logs')
    expect(config.lockRoot).toBe('/home/mk/.vegastack/factory/locks')
    expect(config.dispatcherLock).toBe('/home/mk/.vegastack/factory/dispatcher.lock')
  })

  test('a repo entry missing a field is a named error, never a silent skip', () => {
    expect(() => parseFactoryConfig({ repos: [{ path: '/a' }] }, '/home/mk')).toThrow(/repos\[0\]\.repo/)
  })

  test('no repos at all is an error naming factory.json', () => {
    expect(() => parseFactoryConfig({}, '/home/mk')).toThrow(/factory\.json/)
  })

  test('an unreadable field is a named error, never a silent default', () => {
    expect(() => parseFactoryConfig({ repos: [{ path: '/a', repo: 'acme/app', org: 'acme' }], interval: 'soon' }, '/home/mk')).toThrow(/interval/)
    expect(() => parseFactoryConfig({ repos: [{ path: '/a', repo: 'acme/app', org: 'acme' }], maxRuns: 0 }, '/home/mk')).toThrow(/maxRuns/)
  })

  test('the control-room clone paths carried by the same file survive the read', () => {
    const config = parseFactoryConfig({
      repos: [{ path: '/a', repo: 'acme/app', org: 'acme' }],
      controlRooms: { acme: { repo: 'acme/cr', path: '/home/mk/.vegastack/control-room/acme', branch: 'main', lastSyncedAt: null, sha: null } },
    }, '/home/mk')
    expect(config.controlRoom.acme).toBe('/home/mk/.vegastack/control-room/acme')
  })
})

describe('parseRepoPolicy', () => {
  test('a dev.md with no dispatch knob is off — opting in is explicit', () => {
    expect(parseRepoPolicy('## Knobs\n\noperators: mk\n').dispatch).toBe('off')
  })

  test('reads dispatch, operators and the per-stage harness policy', () => {
    const policy = parseRepoPolicy('## Knobs\n\ndispatch: local\noperators: kmanojkumar, ada\nplan: claude fable-5-1 high\nimplement: claude fable-5-1 high\nreview: codex gpt-5.6 xhigh\n')
    expect(policy.dispatch).toBe('local')
    expect(policy.operators).toEqual(['kmanojkumar', 'ada'])
    expect(policy.stages.implement).toEqual({ harness: 'claude', model: 'fable-5-1', effort: 'high' })
    expect(policy.stages.review!.harness).toBe('codex')
  })

  test('an unknown dispatch value is off, not local', () => {
    expect(parseRepoPolicy('dispatch: yes\n').dispatch).toBe('off')
  })

  test('the single harness-policy line every real profile carries is read stage by stage', () => {
    const policy = parseRepoPolicy('dispatch: local\nharness-policy: intake claude fable-5-1 high · plan claude fable-5-1 high · implement claude fable-5-1 high · review codex gpt-5.6 xhigh   # a trailing comment\n')
    expect(policy.stages.plan).toEqual({ harness: 'claude', model: 'fable-5-1', effort: 'high' })
    expect(policy.stages.review).toEqual({ harness: 'codex', model: 'gpt-5.6', effort: 'xhigh' })
  })

  test('a knob that is not a stage policy is ignored rather than half-parsed', () => {
    const policy = parseRepoPolicy('dispatch: local\nreview: cross-agent-risky   # subagent | cross-agent-risky\n')
    expect(policy.stages.review).toBeUndefined()
  })

  test('a stage naming a harness this dispatcher cannot launch is ignored, never launched blind', () => {
    expect(parseRepoPolicy('dispatch: local\nimplement: hermes m high\n').stages.implement).toBeUndefined()
  })
})

describe('mergeRepoPolicy and stagePolicy', () => {
  test('dev.md overrides the group default key by key', () => {
    const merged = mergeRepoPolicy('plan: claude fable-5-1 high\nimplement: codex gpt-5.6 high\n', 'dispatch: local\nimplement: claude fable-5-1 high\n')
    expect(merged.stages.plan!.harness).toBe('claude')
    expect(merged.stages.implement!.harness).toBe('claude')
    expect(merged.dispatch).toBe('local')
  })

  test('a group default never opts a repo in — dispatch comes from the repo alone', () => {
    expect(mergeRepoPolicy('dispatch: local\n', 'operators: mk\n').dispatch).toBe('off')
  })

  test('corrections runs read the implement policy', () => {
    const policy = parseRepoPolicy('dispatch: local\nimplement: claude fable-5-1 high\n')
    expect(stagePolicy(policy, 'corrections')).toEqual({ harness: 'claude', model: 'fable-5-1', effort: 'high' })
  })

  test('a stage with no policy line throws naming the stage', () => {
    expect(() => stagePolicy(parseRepoPolicy('dispatch: local\n'), 'plan')).toThrow(/plan/)
  })
})

test('runtime policy inherits org stages and refuses invalid known policy', () => {
  const policy = mergeRepoPolicy('', 'dispatch: local', { org: 'implement: codex confirmed high' })
  expect(stagePolicy(policy, 'implement').model).toBe('confirmed')
  const bad = mergeRepoPolicy('', 'dispatch: local\ntests: never')
  expect(bad.refusal).toMatch(/tests/)
  expect(() => stagePolicy(bad, 'implement')).toThrow(/tests/)
})

test('configured room needs validated identity and freshness, while local-only stays supported', () => {
  const text = 'dispatch: local\ncontrol-room: acme/room#dev\nimplement: codex selected high'
  expect(mergeRepoPolicy('', text).refusal).toMatch(/unavailable/)
  const fresh = mergeRepoPolicy('', text, { org: 'stats: on', identity: { repo: 'acme/app', group: 'dev', roomSha: 'a'.repeat(40) }, freshness: { validatedAt: '2026-09-06T00:00:00Z', now: '2026-09-06T00:01:00Z' } })
  expect(fresh.refusal).toBeNull()
  expect(fresh.effective?.sources.stats.revision).toBe('a'.repeat(40))
})

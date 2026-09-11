import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { evaluateReclaim } from '../scripts/reclaim.mjs'

const skillRoot = resolve(import.meta.dir, '..')

const NOW = Date.parse('2026-08-29T12:00:00Z')
const working = (assignees = ['bot']) => ({ state: 'open', labels: [{ name: 'working' }, { name: 'full-plan' }], assignees: assignees.map((login) => ({ login })) })
const ledger = (updated_at: string) => ({ body: '<!-- vsk:v1 type=ledger branch=feat/x -->\n## Ledger', updated_at })

describe('evaluateReclaim: read-verify before releasing a claim', () => {
  test('a working issue whose ledger never got written is releasable', () => {
    const r = evaluateReclaim({ issue: working(), comments: [], now: NOW })
    expect(r.blocks).toEqual([])
    expect(r.plan.removeAssignees).toEqual(['bot'])
    expect(r.plan.ledgerAgeHours).toBeNull()
  })
  test('a working issue silent past the orphan threshold is releasable', () => {
    const r = evaluateReclaim({ issue: working(), comments: [ledger('2026-08-28T12:00:00Z')], orphanHours: 6, now: NOW })
    expect(r.blocks).toEqual([])
    expect(r.plan.ledgerAgeHours).toBe(24)
  })
  test('a fresh ledger refuses release unless forced', () => {
    const fresh = [ledger('2026-08-29T09:00:00Z')] // 3h ago, < 6h
    const refused = evaluateReclaim({ issue: working(), comments: fresh, orphanHours: 6, now: NOW })
    expect(refused.blocks.length).toBe(1)
    expect(refused.blocks[0]).toContain('may be live')
    const forced = evaluateReclaim({ issue: working(), comments: fresh, orphanHours: 6, force: true, now: NOW })
    expect(forced.blocks).toEqual([])
  })
  test('a non-working issue is nothing to reclaim', () => {
    const ready = { state: 'open', labels: [{ name: 'ready' }], assignees: [] }
    expect(evaluateReclaim({ issue: ready, comments: [], now: NOW }).blocks.some((b: string) => b.includes("not 'working'"))).toBe(true)
  })
  test('a closed issue is blocked', () => {
    const closed = { ...working(), state: 'closed' }
    expect(evaluateReclaim({ issue: closed, comments: [], now: NOW }).blocks.some((b: string) => b.includes('closed'))).toBe(true)
  })
  test('CLI fails closed: unreachable gh → exit 2, never a silent release', () => {
    const r = spawnSync('node', [join(skillRoot, 'scripts/reclaim.mjs'), '--issue', '5', '--repo', 'o/r', '--json'], {
      env: { ...process.env, VSK_GH: '/nonexistent-vsk-gh' }, encoding: 'utf8',
    })
    expect(r.status).toBe(2)
    expect(r.stdout + r.stderr).toContain('cannot verify')
  })
})

test('141 reclaim uses configured labels and never releases a mixed state, even forced', () => {
  const map = { needsOperator: 'Decision', needsPlan: 'Plan', ready: 'Go', working: 'Build', forOperator: 'Review' }
  const profile = 'workflow-labels: ' + JSON.stringify(map)
  const current = { ...working(), labels: [{ name: 'Build' }, { name: 'full-plan' }] }
  const result = evaluateReclaim({ issue: current, comments: [], devMd: profile, now: NOW })
  expect(result.blocks).toEqual([])
  expect(result.plan.labelMap).toEqual(map)
  current.labels.push({ name: 'Go' })
  expect(evaluateReclaim({ issue: current, comments: [], devMd: profile, force: true, now: NOW }).blocks.join()).toContain('conflicting')
})

test('141 installed standalone reclaim emits exact custom label mutation argv', async () => {
  const { copyFileSync, cpSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vsk-reclaim-installed-')))
  const scripts = join(root, 'scripts')
  mkdirSync(scripts)
  cpSync(join(skillRoot, 'scripts/lib'), join(scripts, 'lib'), { recursive: true })
  copyFileSync(join(skillRoot, 'scripts/reclaim.mjs'), join(scripts, 'reclaim.mjs'))
  copyFileSync(join(skillRoot, '../dev-setup/scripts/effective-policy.mjs'), join(scripts, 'effective-policy.mjs'))
  const profile = join(root, 'dev.md'), log = join(root, 'argv.jsonl'), gh = join(root, 'gh')
  writeFileSync(profile, 'workflow-labels: ' + JSON.stringify({ needsOperator: 'Decision', needsPlan: 'Plan', ready: 'Go', working: 'Build', forOperator: 'Review' }))
  writeFileSync(gh, '#!/usr/bin/env node\nimport {appendFileSync} from "node:fs"; const a=process.argv.slice(2); appendFileSync(' + JSON.stringify(log) + ',JSON.stringify(a)+"\\n"); console.log(JSON.stringify(a[0]==="api" && !a[1].endsWith("comments") ? {state:"open",labels:[{name:"Build"}],assignees:[]} : []));\n', { mode: 0o755 })
  const result = spawnSync('node', [join(scripts, 'reclaim.mjs'), '--issue', '5', '--repo', 'acme/app', '--dev-md', profile, '--json'], { cwd: root, env: { ...process.env, VSK_GH: gh, HOME: root }, encoding: 'utf8' })
  expect(result.status, result.stdout + result.stderr).toBe(1)
  expect(JSON.parse(result.stdout).ok).toBe(true)
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  expect(calls).toContainEqual(['issue', 'edit', '5', '-R', 'acme/app', '--remove-label', 'Build', '--add-label', 'Go'])
  copyFileSync(join(skillRoot, '../dev-status/scripts/status.mjs'), join(scripts, 'status.mjs'))
  const status = spawnSync('node', ['--input-type=module', '-e', 'import {readKnobs} from ' + JSON.stringify('file://' + join(scripts, 'status.mjs')) + '; import {readFileSync} from "node:fs"; console.log(JSON.stringify(readKnobs(readFileSync(' + JSON.stringify(profile) + ',"utf8"))));'], { cwd: root, encoding: 'utf8' })
  expect(status.status, status.stderr).toBe(0)
  expect(JSON.parse(status.stdout).states).toEqual(['Decision', 'Plan', 'Go', 'Build', 'Review'])
})

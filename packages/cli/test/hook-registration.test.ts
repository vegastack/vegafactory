import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readHookConfiguration, validateRegistration } from '../src/hook-registration.ts'

function fixture(harness: 'claude' | 'codex' = 'codex') {
  const checkout = mkdtempSync(join(tmpdir(), 'vf hook registration '))
  const guardPath = join(checkout, '.vegastack/hooks/ship-guard.mjs')
  mkdirSync(join(checkout, '.vegastack/hooks'), { recursive: true })
  writeFileSync(guardPath, '// trusted fixture target\n')
  const command = `node "${guardPath}" --harness ${harness}`
  const config = { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command }] }] } }
  return { checkout, guardPath, harness, config, command }
}

describe('supported direct guard registration', () => {
  for (const harness of ['claude', 'codex'] as const) {
    test(`${harness}: applicable direct node registration with quoted paths`, () => {
      const f = fixture(harness)
      expect(validateRegistration(f)).toEqual({ ok: true, problems: [] })
      for (const matcher of [undefined, '', '*', '.*', 'Bash', '^Bash$', 'Bash|Edit', '^(Bash|Edit)$']) {
        const config = { hooks: { PreToolUse: [{ matcher, hooks: [{ type: 'command', command: f.command }] }] } }
        expect(validateRegistration({ ...f, config }).ok, String(matcher)).toBe(true)
      }
    })
  }

  test('unrelated mentions, wrong events/types and restrictive shell matchers refuse', () => {
    const f = fixture()
    for (const config of [
      { unrelated: { command: 'echo ship-guard.mjs' } },
      { hooks: { Stop: [{ hooks: [{ type: 'command', command: f.command }] }] } },
      { hooks: { PreToolUse: [{ command: f.command }] } },
      { hooks: { PreToolUse: [{ hooks: [{ type: 'prompt', command: f.command }] }] } },
      ...['exec_command', 'shell', '^Edit$', 'Bash(ls:*)', '(?!)'].map(matcher => ({ hooks: { PreToolUse: [{ matcher, hooks: [{ type: 'command', command: f.command }] }] } })),
      { disableAllHooks: true, ...f.config },
    ]) expect(validateRegistration({ ...f, config }).ok, JSON.stringify(config)).toBe(false)
  })

  test('shell programs and incorrect argv never count as a direct guard call', () => {
    const f = fixture()
    for (const command of [
      'echo ship-guard.mjs', f.command.replace(' ', '\u00a0'), `echo ${f.command}`, `${f.command} && true`, `${f.command}; true`,
      `${f.command} | cat`, `${f.command} &`, `$(echo node) "${f.guardPath}" --harness codex`,
      `node "${f.guardPath}"`, `node "${f.guardPath}" --harness claude`,
      `${f.command} --check`, `env ${f.command}`, `node -e "${f.guardPath}" --harness codex`,
      `node "${f.guardPath}" --harness codex\n`, `node "${f.guardPath}" --harness codex > /tmp/out`,
      `node "${f.guardPath}" --harness codex --harness claude`,
    ]) {
      const config = { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command }] }] } }
      expect(validateRegistration({ ...f, config }).ok, command).toBe(false)
    }
  })

  test('guard must resolve inside the actual checkout without symlinks', () => {
    const f = fixture()
    const other = fixture()
    const command = `node "${other.guardPath}" --harness codex`
    expect(validateRegistration({ ...f, config: { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command }] }] } } }).ok).toBe(false)
    const linked = join(f.checkout, 'linked.mjs')
    symlinkSync(f.guardPath, linked)
    expect(validateRegistration({ ...f, guardPath: linked }).ok).toBe(false)
    expect(validateRegistration({ ...f, guardPath: join(f.checkout, 'missing.mjs') }).ok).toBe(false)
    const linkedDir = join(f.checkout, 'links')
    symlinkSync(join(f.checkout, '.vegastack/hooks'), linkedDir)
    expect(validateRegistration({ ...f, guardPath: join(linkedDir, 'ship-guard.mjs') }).ok).toBe(false)
  })

  test('an explicit interpreter must be an executable node binary', () => {
    const f = fixture()
    const node = join(f.checkout, 'node')
    writeFileSync(node, '#!/bin/sh\nexit 0\n')
    chmodSync(node, 0o600)
    const config = { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: `"${node}" "${f.guardPath}" --harness codex` }] }] } }
    expect(validateRegistration({ ...f, config }).ok).toBe(false)
    chmodSync(node, 0o700)
    // An unrelated executable named node must not replace the installed interpreter.
    expect(validateRegistration({ ...f, config }).ok).toBe(false)
  })
})


test('Codex JSON and inline layers merge without overwriting either file or adding duplicate hooks', () => {
  const f = fixture()
  mkdirSync(join(f.checkout, '.codex'))
  const json = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node other.mjs' }] }] } })
  const toml = 'model = "fixture"\n[[hooks.PreToolUse]]\nmatcher = "Bash"\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = ' + JSON.stringify(f.command) + '\n'
  writeFileSync(join(f.checkout, '.codex/hooks.json'), json)
  writeFileSync(join(f.checkout, '.codex/config.toml'), toml)
  const merged = readHookConfiguration(f.checkout, 'codex')
  expect(validateRegistration({ ...f, config: merged.config }).ok).toBe(true)
  expect(merged.sources).toHaveLength(2)
  expect(readFileSync(join(f.checkout, '.codex/hooks.json'), 'utf8')).toBe(json)
  expect(readFileSync(join(f.checkout, '.codex/config.toml'), 'utf8')).toBe(toml)
  writeFileSync(join(f.checkout, '.codex/hooks.json'), JSON.stringify(f.config))
  expect(readHookConfiguration(f.checkout, 'codex').sources).toHaveLength(2)
  // Same registration in two layers is observable; the reader does not install a third one.
  writeFileSync(join(f.checkout, '.codex/config.toml'), toml.replace('matcher = "Bash"\n', ''))
  expect(readHookConfiguration(f.checkout, 'codex').duplicateCommands).toHaveLength(1)
})

test('Claude local disabling and unsupported inline configurations refuse without writes', () => {
  const f = fixture('claude')
  mkdirSync(join(f.checkout, '.claude'))
  writeFileSync(join(f.checkout, '.claude/settings.json'), JSON.stringify(f.config))
  writeFileSync(join(f.checkout, '.claude/settings.local.json'), '{"disableAllHooks":true}')
  expect(validateRegistration({ ...f, config: readHookConfiguration(f.checkout, 'claude').config }).ok).toBe(false)
  mkdirSync(join(f.checkout, '.codex'))
  writeFileSync(join(f.checkout, '.codex/config.toml'), '[hooks]\nPreToolUse = [{ hooks = [] }]\n')
  expect(() => readHookConfiguration(f.checkout, 'codex')).toThrow(/unsupported inline/)
})

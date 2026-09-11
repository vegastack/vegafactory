import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectCodexConfiguration, readHookConfiguration, validateRegistration } from '../src/hook-registration.ts'

function fixture(harness: 'claude' | 'codex' = 'codex') {
  const checkout = realpathSync(mkdtempSync(join(tmpdir(), 'vf hook registration ')))
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

test('Codex feature-table hooks flags are not hook registrations', () => {
  const f = fixture()
  mkdirSync(join(f.checkout, '.codex'))
  const path = join(f.checkout, '.codex/config.toml')
  const features = '[features]\nhooks = true\nmemories = false\n'
  writeFileSync(path, features)
  expect(validateRegistration({ ...f, config: readHookConfiguration(f.checkout, 'codex').config }).ok).toBe(false)
  writeFileSync(join(f.checkout, '.codex/hooks.json'), JSON.stringify(f.config))
  const inline = '[[hooks.SessionStart]]\n[[hooks.SessionStart.hooks]]\ntype = "command"\ncommand = "node other.mjs"\n'
  for (const toml of [features, features + inline, inline + features, '']) {
    writeFileSync(path, toml)
    const merged = readHookConfiguration(f.checkout, 'codex')
    expect(validateRegistration({ ...f, config: merged.config }).ok).toBe(true)
    expect(merged.duplicateCommands).toEqual([])
    expect(readFileSync(path, 'utf8')).toBe(toml)
  }
})

test('unsupported real TOML hook tables and top-level assignments still refuse', () => {
  const f = fixture()
  mkdirSync(join(f.checkout, '.codex'))
  for (const toml of ['hooks = {}', 'hooks.PreToolUse = []', '"hooks" = {}', "'hooks' = {}", '[hooks]\nPreToolUse = []', '[features]\nhooks = true\n[hooks]\nPreToolUse = []']) {
    writeFileSync(join(f.checkout, '.codex/config.toml'), toml)
    expect(() => readHookConfiguration(f.checkout, 'codex')).toThrow(/unsupported inline/)
  }
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


test('bare node must agree with actual shell PATH resolution, including relative entries', () => {
  const f = fixture()
  const original = process.env.PATH
  const bin = join(f.checkout, 'relative-bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'node'), '#!/bin/sh\nprintf wrong-node\n')
  chmodSync(join(bin, 'node'), 0o755)
  const observed = Bun.spawnSync(['/bin/sh', '-c', f.command], { cwd: f.checkout, env: { ...process.env, PATH: `relative-bin:${original}` } })
  expect(observed.stdout.toString()).toBe('wrong-node')
  try {
    process.env.PATH = `relative-bin:${original}`
    expect(validateRegistration(f).ok).toBe(false)
  } finally { process.env.PATH = original }
  expect(validateRegistration(f).ok).toBe(true)
  const real = Bun.spawnSync(['/bin/sh', '-c', f.command], { cwd: f.checkout })
  expect(real.exitCode).toBe(0)
  expect(real.stdout.toString()).toBe('')
})

test('multiline TOML instruction strings never register their example hook commands', () => {
  const f = fixture()
  mkdirSync(join(f.checkout, '.codex'))
  const example = '[[hooks.PreToolUse]]\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = ' + JSON.stringify(f.command) + '\n[unrelated]\n'
  for (const delimiter of ["\"\"\"", "'".repeat(3)]) {
    const quotedExample = delimiter.startsWith('"') ? example.replaceAll('\\', '\\\\').replaceAll('"', '\\"') : example
    writeFileSync(join(f.checkout, '.codex/config.toml'), 'developer_instructions = ' + delimiter + '\n' + quotedExample + delimiter + '\n')
    expect(validateRegistration({ ...f, config: readHookConfiguration(f.checkout, 'codex').config }).ok).toBe(false)
    const instructions = readFileSync(join(f.checkout, '.codex/config.toml'), 'utf8')
    writeFileSync(join(f.checkout, '.codex/config.toml'), instructions + example.replace('[unrelated]\n', ''))
    expect(validateRegistration({ ...f, config: readHookConfiguration(f.checkout, 'codex').config }).ok).toBe(true)
  }
})


for (const mode of ['enabled', 'disabled', 'managed-only', 'missing-requirements', 'memory-on', 'wrong-checkout', 'loader-error', 'forced-memory', 'forced-import', 'forced-context']) {
  test(`external Codex metadata RPC: ${mode}`, async () => {
    const f = fixture()
    const nativeHome = join(f.checkout, 'native-home')
    mkdirSync(nativeHome)
    mkdirSync(join(f.checkout, '.codex'))
    const source = join(f.checkout, '.codex/hooks.json'), calls = join(f.checkout, 'rpc-calls')
    writeFileSync(source, JSON.stringify(f.config))
    const cli = join(f.checkout, 'codex-fixture')
    writeFileSync(cli, `#!/usr/bin/env node
const fs = require('node:fs'), readline = require('node:readline');
const cwd = ${JSON.stringify(f.checkout)}, source = ${JSON.stringify(source)}, command = ${JSON.stringify(f.command)}, mode = ${JSON.stringify(mode)};
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(calls)}, request.method + '\\n');
  if (request.id === undefined) return;
  let result = {};
  if (request.method === 'hooks/list') result = { data: [{ cwd: mode === 'wrong-checkout' ? '/other' : cwd, errors: mode === 'loader-error' ? [{}] : [], warnings: [], hooks: [{ handlerType:'command', eventName:'preToolUse', command, matcher:null, async:false, enabled:mode !== 'disabled', isManaged:false, currentHash:'sha256:' + 'a'.repeat(64), source:'project', sourcePath:source, trustStatus:'untrusted' }] }] };
  if (request.method === 'configRequirements/read' && request.params !== null) process.exit(2);
  if (request.method === 'configRequirements/read') result = mode === 'missing-requirements' ? {} : { requirements: mode === 'managed-only' ? { allowManagedHooksOnly:true } : mode.startsWith('forced-') ? { featureRequirements: { [mode === 'forced-memory' ? 'memories' : mode === 'forced-import' ? 'external_agent_memory_import' : 'context_management']:true } } : null };
  if (request.method === 'config/read') result = { config: { unrelatedSecret:'never-retain-me', projects:{ [cwd]:{ trust_level:'trusted' } }, memories:{use_memories:mode === 'memory-on', generate_memories:false}, features:{hooks:true,memories:false,external_agent_memory_import:false,context_management:{experimental_mode:false}} }, origins:{} };
  process.stdout.write(JSON.stringify({ id:request.id, result }) + '\\n');
});
`)
    chmodSync(cli, 0o755)
    const result = await inspectCodexConfiguration({ command: cli, args: [], cwd: f.checkout, env: { ...process.env, HOME: nativeHome, CODEX_HOME: nativeHome } })
    if (mode === 'enabled' || mode === 'memory-on') expect(result.hookApplicable).toBe(true)
    else expect(result.hookApplicable).toBe(false)
    if (mode === 'memory-on') expect(result.memoryRetrievalDisabled).toBe(false)
    if (mode === 'enabled') {
      expect(result.memoryRetrievalDisabled).toBe(true)
      expect(result.memoryGenerationDisabled).toBe(true)
      expect(result.hookHash).toBe('sha256:' + 'a'.repeat(64))
    }
    const methods = readFileSync(calls, 'utf8').trim().split('\n')
    expect(methods.slice(0, 2)).toEqual(['initialize', 'initialized'])
    expect(methods.slice(2).sort()).toEqual(['config/read', 'configRequirements/read', 'hooks/list'].sort())
    expect(JSON.stringify(result)).not.toContain('never-retain-me')
  }, 10000)
}

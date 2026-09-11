// Installing the dispatcher as a service on the operator's own machine: a launchd LaunchAgent on
// macOS, a systemd user unit on Linux. Both render as data and both are dry-run by default, because
// the thing being installed starts dark builds — the operator reads the file and the commands
// before either exists.
//
// A user agent, never a system daemon: the dispatcher runs as the operator, with the operator's own
// `gh` and harness authentication, and that is the whole identity model of #114. Nothing here needs
// or asks for root.
import { lstat, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, isAbsolute } from 'node:path'

export interface ServiceInput {
  platform: 'darwin' | 'linux'
  label: string
  binPath: string
  configPath: string
  logRoot: string
  home: string
  interval: number
}

export interface ServicePlan {
  unitPath: string
  write: { path: string; body: string }
  install: string[][]
  uninstall: string[][]
  status: string[]
}

export const SERVICE_LABEL = 'com.vegastack.factory'
export const SERVICE_UNIT = 'vegafactory'

function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function serviceArgs(input: ServiceInput): string[] {
  if (!isAbsolute(input.configPath)) throw new Error('dispatcher service requires the exact absolute config path')
  return ['dispatch', '--watch', '--config', input.configPath]
}

export function renderLaunchdPlist(input: ServiceInput): string {
  const args = [input.binPath, ...serviceArgs(input)].map(arg => `    <string>${xml(arg)}</string>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(input.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(join(input.logRoot, 'dispatcher.out.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(input.logRoot, 'dispatcher.err.log'))}</string>
</dict>
</plist>
`
}

export function renderSystemdUnit(input: ServiceInput): string {
  const word = (value: string): string => {
    if (!value || /[\x00-\x1f\x7f]/.test(value)) throw new Error('systemd service value contains a control character')
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '$$$$').replace(/%/g, '%%')}"`
  }
  return `[Unit]
Description=VegaFactory dispatcher — headless runs in feature worktrees
After=network-online.target

[Service]
Type=simple
ExecStart=${[input.binPath, ...serviceArgs(input)].map(word).join(' ')}
Restart=always
RestartSec=${input.interval}
StandardOutput=${word('append:' + join(input.logRoot, 'dispatcher.out.log'))}
StandardError=${word('append:' + join(input.logRoot, 'dispatcher.err.log'))}

[Install]
WantedBy=default.target
`
}

export function servicePlan(input: ServiceInput): ServicePlan {
  if (input.platform === 'linux') {
    const unitPath = join(input.home, '.config', 'systemd', 'user', `${SERVICE_UNIT}.service`)
    return {
      unitPath,
      write: { path: unitPath, body: renderSystemdUnit(input) },
      // Lingering first: without it a user unit stops the moment the operator logs out, which on an
      // always-on box is exactly when it needs to be running.
      install: [
        ['loginctl', 'enable-linger'],
        ['systemctl', '--user', 'enable', '--now', SERVICE_UNIT],
      ],
      uninstall: [
        ['systemctl', '--user', 'disable', '--now', SERVICE_UNIT],
      ],
      status: ['systemctl', '--user', 'status', SERVICE_UNIT],
    }
  }
  const unitPath = join(input.home, 'Library', 'LaunchAgents', `${input.label}.plist`)
  const domain = `gui/${process.getuid?.() ?? 501}`
  return {
    unitPath,
    write: { path: unitPath, body: renderLaunchdPlist(input) },
    install: [['launchctl', 'bootstrap', domain, unitPath]],
    uninstall: [['launchctl', 'bootout', `${domain}/${input.label}`]],
    status: ['launchctl', 'print', `${domain}/${input.label}`],
  }
}

export async function writeUnit(plan: ServicePlan): Promise<void> {
  try {
    const stats = await lstat(plan.write.path)
    if (stats.isSymbolicLink()) throw new Error(`refusing to write ${plan.write.path}: it is a symlink`)
  } catch (error) {
    if ((error as Error).message.startsWith('refusing to write')) throw error
  }
  await mkdir(dirname(plan.write.path), { recursive: true })
  await writeFile(plan.write.path, plan.write.body)
}

// --- the verb ---------------------------------------------------------------

export function serviceUsage(): string {
  return `Usage: vegafactory service <install|uninstall|status> [--write] [--json] [--config PATH] [--bin PATH]

  install     write the launchd LaunchAgent (macOS) or systemd user unit (Linux) and load it
  uninstall   unload it
  status      ask the service manager what it thinks is running

Dry run until --write: install prints the unit file it would write and every command it
would run, and does neither. The dispatcher runs as you, with your own gh and harness
authentication — which is why installing it is your call and not an agent's.
Use one non-root dispatcher account and one lockRoot per host. Copied configuration
does not enroll another machine; corrupt or abandoned claims require offline recovery.
`
}

export interface ServiceArgs { verb: 'install' | 'uninstall' | 'status'; write: boolean; json: boolean; config: string | null; bin: string | null }

export function parseServiceArgs(argv: string[]): ServiceArgs {
  const head = argv[0]
  if (head !== 'install' && head !== 'uninstall' && head !== 'status') {
    throw new Error(`Unknown service verb: ${head ?? '(none)'} — expected install|uninstall|status`)
  }
  const args: ServiceArgs = { verb: head, write: false, json: false, config: null, bin: null }
  const rest = argv.slice(1)
  while (rest.length) {
    const token = rest.shift()!
    if (token === '--write') args.write = true
    else if (token === '--dry-run') args.write = false
    else if (token === '--json') args.json = true
    else if (token === '--config' || token === '--bin') {
      const value = rest.shift()
      if (value === undefined || value.startsWith('-')) throw new Error(`${token} requires a path`)
      if (token === '--config') args.config = value
      else args.bin = value
    }
    else throw new Error(`Unknown option: ${token}`)
  }
  return args
}

export interface ServiceRunDeps {
  platform: () => NodeJS.Platform
  run: (command: string[]) => Promise<{ ok: boolean; message: string }>
  write: (plan: ServicePlan) => Promise<void>
}

export function serviceInputFor(options: { home: string; configPath: string; binPath: string; platform: 'darwin' | 'linux' }): ServiceInput {
  return {
    platform: options.platform,
    label: SERVICE_LABEL,
    binPath: options.binPath,
    configPath: options.configPath,
    logRoot: join(options.home, '.vegastack', 'factory', 'logs'),
    home: options.home,
    interval: 120,
  }
}

async function defaultRun(command: string[]): Promise<{ ok: boolean; message: string }> {
  const { spawn } = await import('node:child_process')
  return new Promise(resolve => {
    const child = spawn(command[0]!, command.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] })
    let message = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { message += chunk })
    child.stderr.on('data', (chunk: string) => { message += chunk })
    child.on('error', error => resolve({ ok: false, message: (error as Error).message }))
    child.on('close', code => resolve({ ok: code === 0, message: message.trim() }))
  })
}

export async function runServiceCli(argv: string[], home: string, deps?: Partial<ServiceRunDeps>): Promise<number> {
  let args: ServiceArgs
  try {
    args = parseServiceArgs(argv)
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${serviceUsage()}`)
    return 2
  }
  const platform = (deps?.platform ?? (() => process.platform))()
  if (platform !== 'darwin' && platform !== 'linux') {
    console.error(`vegafactory service supports macOS and Linux; this machine reports ${platform}`)
    return 2
  }
  const run = deps?.run ?? defaultRun
  const write = deps?.write ?? writeUnit
  const input = serviceInputFor({
    home,
    configPath: args.config ?? join(home, '.vegastack', 'factory.json'),
    binPath: args.bin ?? process.argv[1] ?? 'vegafactory',
    platform,
  })
  const plan = servicePlan(input)
  const commands = args.verb === 'install' ? plan.install : args.verb === 'uninstall' ? plan.uninstall : [plan.status]

  if (args.verb !== 'status' && !args.write) {
    const payload = {
      command: 'service',
      verb: args.verb,
      dryRun: true,
      unitPath: plan.unitPath,
      unit: args.verb === 'install' ? plan.write.body : null,
      commands,
    }
    if (args.json) console.log(JSON.stringify(payload, null, 2))
    else {
      console.log(`would ${args.verb} ${plan.unitPath}`)
      if (args.verb === 'install') console.log(plan.write.body)
      for (const command of commands) console.log(`  would run: ${command.join(' ')}`)
      console.log('  (dry run — re-run with --write to do it)')
    }
    return 0
  }

  if (args.verb === 'install') await write(plan)
  const results: { command: string[]; ok: boolean; message: string }[] = []
  for (const command of commands) {
    const result = await run(command)
    results.push({ command, ...result })
  }
  const ok = results.every(result => result.ok)
  if (args.json) console.log(JSON.stringify({ command: 'service', verb: args.verb, dryRun: false, unitPath: plan.unitPath, ok, results }, null, 2))
  else {
    if (args.verb === 'install') console.log(`wrote ${plan.unitPath}`)
    for (const result of results) console.log(`  ${result.ok ? 'ok' : 'failed'}: ${result.command.join(' ')}${result.message ? ` — ${result.message}` : ''}`)
  }
  return ok ? 0 : 1
}

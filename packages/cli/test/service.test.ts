import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseServiceArgs, renderLaunchdPlist, renderSystemdUnit, runServiceCli, servicePlan,
  type ServiceInput,
} from '../src/service.ts'

const input: ServiceInput = {
  platform: 'darwin', label: 'com.vegastack.factory', binPath: '/usr/local/bin/vegafactory',
  configPath: '/home/mk/.vegastack/factory.json', logRoot: '/home/mk/.vegastack/factory/logs',
  home: '/home/mk', interval: 120,
}

describe('renderLaunchdPlist', () => {
  test('keeps the dispatcher alive across logout and boot, running dispatch --watch', () => {
    const plist = renderLaunchdPlist(input)
    expect(plist).toContain('<key>Label</key>')
    expect(plist).toContain('<string>com.vegastack.factory</string>')
    expect(plist).toContain('<key>KeepAlive</key>')
    expect(plist).toContain('<key>RunAtLoad</key>')
    expect(plist).toContain('<string>/usr/local/bin/vegafactory</string>')
    expect(plist).toContain('<string>--watch</string>')
    expect(plist).toContain('/home/mk/.vegastack/factory/logs')
  })

  test('a path carrying XML metacharacters is escaped, never interpolated raw', () => {
    const plist = renderLaunchdPlist({ ...input, binPath: '/opt/a&b/vegafactory' })
    expect(plist).toContain('/opt/a&amp;b/vegafactory')
    expect(plist).not.toContain('/opt/a&b/vegafactory')
  })
})

describe('renderSystemdUnit', () => {
  test('is a user unit that restarts and starts at login', () => {
    const unit = renderSystemdUnit({ ...input, platform: 'linux' })
    expect(unit).toContain('[Service]')
    expect(unit).toContain('ExecStart="/usr/local/bin/vegafactory" "dispatch" "--watch" "--config" "/home/mk/.vegastack/factory.json"')
    expect(unit).toContain('Restart=always')
    expect(unit).toContain('WantedBy=default.target')
  })

  test('quotes exact executable, config and log paths containing systemd metacharacters', () => {
    const unit = renderSystemdUnit({ ...input, platform: 'linux',
      binPath: '/opt/Vega $Factory/bin/vega%factory',
      configPath: '/home/operator/Vega "Factory"/factory.json',
      logRoot: '/home/operator/Vega Factory/logs' })
    expect(unit).toContain('ExecStart="/opt/Vega $$Factory/bin/vega%%factory" "dispatch" "--watch" "--config" "/home/operator/Vega \\"Factory\\"/factory.json"')
    expect(unit).toContain('StandardOutput="append:/home/operator/Vega Factory/logs/dispatcher.out.log"')
    expect(unit).toContain('StandardError="append:/home/operator/Vega Factory/logs/dispatcher.err.log"')
  })
})

describe('servicePlan', () => {
  test('macOS writes a LaunchAgent and bootstraps it', () => {
    const plan = servicePlan(input)
    expect(plan.unitPath).toBe('/home/mk/Library/LaunchAgents/com.vegastack.factory.plist')
    expect(plan.write.path).toBe(plan.unitPath)
    expect(plan.install.some(command => command[0] === 'launchctl' && command.includes('bootstrap'))).toBe(true)
    expect(plan.uninstall.some(command => command[0] === 'launchctl' && command.includes('bootout'))).toBe(true)
    expect(plan.status[0]).toBe('launchctl')
  })

  test('Linux writes a user unit, enables lingering, then enables the service', () => {
    const plan = servicePlan({ ...input, platform: 'linux' })
    expect(plan.unitPath).toBe('/home/mk/.config/systemd/user/vegafactory.service')
    expect(plan.install[0]).toEqual(['loginctl', 'enable-linger'])
    expect(plan.install[1]).toEqual(['systemctl', '--user', 'enable', '--now', 'vegafactory'])
    expect(plan.status).toEqual(['systemctl', '--user', 'status', 'vegafactory'])
  })

  test('the unit body is the rendered file for that platform', () => {
    expect(servicePlan(input).write.body).toBe(renderLaunchdPlist(input))
    expect(servicePlan({ ...input, platform: 'linux' }).write.body).toBe(renderSystemdUnit({ ...input, platform: 'linux' }))
  })
})

describe('parseServiceArgs', () => {
  test('dry run is the default and --write is the only way to act', () => {
    expect(parseServiceArgs(['install']).write).toBe(false)
    expect(parseServiceArgs(['install', '--write']).write).toBe(true)
  })

  test('an unknown verb is a usage error naming the three that exist', () => {
    expect(() => parseServiceArgs(['start'])).toThrow(/install\|uninstall\|status/)
  })
})

describe('runServiceCli', () => {
  test('install without --write writes nothing and runs nothing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'vsk-svc-'))
    const ran: string[][] = []
    const code = await runServiceCli(['install', '--json', '--bin', '/usr/local/bin/vegafactory'], home, {
      platform: () => 'darwin',
      run: async command => { ran.push(command); return { ok: true, message: '' } },
      write: async () => { throw new Error('a dry run must not write') },
    })
    expect(code).toBe(0)
    expect(ran).toEqual([])
    expect(existsSync(join(home, 'Library/LaunchAgents/com.vegastack.factory.plist'))).toBe(false)
  })

  test('install --write writes the unit and runs the install commands in order', async () => {
    const home = mkdtempSync(join(tmpdir(), 'vsk-svc-'))
    const ran: string[][] = []
    const code = await runServiceCli(['install', '--write', '--json', '--bin', '/usr/local/bin/vegafactory'], home, {
      platform: () => 'linux',
      run: async command => { ran.push(command); return { ok: true, message: '' } },
    })
    expect(code).toBe(0)
    expect(ran[0]).toEqual(['loginctl', 'enable-linger'])
    expect(readFileSync(join(home, '.config/systemd/user/vegafactory.service'), 'utf8')).toContain('"dispatch" "--watch"')
  })

  test('a service manager that refuses is exit 1 with its message, not a claimed success', async () => {
    const home = mkdtempSync(join(tmpdir(), 'vsk-svc-'))
    const code = await runServiceCli(['status', '--json'], home, {
      platform: () => 'linux',
      run: async () => ({ ok: false, message: 'Unit vegafactory.service could not be found.' }),
    })
    expect(code).toBe(1)
  })

  test('an unsupported platform is refused rather than half-installed', async () => {
    const code = await runServiceCli(['install', '--write'], '/home/mk', { platform: () => 'win32' })
    expect(code).toBe(2)
  })
})

test('137 service refuses a relative configuration that could select another lock root',()=>{
 expect(()=>renderLaunchdPlist({...input,configPath:'factory.json'})).toThrow('absolute config')
 expect(()=>renderSystemdUnit({...input,configPath:'factory.json'})).toThrow('absolute config')
})

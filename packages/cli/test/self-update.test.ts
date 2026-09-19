import { describe, expect, test } from 'bun:test'
import { maintainSelfUpdate, selfUpdateMode, SELF_UPDATE_LIMIT_S, type UpdateRunner } from '../src/self-update.ts'

describe('the VegaFactory updater', () => {
  test('the explicit update is version-guarded, runs plain npm, and always returns a usable result', async () => {
    const calls: Array<[string, string[], number]> = []
    const run: UpdateRunner = (command, args, timeout) => {
      calls.push([command, args, timeout])
      return command === 'npm'
        ? { code: 0, stdout: 'changed 1 package', stderr: '' }
        : { code: 0, stdout: '0.21.0\n', stderr: '' }
    }
    const updated = await maintainSelfUpdate({ mode: 'auto', before: '0.20.1', latest: async () => '0.21.0', run })
    expect(updated).toMatchObject({ action: 'updated', before: '0.20.1', after: '0.21.0', latest: '0.21.0' })
    expect(updated.message).toBe('updated vegafactory 0.20.1 → 0.21.0')
    expect(calls[0]).toEqual(['npm', ['install', '-g', '@vegastack/vegafactory@latest'], SELF_UPDATE_LIMIT_S * 1000])

    calls.length = 0
    const current = await maintainSelfUpdate({ mode: 'auto', before: '0.21.0', latest: async () => '0.21.0', run })
    expect(current.message).toBe('vegafactory 0.21.0 is already current')
    expect(calls).toEqual([])

    const failed = await maintainSelfUpdate({ mode: 'auto', before: '0.20.1', latest: async () => '0.21.0', run: () => { throw new Error('read-only prefix') } })
    expect(failed).toMatchObject({ action: 'failed', before: '0.20.1', after: '0.20.1' })
    expect(failed.message).toContain('continuing with vegafactory 0.20.1')
  })

  test('the profile knob has one safe three-state reading', () => {
    expect(selfUpdateMode('')).toBe('auto')
    expect(selfUpdateMode('vegafactory-update: off\n')).toBe('off')
    expect(selfUpdateMode('vegafactory-update: notify   # report only\n')).toBe('notify')
    expect(selfUpdateMode('vegafactory-update: auto\nvegafactory-update: off\n')).toBe('off')
    expect(selfUpdateMode('vegafactory-update: yes\n')).toBe('off')
  })
})


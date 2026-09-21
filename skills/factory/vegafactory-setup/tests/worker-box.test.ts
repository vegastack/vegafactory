import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const template = readFileSync(join(import.meta.dir, '../assets/control-room/onboarding/worker-box.md.template'), 'utf8')

test('worker-box onboarding describes the multi-repository worker boundary', () => {
  for (const text of [
    'comma-separated list of explicit `OWNER/NAME` repositories',
    '`*` or `all` is refused rather than expanded',
    '~/.vegafactory/worker/repos/<owner>__<repo>/repo',
    'Each board separately mints an hour-long token narrowed to that repository',
    'The `runs` cap is one shared budget across every board on this machine',
    'two different repositories may each use their own ship slot',
    '`owner/repo#issue`',
    'its checkout stays in place for attended reclamation',
    '`worker.log` and `worker.err.log` under `~/.vegafactory/worker/`',
  ]) expect(template).toContain(text)
  expect(template).not.toContain("repository's own `.vegastack/.tmp/worker/`")
})

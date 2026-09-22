import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const template = readFileSync(join(import.meta.dir, '../assets/control-room/onboarding/worker-box.md.template'), 'utf8')
const reference = readFileSync(join(import.meta.dir, '../references/control-room.md'), 'utf8')
const githubApp = readFileSync(join(import.meta.dir, '../../../dev/dev-setup/references/github-app.md'), 'utf8')

test('nodes roster grants only explicit repositories', () => {
  expect(reference).toContain('comma-separated list of explicit `OWNER/NAME` repositories')
  expect(reference).toContain('an empty cell authorises nothing')
  expect(reference).toContain('`*` or `all` is refused rather than expanded')
  expect(reference).not.toContain('`*` or `all` has to be said out loud')
})

test('the App is the dedicated worker account own GitHub and Git identity', () => {
  for (const text of [
    '| Contents | Read and write |',
    'Workflows stays at No access',
    'has no human `gh` login or SSH key',
    'permission-contents: read',
    'nonce-ref `git push --dry-run`',
  ]) expect(githubApp).toContain(text)
  expect(githubApp).not.toContain("pushes with the machine's own login")
})

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
    'runtime records and logs are `0600`',
    '`worker disable` validates current and legacy child records before unloading',
    '`~/.vegafactory/worker/quarantine/`',
    'Old descriptors reach EOF and cannot see later output',
    'no human `gh` login or SSH key',
    'Contents read/write and Workflows denied',
    'App-token HTTPS dry-run push',
  ]) expect(template).toContain(text)
  expect(template).not.toContain("repository's own `.vegastack/.tmp/worker/`")
  expect(template).not.toContain("box's own login")
})

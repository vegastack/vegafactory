#!/usr/bin/env node
// Runs the suite with this product's home pointed at a temporary directory.
//
// Every command settles the machine's home before it runs anything, so a test that spawns the CLI
// without saying where that home is would settle the home of whoever ran the tests — moving their
// control room, their config and their App key. That is not hypothetical: it happened on the
// machine this was written on, from a test that spawns the CLI to check something else entirely.
//
// It has to be set here, outside the test process, for two reasons a preload cannot cover: Bun's
// `os.homedir()` asks the operating system rather than reading `$HOME`, and Bun's `spawnSync` does
// not pass on changes a preload makes to `process.env`. A child inherits what the runner started
// with, so the runner is where it belongs.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'vf-test-home-'))
const argv = process.argv.slice(2)
const command = argv.length ? argv : ['bun', 'test', './packages', './skills', './tooling', './scripts']
try {
  const run = spawnSync(command[0], command.slice(1), {
    stdio: 'inherit',
    env: { ...process.env, VEGAFACTORY_HOME: home },
  })
  process.exit(run.status ?? 1)
} finally {
  rmSync(home, { recursive: true, force: true })
}

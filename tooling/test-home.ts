// Loaded before every test file. Every command now settles this machine's home before it runs
// anything, so a test that spawns the CLI without saying where that home is would settle the home
// of whoever ran the tests — moving their control room, their config and their App key, and then
// leaving them for whatever cleans up afterwards.
//
// That is not hypothetical: it happened on the machine this was written on, from a test that
// spawns the CLI to check something else entirely.
//
// `$HOME` is not enough on its own — Bun's `os.homedir()` asks the operating system rather than
// reading the variable — so this names the product's own override, which a child process inherits.
// A test that passes a home of its own still wins over it.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.VEGAFACTORY_HOME ||= mkdtempSync(join(tmpdir(), 'vf-test-home-'))

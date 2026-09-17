#!/usr/bin/env node
// Runs on `bun install`: points git at the repo's .githooks folder (the commit-msg check). Outside a git
// checkout (for example an unpacked tarball) there is nothing to enable; inside one,
// a failure to set the hook path fails the install instead of passing silently.
import { spawnSync } from 'node:child_process'

const inside = spawnSync('git', ['rev-parse', '--git-dir'], { stdio: 'ignore' })
if (inside.error || inside.status !== 0) process.exit(0)
const set = spawnSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'inherit' })
process.exit(set.status ?? 1)

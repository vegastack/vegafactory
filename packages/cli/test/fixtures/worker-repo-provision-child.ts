import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureWorkerCheckout, type RepoCommand } from '../../src/worker-repo.ts'

const [home, barrier] = process.argv.slice(2)
if (!home || !barrier) throw new Error('usage: worker-repo-provision-child <home> <barrier>')

const git = (args: string[], cwd?: string) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } })
  if (result.status !== 0) throw new Error(result.stderr)
}

const repositoryAt = (path: string, origin: string) => {
  mkdirSync(path, { recursive: true })
  git(['init', '--quiet', path])
  writeFileSync(join(path, 'README.md'), 'fixture\n')
  git(['add', 'README.md'], path)
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '--quiet', '-m', 'fixture'], path)
  git(['remote', 'add', 'origin', origin], path)
}

let entered = false
const run: RepoCommand = (command, args, options) => {
  if (args.includes('clone')) {
    repositoryAt(args.at(-1)!, args.at(-2)!)
    entered = true
    writeFileSync(join(barrier, `entered-${process.pid}`), '', { flag: 'wx' })
    while (!existsSync(join(barrier, 'release'))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    return { code: 0, stdout: '', stderr: '' }
  }
  const result = spawnSync(command, args, { cwd: options.cwd, env: options.env, encoding: 'utf8' })
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

writeFileSync(join(barrier, `started-${process.pid}`), '', { flag: 'wx' })
const result = await ensureWorkerCheckout({ repo: 'o/r', home, env: process.env, token: 'secret', run, lock: { timeoutMs: 5000 } })
process.stdout.write(JSON.stringify({ result, entered }))
process.exitCode = result.ok ? 0 : 1

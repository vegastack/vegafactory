import { spawnSync } from 'node:child_process'

// A PID alone is reusable. `ps lstart` is stable for a process's lifetime on the macOS/Linux
// platforms VegaFactory supports, so a lock can distinguish its original owner from a later
// process assigned the same number. An unreadable start stays unknown and therefore conservative.
export function processStart(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid < 1) return null
  const result = spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 1000,
  })
  if (result.status !== 0) return null
  return (result.stdout ?? '').trim() || null
}

export const currentProcessStart = processStart(process.pid)

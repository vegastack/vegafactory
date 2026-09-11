#!/usr/bin/env node
// SessionEnd requests only a bounded local flush. Never block exit, continue a turn,
// forward transcript/tool payloads, or start detached delivery/model work.
import { pathToFileURL } from 'node:url'

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    // The installer copies the shared SessionStart adapter with either consumer.
    // A missing sibling is an advisory failure, not an exit-blocking module error.
    const { runAdvisoryHook } = await import('./session-start.mjs')
    await runAdvisoryHook('SessionEnd', process.argv.slice(2))
  } catch { /* missing CLI/adapter, invalid input and timeout remain non-blocking */ }
  process.exit(0)
}

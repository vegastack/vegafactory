#!/usr/bin/env node
// Decision reminders remain session prose. This compatibility Stop hook only
// requests the same bounded, deduplicated local flush as stop-heartbeat.
//
// Installed to .vegastack/hooks/decision-nudge.mjs and wired on the Stop event. It replaces
// the inline shell recipe this skill used to carry: Node is guaranteed by the installer while
// `jq` is not, and a hook that silently exits because `jq` is missing is a guard that is not
// there. The prose instruction in the AGENTS.md dev section remains the portable base; this
// is a deterministic nudge on top of it, not a replacement.

import { pathToFileURL } from 'node:url'

export const NUDGE_REASON =
  'Before finishing: if this session settled a directional choice (the Decisions test in .vegastack/dev.md), propose one dated register line and ask the user to confirm; otherwise finish.'

const DIRECTIONAL = /decided|chose|instead of|convention|from now on|standardi[sz]|switch(ed|ing)? to/i

export function isDirectional(message) {
  return typeof message === 'string' && DIRECTIONAL.test(message)
}

// Directional changes remain proposals in the session, never a Stop continuation
// or an unchecked session ID used as a temporary-file destination.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { runAdvisoryHook } = await import('./session-start.mjs')
    await runAdvisoryHook('Stop', process.argv.slice(2))
  } catch { /* advisory only */ }
  process.exit(0)
}

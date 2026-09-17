// Runtime rules every headless agent run follows: Claude Code and Codex run on their
// subscriptions only, and never on an API key or a redirected endpoint.

// Variables that switch either tool to pay-per-token billing or another endpoint.
export const BILLING_VARIABLES = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_PROFILE',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
] as const

// Variables a parent Claude Code session sets for itself; a child run must not inherit them.
const PARENT_SESSION_PREFIXES = ['CLAUDE_CODE_', 'CLAUDECODE', 'CLAUDE_AGENT_SDK', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_SSH_']

const isSet = (value: string | undefined) => typeof value === 'string' && value.trim() !== '' && value !== '0'

export function billingVariables(env: NodeJS.ProcessEnv): string[] {
  return BILLING_VARIABLES.filter((name) => isSet(env[name]))
}

// The environment for a headless `claude -p` / `codex exec` child. Variables the parent
// Claude Code app set for itself are removed; anything else that would bill or redirect
// the run is refused with the exact names so the operator can unset them.
export function childEnvironment(env: NodeJS.ProcessEnv, { insideClaudeCode = isSet(env.CLAUDECODE) || isSet(env.CLAUDE_CODE_ENTRYPOINT) } = {}): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(env)) {
    if (insideClaudeCode && PARENT_SESSION_PREFIXES.some((prefix) => name.startsWith(prefix))) continue
    child[name] = value
  }
  // The desktop app points ANTHROPIC_BASE_URL at its own proxy; that belongs to the parent only.
  if (insideClaudeCode) delete child.ANTHROPIC_BASE_URL
  const refused = billingVariables(child)
  if (refused.length) {
    throw new Error(`refusing to start an agent run while ${refused.join(', ')} ${refused.length === 1 ? 'is' : 'are'} set — VegaFactory runs Claude Code and Codex on their subscriptions only; unset ${refused.length === 1 ? 'it' : 'them'} and retry`)
  }
  return child
}

export function assertSupportedPlatform(platform = process.platform) {
  if (platform === 'win32') throw new Error('VegaFactory runs on macOS and Linux — on Windows, use it inside WSL')
}

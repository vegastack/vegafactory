// The workflow labels. An issue carries exactly one state label at a time.
export const STATES = ['waiting-on-operator', 'planning', 'queued', 'in-progress', 'ready-to-ship'] as const
export const SIZES = ['small', 'medium', 'large'] as const
export const FLAGS = ['risky', 'epic', 'research'] as const
export type State = typeof STATES[number]

export const LABEL_SPECS: Array<{ name: string; color: string; description: string }> = [
  { name: 'waiting-on-operator', color: 'FBCA04', description: 'A person must ack or give input (brief, plan, or help after a handback)' },
  { name: 'planning', color: 'E36209', description: 'Brief acked - a plan is being written (medium/large)' },
  { name: 'queued', color: '0E8A16', description: 'Approved - waiting to be built' },
  { name: 'in-progress', color: '1D76DB', description: 'Held by a session or a worker - see the status comment' },
  { name: 'ready-to-ship', color: '5319E7', description: "Built and reviewed - comment changes or say 'ship it'" },
  { name: 'small', color: 'C2E0C6', description: 'Size: brief and plan together, one ack' },
  { name: 'medium', color: '76C7C0', description: 'Size: brief ack, then a separate plan and plan ack' },
  { name: 'large', color: '2A9D8F', description: 'Size: planning splits it into sub-issues under an epic' },
  { name: 'risky', color: 'B60205', description: 'Touches security, money, data, or production' },
  { name: 'epic', color: '24292E', description: 'Parent issue holding the map - never workable itself' },
  { name: 'research', color: 'C5DEF5', description: 'A question to answer - no kept code' },
]

export function stateOf(labels: string[]): { state: State | null; problem: string | null } {
  const found = STATES.filter((state) => labels.includes(state))
  if (found.length === 1) return { state: found[0]!, problem: null }
  if (found.length === 0) return { state: null, problem: 'no state label' }
  return { state: null, problem: `several state labels: ${found.join(', ')}` }
}

export function sizeOf(labels: string[]): string | null {
  const found = [...SIZES, 'research'].filter((size) => labels.includes(size))
  return found.length === 1 ? found[0]! : null
}

// The label edit that moves an issue to `next`, dropping any other state label.
export function transition(labels: string[], next: State): { add: string[]; remove: string[] } {
  return {
    add: labels.includes(next) ? [] : [next],
    remove: STATES.filter((state) => state !== next && labels.includes(state)),
  }
}

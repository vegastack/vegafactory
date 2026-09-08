export const meta = {
  name: 'implement-children',
  description: 'Compatibility entry that directs independent children to the verified CLI owner',
  whenToUse: 'An older installation invokes this workflow; use vegafactory children run from the registered parent session.',
  phases: [{ title: 'Build children', detail: 'the verified CLI owns child execution and integration' }],
}

// Retain the discoverable name for existing installations. A saved workflow
// cannot replace durable execution, subscription qualification or source checks.
export default async function () {
  throw new Error('Use vegafactory children run from the registered parent session; this legacy workflow does not execute children.')
}

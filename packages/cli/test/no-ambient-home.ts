// Every suite that builds a temporary home and then calls the path helpers has to say this first.
//
// `VEGAFACTORY_HOME` is the whole home when it is set, by contract, so it wins over the `home` a
// test passes. A developer with it set in their shell would have `statsDirectory(home)` answer
// about somewhere else entirely — and the suites do not only read those paths, they create,
// truncate and remove them. Failing loudly before a single test runs is the only honest answer;
// a check at the end runs after the damage.
import { beforeAll } from 'bun:test'
import { HOME_VARIABLE } from '../src/home.ts'

export function refuseAmbientHome(): void {
  beforeAll(() => {
    const named = process.env[HOME_VARIABLE]?.trim()
    if (named) throw new Error(`Unset ${HOME_VARIABLE} (it is ${named}) before running the tests: the helpers under test obey it, and these suites write to what they return.`)
  })
}

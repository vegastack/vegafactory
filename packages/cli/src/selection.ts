// Which skills does a set of flags mean?
//
// Kept in its own module, deliberately free of side effects: index.ts calls main() at load, so
// anything exported from there cannot be imported by a test without running the CLI.
//
// Two independent axes, and they must stay independent:
//   group    — where a skill is authored (skills/<group>/<name>/). A selection concept only:
//              the packaged bundle is flat, so an install path never carries a group.
//   repoOnly — who should install it. skill-maintainer and skillify operate ON this monorepo
//              and do nothing useful elsewhere, so `--all` skips them. Naming one explicitly,
//              or selecting its group, still installs it: this is an exclusion from a
//              convenience selector, never a refusal.
//   retired  — a skill this bundle used to ship. It has no files, so it can never be installed,
//              but a retired name stays selectable so `remove dev-chronicle` still works on a
//              machine that has one, and `retiredIn` tells `update` which ones to sweep.

export type SkillEntry = { name: string; group: string | null; repoOnly: boolean; retired?: boolean; replacedBy?: string }

export type Selector = { skill?: string; group?: string; all?: boolean }

const sorted = (names: string[]) => [...new Set(names)].sort()

function groupsIn(catalog: SkillEntry[]): string[] {
  return sorted(catalog.map(entry => entry.group).filter((group): group is string => group !== null))
}

export function selectSkills(selector: Selector, catalog: SkillEntry[], verb = 'install'): string[] {
  const chosen = [
    selector.skill ? 'a skill name' : null,
    selector.group ? '--group' : null,
    selector.all ? '--all' : null,
  ].filter(Boolean) as string[]

  if (chosen.length > 1) {
    throw new Error(`Use only one of ${chosen.join(', ')} — they select different things and are not combined`)
  }

  const live = catalog.filter(entry => !entry.retired)

  if (selector.all) {
    const installable = sorted(live.filter(entry => !entry.repoOnly).map(entry => entry.name))
    if (!installable.length) {
      throw new Error('Nothing to install: every bundled skill is repo-only. Name one explicitly, or use --group, to install it anyway.')
    }
    return installable
  }

  if (selector.group) {
    const members = sorted(live.filter(entry => entry.group === selector.group).map(entry => entry.name))
    if (!members.length) {
      const groups = groupsIn(live)
      throw new Error(`Unknown group: ${selector.group}. Available groups: ${groups.length ? groups.join(', ') : '(none)'}`)
    }
    return members
  }

  if (selector.skill) {
    const entry = catalog.find(candidate => candidate.name === selector.skill)
    if (!entry) {
      throw new Error(`Unknown skill: ${selector.skill}. Bundled skills: ${sorted(live.map(candidate => candidate.name)).join(', ')}`)
    }
    // A retired name is still a name this bundle knows, so removing one works. Installing one
    // cannot: there are no files behind it, and silently installing its replacement instead
    // would be a different skill than the one that was asked for.
    if (entry.retired && verb !== 'remove') {
      throw new Error(`${selector.skill} was retired${entry.replacedBy ? ` — use ${entry.replacedBy} instead` : ''}. It can still be removed: vegafactory skills remove ${selector.skill}`)
    }
    return [selector.skill]
  }

  const groups = groupsIn(live)
  throw new Error(
    `Specify what to ${verb}: a skill name (${sorted(live.map(entry => entry.name)).join(', ')})` +
    `${groups.length ? `, --group (${groups.join(', ')})` : ''}, or --all`,
  )
}

// The retired skills a selection implicates: an upgrade that walks a group, or everything, is
// the only moment anyone finds out a name went away, so that is where the sweep belongs.
export function retiredIn(selector: Selector, catalog: SkillEntry[]): string[] {
  const retired = catalog.filter(entry => entry.retired)
  if (selector.skill) return retired.filter(entry => entry.name === selector.skill).map(entry => entry.name)
  if (selector.group) return sorted(retired.filter(entry => entry.group === selector.group).map(entry => entry.name))
  return sorted(retired.map(entry => entry.name))
}

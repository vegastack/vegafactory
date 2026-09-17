## What

<!-- One or two sentences: what this PR changes and why. -->

## Type of change

- [ ] Installer/CLI (`packages/cli/`)
- [ ] Skill content (`skills/`) — see the content-semver bullet in [.vegastack/dev.md](https://github.com/vegastack/vegafactory/blob/main/.vegastack/dev.md)
- [ ] CI / repo hygiene
- [ ] Docs

## Checklist

- [ ] `bun run check` passes locally
- [ ] No generated files committed (`dist/`, `packages/cli/skill/`, `skill-integrity.json`, `work/`)
- [ ] Semver impact considered per the content versioning policy (content changes only): new reference/section, changed recorded decision, or skill rename = minor, factual refresh/wording = patch, skill removal or profile-format break = major (the operator may declare any change major)

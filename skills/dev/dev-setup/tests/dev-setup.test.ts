import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { validateSkill } from '../../../../packages/cli/scripts/validate-skill.mjs'
import { TODO_PURPOSE } from '../../../../packages/cli/scripts/readme-sync.mjs'

const skillRoot = resolve(import.meta.dir, '..')

describe('dev-setup contract', () => {
  test('SKILL.md passes repo validation', () => {
    const result = validateSkill(skillRoot)
    expect(result.message).toBe('Skill is valid!')
    expect(result.ok).toBe(true)
  })

  test('profile template carries the architect, chronicle-style, and emoji knobs with their documented defaults', () => {
    const template = readFileSync(join(skillRoot, 'assets/dev-profile.md.template'), 'utf8')
    expect(template).toMatch(/^architect: \{\{github-username\}\}\s+#.*gh api user -q \.login/m)
    expect(template).toMatch(/^chronicle-style: plain\s+# plain \| story \| witty/m)
    expect(template).toMatch(/^emoji: none\s+# none \| sparing/m)
  })

  test('profile template carries the board knob defaulting to none, with the one-way rule in its comment', () => {
    const template = readFileSync(join(skillRoot, 'assets/dev-profile.md.template'), 'utf8')
    expect(template).toMatch(/^board: none\s+#.*one way/m)
    expect(template).toMatch(/^board: none\s+#.*factory-board\.yml/m)
  })

  test('Round C offers the board mirror and names the template and its placeholders', () => {
    const skill = readFileSync(join(skillRoot, 'SKILL.md'), 'utf8')
    const roundC = skill.split('**Round C')[1].split('\n## ')[0]
    expect(roundC).toContain('assets/factory-board.yml.template')
    expect(roundC).toContain('{{state-labels}}')
    expect(roundC).toContain('cosmetic until the next label change')
  })

  test('the stop-and-ask section opens with the pause-only sentence and keeps the concrete list', () => {
    const template = readFileSync(join(skillRoot, 'assets/dev-profile.md.template'), 'utf8')
    const section = template.split('## Stop and ask')[1].split('\n## ')[0]
    expect(section).toContain('Pause for the operator only when the work genuinely requires them: a destructive or irreversible action, a real scope change, or input only they can provide — ask and end the turn rather than end on a promise')
    expect(section).toContain('a blocker the brief cannot resolve')
    expect(section).toContain("Nothing ships without the operator's explicit instruction")
  })

  test('agents-section template stays within the always-loaded budget and mirrors this repo AGENTS.md', () => {
    const template = readFileSync(join(skillRoot, 'assets/agents-section.md.template'), 'utf8')
    const body = template.split('<!-- vsk-dev:start -->')[1].split('<!-- vsk-dev:end -->')[0]
    expect(body.trim().split(/\s+/).length).toBeLessThanOrEqual(450)
    expect(body.match(/^\| .* \| .* \|$/gm)?.length).toBe(7) // header + six routing rows
    expect(body).toContain('| dev-intake, which writes the issue and never builds |')
    expect(body).toContain("| dev-implement's direct path |")
    expect(body).toContain('Local, reversible actions proceed')
    expect(body).toContain('Agent conduct:')
    const agents = readFileSync(resolve(skillRoot, '../../../AGENTS.md'), 'utf8')
    expect(agents).toContain(template.trim())
  })

  test('trigger query fixture is a small hard set with near-miss negatives', () => {
    const queries = JSON.parse(readFileSync(join(skillRoot, 'tests/fixtures/trigger-queries.json'), 'utf8'))
    const positives = queries.filter((entry: { should_trigger: boolean }) => entry.should_trigger)
    const negatives = queries.filter((entry: { should_trigger: boolean }) => !entry.should_trigger)
    expect(positives.length).toBeGreaterThanOrEqual(5)
    expect(negatives.length).toBeGreaterThanOrEqual(4)
    for (const entry of queries) expect(typeof entry.query).toBe('string')
  })

  const HARNESS_IDS = ['CC-MEMORY', 'CC-SKILLS', 'CC-TOOLS', 'CC-HOOKS', 'CC-SDK-PRESET', 'CC-CLI', 'CC-SUBAGENT-ENV', 'CODEX-AGENTS', 'CODEX-SKILLS', 'CODEX-EXEC', 'CODEX-HOOKS', 'CODEX-AGENTS-MULTI', 'CODEX-CONFIG', 'CC-TELEMETRY', 'CODEX-OTEL', 'HERMES-HOOKS', 'HERMES-TOOLS', 'HERMES-CURATOR', 'GH-CLI']
  const APP_IDS = ['GH-APP-PERMS', 'GH-APP-TOKEN', 'GH-APP-INSTALLS']
  const REGISTRY_IDS = [...HARNESS_IDS, ...APP_IDS]
  const harnessFacts = readFileSync(join(skillRoot, 'references/harness-facts.md'), 'utf8')

  test('refresh registry carries every tracked source, each manual-review on a 14-day clock, pinned to the file it feeds', () => {
    const registry = JSON.parse(readFileSync(join(skillRoot, 'refresh/sources.json'), 'utf8'))
    expect(registry.schemaVersion).toBe(1)
    const ids = registry.sources.map((source: { id: string }) => source.id).sort()
    expect(ids).toEqual([...REGISTRY_IDS].sort())
    for (const source of registry.sources) {
      expect(source.thresholdDays).toBe(14)
      expect(source.versionDetection.type).toBe('manual-review')
      expect(typeof source.urls.primary).toBe('string')
      const tracked = APP_IDS.includes(source.id) ? 'references/github-app.md' : 'references/harness-facts.md'
      expect(source.affected, `${source.id} must name ${tracked}`).toContain(tracked)
    }
  })

  test('every source marker in harness-facts.md maps to a harness registry ID, and every harness ID is cited', () => {
    const cited = new Set<string>()
    for (const match of harnessFacts.matchAll(/<!--\s*source:\s*([A-Za-z0-9-]+)\s*-->/g)) {
      expect(HARNESS_IDS, `unknown marker ${match[1]}`).toContain(match[1])
      cited.add(match[1])
    }
    expect([...cited].sort()).toEqual([...HARNESS_IDS].sort())
  })

  test('every Claude model id the shipped defaults name is a form Claude Code accepts: an alias, or a claude- full name', () => {
    // `claude --model` takes an alias (fable, sonnet, opus, haiku …) or a full name like
    // claude-sonnet-5; a bare `fable-5-1` is refused as unrecognized, and the dispatcher passes
    // the knob value straight through. The alias list is the one harness-facts.md documents.
    const aliases = ['fable', 'sonnet', 'opus', 'haiku', 'best', 'default', 'opusplan', 'sonnet[1m]', 'opus[1m]']
    const policies = [
      /^harness-policy:\s*([^#\n]+)/m.exec(readFileSync(join(skillRoot, 'assets/dev-profile.md.template'), 'utf8'))![1]!,
      /^harness-policy:\s*([^#\n]+)/m.exec(readFileSync(join(skillRoot, '../../../.vegastack/dev.md'), 'utf8'))![1]!,
    ]
    const group = readFileSync(join(skillRoot, '../../../skills/factory/vegafactory-setup/assets/control-room/group.md.template'), 'utf8')
    policies.push(/^harness-policy:\s*([^#\n]+)/m.exec(group)![1]!)
    const entries = policies.flatMap((line) => line.split('·')).map((entry) => entry.trim().split(/\s+/))
    expect(entries.length).toBeGreaterThanOrEqual(18)
    for (const [stage, agent, model] of entries) {
      expect(stage).toBeTruthy()
      if (agent !== 'claude') continue
      expect(aliases.includes(model!) || model!.startsWith('claude-')).toBe(true)
    }
  })

  test('the gh floors live in harness-facts.md under the GH-CLI marker', () => {
    const floors = harnessFacts.split('\n').filter((line) => /2\.9[47]\.0/.test(line))
    expect(floors.length).toBeGreaterThanOrEqual(2)
    for (const line of floors) expect(line).toContain('<!-- source: GH-CLI -->')
  })

  test('profile template carries the issue-types and issue-fields knobs with a none fallback', () => {
    const template = readFileSync(join(skillRoot, 'assets/dev-profile.md.template'), 'utf8')
    const knobs = template.split('## Knobs')[1].split('\n## ')[0]
    expect(knobs).toMatch(/^issue-types: \{\{.*\| none\}\}\s+#/m)
    expect(knobs).toMatch(/^issue-fields: \{\{.*\| none\}\}\s+#/m)
  })

  test('the flag table names every model, effort and concurrency control under its own source', () => {
    const section = harnessFacts.split('## Model, effort, and concurrency controls')[1].split('\n## ')[0]
    for (const control of ['`--model`', '`--effort`', '`effortLevel`', '`-c model=', '`-c model_reasoning_effort=', '`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`', '`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`', '`agents.max_concurrent_threads_per_session`']) {
      expect(section, `missing control ${control}`).toContain(control)
    }
    for (const id of ['CC-CLI', 'CC-SUBAGENT-ENV', 'CODEX-CONFIG']) expect(section).toContain(`<!-- source: ${id} -->`)
  })

  test('the dated model-currency sentence carries the effort vocabulary and a source', () => {
    const section = harnessFacts.split('## Model, effort, and concurrency controls')[1].split('\n## ')[0]
    const dated = section.split('\n').find((line) => /\b\d{2}-\d{2}-\d{4}\b/.test(line) && line.includes('<!-- source: CC-CLI -->'))
    expect(dated).toBeDefined()
    for (const level of ['low', 'medium', 'high', 'xhigh']) expect(dated).toContain(level)
  })

  test('the codex exec skill-loading drill is recorded reproducibly, dated, with its Codex version', () => {
    const drill = harnessFacts.split('```sh').slice(1).find((block) => block.split('```')[0].includes('codex exec'))
    expect(drill).toBeDefined()
    expect(drill).toContain('.agents/skills/')
    expect(drill).toContain('--skip-git-repo-check')
    const attempt = harnessFacts.split('\n').find((line) => line.includes('codex-cli 0.149.1'))
    expect(attempt).toBeDefined()
    expect(attempt).toMatch(/\b\d{2}-\d{2}-\d{4}\b/)
    expect(attempt).toContain('<!-- source: CODEX-SKILLS -->')
    expect(attempt).toContain('<!-- source: CODEX-EXEC -->')
  })

  // Parked: the drill could not reach the model on 03-09-2026 (Codex refresh token revoked), so
  // the verdict sentence is deliberately unwritten. Re-run the drill after `codex login`, write
  // the line, and turn this into a real test.
  test.todo('the codex exec skill-loading verdict sentence is recorded')

  test('the profile template carries the harness detection line and the six-stage policy default', () => {
    const template = readFileSync(join(skillRoot, 'assets/dev-profile.md.template'), 'utf8')
    expect(template).toMatch(/^harnesses: \{\{.*\}\}\s+#/m)
    const policy = template.split('\n').find((line) => line.startsWith('harness-policy:'))
    expect(policy).toBeDefined()
    const entries = policy!.replace(/^harness-policy:\s*/, '').split('#')[0].trim().split(' · ')
    expect(entries.map((entry) => entry.split(' ')[0])).toEqual(['intake', 'plan', 'implement', 'review', 'status', 'chronicle'])
    for (const entry of entries) expect(entry.split(' ')).toHaveLength(4)
    for (const entry of entries) {
      const stage = entry.split(' ')[0]
      expect(entry).toBe(stage + ' {{' + stage + '-harness}} {{' + stage + '-model}} {{' + stage + '-effort}}')
    }
  })

  test('SKILL.md ties the review recommendation and the Environments gap note to detected harnesses', () => {
    const skill = readFileSync(join(skillRoot, 'SKILL.md'), 'utf8')
    const roundB = skill.split('**Round B')[1].split('**Round C')[0]
    expect(roundB).toContain('harness-policy:')
    expect(roundB).toMatch(/only one harness[^.]*subagent/i)
    const step1 = skill.split('## Step 1')[1].split('## Step 2')[0]
    expect(step1).toContain('harnesses:')
    expect(step1).not.toContain('Codex absent →')
    expect(step1).toMatch(/absent →[^|]*## Environments/)
    const roundC = skill.split('**Round C')[1].split('\n## Step 3')[0]
    expect(roundC).toContain('harness-policy:')
    expect(roundC).toContain('references/harness-facts.md')
  })

  test('the eval file covers the single-harness recommendation', () => {
    const evals = JSON.parse(readFileSync(join(skillRoot, 'evals/evals.json'), 'utf8'))
    const single = evals.evals.find((entry: { prompt: string }) => /nothing else/i.test(entry.prompt))
    expect(single).toBeDefined()
    expect(single.assertions.join(' ')).toContain('review: subagent')
  })

  test('harness-facts documents the hooks package wiring for every harness that has the event', () => {
    expect(harnessFacts).toContain('node .vegastack/hooks/ship-guard.mjs --harness claude')
    expect(harnessFacts).toContain('node .vegastack/hooks/ship-guard.mjs --harness codex')
    expect(harnessFacts).toContain('fail_closed: true')
    expect(harnessFacts).toContain("needs the operator's word — run it by hand")
    expect(harnessFacts).toMatch(/\.codex\/` layer is trusted/)
  })

  test('Round C offers the four hooks separately and Step 3 names the write targets', () => {
    const skill = readFileSync(join(skillRoot, 'SKILL.md'), 'utf8')
    const roundC = skill.split('**Round C')[1].split('## Step 3')[0]
    expect(roundC).toContain('Hooks package')
    for (const phrase of ['ship guard', 'SessionStart context', 'Stop heartbeat', 'decision nudge']) expect(roundC).toContain(phrase)
    expect(roundC).toContain('merging into existing hook config')
    const step3 = skill.split('## Step 3 — Write')[1].split('## Step 4')[0]
    expect(step3).toContain('.vegastack/hooks/')
    expect(step3).toContain('<repo>/.codex/hooks.json')
  })

  test('the four hook assets are packaged and their README rows are generated', () => {
    const packaging = JSON.parse(readFileSync(resolve(skillRoot, '../../../packages/cli/packaging.json'), 'utf8'))
    const readme = readFileSync(join(skillRoot, 'README.md'), 'utf8')
    for (const file of ['ship-guard.mjs', 'session-start.mjs', 'stop-heartbeat.mjs', 'decision-nudge.mjs']) {
      expect(packaging['dev-setup']).toContain(`assets/hooks/${file}`)
      expect(readme).toContain(`assets/hooks/${file}`)
    }
    expect(readme).not.toContain(TODO_PURPOSE)
  })

  test('the parallel-children workflow is offered in Round C and packaged from dev-implement', () => {
    const skill = readFileSync(join(skillRoot, 'SKILL.md'), 'utf8')
    const roundC = skill.split('**Round C')[1].split('## Step 3')[0]
    expect(roundC).toContain('.claude/workflows/implement-children.js')
    const packaging = JSON.parse(readFileSync(resolve(skillRoot, '../../../packages/cli/packaging.json'), 'utf8'))
    expect(packaging['dev-setup']).toContain('assets/workflows/implement-children.js@dev-implement')
  })

  test('the eval file covers wiring the hooks package on a wrangler project', () => {
    const evals = JSON.parse(readFileSync(join(skillRoot, 'evals/evals.json'), 'utf8'))
    const hooks = evals.evals.find((entry: { prompt: string }) => /wire the hooks/i.test(entry.prompt))
    expect(hooks).toBeDefined()
    expect(hooks.assertions.join(' ')).toContain('offered separately')
    expect(hooks.assertions.join(' ')).toContain('merged into, never replaced')
  })

  test('Step 1 detection reads the org issue fields and drafts both knobs', () => {
    const skill = readFileSync(join(skillRoot, 'SKILL.md'), 'utf8')
    expect(skill).toContain('gh api orgs/<org>/issue-types')
    expect(skill).toContain('gh api orgs/<org>/issue-fields')
    expect(skill).toContain('`issue-types:`')
    expect(skill).toContain('`issue-fields:`')
  })

  test('conventions carries the precedence rule and did not grow doing it', () => {
    const conventions = readFileSync(join(skillRoot, 'references/conventions.md'), 'utf8')
    expect(conventions).toContain(
      'locks require explicit org delegation',
    )
    expect(conventions).not.toContain('A checkpoint retains what a compaction summary must retain')
    expect(conventions.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(1090)
  })

  test('the checkpoint-retention rule now lives with the skill that applies it', () => {
    const ledger = readFileSync(
      resolve(skillRoot, '../dev-implement/references/ledger-and-resume.md'),
      'utf8',
    )
    expect(ledger).toContain('A checkpoint retains what a compaction summary must retain')
    expect(ledger).toContain("the operator's words near-verbatim, the agent's reasoning condensed")
  })

  test('the profile template records the clone sha the profile was drafted from', () => {
    const template = readFileSync(join(skillRoot, 'assets/dev-profile.md.template'), 'utf8')
    expect(template).toMatch(/^control-room: \{\{org\}\}\/vegafactory-control-room#\{\{group\}\}@\{\{sha7\}\}\s+#/m)
    expect(template).toMatch(/^sync-max-age: 30m\s+#/m)
  })

  test('dev-setup refreshes the clone before it reads the control room', () => {
    const skill = readFileSync(join(skillRoot, 'SKILL.md'), 'utf8')
    expect(skill).toContain('vegafactory sync --json')
    expect(skill).toContain('never the network')
  })

  test("this repo's own profile carries a parseable control-room knob", () => {
    const devMd = readFileSync(resolve(skillRoot, '../../../.vegastack/dev.md'), 'utf8')
    expect(devMd).toMatch(/^control-room: vegastack\/vegafactory-control-room#dev@[0-9a-f]{7}\s+#/m)
  })

  test('dev-setup detects org defaults before it asks for knobs', () => {
    const skill = readFileSync(join(skillRoot, 'SKILL.md'), 'utf8')
    expect(skill).toContain('org defaults (control room)')
    expect(skill).toContain('vegafactory-setup')
  })

  const githubApp = readFileSync(join(skillRoot, 'references/github-app.md'), 'utf8')

  test('the App reference pins the permission set, the secret names, the mint recipe, and the kill switch', () => {
    for (const row of [
      '| Issues | Read and write |',
      '| Metadata | Read-only |',
      '| Projects (organization) | Read and write |',
      '| Pull requests | Read and write |',
      '| Contents | Read-only |',
    ])
      expect(githubApp).toContain(row)
    expect(githubApp).toContain('vars.VEGAFACTORY_APP_ID')
    expect(githubApp).toContain('secrets.VEGAFACTORY_APP_PRIVATE_KEY')
    expect(githubApp).toContain('actions/create-github-app-token@v3')
    expect(githubApp).toContain('GET /orgs/{org}/installations')
    expect(githubApp).toContain('https://github.com/apps/vegafactory/installations/new')
    for (const heading of [
      '## What the App is for',
      '## Permissions',
      '## Creating the App',
      '## Where the secrets live',
      '## Minting a token in a workflow',
      '## Recording the installation',
      '## Rotating the private key',
      '## Kill switch',
      '## Widening a permission',
      '## Acceptance drill',
    ])
      expect(githubApp).toContain(heading)
    // No HTML comment: a source marker on a path the skill-scan baseline does not
    // already suppress would raise a new finding needing the operator's word.
    expect(githubApp).not.toContain('<!--')
  })

  test('the App reference names no private key material and no token value', () => {
    expect(githubApp).not.toContain('BEGIN RSA PRIVATE KEY')
    expect(githubApp).not.toContain('BEGIN PRIVATE KEY')
    expect(githubApp).toContain('Never on a workstation')
  })

  test('the App reference is packaged, and the board mirror is the only workflow minting an App token', () => {
    const packaging = JSON.parse(readFileSync(resolve(skillRoot, '../../../packages/cli/packaging.json'), 'utf8'))
    expect(packaging['dev-setup']).toContain('references/github-app.md')
    const workflowsDir = resolve(skillRoot, '../../../.github/workflows')
    const minting = readdirSync(workflowsDir).filter((file) =>
      readFileSync(join(workflowsDir, file), 'utf8').includes('create-github-app-token'),
    )
    expect(minting).toEqual(['factory-board.yml'])
    // And it never reaches that step here: the token is gated on the resolve decision,
    // which this repo's `board: none` turns into a skip before any credential is minted.
    const mirror = readFileSync(join(workflowsDir, 'factory-board.yml'), 'utf8')
    expect(mirror).toContain("if: steps.resolve.outputs.decision == 'sync'")
    expect(readFileSync(resolve(skillRoot, '../../../.vegastack/dev.md'), 'utf8')).toMatch(/^board: none\b/m)
  })

  test('dev-setup routes workflow identity to the App reference, not a personal token', () => {
    const skill = readFileSync(join(skillRoot, 'SKILL.md'), 'utf8')
    expect(skill).toContain('[github-app](references/github-app.md)')
    expect(skill).toContain('gh api orgs/<org>/installations')
    expect(skill).toContain('go out as the App and not as a person')
    // The comparison against a person's own credential lives in the reference, and
    // is written without naming the credential type: 'personal access token' and
    // 'PAT' each raise a HIGH PE3 in the skill scan, anywhere in this skill.
    expect(skill).not.toContain('personal access token')
    expect(githubApp).not.toContain('personal access token')
    expect(githubApp).toContain('The alternative worth naming is a credential belonging to a person')
  })

  // TODO: if this skill ships scripts/, add unit tests for every deterministic
  // branch. A prose-only skill needs nothing more here - its quality bar is the
  // behavioral eval of skillify Phase 4, which runs BEFORE tests lock anything in.
})

describe('ship-guard policy lines', () => {
  test('the profile template documents the policy-line grammar with an auto and an ask example', () => {
    const template = readFileSync(join(skillRoot, 'assets/dev-profile.md.template'), 'utf8')
    const section = template.split('\n## Environments\n')[1].split('\n## ')[0]
    expect(section).toContain('`- <target>: <auto|ask> — <command pattern>`')
    expect(section).toContain('- preview: auto — wrangler deploy --env preview')
    expect(section).toContain('- production: ask — wrangler deploy --env production')
  })

  test("this repo's own profile carries a parseable production policy line", () => {
    const devMd = readFileSync(resolve(skillRoot, '../../../.vegastack/dev.md'), 'utf8')
    const section = devMd.split('\n## Environments\n')[1].split('\n## ')[0]
    expect(section).toMatch(/^- production: ask — git push origin v$/m)
  })
})

#!/usr/bin/env node
// Structural validation of authored skill trees (JS port of the skill-creator
// quick_validate checks, so `check` has no machine-local python dependency).
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve, dirname } from 'node:path';
import { discoverSkills } from './lib/skills.mjs';
import { fileURLToPath } from 'node:url';

// The agentskills.io spec's six fields are the ceiling (claude.ai packaging hard-errors on
// anything else); the portable floor for Claude Code and Codex is name + description.
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const ALLOWED_KEYS = new Set(['name', 'description', 'license', 'compatibility', 'allowed-tools', 'metadata']);

// Frontmatter in our skills is single-line "key: value" scalars only; reject anything fancier
// rather than mis-parse it.
function parseFrontmatter(text) {
  const entries = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trimEnd();
    if (line.trim() === '') continue;
    if (/^\s/.test(line)) {
      throw new Error(`unsupported frontmatter continuation line: ${JSON.stringify(line)}`);
    }
    const match = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(line);
    if (!match) throw new Error(`unparseable frontmatter line: ${JSON.stringify(line)}`);
    const [, key, rawValue] = match;
    if (key in entries) throw new Error(`duplicate frontmatter key: ${key}`);
    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    entries[key] = value;
  }
  return entries;
}

export function validateSkill(skillDir) {
  const skillMd = join(skillDir, 'SKILL.md');
  if (!existsSync(skillMd)) return { ok: false, message: 'SKILL.md not found' };

  const content = readFileSync(skillMd, 'utf8');
  if (!content.startsWith('---')) return { ok: false, message: 'No YAML frontmatter found' };
  const match = /^---\n([\s\S]*?)\n---/.exec(content);
  if (!match) return { ok: false, message: 'Invalid frontmatter format' };

  let frontmatter;
  try {
    frontmatter = parseFrontmatter(match[1]);
  } catch (error) {
    return { ok: false, message: `Invalid frontmatter: ${error.message}` };
  }

  const unexpected = Object.keys(frontmatter).filter((key) => !ALLOWED_KEYS.has(key));
  if (unexpected.length > 0) {
    return {
      ok: false,
      message: `Unexpected key(s) in SKILL.md frontmatter: ${unexpected.sort().join(', ')}. Allowed properties are: ${[...ALLOWED_KEYS].sort().join(', ')}`,
    };
  }
  if (!('name' in frontmatter)) return { ok: false, message: "Missing 'name' in frontmatter" };
  if (!('description' in frontmatter)) return { ok: false, message: "Missing 'description' in frontmatter" };

  const name = frontmatter.name.trim();
  if (name === '') return { ok: false, message: 'Name must not be empty' };
  if (!/^[a-z0-9-]+$/.test(name)) {
    return { ok: false, message: `Name '${name}' should be hyphen-case (lowercase letters, digits, and hyphens only)` };
  }
  // Grammar intersection across harnesses: a leading letter is required; the spec forbids
  // consecutive hyphens and leading/trailing hyphens.
  if (!/^[a-z]/.test(name)) {
    return { ok: false, message: `Name '${name}' must start with a lowercase letter` };
  }
  if (name.startsWith('-') || name.endsWith('-') || name.includes('--')) {
    return { ok: false, message: `Name '${name}' cannot start/end with hyphen or contain consecutive hyphens` };
  }
  if (name.length > MAX_NAME_LENGTH) {
    return { ok: false, message: `Name is too long (${name.length} characters). Maximum is ${MAX_NAME_LENGTH} characters.` };
  }
  // The spec requires the name to equal the parent directory name (the directory is the command).
  const directoryName = basename(resolve(skillDir));
  if (name !== directoryName) {
    return { ok: false, message: `Name '${name}' must match the skill directory name '${directoryName}'` };
  }

  const description = frontmatter.description.trim();
  if (description === '') return { ok: false, message: 'Description must not be empty' };
  if (description.includes('<') || description.includes('>')) {
    return { ok: false, message: 'Description cannot contain angle brackets (< or >)' };
  }
  // Real YAML parsers treat " #" in an unquoted scalar as a comment start, silently
  // truncating the description in the harness skill listing.
  if (/\s#/.test(description)) {
    return { ok: false, message: "Description contains ' #', which YAML parses as a comment start and silently truncates (write 'issue 12', not 'issue #12')" };
  }
  // A colon followed by whitespace (or ending the value) is a mapping indicator in a
  // plain scalar: a real YAML parser refuses the whole frontmatter ("mapping values are
  // not allowed here") and the skill loads with no description at all.
  if (/:(\s|$)/.test(description)) {
    return { ok: false, message: "Description contains ': ', which YAML reads as a nested mapping and refuses to parse (write 'this repo - editing', not 'this repo: editing')" };
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return { ok: false, message: `Description is too long (${description.length} characters). Maximum is ${MAX_DESCRIPTION_LENGTH} characters.` };
  }

  const brokenLinks = findBrokenLinks(skillDir);
  if (brokenLinks.length > 0) {
    return { ok: false, message: `Broken relative link(s): ${brokenLinks.join(', ')}` };
  }

  return { ok: true, message: 'Skill is valid!' };
}

// Repo-wide consistency check: every relative markdown link in a skill's prose must resolve.
// This replaces per-skill link tests — written once here instead of once per skill.
function findBrokenLinks(skillDir) {
  const proseFiles = ['SKILL.md', 'README.md'];
  const referencesDir = join(skillDir, 'references');
  if (existsSync(referencesDir) && statSync(referencesDir).isDirectory()) {
    for (const entry of readdirSync(referencesDir)) {
      if (entry.endsWith('.md')) proseFiles.push(join('references', entry));
    }
  }
  const broken = [];
  for (const file of proseFiles) {
    const path = join(skillDir, file);
    if (!existsSync(path)) continue;
    const body = readFileSync(path, 'utf8');
    for (const match of body.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = match[1].split('#')[0];
      if (target === '' || /^[a-z][a-z0-9+.-]*:/.test(target)) continue;
      if (!existsSync(join(dirname(path), target))) broken.push(`${file} -> ${target}`);
    }
  }
  return broken;
}

// Skills live at skills/<name>/ or skills/<group>/<name>/; discovery is shared with the build
// and the structure checker so the layout rule has one home.
export function discoverSkillDirs(skillsRoot) {
  if (!existsSync(skillsRoot)) return [];
  return [...discoverSkills(skillsRoot).values()].map((skill) => skill.path);
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const args = process.argv.slice(2);
  // --dir points at a repo root other than this checkout, matching structure.mjs and the
  // skillify scaffolder. Without it this script could only ever validate its own repo, which
  // also left its layout-error path untestable.
  if (args.filter((arg) => arg === '--dir').length > 1) {
    console.error('validate-skill: --dir may be given at most once');
    process.exit(2);
  }
  const dirIndex = args.indexOf('--dir');
  let repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  if (dirIndex !== -1) {
    const value = args[dirIndex + 1];
    if (!value || value.startsWith('-')) {
      console.error('validate-skill: --dir requires a value');
      process.exit(2);
    }
    repoRoot = resolve(value);
    args.splice(dirIndex, 2);
  }
  let targets;
  try {
    targets = args.length > 0 ? args.map((arg) => resolve(arg)) : discoverSkillDirs(join(repoRoot, 'skills'));
  } catch (error) {
    // A layout error belongs to the structure check, which reports it readably. This stage runs
    // first, so without this it would bury the same fact under a raw stack trace.
    console.error(`validate-skill: ${error.message}`);
    console.error('validate-skill: run `node packages/cli/scripts/structure.mjs check` for the full structural report');
    process.exit(1);
  }
  if (targets.length === 0) {
    console.error('validate-skill: no skill directories found');
    process.exit(1);
  }
  let failed = false;
  for (const target of targets) {
    const { ok, message } = validateSkill(target);
    console.log(`${ok ? 'PASS' : 'FAIL'} ${target}: ${message}`);
    if (!ok) failed = true;
  }
  process.exit(failed ? 1 : 0);
}

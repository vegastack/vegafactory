import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const cli = resolve(import.meta.dir, '../scripts/ship-gate.mjs')
function fixture(check = 'test "$(cat check.txt)" = PASS', content = 'PASS') {
  const root = mkdtempSync(join(tmpdir(), 'ship-exact-'))
  const dir = join(root, 'repo'); mkdirSync(dir)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'fixture'); git('config', 'user.email', 'fixture@example.test')
  execFileSync('git', ['init', '--bare', '-q', join(root, 'origin.git')]); git('remote', 'add', 'origin', join(root, 'origin.git'))
  mkdirSync(join(dir, '.vegastack'))
  writeFileSync(join(dir, '.vegastack/dev.md'), `repo: o/r\noperators: fixture\nchangelog: none\ncommands: check \`${check}\`\n`)
  writeFileSync(join(dir, '.gitignore'), 'build/\n')
  writeFileSync(join(dir, 'check.txt'), content)
  git('add', '.'); git('commit', '-qm', 'seed'); const base = git('rev-parse', 'HEAD')
  git('checkout', '-qb', 'codex/fixture'); writeFileSync(join(dir, 'feature.txt'), 'feature'); git('add', '.'); git('commit', '-qm', 'feature')
  const sha = git('rev-parse', 'HEAD')
  const plan = { id: 2, node_id: 'PLAN', user: { login: 'fixture' }, body: '<!-- vsk:v1 type=plan rev=1 -->\n## Plan\n' }
  const brief = { number: 1, node_id: 'ISSUE', body: '<!-- vsk:v1 type=brief rev=1 scope=full-plan -->\n## Outcome\nship\n' }
  const scope = execFileSync(process.execPath, ['--input-type=module', '-e', `import {scopeDigest} from ${JSON.stringify(resolve(import.meta.dir, '../../dev-implement/scripts/lib/approval.mjs'))}; process.stdout.write(scopeDigest(${JSON.stringify(plan.body)}, 'plan'))`], { encoding: 'utf8' })
  const binding = { sha, baseSha: base, scopeDigest: scope, verdict: 'clean', findings: [] }
  const comments: any[] = [plan, { id: 3, user: { login: 'fixture' }, body: `<!-- vsk:v1 type=evidence rev=1 sha=${sha} -->` }, { id: 4, user: { login: 'fixture' }, body: `<!-- vsk:v1 type=review round=1 sha=${sha} verdict=clean -->\n\`\`\`json\n${JSON.stringify({ reviewBinding: binding })}\n\`\`\`` }]
  const gh = join(root, 'gh'); const data = join(root, 'comments.json')
  writeFileSync(gh, `#!/usr/bin/env node\nconst fs=require('node:fs'),pages=JSON.parse(fs.readFileSync(${JSON.stringify(data)},'utf8'));process.stdout.write(process.argv.includes('--paginate')?JSON.stringify(process.argv.includes('--slurp')?pages:pages.flat()):${JSON.stringify(JSON.stringify(brief))});\n`, { mode: 0o700 })
  return { dir, git, sha, base, comments, run: (pages: any = [comments]) => { writeFileSync(data, JSON.stringify(pages)); return spawnSync(process.execPath, [cli, '--issue', '1', '--repo', 'o/r', '--branch', 'codex/fixture', '--base', 'main', '--worktree', dir, '--json'], { cwd: dir, env: { ...process.env, VSK_GH: gh }, encoding: 'utf8' }) }, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

for (const [name, check, content, mutation, passes] of [
  ['clean current commit', undefined, 'PASS', undefined, true],
  ['clean committed FAIL', undefined, 'FAIL', undefined, false],
  ['dirty PASS over committed FAIL', undefined, 'FAIL', (f: any) => writeFileSync(join(f.dir, 'check.txt'), 'PASS'), false],
  ['untracked check input', undefined, 'PASS', (f: any) => writeFileSync(join(f.dir, 'input.txt'), 'input'), false],
  ['staged edit', undefined, 'PASS', (f: any) => { writeFileSync(join(f.dir, 'check.txt'), 'new'); f.git('add', '.') }, false],
  ['hidden tracked dirty input', undefined, 'FAIL', (f: any) => { f.git('update-index', '--assume-unchanged', 'check.txt'); writeFileSync(join(f.dir, 'check.txt'), 'PASS') }, false],
  ['check tracked mutation', 'echo changed > check.txt', 'PASS', undefined, false],
  ['check moves HEAD', 'git commit --allow-empty -qm moved', 'PASS', undefined, false],
  ['check moves branch off HEAD', 'git update-ref refs/heads/codex/fixture HEAD~1', 'PASS', undefined, false],
  ['ignored build output', 'mkdir -p build && echo generated > build/out', 'PASS', undefined, true],
  ['missing review', undefined, 'PASS', (f: any) => f.comments.pop(), false],
  ['wrong scope', undefined, 'PASS', (f: any) => { f.comments[2].body = f.comments[2].body.replace(/scopeDigest":"[a-f0-9]+/, 'scopeDigest":"' + '0'.repeat(64)) }, false],
  ['explicit scoped operator exception', undefined, 'PASS', (f: any) => { f.comments[2].body = f.comments[2].body.replaceAll('clean', 'needs-fixes').replace('findings":[]', 'findings":[{"id":"F1","status":"open"}]'); f.comments[1].user={login:'fixture'}; f.comments[1].body += '\n```json\n' + JSON.stringify({adjudication:{sha:f.sha,reviewCommentId:4,operator:'fixture',source:{kind:'session',ref:'session:fixture',quote:'Accept F1 for this candidate'},findings:[{id:'F1',disposition:'accept-risk',reason:'known bounded limitation'}]}}) + '\n```' }, true],
  ['negative prose with open finding', undefined, 'PASS', (f: any) => { f.comments[2].body = f.comments[2].body.replaceAll('clean', 'needs-fixes').replace('findings":[]', 'findings":[{"id":"F1","status":"open"}]'); f.comments[1].body += '\n**Review:** no adjudication has occurred' }, false],
  ['ancestor review', undefined, 'PASS', (f: any) => { f.comments[2].body = f.comments[2].body.replaceAll(f.sha, f.base) }, false],
  ['unknown review commit', undefined, 'PASS', (f: any) => { f.comments[2].body = f.comments[2].body.replaceAll(f.sha, 'f'.repeat(40)) }, false],
] as const) {
  test(`actual CLI: ${name}`, () => {
    const f = fixture(check, content)
    try { mutation?.(f); const result = f.run(); expect(result.status, result.stdout + result.stderr).toBe(passes ? 0 : 2) } finally { f.cleanup() }
  })
}

test('dirty candidate refuses before running the command and preserves files', () => {
  const f = fixture('mkdir -p build && echo ran > build/out', 'FAIL')
  try {
    writeFileSync(join(f.dir, 'check.txt'), 'PASS')
    const r=f.run();expect(r.status).toBe(2);expect(JSON.parse(r.stdout).candidate.checkExit).toBeNull()
    expect(execFileSync('cat',[join(f.dir,'check.txt')],{encoding:'utf8'})).toBe('PASS')
  } finally {f.cleanup()}
})

test('actual CLI retains trusted open findings when a later outsider posts an exact clean review', () => {
  const f = fixture()
  try {
    f.comments[2].body = f.comments[2].body.replaceAll('clean', 'needs-fixes').replace('findings":[]', 'findings":[{"id":"X1","status":"open"}]')
    f.comments.push({ id: 5, user: { login: 'outsider' }, body: f.comments[2].body.replaceAll('needs-fixes', 'clean').replace('findings":[{"id":"X1","status":"open"}]', 'findings":[]') })
    const result = f.run()
    expect(result.status, result.stdout + result.stderr).toBe(2)
    const output = JSON.parse(result.stdout)
    expect(output.blocks.some((block: string) => block.includes('review verdict needs-fixes'))).toBe(true)
    expect(output.candidate.review.findings).toEqual([{ id: 'X1', status: 'open' }])
    expect(output.candidate.reviewSource.commentId).toBe(4)
  } finally { f.cleanup() }
})

test('actual CLI reports the exact trusted clean comment ID and body SHA', () => {
  const f = fixture()
  try {
    const result = f.run()
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(JSON.parse(result.stdout).candidate.reviewSource).toEqual({
      commentId: 4,
      bodySha256: createHash('sha256').update(f.comments[2].body, 'utf8').digest('hex'),
      publisher: 'fixture',
    })
  } finally { f.cleanup() }
})

test('actual CLI refuses two trusted exact matches, missing publisher metadata, and incomplete pagination', () => {
  for (const mutate of [
    (f: any) => f.comments.push({ ...f.comments[2], id: 5 }),
    (f: any) => { delete f.comments[2].user },
  ]) {
    const f = fixture()
    try { mutate(f); expect(f.run().status).toBe(2) } finally { f.cleanup() }
  }
  const f = fixture()
  try { expect(f.run(f.comments).status).toBe(2) } finally { f.cleanup() }
})

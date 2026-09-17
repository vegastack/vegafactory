import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyCommand, extractCommand, loadPolicy, mergeTarget, parseCommand, shipAskCommands, splitSegments, type Policy } from '../src/guard-rules.ts'

const policy: Policy = { defaultBranch: 'main', shipAsk: ['bun run docs:publish', 'wrangler deploy --env production'] }
const decide = (command: string, p: Policy = policy) => classifyCommand(command, p)

describe('policy', () => {
  test('only backticked commands on ask: lines of the Ship section count', () => {
    const devMd = [
      '## Verify', '- ask: `bun run nope`',
      '## Ship — after merge', '- auto: `bun run build`', '- ask: run `wrangler deploy --env production` then `bun run docs:publish`', '- ask: tell the team',
      '## Other', '- ask: `rm -rf /`',
    ].join('\n')
    expect(shipAskCommands(devMd)).toEqual(['wrangler deploy --env production', 'bun run docs:publish'])
  })

  test("reads dev.md from the remote's default branch, never the working copy", () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'guard-policy-')))
    const origin = join(tmp, 'origin.git')
    const work = join(tmp, 'work')
    const git = (cwd: string, ...args: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' })
    git(tmp, 'init', '-q', '--bare', '-b', 'main', origin)
    git(tmp, 'clone', '-q', origin, work)
    mkdirSync(join(work, '.vegastack'))
    writeFileSync(join(work, '.vegastack/dev.md'), '## Ship\n- ask: `bun run release`\n')
    git(work, 'add', '-A')
    git(work, 'commit', '-q', '-m', 'init')
    git(work, 'push', '-q', 'origin', 'main')
    git(work, 'remote', 'set-head', 'origin', '--auto')
    writeFileSync(join(work, '.vegastack/dev.md'), '## Ship\n- auto: `bun run release`\n')
    expect(loadPolicy(work)).toMatchObject({ defaultBranch: 'main', shipAsk: ['bun run release'] })
    expect(loadPolicy(tmp)).toMatchObject({ defaultBranch: null, shipAsk: [] })
  })
})

describe('command parsing', () => {
  test('splits on every operator, including a single & and a newline', () => {
    expect(splitSegments('echo hi && gh pr merge 12 --squash')).toEqual(['echo hi', 'gh pr merge 12 --squash'])
    expect(splitSegments('bun run check; git tag v1.0.0')).toEqual(['bun run check', 'git tag v1.0.0'])
    expect(splitSegments('echo x & gh pr merge 12')).toEqual(['echo x', 'gh pr merge 12'])
    expect(splitSegments('a | b || c\nd')).toEqual(['a', 'b', 'c', 'd'])
  })

  test('quotes, escapes and substitutions are read as a shell would read them', () => {
    expect(parseCommand('git push origin "main"')[0]!.words).toEqual(['git', 'push', 'origin', 'main'])
    expect(parseCommand("git push origin 'main'")[0]!.words).toEqual(['git', 'push', 'origin', 'main'])
    expect(parseCommand('git push origin ma\\in')[0]!.words).toEqual(['git', 'push', 'origin', 'main'])
    expect(parseCommand('echo $(npm publish)').map((s) => s.words)).toEqual([['echo'], ['npm', 'publish']])
    expect(parseCommand('echo `npm publish`').map((s) => s.words)).toEqual([['echo'], ['npm', 'publish']])
    expect(parseCommand('(git push origin main)')[0]!.words).toEqual(['git', 'push', 'origin', 'main'])
    expect(parseCommand('{ git push origin main; }')[0]!.words).toEqual(['git', 'push', 'origin', 'main'])
  })

  test('a redirection target never becomes an argument', () => {
    const segment = parseCommand('git push origin feat/x > out.log 2>&1')[0]!
    expect(segment.words).toEqual(['git', 'push', 'origin', 'feat/x'])
    expect(segment.redirects).toEqual(['out.log'])
  })
})

describe('decisions', () => {
  test('allows a command in no guarded family', () => {
    for (const command of ['ls', 'bun run check', 'git push origin feat/110-hooks', 'git push -u origin feat/x', 'git push origin HEAD:feat/x', 'git push origin feat/x:feat/x', 'git push --force-with-lease origin feat/x', 'git status', 'git -C /repo push origin feat/x', 'env FOO=1 bun run check', 'git commit -m "deploy notes"', 'gh release list', 'wrangler deploy --env staging', 'git worktree list']) {
      expect(decide(command).decision, command).toBe('allow')
    }
  })

  test('asks on the fixed list and the Ship ask: commands', () => {
    for (const command of ['gh pr merge 12 --squash', 'git push origin main', 'git tag v0.19.0', 'npm publish', 'bun publish', 'gh release create v1', 'gh release delete v1', 'bun run docs:publish', 'wrangler deploy --env production', 'git worktree remove .vegastack/.worktrees/x']) {
      expect(decide(command).decision, command).toBe('ask')
    }
    expect(decide('wrangler deploy --env production').rule).toBe('ship-ask')
  })

  test('pushing one tag by name asks, however it is spelled', () => {
    const withTags: Policy = { ...policy, tags: new Set(['release-candidate']) }
    for (const command of ['git push origin v0.20.0', 'git push origin 1.2.3', 'git push origin release-candidate', 'git push origin v1.0.0:v1.0.0', 'git push origin refs/tags/x']) {
      expect(decide(command, withTags).decision, command).toBe('ask')
    }
    expect(decide('git push origin feat/216-coordination', withTags).decision).toBe('allow')
  })

  test('every spelling of a push to the default branch asks', () => {
    for (const command of [
      'git push origin main:main', 'git push origin HEAD:main', 'git push origin refs/heads/main', 'git push origin HEAD:refs/heads/main',
      'git push --set-upstream origin main:main', 'git push origin "main"', "git push origin 'main'",
      'git push origin feature main', 'git push -o ci.skip origin main', 'git push origin feat/x:main', 'git push --all origin', 'git push --mirror origin',
    ]) {
      const result = decide(command)
      expect(result.decision, command).toBe('ask')
      expect(result.rule, command).toBe('default-branch')
    }
  })

  test('a push whose destination the guard cannot read asks rather than guessing', () => {
    for (const command of ['git push', 'git push origin', 'git push origin HEAD', 'git push origin @']) {
      expect(decide(command)).toMatchObject({ decision: 'ask', rule: 'unclassified' })
    }
    expect(decide('git push origin feat/x', { defaultBranch: null, shipAsk: [] })).toMatchObject({ decision: 'ask', rule: 'unclassified' })
  })

  test('pushing tags and deleting a remote branch both ask', () => {
    for (const command of ['git push origin refs/tags/v1.2.3', 'git push --tags origin', 'git push origin :refs/heads/main', 'git push origin :feat/x', 'git push --delete origin feat/x', 'git push -d origin feat/x']) {
      expect(decide(command).decision, command).toBe('ask')
    }
  })

  test('asks on the always-ask list with the flag in any position', () => {
    for (const command of [
      'git push --force', 'git push origin feat/x --force', 'git push origin feat/x -f', 'git push -fu origin feat/x', 'git push origin +feat/x', 'git push origin +main',
      'git reset --hard HEAD~1', 'git reset -q --hard', 'git branch -D feat/x', 'git branch --force -D feat/x', 'git branch -d feat/x', 'git branch --delete feat/x',
      'git worktree remove --force x', 'git worktree remove x --force', 'git worktree remove -f x',
      'git commit --no-verify -m x', 'git commit -m x --no-verify', 'git tag v1', 'npm publish',
    ]) {
      expect(decide(command), command).toMatchObject({ decision: 'ask', rule: 'always-ask' })
    }
  })

  test('a wrapper, a path, an escape, quoting or a nested shell cannot walk a guarded command past the guard', () => {
    for (const command of [
      'sudo git push --force', 'sudo -u root git push origin main', 'env FOO=1 gh pr merge 110', 'env -i gh pr merge 12', 'GIT_DIR=x git tag v1.0.0',
      'command npm publish', 'nice -n 5 git push origin main', 'time gh pr merge 12', 'timeout 30 git push origin main', 'xargs -I{} git push origin main',
      '/usr/bin/git push origin main', '\\gh pr merge 1', '"git" push origin main', 'git -C /repo push origin main', 'git --no-pager push origin main',
      'git -c alias.ship=push ship origin main', 'gh -R o/r pr merge 12', 'gh --repo o/r pr merge 12',
      'sh -c "npm publish"', 'bash -lc "gh pr merge 12"', 'bash -c "git push origin main"', 'zsh -c \'git tag v1\'', 'sh -c "echo hi; npm publish"',
      'echo $(npm publish)', 'echo `gh pr merge 1`', '(git push origin main)', 'echo x & gh pr merge 12', 'echo x & npm publish',
      'bash -lc "wrangler deploy --env production"',
    ]) {
      expect(decide(command).decision, command).toBe('ask')
    }
  })

  test('text handed to another interpreter is probed for the guarded verbs', () => {
    for (const command of [
      'node -e "require(\'child_process\').spawnSync(\'sh\', [\'-c\', \'gh pr merge 12\'])"',
      'python3 -c "import os; os.system(\'git push origin main\')"',
      'ssh box "npm publish"',
      'ssh box "wrangler deploy --env production"',
    ]) {
      expect(decide(command), command).toMatchObject({ decision: 'ask', rule: 'unclassified' })
    }
    expect(decide('node -e "console.log(1)"').decision).toBe('allow')
  })

  test('a merge through the API asks like a merge through the CLI', () => {
    expect(decide('gh api --method PUT repos/o/r/pulls/12/merge').decision).toBe('ask')
    expect(decide('gh api -X PUT /repos/o/r/pulls/12/merge').decision).toBe('ask')
    expect(decide('gh api repos/o/r/pulls/12').decision).toBe('allow')
  })

  test('an unknown git alias asks, and an unlisted publish fails closed', () => {
    expect(decide('git ship origin main').decision).toBe('ask')
    expect(decide('bun run publish:docs')).toMatchObject({ decision: 'ask', rule: 'unclassified' })
  })

  test('a recorded ship it lets gh pr merge through, and only the merge', () => {
    const seen: string[][] = []
    const check = (words: string[], raw: string[]) => { seen.push(raw); return words.includes('12') }
    expect(classifyCommand('gh pr merge 12 --squash', policy, check)).toEqual({ decision: 'allow', reason: null, rule: 'ship-it-recorded' })
    expect(seen[0]).toEqual(['gh', 'pr', 'merge', '12', '--squash'])
    expect(classifyCommand('gh pr merge 13', policy, check).decision).toBe('ask')
    expect(classifyCommand('gh pr merge 12 && git tag v1', policy, check).decision).toBe('ask')
    expect(classifyCommand('gh api -X PUT repos/o/r/pulls/12/merge', policy, check).decision).toBe('ask')
  })

  test('mergeTarget reads the PR argument past the flags', () => {
    expect(mergeTarget(['gh', 'pr', 'merge', '--squash', '12'])).toBe('12')
    expect(mergeTarget(['gh', 'pr', 'merge', '-b', 'body text', 'feat/1-x'])).toBe('feat/1-x')
    expect(mergeTarget(['gh', 'pr', 'merge', '--auto'])).toBe(null)
  })
})

describe('payloads', () => {
  test('reads the command from each harness payload shape', () => {
    expect(extractCommand({ tool_name: 'Bash', tool_input: { command: 'gh pr merge 12' } })).toBe('gh pr merge 12')
    expect(extractCommand({ tool_input: { command: ['bash', '-lc', 'npm publish'] } })).toBe("bash -lc 'npm publish'")
    expect(extractCommand({ tool_input: 'git tag v1' })).toBe('git tag v1')
    expect(extractCommand({ tool_name: 'Read', tool_input: { file_path: '/x' } })).toBe(null)
  })
})

import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyCommand, EXPANDED, extractCommand, isShellTool, loadPolicy, mergeTarget, parseCommand, shipAskCommands, splitSegments, type Policy } from '../src/guard-rules.ts'

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
    expect(parseCommand('echo $(npm publish)').map((s) => s.words)).toEqual([['echo', EXPANDED], ['npm', 'publish']])
    expect(parseCommand('echo `npm publish`').map((s) => s.words)).toEqual([['echo', EXPANDED], ['npm', 'publish']])
    expect(parseCommand('git${IFS}push "$HOME/x" \'$literal\' a$')[0]!.words).toEqual([`git${EXPANDED}{IFS}push`, `${EXPANDED}HOME/x`, '$literal', 'a$'])
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
    for (const command of ['ls', 'bun run check', 'git push origin feat/110-hooks', 'git push -u origin feat/x', 'git push origin HEAD:feat/x', 'git push origin feat/x:feat/x', 'git push --dry-run origin feat/x', 'git status', 'git -C /repo push origin feat/x', 'env FOO=1 bun run check', 'git commit -m "deploy notes"', 'gh release list', 'wrangler deploy --env staging', 'git worktree list']) {
      expect(decide(command).decision, command).toBe('allow')
    }
  })

  test('asks on the fixed list and the Ship ask: commands', () => {
    for (const command of ['gh pr merge 12 --squash', 'git push origin main', 'git tag v0.19.0', 'npm publish', 'bun publish', 'gh release create v1', 'gh release delete v1', 'bun run docs:publish', 'wrangler deploy --env production', 'git worktree remove .vegastack/.worktrees/x']) {
      expect(decide(command).decision, command).toBe('ask')
    }
    expect(decide('wrangler deploy --env production').rule).toBe('ship-ask')
  })

  test('env -S and zsh command modifiers cannot hide a guarded command', () => {
    for (const command of [
      'env -S "git push origin main"', 'env -S"git push origin main"', 'env --split-string="git push origin main"',
      'env -S "vegafactory issue ack 7 --stage ship --by mk --quote x"', 'noglob git push origin main', 'nocorrect git push origin main', 'coproc git push origin main',
    ]) expect(decide(command).decision, command).toBe('ask')
    for (const command of ['env -S "ls -la"', 'noglob ls', 'env FOO=1 ls']) expect(decide(command).decision, command).toBe('allow')
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

  test('shell expansion cannot build a guarded command', () => {
    for (const command of [
      '$(printf git) push origin main', 'git${IFS}push origin main', '`echo git` push origin main', '$GIT push origin main',
      '"$(which git)" push origin main', 'git $(echo push) origin main', 'git push origin $(git rev-parse --abbrev-ref HEAD)',
      'git push origin "$BRANCH"', "git -c \"$ALIAS\" ship origin main", 'gh pr $(echo merge) 12', 'gh $CMD 12',
      'gh -R "$R" pr merge 1', 'npm $VERB', "$'\\x67it' push origin main", 'env $CMD push', 'sudo $(which gh) pr merge 1',
      'echo main | xargs git push origin', 'find . -name x -exec git push origin {} \\;', 'eval git push origin main',
      'if true; then git push origin main; fi', 'for b in a; do git push origin main; done', 'git tag "$V"',
    ]) {
      expect(decide(command).decision, command).toBe('ask')
    }
    for (const command of [
      'git commit -m "$(cat msg.txt)"', 'echo $HOME', 'cd "$(git rev-parse --show-toplevel)" && ls', 'git add $FILES',
      'gh pr view 3 --json body --jq "$Q"', 'ls | xargs git add', 'bun run $SCRIPT', 'FOO=$(date) bun run check',
      'git log --since "$SINCE"', 'echo "cost: 5$"',
    ]) {
      expect(decide(command).decision, command).toBe('allow')
    }
  })

  test('gh api asks for every write and every GraphQL mutation, and lets reads through', () => {
    for (const command of [
      "gh api graphql -f query='mutation{mergePullRequest(input:{pullRequestId:\"x\"}){clientMutationId}}'",
      "gh api graphql -f query='mutation { createRelease { id } }'", "gh api graphql --raw-field 'query=mutation{deleteRef(input:{refId:\"r\"}){clientMutationId}}'",
      "gh api graphql -F query=@mutation.graphql", 'gh api graphql --input body.json', "gh api graphql -f 'query=mutation{updateRef}'",
      'gh api -X POST repos/o/r/releases', 'gh api --method DELETE repos/o/r/git/refs/heads/main', 'gh api -XPATCH repos/o/r/git/refs/heads/main -f sha=x',
      'gh api repos/o/r/issues/1/comments -f body=hi', 'gh api repos/o/r/issues/comments/9 -F body=@x', 'gh api repos/o/r/dispatches --input x.json',
      'gh api --method=PUT repos/o/r/pulls/1/merge', 'gh api repos/o/r/git/refs -H "X-HTTP-Method-Override: DELETE"', 'gh api $URL', 'gh api -X $M repos/o/r',
    ]) {
      expect(decide(command).decision, command).toBe('ask')
    }
    for (const command of [
      'gh api repos/o/r/pulls/12', 'gh api --paginate repos/o/r/issues --jq ".[].number"', 'gh api -X GET search/issues -f q=repo:o/r',
      "gh api graphql -f query='query { viewer { login } }'", "gh api graphql -f query='{ repository(owner:\"o\", name:\"r\") { id } }' -F n=1",
    ]) {
      expect(decide(command).decision, command).toBe('allow')
    }
  })

  test('a session cannot record its own ship it, write raw comments or take an issue back', () => {
    for (const command of [
      'vegafactory issue ack 1 --stage ship --by x --quote y', 'vegafactory issue ack 1 --stage ship --by x --quote y --source comment:5',
      'vegafactory issue ack 1 --stage plan --by x --quote y', 'vegafactory issue ack 1 --stage plan --by x --quote y --source session',
      'bunx @vegastack/vegafactory issue ack 1 --stage brief --by x --quote y', 'bun packages/cli/src/index.ts issue ack 1 --stage=ship',
      'vegafactory issue ack 1 --stage plan --source "$S" --by x --quote y', 'vegafactory issue $VERB 1',
      'vegafactory issue claim 1 --harness claude --model m --take-back-by mk', 'gh issue comment 1 --body "ok"', 'gh pr comment 3 -F body.md',
    ]) {
      expect(decide(command).decision, command).toBe('ask')
    }
    for (const command of [
      'vegafactory issue ack 1 --stage plan --by x --quote y --source comment:5', 'vegafactory issue claim 1 --harness claude --model m',
      'vegafactory issue comment 1 --file c.md', 'gh issue view 1', 'gh pr view 3 --comments',
    ]) {
      expect(decide(command).decision, command).toBe('allow')
    }
  })

  test('push options that force, prune, follow tags or change the remote side ask, in any spelling', () => {
    for (const command of [
      'git push --force-with-lease origin feat/x', 'git push --force-with-lease=feat/x:abc origin feat/x', 'git push --force-with-lease origin feat/x --force-if-includes',
      'git push --force-if-includes origin feat/x', 'git push --follow-tags origin feat/x', 'git push --prune origin feat/x', 'git push --mirror origin',
      'git push --foll origin feat/x', 'git push --forc origin feat/x', 'git push --pru origin feat/x', 'git push --del origin feat/x', 'git push --mir origin',
      'git push --receive-pack=/tmp/x origin feat/x', 'git push --receive-pack /tmp/x origin feat/x', 'git push --exec=/tmp/x origin feat/x',
      "git push origin 'refs/heads/*:refs/heads/*'", "git push origin 'feat/*'", 'git push origin HEAD:feat/x@{1}', 'git push origin feat/x:feat/a..b',
    ]) {
      expect(decide(command).decision, command).toBe('ask')
    }
    for (const command of ['git push --no-force-with-lease origin feat/x', 'git push -u origin feat/x', 'git push --set-upstream origin feat/x', 'git push --porcelain origin feat/x']) {
      expect(decide(command).decision, command).toBe('allow')
    }
  })

  test('ref-writing plumbing fails closed', () => {
    for (const command of [
      'git update-ref refs/heads/main abc', 'git update-ref -d refs/heads/main', 'git send-pack origin main', 'git symbolic-ref HEAD refs/heads/main',
      'git symbolic-ref -d HEAD', 'git fetch origin feat/x:main', 'git fetch origin +refs/heads/*:refs/remotes/origin/*', 'git fetch origin v1:refs/tags/v1',
      'git fetch --refmap=x origin', 'git pull origin feat/x:main', 'git replace abc def', 'git replace -d abc', 'git filter-branch --all', 'git filter-repo --path x',
    ]) {
      expect(decide(command).decision, command).toBe('ask')
    }
    for (const command of ['git symbolic-ref HEAD', 'git symbolic-ref --short HEAD', 'git fetch origin', 'git fetch origin main', 'git fetch --prune origin', 'git replace', 'git replace -l', 'git pull --rebase origin feat/x', 'git fetch origin tag v1']) {
      expect(decide(command).decision, command).toBe('allow')
    }
  })

  test('commit hooks cannot be skipped or redirected', () => {
    for (const command of [
      'git commit -n -m x', 'git commit -anm x', 'git commit -m x -n', 'git commit -qn', 'git commit --no-verif -m x', 'git commit --no-veri -m x',
      'git commit $FLAGS -m x', 'git -c core.hooksPath=/dev/null commit -m x', 'git -c CORE.HOOKSPATH=/tmp commit -m x', 'git --config-env=core.hooksPath=H commit -m x',
      'git --config-env core.hooksPath=H merge feat/x', 'git -c include.path=/tmp/cfg rebase main', 'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/tmp git commit -m x',
      'GIT_CONFIG_GLOBAL=/tmp/g git cherry-pick abc', 'env GIT_DIR=/tmp/r git am x.patch', 'git --git-dir=/tmp/r commit -m x', 'GIT_CONFIG_PARAMETERS="x" git revert HEAD',
      'git -c remote.origin.push=refs/heads/*:refs/heads/main push origin', 'git -c push.followTags=true push origin feat/x', 'export GIT_CONFIG_GLOBAL=/tmp/g', 'export GIT_DIR=/x',
    ]) {
      expect(decide(command).decision, command).toBe('ask')
    }
    for (const command of [
      'git commit -m "$(cat msg.txt)"', 'git commit -am "-n"', 'git commit -m -n', 'git commit -F msg.txt', 'git -c user.name=x -c user.email=y commit -m x',
      'git commit --verbose -m x', 'GIT_AUTHOR_NAME=x git commit -m x', 'git cherry-pick -n abc', 'git merge -n feat/x', 'export PATH=/x:$PATH',
    ]) {
      expect(decide(command).decision, command).toBe('allow')
    }
  })

  test('gh: --admin and --repo in every spelling ask, aliases, extensions and write commands ask, reads pass', () => {
    const check = () => true
    for (const command of ['gh pr merge 12 --admin', 'gh pr merge 12 --admin=true', 'gh pr merge 12 --admin=1', 'gh pr merge 12 -R=o/r', 'gh pr merge 12 --repo=o/r', 'gh -R=o/r pr merge 12', 'gh -Ro/r pr merge 12', 'gh --repo=o/r pr merge 12']) {
      expect(classifyCommand(command, policy, check).decision, command).toBe('ask')
    }
    expect(classifyCommand('gh pr merge 12 --squash', policy, check).decision).toBe('allow')
    for (const command of [
      'gh alias set ship "pr merge"', 'gh alias import x.yml', 'gh alias delete ship', 'gh ship 12', 'gh extension install o/gh-x', 'gh x-merge 1', 'gh pr create --title x',
      'gh pr edit 1 --base main', 'gh repo delete o/r', 'gh workflow run release', 'gh secret set X', 'gh auth token', 'gh run rerun 1', 'gh issue create -t x', 'gh label create x', 'gh project item-edit 1',
    ]) {
      expect(decide(command).decision, command).toBe('ask')
    }
    for (const command of [
      'gh auth status', 'gh pr view 1', 'gh pr list', 'gh pr checks 1 --watch', 'gh pr diff 1', 'gh issue view 1', 'gh issue list', 'gh run view 1', 'gh run list',
      'gh run watch 1', 'gh repo view', 'gh release list', 'gh release view v1', 'gh release download v1', 'gh label list', 'gh project item-list 1', 'gh project view 1',
      'gh project field-list 1', 'gh --version', 'gh api repos/o/r',
    ]) {
      expect(decide(command).decision, command).toBe('allow')
    }
  })

  test('vegafactory worktree remove passes, remove --force and prune ask, git worktree remove asks', () => {
    for (const command of ['vegafactory worktree remove 12 --force', 'vegafactory worktree remove --force=1 12', 'vegafactory worktree prune', 'vegafactory worktree prune --older-than 1d', 'bunx @vegastack/vegafactory worktree prune', 'vegafactory worktree remove $N --force', 'git worktree remove x', 'vegafactory worktree $VERB 12']) {
      expect(decide(command).decision, command).toBe('ask')
    }
    for (const command of ['vegafactory worktree remove 12', 'vegafactory worktree prune --dry-run', 'vegafactory worktree list', 'vegafactory worktree create 12']) {
      expect(decide(command).decision, command).toBe('allow')
    }
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

  test('real Claude and Codex shell payloads', () => {
    const claude = { session_id: 's', cwd: '/r', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push origin main', description: 'push', timeout: 120000 }, tool_use_id: 't' }
    const codexBash = { session_id: 's', cwd: '/r', hook_event_name: 'PreToolUse', model: 'gpt-5.5', permission_mode: 'default', tool_name: 'Bash', tool_input: { command: 'git push origin main' } }
    const codexExec = { session_id: 's', cwd: '/r', hook_event_name: 'PreToolUse', model: 'gpt-5.5', tool_name: 'exec_command', tool_input: { cmd: 'git push origin main', workdir: '/r', yield_time_ms: 1000 } }
    const codexShell = { session_id: 's', cwd: '/r', hook_event_name: 'PreToolUse', model: 'gpt-5.5', tool_name: 'shell', tool_input: { command: ['bash', '-lc', 'git push origin main'], workdir: '/r' } }
    const codexArgv = { tool_name: 'exec_command', tool_input: { cmd: ['git', 'push', 'origin', 'main'] } }
    for (const payload of [claude, codexBash, codexExec, codexShell, codexArgv]) {
      expect(classifyCommand(extractCommand(payload), policy).decision, JSON.stringify(payload)).toBe('ask')
    }
    // apply_patch carries the patch in `command`; it runs nothing.
    expect(extractCommand({ tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n+git push origin main' } })).toBe(null)
  })

  test('a shell-like tool is recognised by name, so an unknown payload shape fails closed', () => {
    for (const name of ['Bash', 'shell', 'exec_command', 'local_shell', 'unified_exec', 'shell_command', 'container.exec', 'mcp__terminal__run_in_terminal']) {
      expect(isShellTool(name), name).toBe(true)
    }
    for (const name of ['Write', 'Edit', 'apply_patch', 'Read', 'mcp__terminal__read_terminal', 'mcp__docs__search', 'WebFetch']) {
      expect(isShellTool(name), name).toBe(false)
    }
  })
})

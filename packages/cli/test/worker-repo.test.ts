import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { workerBoardsPath } from '../src/home.ts'
import {
  canonicalRepository,
  workerCheckoutDirectory,
  workerRepositoryDirectory,
} from '../src/worker-repo.ts'

test('case variants name one owned checkout and machine state is repo-independent', () => {
  const options = { env: {}, home: '/home/worker' }
  const repositoryDirectory = join('/home/worker', '.vegafactory', 'worker', 'repos', 'org__repo')

  expect(canonicalRepository('Org/Repo')).toBe('org/repo')
  expect(workerRepositoryDirectory('Org/Repo', options)).toBe(repositoryDirectory)
  expect(workerCheckoutDirectory('Org/Repo', options)).toBe(join(repositoryDirectory, 'repo'))
  expect(workerCheckoutDirectory('org/repo', options)).toBe(workerCheckoutDirectory('Org/Repo', options))
  expect(workerBoardsPath(options)).toBe(join('/home/worker', '.vegafactory', 'worker', 'boards.json'))
})

test('invalid and wildcard repository names never become owned paths', () => {
  const options = { env: {}, home: '/home/worker' }

  for (const repo of ['*', 'all', 'owner', '../repo', 'owner/..', 'owner/repo/extra']) {
    expect(() => workerCheckoutDirectory(repo, options)).toThrow('invalid repository')
  }
})

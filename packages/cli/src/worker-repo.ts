import { join } from 'node:path'
import type { HomeOptions } from './home.ts'
import { workerRepositoriesDirectory } from './home.ts'
import { assertRepo } from './issue-cache.ts'

// GitHub repository identity is case-insensitive. Validate before canonicalizing so wildcard and
// path-like values can never become worker-owned filesystem paths.
export function canonicalRepository(repo: string): string {
  return assertRepo(repo).toLowerCase()
}

export function workerRepositoryDirectory(repo: string, options: HomeOptions = {}): string {
  return join(workerRepositoriesDirectory(options), canonicalRepository(repo).replace('/', '__'))
}

export function workerCheckoutDirectory(repo: string, options: HomeOptions = {}): string {
  return join(workerRepositoryDirectory(repo, options), 'repo')
}

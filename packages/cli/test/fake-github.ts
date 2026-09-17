// An in-process stand-in for `gh api -i`: enough of GitHub's REST surface for the
// issue cache, acks and label edits, with ETags and 304s like the real thing.
import { createHash } from 'node:crypto'
import type { GhResult, GhRunner } from '../src/gh.ts'

export interface FakeComment { id: number; body: string; login: string; type?: string; created_at: string; updated_at: string }
export interface FakeIssue {
  number: number
  title: string
  body: string
  state: string
  labels: string[]
  assignees: string[]
  login: string
  updated_at: string
  comments: FakeComment[]
  subIssues: number[]
  blockedBy: Array<{ number: number; state: string }>
  parent: number | null
}

export class FakeGitHub {
  issues = new Map<number, FakeIssue>()
  permissions = new Map<string, string>()
  calls: string[] = []
  private nextId = 1000
  private clock = Date.parse('2026-09-17T10:00:00Z')

  tick(): string {
    this.clock += 1000
    return new Date(this.clock).toISOString().replace(/\.\d+Z$/, 'Z')
  }

  addIssue(partial: Partial<FakeIssue> & { number: number }): FakeIssue {
    const issue: FakeIssue = {
      title: `Issue ${partial.number}`, body: 'Brief body', state: 'open', labels: [], assignees: [], login: 'mk',
      updated_at: this.tick(), comments: [], subIssues: [], blockedBy: [], parent: null, ...partial,
    }
    this.issues.set(issue.number, issue)
    return issue
  }

  addComment(number: number, body: string, login = 'mk', type = 'User'): FakeComment {
    const issue = this.issues.get(number)!
    const at = this.tick()
    const comment = { id: this.nextId++, body, login, type, created_at: at, updated_at: at }
    issue.comments.push(comment)
    issue.updated_at = at
    return comment
  }

  editComment(id: number, body: string) {
    for (const issue of this.issues.values()) {
      const comment = issue.comments.find((c) => c.id === id)
      if (comment) { comment.body = body; comment.updated_at = this.tick(); issue.updated_at = comment.updated_at }
    }
  }

  deleteComment(id: number) {
    for (const issue of this.issues.values()) issue.comments = issue.comments.filter((c) => c.id !== id)
  }

  private respond(status: number, body: unknown, etag?: string): GhResult {
    const head = [`HTTP/2.0 ${status} ${status === 304 ? 'Not Modified' : 'OK'}`, 'Content-Type: application/json']
    if (etag) head.push(`Etag: ${etag}`)
    const text = body === undefined ? '' : JSON.stringify(body)
    return { code: status >= 300 ? 1 : 0, stdout: `${head.join('\r\n')}\r\n\r\n${text}`, stderr: '' }
  }

  private conditional(body: unknown, ifNoneMatch: string | undefined): GhResult {
    const etag = `W/"${createHash('sha1').update(JSON.stringify(body)).digest('hex')}"`
    if (ifNoneMatch === etag) return this.respond(304, undefined, etag)
    return this.respond(200, body, etag)
  }

  private issueJson(issue: FakeIssue) {
    return {
      number: issue.number, title: issue.title, body: issue.body, state: issue.state,
      labels: issue.labels.map((name) => ({ name })), assignees: issue.assignees.map((login) => ({ login })),
      user: { login: issue.login, type: 'User' }, comments: issue.comments.length, updated_at: issue.updated_at,
      html_url: `https://github.com/o/r/issues/${issue.number}`,
    }
  }

  private commentJson(comment: FakeComment, number: number) {
    return {
      id: comment.id, body: comment.body, user: { login: comment.login, type: comment.type ?? 'User' },
      created_at: comment.created_at, updated_at: comment.updated_at,
      html_url: `https://github.com/o/r/issues/${number}#issuecomment-${comment.id}`,
    }
  }

  runner: GhRunner = (args, input) => {
    const method = args[args.indexOf('-X') + 1]!
    const path = args[args.indexOf('-X') + 2]!
    const header = args.includes('-H') ? args[args.indexOf('-H') + 1]!.replace(/^If-None-Match: /, '') : undefined
    this.calls.push(`${method} ${path}`)
    const payload = input ? JSON.parse(input) : undefined
    const [route, query = ''] = path.split('?')
    const params = new URLSearchParams(query)
    const page = Number(params.get('page') ?? 1)
    const perPage = Number(params.get('per_page') ?? 30)
    let m: RegExpExecArray | null

    if ((m = /^repos\/o\/r\/issues\/(\d+)$/.exec(route!))) {
      const issue = this.issues.get(Number(m[1]))
      if (!issue) return this.respond(404, { message: 'Not Found' })
      if (method === 'PATCH') { issue.body = payload.body; issue.updated_at = this.tick(); return this.respond(200, this.issueJson(issue)) }
      return this.conditional(this.issueJson(issue), header)
    }
    if ((m = /^repos\/o\/r\/issues\/(\d+)\/comments$/.exec(route!))) {
      const issue = this.issues.get(Number(m[1]))!
      if (method === 'POST') {
        const comment = this.addComment(issue.number, payload.body, 'mk')
        return this.respond(201, this.commentJson(comment, issue.number))
      }
      const slice = issue.comments.slice((page - 1) * perPage, page * perPage).map((c) => this.commentJson(c, issue.number))
      return this.conditional(slice, header)
    }
    if ((m = /^repos\/o\/r\/issues\/comments\/(\d+)$/.exec(route!))) {
      this.editComment(Number(m[1]), payload.body)
      return this.respond(200, {})
    }
    if ((m = /^repos\/o\/r\/issues\/(\d+)\/sub_issues$/.exec(route!))) {
      const issue = this.issues.get(Number(m[1]))!
      return this.respond(200, page === 1 ? issue.subIssues.map((number) => ({ number, state: 'open' })) : [])
    }
    if ((m = /^repos\/o\/r\/issues\/(\d+)\/dependencies\/blocked_by$/.exec(route!))) {
      const issue = this.issues.get(Number(m[1]))!
      return this.respond(200, page === 1 ? issue.blockedBy : [])
    }
    if ((m = /^repos\/o\/r\/issues\/(\d+)\/parent$/.exec(route!))) {
      const issue = this.issues.get(Number(m[1]))!
      return issue.parent ? this.respond(200, { number: issue.parent }) : this.respond(404, { message: 'Not Found' })
    }
    if ((m = /^repos\/o\/r\/issues\/(\d+)\/labels$/.exec(route!))) {
      const issue = this.issues.get(Number(m[1]))!
      for (const label of payload.labels) if (!issue.labels.includes(label)) issue.labels.push(label)
      issue.updated_at = this.tick()
      return this.respond(200, [])
    }
    if ((m = /^repos\/o\/r\/issues\/(\d+)\/labels\/(.+)$/.exec(route!))) {
      const issue = this.issues.get(Number(m[1]))!
      const name = decodeURIComponent(m[2]!)
      if (!issue.labels.includes(name)) return this.respond(404, { message: 'Label does not exist' })
      issue.labels = issue.labels.filter((label) => label !== name)
      issue.updated_at = this.tick()
      return this.respond(200, [])
    }
    if ((m = /^repos\/o\/r\/collaborators\/([^/]+)\/permission$/.exec(route!))) {
      return this.respond(200, { permission: this.permissions.get(decodeURIComponent(m[1]!)) ?? 'read' })
    }
    return this.respond(404, { message: `fake GitHub has no route for ${method} ${path}` })
  }
}

#!/usr/bin/env node
// The ask round: render questions into a `questions` comment, parse whatever a
// teammate replies, re-ask only what is still open, and decide which route the
// round takes at all. Text in, text out — this script makes no `gh` call, no
// network call, and writes no file, so it needs no credentials and no dry run.
//
// The route, the comment shape and the reply grammar are documented once in
// dev-setup's references/ask-route.md; this file is the method behind them.
//
//   node questions.mjs render  --spec <file.json> [--rev <n>] [--json]
//   node questions.mjs parse   --comment <file> (--spec <file.json> | --round <file.md>) [--json]
//   node questions.mjs re-ask  (--spec <file.json> | --round <file.md>) --comment <file> --rev <n> [--json]
//   node questions.mjs route   --tool <name|none> --asker <login> --operator <login> [--json]
//
// Exit codes: 0 pass · 1 answers still open or malformed (nothing to re-ask, for
// `re-ask`) · 2 refusal or usage error.
import { lstatSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The comment marker, written once: the renderer emits it and the round reader
// finds it by the same string, so the two can never drift apart.
const MARKER_OPEN = '<!-- vsk:v1 type=questions rev='
const MARKER_CLOSE = ' -->'

// Options run a through h: eight is already more than a person will weigh, and a
// bounded set is what makes the reply grammar a single character.
const LETTERS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']

// Every path this script reads goes through here. A symlink is refused rather
// than followed: the caller hands it a path from an issue comment's neighbourhood,
// and a guard that resolves links reads whatever the link points at.
export function readTextFile(path) {
  const stats = lstatSync(path)
  if (stats.isSymbolicLink()) throw new Error('refusing to read a symlink: ' + path)
  if (!stats.isFile()) throw new Error('not a regular file: ' + path)
  return readFileSync(path, 'utf8')
}

// The display number of a question: its `n` when the round is a re-ask carrying
// the original numbering, otherwise its position.
function numberOf(question, index) {
  return typeof question.n === 'number' ? question.n : index + 1
}

// Text that would break out of the round it is rendered into. A round can be read
// back out of a comment anyone may have written, so this is checked on the way in
// as well as on the way out — rendered text is never allowed to carry a marker or
// close the block it sits in.
const UNSAFE_TEXT = ['<!--', '-->', '<questions>', '</questions>']

function checkText(label, value) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(label + ' is empty')
  for (const fragment of UNSAFE_TEXT) {
    if (value.includes(fragment)) throw new Error(label + ' carries markup that would break the round: ' + fragment)
  }
}

// A spec that cannot render is a bug in the caller, not a question for the user,
// so every check throws with the question's own number in the message.
export function checkSpec(spec) {
  const questions = spec && Array.isArray(spec.questions) ? spec.questions : null
  if (!questions) throw new Error('spec has no questions array')
  if (questions.length === 0) throw new Error('a round needs at least one question')
  questions.forEach((question, index) => {
    const n = numberOf(question, index)
    const label = 'question ' + n
    checkText(label, question.text)
    const options = Array.isArray(question.options) ? question.options : []
    if (options.length < 2) throw new Error(label + ' has fewer than two options')
    const seen = new Set()
    for (const option of options) {
      checkText(label, option.text)
      if (!LETTERS.includes(option.letter)) {
        throw new Error(label + ' uses the letter "' + option.letter + '" — options run a through h')
      }
      if (seen.has(option.letter)) throw new Error(label + ' repeats the letter "' + option.letter + '"')
      seen.add(option.letter)
      if (option.recommended) {
        if (typeof option.reason !== 'string' || option.reason.trim() === '') {
          throw new Error(label + ' recommends "' + option.letter + '" without a reason')
        }
        checkText(label, option.reason)
      }
    }
    const recommended = options.filter((option) => option.recommended)
    if (recommended.length === 0) throw new Error(label + ' has no recommended option')
    if (recommended.length > 1) throw new Error(label + ' has ' + recommended.length + ' recommended options')
  })
  return questions
}

// The rendered comment. The `<questions>` wrapper is what lets the parser and the
// model both find the round inside a comment that may carry prose around it.
export function renderQuestions(spec, options) {
  const rev = options && options.rev ? Number(options.rev) : 1
  if (!Number.isInteger(rev) || rev < 1) throw new Error('rev must be a positive integer')
  const questions = checkSpec(spec)
  const lines = []
  lines.push(MARKER_OPEN + rev + MARKER_CLOSE)
  lines.push('## Questions (v' + rev + ')')
  lines.push('')
  lines.push('<questions>')
  questions.forEach((question, index) => {
    if (index > 0) lines.push('')
    lines.push('**Q' + numberOf(question, index) + '.** ' + question.text)
    for (const option of question.options) {
      let line = '- ' + option.letter + ') ' + option.text
      if (option.recommended) line += ' (recommended — ' + option.reason + ')'
      lines.push(line)
    }
  })
  // The example in the reply line is the round's own first question and its first
  // letter, so a re-ask that starts at Q3 tells the reader to write `3: a`.
  const first = questions[0]
  const example = numberOf(first, 0) + ': ' + first.options[0].letter
  lines.push('')
  lines.push('Reply with `' + example + '` per question, or `all recommended`.')
  lines.push('</questions>')
  lines.push('')
  return lines.join('\n')
}

// An answer line: an optional bullet, the question number, `:` or `.`, the option
// word, and optional trailing prose — only after a dash. The dash is what makes
// `1: a — too slow` a note and `1: a is too slow, go with b` a sentence: without
// it the letter is not an answer, and a numbered line that is not an answer is
// reported rather than read as the letter it happens to open with. Lines with no
// number are prose — a reply is a comment written by a person, not a form.
const ANSWER_LINE = /^\s*(?:[-*]\s+)?(\d+)\s*[:.]\s*([A-Za-z]+)[.!]?\s*(?:(?:—|–|--|-)\s*(.*))?$/
const NUMBERED_LINE = /^\s*(?:[-*]\s+)?(\d+)\s*[:.]\s*(\S.*)$/
const ALL_RECOMMENDED = /^\s*(?:[-*]\s+)?all\s+recommended\s*[.!]?\s*$/i

// Reads a reply comment against the round it answers. Never throws on the reply
// itself: an unusable reply comes back as `malformed`, which is what a re-ask is
// built from. It throws only on a spec that could not have been rendered.
export function parseAnswers(replyText, spec) {
  const questions = checkSpec(spec)
  const numbers = questions.map((question, index) => numberOf(question, index))
  const answers = {}
  const malformed = []
  let sawAnswerLine = false
  let allRecommended = false

  for (const line of String(replyText).split('\n')) {
    if (ALL_RECOMMENDED.test(line)) {
      allRecommended = true
      sawAnswerLine = true
      continue
    }
    const match = ANSWER_LINE.exec(line)
    if (!match) {
      const numbered = NUMBERED_LINE.exec(line)
      if (numbered) {
        sawAnswerLine = true
        malformed.push('question ' + Number(numbered[1]) + ': "' + numbered[2].trim() + '" is not a bare answer — write "' + Number(numbered[1]) + ': a" or "' + Number(numbered[1]) + ': a — <note>"')
      }
      continue
    }
    sawAnswerLine = true
    const n = Number(match[1])
    const token = match[2].toLowerCase()
    const trailing = (match[3] || '').trim()
    const position = numbers.indexOf(n)
    if (position === -1) {
      malformed.push('question ' + n + ' is not in this round')
      continue
    }
    if (Object.prototype.hasOwnProperty.call(answers, n)) {
      malformed.push('question ' + n + ' answered twice — the first answer stands')
      continue
    }
    const known = questions[position].options.some((option) => option.letter === token)
    if (token !== 'other' && !known) {
      malformed.push('question ' + n + ': "' + token + '" is not an option')
      continue
    }
    answers[n] = { option: token, text: trailing === '' ? null : trailing }
  }

  if (allRecommended) {
    questions.forEach((question, index) => {
      const n = numbers[index]
      if (Object.prototype.hasOwnProperty.call(answers, n)) return
      const recommended = question.options.find((option) => option.recommended)
      answers[n] = { option: recommended.letter, text: null }
    })
  }

  const missing = numbers.filter((n) => !Object.prototype.hasOwnProperty.call(answers, n))
  if (!sawAnswerLine) {
    malformed.push('no answer line found — expected "<number>: <letter>" per question, or "all recommended"')
  }
  return { answers, missing, malformed }
}

// The next round: the questions a reply left open, each carrying the number it
// had in the original round, so a re-ask re-uses `**Q3.**` rather than renumbering
// and inviting an answer to a question nobody asked twice.
export function openQuestions(spec, parsed) {
  const questions = checkSpec(spec)
  const numbers = questions.map((question, index) => numberOf(question, index))
  const open = new Set(parsed.missing)
  // A malformed entry names its question; reopen it unless an earlier line in the
  // same reply already answered it (a repeat is malformed, but the first stands).
  for (const problem of parsed.malformed) {
    const named = /^question (\d+)\b/.exec(problem)
    if (!named) continue
    const n = Number(named[1])
    if (!numbers.includes(n)) continue
    if (Object.prototype.hasOwnProperty.call(parsed.answers, n)) continue
    open.add(n)
  }
  const kept = questions
    .map((question, index) => ({ ...question, n: numbers[index] }))
    .filter((question) => open.has(question.n))
  return { ...spec, questions: kept }
}

// The inverse of `renderQuestions`: a posted `questions` comment read back into
// the spec it was rendered from. This is what makes the wrapper earn its place —
// the run that reads the reply is a different, later session with no round.json
// on disk, so the comment itself has to be the record of what was asked.
const ROUND_QUESTION = /^\*\*Q(\d+)\.\*\*\s+(.+)$/
const ROUND_OPTION = /^-\s+([a-z])\)\s+(.+)$/
const ROUND_RECOMMENDED = /^(.*?)\s+\(recommended — (.+)\)$/

export function parseRound(commentText) {
  const text = String(commentText)
  const opened = text.indexOf('<questions>')
  const closed = text.indexOf('</questions>', opened + 1)
  if (opened === -1 || closed === -1) throw new Error('no <questions> block in this comment')
  const markerAt = text.indexOf(MARKER_OPEN)
  const revDigits = markerAt === -1 ? null : /^(\d+)/.exec(text.slice(markerAt + MARKER_OPEN.length))
  const rev = revDigits ? Number(revDigits[1]) : 1
  const questions = []
  for (const line of text.slice(opened + '<questions>'.length, closed).split('\n')) {
    const asked = ROUND_QUESTION.exec(line)
    if (asked) {
      questions.push({ n: Number(asked[1]), text: asked[2].trim(), options: [] })
      continue
    }
    const offered = ROUND_OPTION.exec(line)
    if (!offered) continue
    if (questions.length === 0) throw new Error('an option appears before any question')
    const recommended = ROUND_RECOMMENDED.exec(offered[2].trim())
    if (recommended) {
      questions[questions.length - 1].options.push({
        letter: offered[1],
        text: recommended[1].trim(),
        recommended: true,
        reason: recommended[2].trim(),
      })
    } else {
      questions[questions.length - 1].options.push({ letter: offered[1], text: offered[2].trim() })
    }
  }
  const round = { rev, questions }
  checkSpec(round)
  return round
}

// Which surface the round goes to, in one precedence a caller cannot reorder:
// the environment the worker sets, then whether this harness and run have a
// question tool at all, then whether the person being asked is the person who
// owns the issue. Anything unresolved routes to the issue, because a round in a
// comment is always readable and a round put to the wrong person is not.
export function decideRoute(input) {
  const env = (input && input.env) || {}
  const forced = typeof env.VSK_ASK_ROUTE === 'string' ? env.VSK_ASK_ROUTE.trim() : ''
  if (forced !== '') {
    if (forced !== 'issue' && forced !== 'tool') throw new Error('VSK_ASK_ROUTE must be issue or tool, not "' + forced + '"')
    return { route: forced, reason: 'VSK_ASK_ROUTE=' + forced }
  }
  const tool = input && typeof input.tool === 'string' ? input.tool.trim() : ''
  if (tool === '' || tool === 'none') return { route: 'issue', reason: 'no question tool in this harness or run' }
  const asker = input && typeof input.asker === 'string' ? input.asker.trim() : ''
  const operator = input && typeof input.operator === 'string' ? input.operator.trim() : ''
  if (asker === '' || operator === '') return { route: 'issue', reason: 'the asker or the issue operator is unknown' }
  if (asker !== operator) return { route: 'issue', reason: 'asker ' + asker + ' is not the issue operator ' + operator }
  return { route: 'tool', reason: 'tool ' + tool + ' is available and the asker is the issue operator' }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = [
  'usage:',
  '  questions.mjs render --spec <file.json> [--rev <n>] [--json]',
  '  questions.mjs parse  --comment <file> (--spec <file.json> | --round <file.md>) [--json]',
  '  questions.mjs re-ask (--spec <file.json> | --round <file.md>) --comment <file> --rev <n> [--json]',
  '  questions.mjs route  --tool <name|none> --asker <login> --operator <login> [--json]',
].join('\n')

// A caller supplies the round it is answering either as the JSON it rendered from
// (--spec) or as the posted comment itself (--round), which is what a later,
// fresh session actually has.
function readSpec(path) {
  return JSON.parse(readTextFile(path))
}

function loadRound(specPath, roundPath) {
  if (specPath && roundPath) throw new Error('pass --spec or --round, not both')
  if (specPath) return readSpec(specPath)
  return parseRound(readTextFile(roundPath))
}

function report(json, payload, exitCode, humanLines) {
  if (json) console.log(JSON.stringify(payload, null, 2))
  else for (const line of humanLines) console.log(line)
  process.exit(exitCode)
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  const argv = process.argv.slice(2)
  const json = argv.includes('--json')
  const get = (flag) => { const i = argv.indexOf(flag); return i === -1 ? undefined : argv[i + 1] }
  const command = argv[0]
  const refuse = (reason) => report(json, { command: command || null, ok: false, error: reason }, 2, ['questions: ' + reason])

  if (command === 'render') {
    const specPath = get('--spec')
    if (!specPath) refuse(USAGE)
    try {
      const rev = get('--rev') ? Number(get('--rev')) : 1
      const markdown = renderQuestions(readSpec(specPath), { rev })
      report(json, { command: 'render', ok: true, rev, markdown }, 0, [markdown])
    } catch (error) {
      refuse(error.message)
    }
  } else if (command === 'parse') {
    const specPath = get('--spec')
    const roundPath = get('--round')
    const commentPath = get('--comment')
    if ((!specPath && !roundPath) || !commentPath) refuse(USAGE)
    try {
      const parsed = parseAnswers(readTextFile(commentPath), loadRound(specPath, roundPath))
      const open = parsed.missing.length > 0 || parsed.malformed.length > 0
      const human = ['questions: ' + Object.keys(parsed.answers).length + ' answered']
      if (parsed.missing.length) human.push('  open: ' + parsed.missing.join(', '))
      for (const problem of parsed.malformed) human.push('  malformed: ' + problem)
      report(json, { command: 'parse', ok: !open, ...parsed }, open ? 1 : 0, human)
    } catch (error) {
      refuse(error.message)
    }
  } else if (command === 're-ask') {
    const specPath = get('--spec')
    const roundPath = get('--round')
    const commentPath = get('--comment')
    const revRaw = get('--rev')
    if ((!specPath && !roundPath) || !commentPath || !revRaw) refuse(USAGE)
    try {
      const spec = loadRound(specPath, roundPath)
      const parsed = parseAnswers(readTextFile(commentPath), spec)
      const open = openQuestions(spec, parsed)
      if (open.questions.length === 0) {
        report(json, { command: 're-ask', ok: false, open: [], reason: 'nothing is open — every question is answered' }, 1, ['questions: nothing is open'])
      }
      const rev = Number(revRaw)
      const markdown = renderQuestions(open, { rev })
      report(json, { command: 're-ask', ok: true, rev, open: open.questions.map((q) => q.n), markdown }, 0, [markdown])
    } catch (error) {
      refuse(error.message)
    }
  } else if (command === 'route') {
    const tool = get('--tool')
    const asker = get('--asker')
    const operator = get('--operator')
    if (!tool || !asker || !operator) refuse(USAGE)
    try {
      const decision = decideRoute({ env: process.env, tool, asker, operator })
      report(json, { command: 'route', ok: true, ...decision }, 0, ['questions: route ' + decision.route + ' — ' + decision.reason])
    } catch (error) {
      refuse(error.message)
    }
  } else {
    refuse(USAGE)
  }
}

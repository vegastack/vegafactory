/*
## Scoped approval records

The owner is dev-implement's `scripts/lib/approval.mjs`. Use its `artifactRef`, `scopeDigest`, `parseApproval` and approval evaluators; consumers do not implement another interpretation. Refresh complete issue/comment/dependency reads and current operator policy before recording or consuming intent. Unreadable history refuses execution.

An `ArtifactRef` has exactly `repo`, `issue`, `kind` (`brief`, `plan` or `protocol`), `artifactId`, `rev` and `digest`. The issue node ID identifies a brief; the unique canonical comment node ID identifies a plan/protocol. Digest is lowercase SHA-256 of canonical UTF-8 scope, with CRLF normalized to LF. Resolve these fields from current source, never from an index or a copied approval.

An ordinary approval opens with `<!-- vsk:v1 type=approval scope=brief+plan -->` (or its exact `brief`/`plan` scope), followed by one fenced JSON payload:

```ts
type ApprovalRecord = {
  schemaVersion: 2; id: string; operator: string;
  scope: "brief" | "plan" | "brief+plan";
  source: {kind: "github-comment" | "session"; ref: string; quote: string};
  artifacts: ArtifactRef[]; supersedes: string[]; revokes: string[];
};
```

Record the operator's actual words and source, then the exact approved bindings. Quick-build implementation requires both brief and plan; full-plan planning requires brief approval, and implementation requires both. Research execution additionally binds its current immutable protocol through the consolidated event. Brief-only research preparation does not launch a trial. Shipping actions retain their own authority.

Events have unique IDs. A changed scope needs fresh intent; conflicting grants require explicit `supersedes`, never newest-wins. A revocation event names exact earlier IDs and grants no new binding when its artifact list is empty. Preserve originals. Legacy marker-only or malformed records refuse: an explicitly authorized `scope=none` correction can neutralize only exact malformed targets, and a separate valid approval still supplies current intent. The correction JSON has exactly `schemaVersion:2`, `kind:"correction"`, `scope:"none"`, `operator`, `source`, `targets:[{commentId,bodySha256}]`, `supersedes:[]`, `revokes:[]`. Changed/missing targets, invalid operator/source, self-reference and malformed corrections refuse.

For a reviewed parent scope, use a separate `scope=consolidated` event on the parent issue. Its closed JSON has `schemaVersion:2`, `kind:"consolidated"`, `id`, `operator`, `scope:"consolidated"`, `source`, `manifest`, `items`, `actions`, `supersedes` and `revokes`. Each item names exact repository/issue/mode (`code`, `preparation`, `research`), artifact bindings, task IDs and action IDs. Each action is one reviewed local operation set, an exact source-checkpoint ref/scope, or a protocol-bound research allowance. Unknown keys/kinds and excess or missing selections refuse. The completion index is not a plan.

The manifest locator is `{sha256,source:{kind:"inline",utf8}}` or `{sha256,source:{kind:"git-blob",repositoryId,commitSha,path,blobSha256}}`. Keep the reviewed manifest bytes frozen; authority lives in the separate actual approval event. A Git locator requires its own authorized immutable destination; a local filename alone cannot locate runtime authority. The parent ledger pins the approval's comment ID/body SHA-256 and manifest SHA-256. Children consume that exact record, without synthetic child approval comments. Source checkpoints still require the complete export proof and durable delivery intent; research still requires the protocol's candidate, prerequisite and shared allowance checks. Local approval never supplies production/private-state, service/reboot, merge, publication or destructive-cleanup authority.

The canonicalizer reads artifact/task markers outside fenced examples. Plan task IDs/order, requirements, interfaces, action bounds, revisions and all other bytes remain scope. Only existing structural task-header checkboxes normalize to unchecked. A plan may also carry one progress block whose body is strict JSON `{tasks:[{id,evidenceUrls}]}` between `<!-- vsk:progress:start -->` and `<!-- vsk:progress:end -->`; IDs must name existing tasks and evidence URLs must be HTTP(S). The entire validated block is excluded from scope. Unknown fields, duplicates, invalid URLs and malformed blocks refuse. Briefs permit no mutable block. Protocols retain their entire normalized body, including checkboxes. Fenced examples remain immutable bytes and supply no metadata authority.

### Inspect, reconfirm and consume

Keep old comments verbatim. In report-only inventory, read every open issue and all comment pages, call `artifactRef` for its current brief/unique plan, and call `evaluateApprovals` for the intended stage. Report refusal reasons plus current artifact IDs/revisions/digests; never emit a fabricated grant or alter labels. Ask for the operator’s exact current-scope intent and, when needed, their exact malformed-target correction. Record each new event separately, refresh again and run the evaluator before work starts.

`preflight.mjs --stage plan` requires brief intent; implementation requires brief+plan, including quick-build’s separate plan comment. Research preparation does not start a vendor process. `--consolidated-request <json>` accepts `{parentRepo,parentIssue,approvalBinding:{commentId,bodySha256},requested:{repo,issue,taskIds,actionId,branch,baseSha,paths,operation}}`; the approved manifest is fetched from the pinned record, never a local path. Approval bodies/source comments, canonical singleton comments, manifests and dependencies are fresh reads. Successful launch results expose `approvalIds` and `bindings` for run/recovery consumers.

Preparation adds `requested.preparation:{commentId,bodySha256}` and the #144 owner’s exact source-bound projection: parent identity, current plan ref, selected task IDs/files/prerequisite issues and accepted code-contract receipts with child/parent SHA and evidence pins. These are checked against the canonical selected scope; the recovery owner establishes mapping completeness and actual accepted integration. Missing receipts refuse. Full issue execution keeps every native blocker and is not authorized by preparation.

Research adds its exact scenario and pinned reservation reference. The protocol owner supplies fetched ledger projections binding owner task/changed skill, protocol, source/tree and packed SHA-256/SRI, subscription harness/model/account/effort/config/policy, and complete phase/overall attempt history. Failed, child and resumed starts remain counted; a changed skill never gets a fresh allowance merely because another issue owns its next edit. `protocolLimits` recognizes only unambiguous envelope clauses from the bound protocol outside fenced examples (core/skill/reserve/total/active-time/per-process, or the top-level trial envelope); unsupported clauses refuse. Numeric limits beside a protocol digest are not authority.

`evaluateConsolidatedApproval` evaluates scope and returns research `pendingEffects`; `gatherConsolidatedApproval` will not admit a process without `admitConsolidatedResearch`’s protocol-owned `inspectCandidate` and atomic `consumeReservation` adapter. The former verifies actual clean SHA/tree, approved-base/integration ancestry and packed bytes; the latter consumes the exact revision/attempt once before launch. An absent adapter, changed identity or replay refuses. Checkpoint scope likewise retains #138’s complete export proof/durable delivery intent. These APIs do not supply production/service/private-state/publication authority.

*/
import { createHash } from 'node:crypto';

const hash = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const fail = (reason) => { throw new Error(reason); };
const check = (condition, reason) => { if (!condition) fail(reason); };
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.trim().length > 0;
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const integer = (value) => Number.isSafeInteger(value) && value > 0;
const repo = (value) => typeof value === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
const taskId = (value) => typeof value === 'string' && /^[1-9]\d*-T[1-9]\d*$/.test(value);
const branch = (value) => text(value) && !/\s|[~^:?*\[\\]|\.\.|@\{|\/\/|^\/|\/$|\.$|\.lock(?:\/|$)/.test(value) && value !== '@' && !value.startsWith('-');
const keys = (value, names, optional = []) => {
  check(isObject(value), 'expected an object');
  check(Object.keys(value).every((key) => names.includes(key) || optional.includes(key)), 'unknown record field');
  check(names.every((key) => Object.hasOwn(value, key)), 'missing record field');
};
const list = (value, predicate, name, { nonempty = false } = {}) => {
  check(Array.isArray(value) && (!nonempty || value.length > 0) && value.every(predicate), 'invalid ' + name);
  check(new Set(value.map((item) => JSON.stringify(item))).size === value.length, 'duplicate ' + name);
};

// JSON.parse alone silently accepts duplicate keys. Tokenize only after grammar
// validation, then inspect each object, including escaped spellings of keys.
export function parseStrictJson(raw) {
  check(typeof raw === 'string' && Buffer.byteLength(raw, 'utf8') <= 1024 * 1024, 'invalid JSON size');
  const value = JSON.parse(raw);
  const tokens = raw.match(/"(?:[^"\\]|\\.)*"|[{}\[\],:]|[^\s{}\[\],:]+/g) ?? [];
  let cursor = 0;
  function visit(depth = 0) {
    check(depth <= 64, 'JSON nesting too deep');
    const token = tokens[cursor++];
    if (token === '{') {
      const found = new Set();
      while (tokens[cursor] !== '}') {
        const key = JSON.parse(tokens[cursor++]);
        check(!found.has(key), 'duplicate JSON key');
        check(!['__proto__', 'prototype', 'constructor'].includes(key), 'unsafe JSON key');
        found.add(key);
        cursor++; // colon; syntax was already validated
        visit(depth + 1);
        if (tokens[cursor] === ',') cursor++;
      }
      cursor++;
    } else if (token === '[') {
      while (tokens[cursor] !== ']') {
        visit(depth + 1);
        if (tokens[cursor] === ',') cursor++;
      }
      cursor++;
    }
  }
  visit();
  check(cursor === tokens.length, 'invalid JSON tokens');
  return value;
}

function linesOf(body) {
  check(typeof body === 'string' && body.isWellFormed() && Buffer.byteLength(body, 'utf8') <= 1024 * 1024, 'invalid artifact body');
  let fence = null;
  return body.replaceAll('\r\n', '\n').match(/[^\n]*\n|[^\n]+$/g)?.map((line) => {
    const opening = /^ {0,3}(`{3,}|~{3,})(.*?)(?:\n)?$/.exec(line);
    const structural = fence === null && opening === null && !/^(?: {4}|\t)/.test(line);
    const fenceOpen = fence === null && opening ? opening[2].trim() : null;
    const fenceClose = fence !== null && opening && opening[1][0] === fence[0] && opening[1].length >= fence.length && opening[2].trim() === '';
    if (opening) {
      if (fence === null) fence = opening[1];
      else if (opening[1][0] === fence[0] && opening[1].length >= fence.length && opening[2].trim() === '') fence = null;
    }
    return { line, structural, fenceOpen, fenceClose: Boolean(fenceClose) };
  }) ?? [];
}

function structuralMarker(line) {
  const match = /^\s*<!--\s*vsk:v1\s+([^>]+?)\s*-->\s*$/.exec(line);
  if (!match) return null;
  const result = {};
  for (const pair of match[1].trim().split(/\s+/)) {
    const split = pair.indexOf('=');
    check(split > 0 && split < pair.length - 1, 'malformed artifact marker');
    const key = pair.slice(0, split);
    check(!Object.hasOwn(result, key) && !['__proto__', 'constructor', 'prototype'].includes(key), 'duplicate marker key');
    result[key] = pair.slice(split + 1);
  }
  return result;
}

export function canonicalScope(body, kind) {
  check(['brief', 'plan', 'protocol'].includes(kind), 'unknown artifact kind');
  const lines = linesOf(body);
  if (kind === 'protocol') return body.replaceAll('\r\n', '\n');
  const markers = [];
  const tasks = new Set();
  let progress = null;
  let progressSeen = false;
  let progressBody = '';
  let result = '';
  for (const { line, structural } of lines) {
    if (structural && line.trim() === '<!-- vsk:progress:start -->') {
      check(kind === 'plan' && !progressSeen, 'duplicate or forbidden progress block');
      progressSeen = true;
      progress = true;
      continue;
    }
    if (structural && line.trim() === '<!-- vsk:progress:end -->') {
      check(progress === true, 'unmatched progress end');
      progress = false;
      continue;
    }
    if (progress === true) { progressBody += line; continue; }
    if (structural) {
      const marker = structuralMarker(line);
      if (marker && ['brief', 'plan'].includes(marker.type)) markers.push(marker);
      const ids = [...line.matchAll(/<!-- task-id:([^>]+) -->/g)].map((match) => match[1]);
      if (ids.length > 0) {
        check(kind === 'plan' && /^- \[[ xX]\] \*\*Task /.test(line) && ids.length === 1 && taskId(ids[0]), 'invalid structural task identity');
        check(!tasks.has(ids[0]), 'duplicate task identity');
        tasks.add(ids[0]);
        result += line.replace(/^- \[[xX]\]/, '- [ ]');
        continue;
      }
      check(!/^- \[[ xX]\] \*\*Task /.test(line), 'task header lacks stable identity');
    }
    result += line;
  }
  check(markers.length === 1 && markers[0].type === kind && /^[1-9]\d*$/.test(markers[0].rev), 'missing or duplicate artifact marker');
  check(progress !== true, 'unclosed progress block');
  if (progressSeen) {
    const value = parseStrictJson(progressBody);
    keys(value, ['tasks']);
    list(value.tasks, isObject, 'progress tasks');
    const seen = new Set();
    for (const item of value.tasks) {
      keys(item, ['id', 'evidenceUrls']);
      check(tasks.has(item.id) && !seen.has(item.id), 'unknown or duplicate progress task');
      seen.add(item.id);
      list(item.evidenceUrls, (url) => {
        try { const parsed = new URL(url); return typeof url === 'string' && ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password; } catch { return false; }
      }, 'evidence URLs');
    }
  }
  return result;
}

export const scopeDigest = (body, kind) => hash(canonicalScope(body, kind));

function validateSource(value) {
  keys(value, ['kind', 'ref', 'quote']);
  check(['github-comment', 'session'].includes(value.kind) && text(value.ref) && text(value.quote), 'invalid approval source or quotation');
}

function validateArtifact(value) {
  keys(value, ['repo', 'issue', 'kind', 'artifactId', 'rev', 'digest']);
  check(repo(value.repo) && integer(value.issue) && ['brief', 'plan', 'protocol'].includes(value.kind) && text(value.artifactId) && integer(value.rev) && digest(value.digest), 'invalid artifact binding');
}

function validateArtifacts(values) {
  list(values, isObject, 'artifacts');
  const seen = new Set();
  for (const value of values) {
    validateArtifact(value);
    const id = [value.repo, value.issue, value.kind].join('#');
    check(!seen.has(id), 'duplicate artifact kind');
    seen.add(id);
  }
}

function validateManifestSource(value) {
  if (value?.kind === 'inline') {
    keys(value, ['kind', 'utf8']);
    check(text(value.utf8), 'empty inline manifest');
  } else {
    keys(value, ['kind', 'repositoryId', 'commitSha', 'path', 'blobSha256']);
    check(value.kind === 'git-blob' && text(value.repositoryId) && sha(value.commitSha) && safePath(value.path) && digest(value.blobSha256), 'invalid manifest locator');
  }
}

function safePath(value) {
  return text(value) && !value.startsWith('/') && !/[\\\x00-\x1f]/.test(value) && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..') && !/^[a-z]:/i.test(value);
}

function validateAction(value, frozen = false) {
  if (value?.kind === 'local') {
    keys(value, ['id', 'kind', 'repo', 'parentBranch', 'operations']);
    check(repo(value.repo) && branch(value.parentBranch), 'invalid local target');
    list(value.operations, (op) => ['edit', 'check', 'review', 'integrate'].includes(op), 'local operations', { nonempty: true });
  } else if (value?.kind === 'checkpoint') {
    keys(value, ['id', 'kind', 'repo', 'branch', 'sourceScopeDigest']);
    check(repo(value.repo) && branch(value.branch) && digest(value.sourceScopeDigest), 'invalid checkpoint target');
  } else {
    keys(value, ['id', 'kind', 'issue', 'protocolArtifactId', 'protocolDigest', 'candidateRule', 'scenarioIds', 'maxStarts', 'aggregateActiveMs', 'providerMode']);
    check(value.kind === 'research-tests' && integer(value.issue) && text(value.protocolArtifactId) && digest(value.protocolDigest), 'invalid research protocol');
    const rule = value.candidateRule;
    keys(rule, ['kind', 'repo', 'parentBranch', 'baseSha', ...(frozen ? [] : ['manifestSha256'])]);
    check(rule.kind === 'approved-parent-candidate' && repo(rule.repo) && branch(rule.parentBranch) && sha(rule.baseSha) && (frozen || digest(rule.manifestSha256)), 'invalid candidate rule');
    list(value.scenarioIds, text, 'scenarios', { nonempty: true });
    check(integer(value.maxStarts) && (value.aggregateActiveMs === null || integer(value.aggregateActiveMs)) && value.providerMode === 'subscription-only', 'invalid research allowance');
  }
  check(text(value.id), 'missing action identity');
}

function validateItem(value) {
  keys(value, ['repo', 'issue', 'mode', 'artifacts', 'taskIds', 'actionIds']);
  check(repo(value.repo) && integer(value.issue) && ['code', 'preparation', 'research'].includes(value.mode), 'invalid selection');
  validateArtifacts(value.artifacts);
  check(value.artifacts.every((ref) => ref.repo === value.repo && ref.issue === value.issue), 'cross-issue artifact binding');
  check(value.artifacts.length === 2 && value.artifacts.some((ref) => ref.kind === 'brief') && value.artifacts.some((ref) => ref.kind === (value.mode === 'research' ? 'protocol' : 'plan')), 'missing selection artifact');
  list(value.taskIds, (id) => taskId(id) && id.startsWith(value.issue + '-T'), 'selected tasks', { nonempty: value.mode !== 'research' });
  check(value.mode !== 'research' || value.taskIds.length === 0, 'research cannot select code tasks');
  list(value.actionIds, text, 'selected actions', { nonempty: true });
}

export function parseApproval(comment) {
  try {
    const lines = linesOf(comment?.body);
    const markers = lines.filter((line) => line.structural).map(({ line }) => structuralMarker(line)).filter((marker) => marker?.type === 'approval');
    check(markers.length === 1, 'missing or duplicate type=approval marker');
    const blocks = [];
    let collecting = false;
    let payload = '';
    let seenMarker = false;
    for (const row of lines) {
      if (row.structural && structuralMarker(row.line)?.type === 'approval') seenMarker = true;
      if (row.fenceOpen === 'json') {
        check(seenMarker, 'approval payload precedes its marker');
        collecting = true;
        payload = '';
      } else if (row.fenceClose && collecting) {
        blocks.push(payload);
        collecting = false;
      } else if (collecting) payload += row.line;
    }
    check(!collecting, 'unclosed approval payload');
    check(blocks.length === 1, 'approval requires one JSON payload');
    const value = parseStrictJson(blocks[0]);
    check(value.schemaVersion === 2 && value.scope === markers[0].scope && text(value.operator), 'invalid approval version, scope or operator');
    validateSource(value.source);
    list(value.supersedes, text, 'superseded IDs');
    list(value.revokes, text, 'revoked IDs');
    if (value.kind === 'correction') {
      keys(value, ['schemaVersion', 'kind', 'scope', 'operator', 'source', 'targets', 'supersedes', 'revokes']);
      check(value.scope === 'none' && value.supersedes.length === 0 && value.revokes.length === 0, 'correction grants no scope');
      list(value.targets, isObject, 'correction targets', { nonempty: true });
      const ids = new Set();
      for (const target of value.targets) {
        keys(target, ['commentId', 'bodySha256']);
        check((text(target.commentId) || integer(target.commentId)) && digest(target.bodySha256) && !ids.has(String(target.commentId)) && String(target.commentId) !== String(comment.id), 'invalid correction target');
        ids.add(String(target.commentId));
      }
    } else if (value.kind === 'consolidated') {
      keys(value, ['schemaVersion', 'kind', 'id', 'operator', 'scope', 'source', 'manifest', 'items', 'actions', 'supersedes', 'revokes']);
      check(value.scope === 'consolidated', 'invalid consolidated scope');
      keys(value.manifest, ['sha256', 'source']);
      check(digest(value.manifest.sha256), 'invalid manifest digest');
      validateManifestSource(value.manifest.source);
      list(value.items, isObject, 'selections', { nonempty: true });
      value.items.forEach(validateItem);
      check(new Set(value.items.map((item) => item.repo + '#' + item.issue)).size === value.items.length, 'duplicate selection');
      list(value.actions, isObject, 'actions', { nonempty: true });
      value.actions.forEach((action) => validateAction(action));
      check(new Set(value.actions.map((action) => action.id)).size === value.actions.length, 'duplicate action ID');
    } else {
      keys(value, ['schemaVersion', 'id', 'operator', 'scope', 'source', 'artifacts', 'supersedes', 'revokes']);
      check(['brief', 'plan', 'brief+plan'].includes(value.scope), 'unknown approval scope');
      validateArtifacts(value.artifacts);
      check(value.artifacts.length > 0 || value.revokes.length > 0, 'approval grants or revokes no binding');
      const permitted = value.scope === 'brief+plan' ? ['brief', 'plan'] : [value.scope];
      check(value.artifacts.every((ref) => permitted.includes(ref.kind)), 'artifact outside approval scope');
    }
    if (value.kind !== 'correction') {
      check(text(value.id) && !value.supersedes.includes(value.id) && !value.revokes.includes(value.id), 'invalid approval event identity');
      check(!value.supersedes.some((id) => value.revokes.includes(id)), 'conflicting supersede/revoke');
    }
    return value;
  } catch (error) {
    return { ok: false, blocks: ['approval: ' + error.message] };
  }
}

function hasArtifactMarker(comment, kind) {
  return linesOf(comment?.body).some(({ line, structural }) => structural && structuralMarker(line)?.type === kind);
}

function approvalHistory(comments, operators, sourceComments = []) {
  check(Array.isArray(comments), 'approval history is unavailable');
  list(operators, text, 'operators', { nonempty: true });
  const marked = comments.filter((comment) => linesOf(comment?.body).some(({ line, structural }) => structural && /<!--\s*vsk:v1\b[^>]*\btype=approval(?:\s|>|$)/.test(line)));
  const parsed = marked.map((comment) => ({ comment, event: parseApproval(comment) }));
  const commentIds = marked.map((comment) => String(comment.id));
  check(new Set(commentIds).size === commentIds.length, 'duplicate approval comment identity');
  for (const { event } of parsed) {
    if (event.ok === false || event.source.kind !== 'github-comment') continue;
    const source = sourceComments.filter((comment) => comment.html_url === event.source.ref);
    check(source.length === 1 && source[0].user?.login === event.operator && source[0].body.includes(event.source.quote), 'approval source quotation is unavailable or changed');
  }
  const neutralized = new Set();
  for (const { comment, event } of parsed) {
    if (event.kind !== 'correction') continue;
    check(operators.includes(event.operator), 'correction operator is not authorized');
    for (const target of event.targets) {
      const matches = parsed.filter((entry) => String(entry.comment.id) === String(target.commentId));
      check(matches.length === 1 && matches[0].comment !== comment && hash(matches[0].comment.body) === target.bodySha256, 'correction target is absent, duplicate or changed');
      check(matches[0].event.ok === false, 'correction target is not a malformed approval');
      check(!neutralized.has(String(target.commentId)), 'conflicting corrections');
      neutralized.add(String(target.commentId));
    }
  }
  const events = [];
  const byId = new Map();
  const removed = new Set();
  for (const entry of parsed) {
    if (neutralized.has(String(entry.comment.id))) continue;
    const event = entry.event;
    check(event.ok !== false, event.blocks?.join('; ') ?? 'malformed approval');
    check(operators.includes(event.operator), 'approval operator is not authorized');
    if (event.kind === 'correction') continue;
    check(!byId.has(event.id), 'duplicate approval ID');
    for (const id of [...event.supersedes, ...event.revokes]) {
      check(byId.has(id), 'approval references an absent or later event');
      removed.add(id);
    }
    byId.set(event.id, entry);
    events.push(entry);
  }
  return { events, active: events.filter(({ event }) => !removed.has(event.id)), removed };
}

export function artifactRef({ repo: repository, issue, kind, artifact }) {
  check(repo(repository) && integer(issue) && text(artifact?.node_id), 'missing current repository/issue/artifact identity');
  const body = canonicalScope(artifact.body, kind);
  const marker = kind === 'protocol'
    ? linesOf(body).filter((line) => line.structural).map(({ line }) => /^\s*<!--\s*[^>]+\bissue=([1-9]\d*)\s+rev=([1-9]\d*)\s*-->\s*$/.exec(line)).filter(Boolean)
    : linesOf(body).filter((line) => line.structural).map(({ line }) => structuralMarker(line)).filter((value) => value?.type === kind);
  check(marker.length === 1, 'ambiguous current artifact revision');
  if (kind === 'protocol') check(Number(marker[0][1]) === issue, 'protocol issue identity mismatch');
  return { repo: repository, issue, kind, artifactId: artifact.node_id, rev: Number(kind === 'protocol' ? marker[0][2] : marker[0].rev), digest: hash(body) };
}

const sameRef = (left, right) => ['repo', 'issue', 'kind', 'artifactId', 'rev', 'digest'].every((key) => left[key] === right[key]);

export function evaluateApprovals({ repo: repository, issue, brief, plan, comments, operators, requiredScope, sourceComments = [] }) {
  try {
    check(['brief', 'plan', 'brief+plan'].includes(requiredScope), 'unsupported required approval scope');
    const history = approvalHistory(comments, operators, sourceComments);
    const kinds = requiredScope === 'brief+plan' ? ['brief', 'plan'] : [requiredScope];
    const bindings = [];
    for (const kind of kinds) {
      let current = brief;
      if (kind === 'plan') {
        const plans = comments.filter((comment) => hasArtifactMarker(comment, 'plan'));
        check(plans.length === 1 && (!plan || plan.node_id === plans[0].node_id && plan.body === plans[0].body), 'missing or duplicate canonical plan');
        current = plans[0];
      }
      bindings.push(artifactRef({ repo: repository, issue, kind, artifact: current }));
    }
    const applicable = history.active.filter(({ event }) => event.kind !== 'consolidated' && event.artifacts.length > 0);
    for (const { event } of applicable) {
      check(event.artifacts.every((ref) => ref.repo === repository && ref.issue === issue), 'approval belongs to an unrelated issue');
    }
    const ids = new Set();
    for (const binding of bindings) {
      const matching = applicable.filter(({ event }) => event.artifacts.some((ref) => ref.kind === binding.kind));
      check(matching.length === 1, matching.length > 1 ? 'conflicting approvals require explicit supersedes' : 'missing current ' + binding.kind + ' approval');
      check(matching[0].event.artifacts.some((ref) => sameRef(ref, binding)), 'approval scope or artifact identity changed');
      ids.add(matching[0].event.id);
    }
    return { ok: true, bindings, approvalIds: [...ids], blocks: [] };
  } catch (error) {
    return { ok: false, bindings: [], approvalIds: [], blocks: ['approval: ' + error.message] };
  }
}

const sortedJson = (value) => JSON.stringify(value, (_, item) => isObject(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);

export function validateExecutionManifest(bytes) {
  const value = parseStrictJson(bytes);
  keys(value, ['schemaVersion', 'parent', 'codeIssues', 'preparationTaskIds', 'candidateProtocols', 'excludedIssues', 'laterResearch', 'selections', 'actionBounds']);
  check(value.schemaVersion === 1, 'unknown execution manifest version');
  keys(value.parent, ['repo', 'issue', 'branch', 'baseSha']);
  check(repo(value.parent.repo) && integer(value.parent.issue) && branch(value.parent.branch) && sha(value.parent.baseSha), 'invalid manifest parent');
  for (const field of ['codeIssues', 'candidateProtocols', 'excludedIssues', 'laterResearch']) list(value[field], integer, field);
  list(value.preparationTaskIds, taskId, 'preparation IDs');
  list(value.selections, isObject, 'manifest selections', { nonempty: true });
  value.selections.forEach(validateItem);
  check(new Set(value.selections.map((item) => item.repo + '#' + item.issue)).size === value.selections.length, 'duplicate manifest issue');
  check(value.selections.every((item) => item.repo === value.parent.repo && !value.excludedIssues.includes(item.issue) && !value.laterResearch.includes(item.issue)), 'excluded or foreign selection');
  const matches = (left, right) => sortedJson([...left].sort()) === sortedJson([...right].sort());
  check(matches(value.codeIssues, value.selections.filter((item) => item.mode === 'code').map((item) => item.issue)), 'code selection mismatch');
  check(matches(value.candidateProtocols, value.selections.filter((item) => item.mode === 'research').map((item) => item.issue)), 'research selection mismatch');
  check(matches(value.preparationTaskIds, value.selections.filter((item) => item.mode === 'preparation').flatMap((item) => item.taskIds)), 'preparation selection mismatch');
  check(isObject(value.actionBounds), 'missing action bounds');
  for (const [id, action] of Object.entries(value.actionBounds)) {
    validateAction(action, true);
    check(id === action.id, 'action key differs from identity');
    if (action.kind === 'local' || action.kind === 'checkpoint') {
      check(action.repo === value.parent.repo && (action.parentBranch ?? action.branch) === value.parent.branch, 'action escapes parent');
      if (action.kind === 'checkpoint') check(action.sourceScopeDigest === hash(sortedJson({ parent: value.parent, selections: value.selections.filter((item) => item.mode !== 'research') })), 'checkpoint source scope mismatch');
    } else {
      check(action.candidateRule.repo === value.parent.repo && action.candidateRule.parentBranch === value.parent.branch && action.candidateRule.baseSha === value.parent.baseSha, 'research candidate escapes parent');
      const selection = value.selections.find((item) => item.issue === action.issue && item.mode === 'research');
      check(selection?.artifacts.some((ref) => ref.kind === 'protocol' && ref.artifactId === action.protocolArtifactId && ref.digest === action.protocolDigest), 'research action lacks selected protocol');
    }
  }
  check(value.selections.every((item) => item.actionIds.every((id) => Object.hasOwn(value.actionBounds, id))), 'selection references absent action');
  return value;
}

function selectedTaskFiles(body, ids) {
  canonicalScope(body, 'plan');
  const result = new Map();
  let current = null;
  for (const { line, structural } of linesOf(body)) {
    if (!structural) continue;
    const match = /^- \[[ xX]\] \*\*Task .*?<!-- task-id:([1-9]\d*-T[1-9]\d*) -->/.exec(line);
    if (match) { current = match[1]; result.set(current, []); }
    if (/^#{1,6}\s/.test(line)) current = null;
    if (current && /^\s*(?:- )?Files —/.test(line)) {
      result.get(current).push(...[...line.matchAll(/`([^`]+)`/g)].map((entry) => entry[1]));
    }
  }
  check(ids.every((id) => result.has(id)), 'selected task is absent from canonical plan');
  const files = ids.flatMap((id) => result.get(id));
  check(files.length > 0 && files.every(safePath), 'unverifiable task file scope');
  return [...new Set(files)];
}

// currentArtifacts contains independently fetched issue/comment records plus
// the parent ledger's exact approval-comment binding. The fetched parent
// approval history is distinct from historical child planning permissions.
export function evaluateConsolidatedApproval({ record, manifestBytes, currentArtifacts, operators, currentDependencies, requested }) {
  try {
    const manifest = validateExecutionManifest(manifestBytes);
    check(record?.kind === 'consolidated' && hash(manifestBytes) === record.manifest?.sha256, 'manifest hash differs from approval');
    const context = currentArtifacts;
    check(isObject(context) && Array.isArray(context.artifacts) && isObject(context.approvalBinding), 'current artifact or approval binding unavailable');
    const history = approvalHistory(context.approvalComments, operators, context.sourceComments);
    const matching = history.active.filter(({ event }) => event.id === record.id);
    check(matching.length === 1 && sortedJson(matching[0].event) === sortedJson(record), 'approval is absent, revoked or altered');
    check(String(matching[0].comment.id) === String(context.approvalBinding.commentId) && hash(matching[0].comment.body) === context.approvalBinding.bodySha256, 'approval quotation/body binding changed');
    if (record.manifest.source.kind === 'inline') check(record.manifest.source.utf8 === manifestBytes, 'inline manifest differs');
    else check(context.manifestBlob?.repositoryId === record.manifest.source.repositoryId && context.manifestBlob?.commitSha === record.manifest.source.commitSha && context.manifestBlob?.path === record.manifest.source.path && hash(manifestBytes) === record.manifest.source.blobSha256, 'immutable manifest blob unavailable or changed');
    for (const item of record.items) {
      const selection = manifest.selections.find((entry) => entry.repo === item.repo && entry.issue === item.issue);
      check(selection && sortedJson(selection) === sortedJson(item), 'approval selection differs from frozen manifest');
      for (const ref of item.artifacts) {
        const found = context.artifacts.filter((entry) => entry.repo === ref.repo && entry.issue === ref.issue && entry.kind === ref.kind);
        check(found.length === 1, 'current canonical artifact absent or duplicate');
        const actual = artifactRef({ repo: ref.repo, issue: ref.issue, kind: ref.kind, artifact: found[0].artifact });
        check(sameRef(ref, actual), 'current canonical scope, revision or identity changed');
      }
    }
    const usedActions = [...new Set(record.items.flatMap((item) => item.actionIds))].sort();
    check(sortedJson(usedActions) === sortedJson(record.actions.map((action) => action.id).sort()), 'approval action inventory differs from selections');
    for (const action of record.actions) {
      const bound = manifest.actionBounds[action.id];
      check(bound, 'unreviewed action');
      const expected = structuredClone(bound);
      if (expected.kind === 'research-tests') expected.candidateRule.manifestSha256 = record.manifest.sha256;
      check(sortedJson(action) === sortedJson(expected), 'action bounds changed');
    }
    check(isObject(requested), 'missing requested scope');
    const item = record.items.find((entry) => entry.repo === requested.repo && entry.issue === requested.issue);
    check(item, 'requested issue is not selected');
    for (const { event } of history.active) {
      if (event.id === record.id) continue;
      const bindings = event.kind === 'consolidated' ? event.items : event.artifacts;
      check(!bindings.some((entry) => entry.repo === item.repo && entry.issue === item.issue), 'conflicting consolidated approval needs explicit supersedes');
    }
    keys(requested, ['repo', 'issue', 'taskIds', 'actionId', 'branch', 'baseSha', 'paths', 'operation'], ['scenarioId', 'research', 'preparation']);
    check(item.actionIds.includes(requested.actionId), 'action is not selected for this issue');
    const action = record.actions.find((entry) => entry.id === requested.actionId);
    check(requested.branch === manifest.parent.branch && requested.baseSha === manifest.parent.baseSha, 'requested parent branch/base differs');
    list(requested.taskIds, taskId, 'requested tasks', { nonempty: item.mode !== 'research' });
    check(requested.taskIds.every((id) => item.taskIds.includes(id)), 'requested task is outside selected subset');
    check(Array.isArray(currentDependencies), 'current dependency reads unavailable');
    const dependencies = currentDependencies.filter((entry) => entry.repo === item.repo && entry.issue === item.issue);
    check(dependencies.length === 1 && Array.isArray(dependencies[0].blockedBy), 'current dependency identity unavailable');
    check(item.mode === 'preparation' || !requested.preparation, 'preparation evidence on another mode');
    if (item.mode === 'preparation') validatePreparationEvidence(context, item, requested, manifest);
    else check(dependencies[0].blockedBy.every((dependency) => dependency.state === 'closed'), 'open native prerequisites');
    if (action.kind === 'research-tests') {
      check(action.scenarioIds.includes(requested.scenarioId), 'unreviewed research scenario');
      check(item.mode === 'research' || requested.scenarioId === 'SKILL-EVAL', 'predecessor cannot admit this research phase');
      const research = validateResearchEvidence(context, item, requested, action, record, manifest);
      return { ok: true, bindings: item.artifacts, approvalIds: [record.id], manifestSha256: record.manifest.sha256,
        taskIds: requested.taskIds, action, research, blocks: [] };
    }
    check(!requested.research && !requested.scenarioId, 'research fields on local request');
    check(item.mode !== 'research', 'research selection cannot execute code');
    const currentPlan = context.artifacts.find((entry) => entry.repo === item.repo && entry.issue === item.issue && entry.kind === 'plan');
    const files = selectedTaskFiles(currentPlan.artifact.body, requested.taskIds);
    list(requested.paths, safePath, 'requested paths');
    check(requested.paths.every((path) => files.includes(path)), 'requested file escapes selected task scope');
    if (action.kind === 'local') check(action.operations.includes(requested.operation), 'unapproved local operation');
    else {
      check(requested.operation === 'checkpoint' && requested.paths.length > 0, 'invalid checkpoint request');
      // This result validates intent scope only. #138 must separately prove
      // complete exported history and persist delivery intent before pushing.
    }
    return { ok: true, bindings: item.artifacts, approvalIds: [record.id], manifestSha256: record.manifest.sha256, taskIds: requested.taskIds, files, action, blocks: [] };
  } catch (error) {
    return { ok: false, bindings: [], approvalIds: [], blocks: ['consolidated approval: ' + error.message] };
  }
}

// These projections are owned by the parent recovery/protocol adapters. Each
// comes from an exact fetched ledger comment, never a caller-supplied pass flag.
function boundEvidence(context, reference, kind) {
  keys(reference, ['commentId', 'bodySha256']);
  check(integer(reference.commentId) && digest(reference.bodySha256), 'invalid evidence reference');
  const matches = (context.admissionEvidence ?? []).filter((entry) => entry.comment.id === reference.commentId);
  check(matches.length === 1 && hash(matches[0].comment.body) === reference.bodySha256, 'admission evidence absent or changed');
  const evidence = matches[0];
  check(evidence.kind === kind && isObject(evidence.payload), 'wrong admission evidence kind');
  // The projection must be literally present in the fetched ledger, not a
  // separate mutable object next to it. Keep all other ledger prose intact.
  const payloads = [];
  let collecting = false;
  let raw = '';
  for (const row of linesOf(evidence.comment.body)) {
    if (row.fenceOpen === 'json') { collecting = true; raw = ''; }
    else if (row.fenceClose && collecting) { payloads.push(parseStrictJson(raw)); collecting = false; }
    else if (collecting) raw += row.line;
  }
  check(payloads.some((payload) => sortedJson(payload) === sortedJson(evidence.payload)), 'evidence projection differs from source');
  return evidence.payload;
}

function validatePreparationEvidence(context, item, requested, manifest) {
  check(requested.operation === 'edit' || requested.operation === 'check' || requested.operation === 'review', 'preparation permits local preparation only');
  const evidence = boundEvidence(context, requested.preparation, 'preparation');
  keys(evidence, ['schemaVersion', 'kind', 'parent', 'plan', 'tasks', 'acceptedContracts']);
  check(evidence.schemaVersion === 1 && evidence.kind === 'preparation' && sortedJson(evidence.parent) === sortedJson(manifest.parent), 'invalid preparation parent');
  const plan = item.artifacts.find((ref) => ref.kind === 'plan');
  check(sameRef(evidence.plan, plan), 'preparation plan scope changed');
  list(evidence.tasks, isObject, 'preparation task contracts', { nonempty: true });
  list(evidence.acceptedContracts, isObject, 'accepted code contracts');
  const taskIds = new Set();
  for (const task of evidence.tasks) {
    keys(task, ['id', 'files', 'prerequisiteIssues']);
    check(item.taskIds.includes(task.id) && !taskIds.has(task.id), 'unselected or duplicate preparation task');
    taskIds.add(task.id);
    list(task.files, safePath, 'preparation files', { nonempty: true });
    list(task.prerequisiteIssues, integer, 'preparation prerequisites', { nonempty: true });
    const current = context.artifacts.find((entry) => entry.repo === item.repo && entry.issue === item.issue && entry.kind === 'plan');
    check(sortedJson([...task.files].sort()) === sortedJson(selectedTaskFiles(current.artifact.body, [task.id]).sort()), 'preparation file contract differs from approved plan');
    for (const prerequisite of task.prerequisiteIssues) {
      const records = evidence.acceptedContracts.filter((entry) => entry.issue === prerequisite);
      check(records.length === 1, 'missing or ambiguous accepted preparation prerequisite');
      const accepted = records[0];
      keys(accepted, ['repo', 'issue', 'plan', 'childHead', 'parentHead', 'acceptance', 'evidence']);
      check(accepted.repo === item.repo && sha(accepted.childHead) && sha(accepted.parentHead) && accepted.acceptance === 'implemented', 'preparation prerequisite is not accepted code');
      const selected = manifest.selections.find((entry) => entry.issue === prerequisite && entry.repo === item.repo);
      check(selected?.mode === 'code' && selected.artifacts.some((ref) => sameRef(ref, accepted.plan)), 'accepted prerequisite scope differs from manifest');
      const receipt = boundEvidence(context, accepted.evidence, 'accepted-contract');
      check(receipt.repo === accepted.repo && receipt.issue === accepted.issue && receipt.childHead === accepted.childHead && receipt.parentHead === accepted.parentHead && receipt.acceptance === 'implemented' && sameRef(receipt.plan, accepted.plan), 'accepted contract receipt differs');
    }
  }
  check(requested.taskIds.every((id) => taskIds.has(id)), 'preparation task mapping missing');
}

// Supported protocol envelope grammar. Unknown/ambiguous prose is a refusal,
// never a semantic guess. Values come from the immutable bound source, not the
// reservation record. This parser has no repository or issue-number defaults.
export function protocolLimits(body) {
  const source = linesOf(canonicalScope(body, 'protocol')).filter((row) => row.structural).map((row) => row.line).join('');
  const numbers = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20 };
  const value = (word) => /^\d+$/.test(word) ? Number(word) : numbers[word.toLowerCase()];
  const read = (pattern, group = 1) => {
    const found = [...source.matchAll(pattern)].map((match) => value(match[group]));
    check(found.length > 0 && found.every(integer) && new Set(found).size === 1, 'missing or ambiguous protocol limit');
    return found[0];
  };
  if (/top-level subscription vendor launches/.test(source)) {
    const total = read(/at most\s*(\d+) top-level subscription vendor launches/g);
    return { total, activeMs: null, trialMaxMs: read(/(\d+) minutes each as a bounded trial control/g) * 60000,
      phases: { dogfood: total }, skillMaxStarts: null, maxSkills: null };
  }
  return { total: read(/Overall maximum\s*(\d+) processes/g), activeMs: read(/Overall maximum\s*\d+ processes and\s*(\d+) hours/g) * 3600000,
    trialMaxMs: read(/([A-Za-z]+|\d+) minutes per qualification process/g) * 60000,
    phases: { core: read(/Up to\s*(\d+) vendor processes/g), 'SKILL-EVAL': read(/maximum\s*\d+ skills\/(\d+) processes/g), REQUALIFY: read(/Reserve\s*(\d+) additional processes/g) },
    skillMaxStarts: read(/at most ([A-Za-z]+|\d+) vendor processes per changed authored skill/g), maxSkills: read(/maximum\s*(\d+) skills\/\d+ processes/g) };
}

function validateResearchEvidence(context, item, requested, action, record, manifest) {
  check(requested.operation === 'research-test' && requested.paths.length === 0, 'research grant cannot authorize other effects');
  const evidence = boundEvidence(context, requested.research, 'research-reservation');
  keys(evidence, ['schemaVersion', 'kind', 'approvalId', 'manifestSha256', 'actionId', 'owner', 'protocol', 'scenarioId', 'candidate', 'execution', 'allowance']);
  check(evidence.schemaVersion === 1 && evidence.kind === 'research-reservation' && evidence.approvalId === record.id && evidence.manifestSha256 === record.manifest.sha256 && evidence.actionId === action.id && evidence.scenarioId === requested.scenarioId, 'research reservation scope differs');
  keys(evidence.owner, ['repo', 'issue', 'taskIds', 'artifact', 'skill']);
  check(evidence.owner.repo === item.repo && evidence.owner.issue === item.issue && sortedJson(evidence.owner.taskIds) === sortedJson(requested.taskIds), 'research owner differs');
  const protocol = manifest.selections.find((entry) => entry.issue === action.issue && entry.mode === 'research')?.artifacts.find((ref) => ref.kind === 'protocol');
  check(protocol && sameRef(evidence.protocol, protocol), 'research protocol differs');
  if (item.mode !== 'research') {
    check(requested.taskIds.length === 1 && /^skills\/[^/]+\/[^/]+$/.test(evidence.owner.skill), 'skill evaluation needs one selected task and authored skill');
    check(item.artifacts.some((ref) => sameRef(ref, evidence.owner.artifact)), 'skill owner scope changed');
    const current = context.artifacts.find((entry) => entry.repo === item.repo && entry.issue === item.issue && entry.kind === 'plan');
    check(selectedTaskFiles(current.artifact.body, requested.taskIds).some((path) => path.startsWith(evidence.owner.skill + '/')), 'skill is outside changed task scope');
  } else check(evidence.owner.skill === null && sameRef(evidence.owner.artifact, protocol), 'invalid research owner artifact');
  const candidate = evidence.candidate;
  keys(candidate, ['repo', 'parentBranch', 'baseSha', 'sourceSha', 'treeSha', 'acceptedIntegrations', 'packedArtifacts']);
  check(candidate.repo === manifest.parent.repo && candidate.parentBranch === manifest.parent.branch && candidate.baseSha === manifest.parent.baseSha && sha(candidate.sourceSha) && sha(candidate.treeSha), 'research candidate identity differs');
  list(candidate.acceptedIntegrations, (value) => sha(value), 'accepted integrations');
  list(candidate.packedArtifacts, isObject, 'packed artifacts', { nonempty: true });
  for (const packed of candidate.packedArtifacts) {
    keys(packed, ['name', 'sha256', 'integrity']);
    check(text(packed.name) && digest(packed.sha256) && /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(packed.integrity), 'invalid packed identity');
  }
  keys(evidence.execution, ['harness', 'version', 'model', 'accountRef', 'effort', 'platform', 'runtime', 'configDigest', 'policyDigest', 'providerMode']);
  check(['harness', 'version', 'model', 'accountRef', 'effort', 'platform', 'runtime'].every((key) => text(evidence.execution[key])) && digest(evidence.execution.configDigest) && digest(evidence.execution.policyDigest) && evidence.execution.providerMode === action.providerMode, 'execution identity unavailable');
  const currentProtocol = context.artifacts.find((entry) => entry.repo === protocol.repo && entry.issue === protocol.issue && entry.kind === 'protocol');
  const limits = protocolLimits(currentProtocol.artifact.body);
  check(action.maxStarts <= limits.total && (limits.activeMs === null || action.aggregateActiveMs !== null && action.aggregateActiveMs <= limits.activeMs), 'grant exceeds protocol envelope');
  const allowance = evidence.allowance;
  keys(allowance, ['id', 'reservationId', 'attemptId', 'phase', 'ledgerRevision', 'status', 'totalStarts', 'phaseStarts', 'phaseMaxStarts', 'activeMs', 'reservedActiveMs', 'trialMaxMs', 'skillStarts', 'skillMaxStarts', 'skillCount', 'maxSkills', 'attempts']);
  check(['id', 'reservationId', 'attemptId', 'phase'].every((key) => text(allowance[key])) && integer(allowance.ledgerRevision) && allowance.status === 'reserved', 'research allowance is not a reserved attempt');
  for (const key of ['totalStarts', 'phaseStarts', 'phaseMaxStarts', 'trialMaxMs']) check(integer(allowance[key]), 'invalid allowance counter');
  for (const key of ['activeMs', 'reservedActiveMs', 'skillStarts', 'skillCount']) check(Number.isSafeInteger(allowance[key]) && allowance[key] >= 0, 'invalid allowance usage');
  const phase = requested.scenarioId === 'SKILL-EVAL' ? 'SKILL-EVAL' : requested.scenarioId === 'REQUALIFY' ? 'REQUALIFY' : Object.hasOwn(limits.phases, 'dogfood') ? 'dogfood' : 'core';
  check(allowance.phase === phase && allowance.phaseMaxStarts === limits.phases[phase] && allowance.trialMaxMs <= limits.trialMaxMs && allowance.skillMaxStarts === limits.skillMaxStarts && allowance.maxSkills === limits.maxSkills, 'reservation bounds differ from canonical protocol');
  check(allowance.totalStarts <= action.maxStarts && allowance.phaseStarts <= allowance.phaseMaxStarts && allowance.reservedActiveMs >= allowance.trialMaxMs, 'research start allowance exceeded');
  check(action.aggregateActiveMs === null || allowance.activeMs + allowance.reservedActiveMs <= action.aggregateActiveMs, 'research aggregate active allowance exceeded');
  if (requested.scenarioId === 'SKILL-EVAL') check(allowance.phase === 'SKILL-EVAL' && integer(allowance.skillMaxStarts) && integer(allowance.maxSkills) && allowance.skillStarts > 0 && allowance.skillStarts <= allowance.skillMaxStarts && allowance.skillCount > 0 && allowance.skillCount <= allowance.maxSkills, 'skill phase allowance exceeded');
  list(allowance.attempts, isObject, 'shared attempt history', { nonempty: true });
  const attempts = allowance.attempts;
  check(new Set(attempts.map((entry) => entry.id)).size === attempts.length, 'duplicate shared attempt identity');
  for (const attempt of attempts) {
    keys(attempt, ['id', 'phase', 'skill', 'kind', 'status', 'activeMs', 'reservedActiveMs']);
    check(text(attempt.id) && Object.hasOwn(limits.phases, attempt.phase) && (attempt.skill === null || text(attempt.skill)) && ['initial', 'child', 'resume'].includes(attempt.kind) && ['reserved', 'running', 'passed', 'failed', 'cancelled'].includes(attempt.status), 'invalid shared attempt');
    check(['activeMs', 'reservedActiveMs'].every((key) => Number.isSafeInteger(attempt[key]) && attempt[key] >= 0), 'invalid shared attempt duration');
    check(attempt.phase !== 'SKILL-EVAL' || text(attempt.skill), 'skill attempt lacks skill identity');
  }
  const reserved = attempts.filter((entry) => entry.id === allowance.attemptId);
  check(reserved.length === 1 && reserved[0].status === 'reserved' && reserved[0].phase === phase && reserved[0].skill === evidence.owner.skill && reserved[0].reservedActiveMs >= allowance.trialMaxMs, 'attempt reservation absent or consumed');
  const totalActive = attempts.reduce((sum, entry) => sum + entry.activeMs, 0);
  const totalReserved = attempts.reduce((sum, entry) => sum + entry.reservedActiveMs, 0);
  check(allowance.totalStarts === attempts.length && allowance.phaseStarts === attempts.filter((entry) => entry.phase === phase).length && allowance.activeMs === totalActive && allowance.reservedActiveMs === totalReserved, 'shared counters differ from complete attempt history');
  for (const [name, maximum] of Object.entries(limits.phases)) check(attempts.filter((entry) => entry.phase === name).length <= maximum, 'shared phase allowance exceeded');
  const skills = [...new Set(attempts.filter((entry) => entry.phase === 'SKILL-EVAL').map((entry) => entry.skill))];
  if (limits.maxSkills !== null) {
    check(skills.length <= limits.maxSkills && allowance.skillCount === skills.length, 'shared changed-skill inventory exceeded');
    for (const skill of skills) check(attempts.filter((entry) => entry.phase === 'SKILL-EVAL' && entry.skill === skill).length <= limits.skillMaxStarts, 'shared per-skill allowance exceeded');
    check(allowance.skillStarts === attempts.filter((entry) => entry.phase === 'SKILL-EVAL' && entry.skill === evidence.owner.skill).length, 'per-skill counter differs from shared attempts');
  }
  // The protocol owner must atomically consume this reservation immediately at
  // launch and verify candidate bytes. Scope approval cannot replace that CAS.
  return { reservationId: allowance.reservationId, attemptId: allowance.attemptId, ledgerRevision: allowance.ledgerRevision, candidate, execution: evidence.execution, trialMaxMs: allowance.trialMaxMs,
    pendingEffects: ['verify-clean-candidate-and-packed-bytes', 'consume-shared-reservation-before-process-start'] };
}

// Transport adapters return provider records, not precomputed permission flags.
// Source reads are shared by the ordinary and consolidated launch paths.
export async function readApprovalSources(comments, readJson) {
  const sources = new Map();
  for (const comment of comments) {
    const event = parseApproval(comment);
    if (event.ok === false || event.source.kind !== 'github-comment') continue;
    const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/\d+#issuecomment-(\d+)$/.exec(event.source.ref);
    check(match && repo(match[1]), 'unsupported GitHub approval source locator');
    if (!sources.has(event.source.ref)) sources.set(event.source.ref, await readJson(['api', 'repos/' + match[1] + '/issues/comments/' + match[2]]));
  }
  return [...sources.values()];
}

export async function gatherConsolidatedApproval({ parentRepo, parentIssue, approvalBinding, requested, operators, readJson, admissionEvidence = [], researchAdapter }) {
  const pages = async (path) => {
    const value = await readJson(['api', path, '--paginate', '--slurp']);
    check(Array.isArray(value) && value.every(Array.isArray), 'unreadable complete approval history');
    return value.flat();
  };
  check(repo(parentRepo) && integer(parentIssue), 'invalid approval parent');
  keys(approvalBinding, ['commentId', 'bodySha256']);
  check(integer(approvalBinding.commentId) && digest(approvalBinding.bodySha256), 'invalid approval comment binding');
  const approvalComments = await pages('repos/' + parentRepo + '/issues/' + parentIssue + '/comments');
  const matches = approvalComments.filter((comment) => comment.id === approvalBinding.commentId);
  check(matches.length === 1 && hash(matches[0].body) === approvalBinding.bodySha256, 'pinned approval comment unavailable or changed');
  const record = parseApproval(matches[0]);
  check(record.kind === 'consolidated', 'pinned comment is not consolidated intent');
  let manifestBytes;
  let manifestBlob;
  const locator = record.manifest.source;
  if (locator.kind === 'inline') manifestBytes = locator.utf8;
  else {
    const repository = await readJson(['api', 'repositories/' + encodeURIComponent(locator.repositoryId)]);
    check(String(repository.id) === locator.repositoryId || repository.node_id === locator.repositoryId, 'immutable manifest repository identity changed');
    check(repo(repository.full_name), 'manifest repository unavailable');
    const blob = await readJson(['api', 'repos/' + repository.full_name + '/contents/' + locator.path.split('/').map(encodeURIComponent).join('/') + '?ref=' + locator.commitSha]);
    check(blob.type === 'file' && blob.encoding === 'base64' && typeof blob.content === 'string', 'manifest is not a readable immutable file');
    const bytes = Buffer.from(blob.content.replaceAll('\n', ''), 'base64');
    manifestBytes = bytes.toString('utf8');
    check(Buffer.from(manifestBytes, 'utf8').equals(bytes) && hash(manifestBytes) === locator.blobSha256, 'manifest blob bytes changed');
    manifestBlob = locator;
  }
  const manifest = validateExecutionManifest(manifestBytes);
  check(manifest.parent.repo === parentRepo && manifest.parent.issue === parentIssue, 'approval parent differs from frozen manifest');
  const artifacts = [];
  const currentDependencies = [];
  for (const item of record.items) {
    const path = 'repos/' + item.repo + '/issues/' + item.issue;
    const issue = await readJson(['api', path]);
    check(issue.number === item.issue, 'current issue identity differs');
    if (item.repo === requested.repo && item.issue === requested.issue) check(issue.state === 'open', 'requested issue is not open');
    const comments = await pages(path + '/comments');
    artifacts.push({ repo: item.repo, issue: item.issue, kind: 'brief', artifact: issue });
    for (const binding of item.artifacts.filter((ref) => ref.kind !== 'brief')) {
      const candidates = binding.kind === 'plan'
        ? comments.filter((comment) => hasArtifactMarker(comment, 'plan'))
        : comments.filter((comment) => {
            try { artifactRef({ repo: item.repo, issue: item.issue, kind: 'protocol', artifact: comment }); return true; } catch { return false; }
          });
      check(candidates.length === 1, 'missing or duplicate canonical ' + binding.kind);
      artifacts.push({ repo: item.repo, issue: item.issue, kind: binding.kind, artifact: candidates[0] });
    }
    currentDependencies.push({ repo: item.repo, issue: item.issue, blockedBy: await pages(path + '/dependencies/blocked_by') });
  }
  const fetchedEvidence = [];
  for (const entry of admissionEvidence) {
    const comment = await readJson(['api', 'repos/' + parentRepo + '/issues/comments/' + entry.comment.id]);
    fetchedEvidence.push({ ...entry, comment });
  }
  const result = evaluateConsolidatedApproval({ record, manifestBytes, operators, requested, currentDependencies,
    currentArtifacts: { artifacts, approvalComments, approvalBinding, manifestBlob,
      sourceComments: await readApprovalSources(approvalComments, readJson), admissionEvidence: fetchedEvidence } });
  if (result.ok && result.research) return admitConsolidatedResearch(result, researchAdapter);
  return result;
}

// The production adapter belongs to the protocol owner. No adapter, no launch;
// tests exercise this seam with actual isolated candidate/one-use ledger reads.
export async function admitConsolidatedResearch(scope, adapter) {
  try {
    check(scope.ok && scope.research, 'missing validated research scope');
    check(typeof adapter?.inspectCandidate === 'function' && typeof adapter?.consumeReservation === 'function', 'research candidate/shared-ledger production adapter unavailable');
    const expected = scope.research;
    const current = await adapter.inspectCandidate(expected.candidate);
    keys(current, ['candidate', 'clean', 'ancestorShas']);
    check(current.clean === true && sortedJson(current.candidate) === sortedJson(expected.candidate), 'actual candidate or packed bytes differ');
    list(current.ancestorShas, sha, 'candidate ancestry', { nonempty: true });
    check([expected.candidate.baseSha, ...expected.candidate.acceptedIntegrations].every((commit) => current.ancestorShas.includes(commit)), 'candidate lacks approved base/integrations');
    const receipt = await adapter.consumeReservation({ reservationId: expected.reservationId, attemptId: expected.attemptId,
      ledgerRevision: expected.ledgerRevision, candidate: expected.candidate, execution: expected.execution,
      approvalIds: scope.approvalIds, manifestSha256: scope.manifestSha256, trialMaxMs: expected.trialMaxMs });
    keys(receipt, ['reservationId', 'attemptId', 'previousRevision', 'revision', 'state', 'candidateSha', 'execution']);
    check(receipt.reservationId === expected.reservationId && receipt.attemptId === expected.attemptId && receipt.previousRevision === expected.ledgerRevision && receipt.revision === expected.ledgerRevision + 1 && receipt.state === 'consumed' && receipt.candidateSha === expected.candidate.sourceSha && sortedJson(receipt.execution) === sortedJson(expected.execution), 'research reservation consume failed or changed');
    return { ...scope, research: { ...expected, pendingEffects: [], receipt } };
  } catch (error) {
    return { ok: false, bindings: [], approvalIds: [], blocks: ['research launch: ' + error.message] };
  }
}

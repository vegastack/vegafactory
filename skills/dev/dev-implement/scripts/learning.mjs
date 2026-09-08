#!/usr/bin/env node
// Bounded lessons reuse ordinary-work evidence. No model, network or vendor memory.
const sha=/^[a-f0-9]{40}$/;
const digest=/^[a-f0-9]{64}$/;
const closed=(row,keys)=>row&&typeof row==='object'&&!Array.isArray(row)&&Object.keys(row).length===keys.length&&keys.every(key=>Object.hasOwn(row,key));
const safePath=value=>typeof value==='string'&&value.length>0&&!value.startsWith('/')&&!value.includes('\\')&&!/[\0\r\n]/.test(value)&&!value.split('/').some(part=>['.','..',''].includes(part));
const nativePath=path=>/(?:^|\/)\.(?:claude|codex)\/.*memory|(?:^|\/)MEMORY\.md$/i.test(path);
const protectedPath=path=>/(?:^|\/)(?:AGENTS\.md|CLAUDE\.md|org\.md|dev\.md|decisions\.md|settings\.json|factory\.json)$/.test(path);
export function validateLesson(row) {
  if (!closed(row,['id','repo','taskId','scopeDigest','sourceSha','statement','evidenceRefs','targetPaths','undoRef','state','supersedes'])||!/^lesson-[a-f0-9]{32}$/.test(row.id)||!/^\S+\/\S+$/.test(row.repo)||!/^\d+-T\d+$/.test(row.taskId)||!digest.test(row.scopeDigest)||!sha.test(row.sourceSha)||typeof row.statement!=='string'||!row.statement.trim()||Buffer.byteLength(row.statement)>768||/[\0\r]/.test(row.statement)) throw Error('invalid lesson identity');
  if (!['observed','validated','adopted','rejected','reverted'].includes(row.state)||!Array.isArray(row.targetPaths)||!row.targetPaths.length||row.targetPaths.length>32||row.targetPaths.some(path=>!safePath(path)||nativePath(path))||new Set(row.targetPaths).size!==row.targetPaths.length||typeof row.undoRef!=='string'||!/^git:[a-f0-9]{40}$/.test(row.undoRef)||!Array.isArray(row.supersedes)||row.supersedes.length>32||row.supersedes.some(id=>!/^lesson-[a-f0-9]{32}$/.test(id)||id===row.id)) throw Error('invalid reversible lesson');
  if (!Array.isArray(row.evidenceRefs)||!row.evidenceRefs.length||row.evidenceRefs.length>8||row.evidenceRefs.some(ref=>!closed(ref,['kind','ref','sha','passed'])||!['check','review','measurement'].includes(ref.kind)||typeof ref.ref!=='string'||ref.ref.length>256||!sha.test(ref.sha)||typeof ref.passed!=='boolean')) throw Error('invalid lesson evidence');
  return row;
}
export function evaluateLesson(candidate,context) {
  const answer=(action,reason)=>({action,reason});
  if (context?.protectedChange || candidate?.targetPaths?.some(protectedPath)) return answer('propose','protected rules require explicit approval');
  try { validateLesson(candidate); } catch(error) { return answer('reject',error.message); }
  if (context.learningEnabled!==true) return answer('reject','learning disabled or policy unavailable');
  if (candidate.repo!==context.repo||candidate.scopeDigest!==context.scopeDigest||candidate.sourceSha!==context.sourceSha||!context.taskIds?.includes(candidate.taskId)) return answer('reject','lesson scope or source differs');
  if (candidate.targetPaths.some(path=>!context.allowedFiles?.includes(path))||context.paidProviderChange) return answer('propose','outside reversible local authorization');
  if (!['validated','adopted'].includes(candidate.state)||context.reversible!==true||context.improved!==true) return answer('reject','ordinary work improvement and exact undo unverified');
  if (!candidate.evidenceRefs.every(ref=>context.verifiedEvidence?.some(verified=>JSON.stringify(verified)===JSON.stringify(ref)))||!candidate.evidenceRefs.some(ref=>ref.passed&&ref.sha===candidate.sourceSha)) return answer('reject','source-bound evidence unavailable');
  if (context.reviewRequired&&!candidate.evidenceRefs.some(ref=>ref.kind==='review'&&ref.passed&&ref.sha===candidate.sourceSha)) return answer('reject','independent review required');
  if (context.adoption==='propose-only') return answer('propose','policy requires proposal');
  return answer('adopt','verified reversible improvement');
}
export function selectLessons(packet,{repo,scopeDigest,sourceSha,maxItems=3,maxBytes=2048}) {
  if (!Array.isArray(packet?.learning)||packet.learning.length>32||Buffer.byteLength(JSON.stringify(packet.learning))>16384) return [];
  const count=Math.min(3,Math.max(0,maxItems)),limit=Math.min(2048,Math.max(0,maxBytes)),selected=[],seen=new Set();
  const superseded=new Set(packet.learning.filter(row=>['adopted','reverted'].includes(row.state)).flatMap(row=>row.supersedes??[]));
  for (const row of packet.learning) {
    try {validateLesson(row);}catch{continue;}
    if(row.state!=='adopted'||row.repo!==repo||row.scopeDigest!==scopeDigest||row.sourceSha!==sourceSha||superseded.has(row.id))continue;
    const key=JSON.stringify([repo,[...row.targetPaths].sort(),row.evidenceRefs]);
    if(seen.has(key)||selected.some(other=>other.targetPaths.some(path=>row.targetPaths.includes(path))))continue;
    if(selected.length>=count||Buffer.byteLength(JSON.stringify([...selected,row]))>limit)continue;
    seen.add(key);selected.push(row);
  }
  return selected;
}

// The owned group leader survives its vendor child until the parent verifies cleanup.
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { processIdentity, type ProcessIdentity } from './claims.ts'
import { atomicRunFile } from './runs.ts'

export interface GroupObservation { kind:'owned'|'absent'|'foreign'|'unknown'; members:number[] }
export interface GroupInspector {
  identity:(pid:number)=>Promise<ProcessIdentity>
  exists:(pid:number)=>boolean
  listing:()=>Promise<string>
  signal:(pgid:number,signal:NodeJS.Signals)=>void
}
const execute=promisify(execFile)
const sameProcess=(a:ProcessIdentity,b:ProcessIdentity)=>a.pid===b.pid&&a.uid===b.uid&&a.bootId===b.bootId&&a.startId===b.startId
export const nativeGroupInspector:GroupInspector={
  identity:processIdentity,
  exists:pid=>{try{process.kill(pid,0);return true}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return false;throw error}},
  listing:async()=> (await execute('/bin/ps',['-ax','-o','pid=,pgid=,stat='],{timeout:1000,maxBuffer:4*1024*1024,env:{...process.env,LC_ALL:'C'}})).stdout,
  signal:(pgid,signal)=>process.kill(-pgid,signal),
}
export async function inspectOwnedGroup(identity:ProcessIdentity,inspector:GroupInspector=nativeGroupInspector):Promise<GroupObservation>{
  try {
    let leader=false
    try {const current=await inspector.identity(identity.pid);if(!sameProcess(current,identity))return{kind:'foreign',members:[]};leader=true}
    catch {if(inspector.exists(identity.pid))return{kind:'unknown',members:[]}}
    const members:number[]=[]
    for(const line of (await inspector.listing()).split('\n')){
      if(!line.trim())continue
      const match=/^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line)
      if(!match)return{kind:'unknown',members:[]}
      // A zombie cannot execute and cannot be killed; its parent/OS must reap it.
      if(Number(match[2])===identity.pid&&!match[3]!.startsWith('Z'))members.push(Number(match[1]))
    }
    if(!members.length)return{kind:'absent',members:[]}
    return{kind:leader?'owned':'unknown',members}
  }catch{return{kind:'unknown',members:[]}}
}
export async function refreshOwnedGroupAnchors(identity:ProcessIdentity,anchors:ProcessIdentity[]=[],inspector:GroupInspector=nativeGroupInspector):Promise<ProcessIdentity[]|null>{
  const observation=await inspectOwnedGroup(identity,inspector)
  if(observation.kind==='absent')return []
  if(observation.kind==='foreign'||!observation.members.length)return null
  const members:ProcessIdentity[]=[]
  for(const pid of observation.members)try{const member=await inspector.identity(pid);if(member.uid===identity.uid&&member.bootId===identity.bootId)members.push(member)}catch{/* A concurrently exiting member does not erase a surviving exact anchor. */}
  // A live exact leader establishes the group initially. After leader loss, at
  // least one exact previously observed member must keep the same PGID alive;
  // a newly reused numeric group cannot inherit kill authority.
  if(observation.kind!=='owned'&&!anchors.some(anchor=>members.some(member=>sameProcess(anchor,member))))return null
  return members
}
export async function signalOwnedGroup(identity:ProcessIdentity,signal:NodeJS.Signals,inspector:GroupInspector=nativeGroupInspector,anchors:ProcessIdentity[]=[]):Promise<boolean>{
  const members=await refreshOwnedGroupAnchors(identity,anchors,inspector)
  if(members?.length===0)return true
  if(!members)return false
  try {inspector.signal(identity.pid,signal);return true}
  catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return true;return(await inspectOwnedGroup(identity,inspector)).kind==='absent'}
}

export interface WrapperHandshake {schemaVersion:2;runId:string;attemptId:string;identity:ProcessIdentity;anchorIdentity:ProcessIdentity;pgid:number}
export interface WrapperResult {schemaVersion:1;runId:string;attemptId:string;exitCode:number|null;cause:'succeeded'|'failed'|'spawn-failed'|'interrupted';finishedAt:string}
export async function runWrapper(directory:string,runId:string,attemptId:string):Promise<void>{
  if(!process.send||!['darwin','linux'].includes(process.platform))throw Error('owned wrapper requires supported IPC launch')
  const identity=await processIdentity()
  // A trusted inert member keeps the process-group identity continuously
  // observable if the leader and short-lived vendor exit together. It exists
  // before vendor admission and its exact process identity is persisted.
  const anchor=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.on('SIGUSR1',()=>process.exit(0));setInterval(()=>{},1000)"],{stdio:'ignore'})
  await new Promise<void>((resolve,reject)=>anchor.once('spawn',resolve).once('error',reject))
  const anchorIdentity=await processIdentity(anchor.pid!)
  const handshake:WrapperHandshake={schemaVersion:2,runId,attemptId,identity,anchorIdentity,pgid:process.pid}
  await atomicRunFile(join(directory,'handshake.json'),handshake)
  process.send({kind:'handshake',...handshake})
  let admitted=false,stopping=false,completed=false,lastHeartbeat=performance.now()
  const acknowledgment=setTimeout(()=>process.exit(72),5000)
  let escalation:ReturnType<typeof setTimeout>|undefined
  const terminate=()=>{
    if(stopping)return
    stopping=true
    escalation=setTimeout(()=>process.kill(-process.pid,'SIGKILL'),5000)
    void atomicRunFile(join(directory,'owner-loss.json'),{schemaVersion:1,runId,attemptId,cause:'interrupted',requestedAt:new Date().toISOString()}).catch(()=>{})
    process.kill(-process.pid,'SIGTERM')
  }
  process.on('SIGTERM',()=>{})
  process.on('disconnect',terminate)
  const lease=setInterval(()=>{if(performance.now()-lastHeartbeat>=30_000)terminate()},1000)
  const result=async(exitCode:number|null,cause:WrapperResult['cause'])=>{
    if(completed)return
    completed=true
    if(anchor.exitCode===null&&anchor.signalCode===null)await new Promise<void>(resolve=>{const timer=setTimeout(resolve,1000);anchor.once('exit',()=>{clearTimeout(timer);resolve()});anchor.kill('SIGUSR1')})
    const record:WrapperResult={schemaVersion:1,runId,attemptId,exitCode,cause,finishedAt:new Date().toISOString()}
    try {await atomicRunFile(join(directory,'result.json'),record)}catch{terminate();return}
    process.send?.({kind:'result',...record})
    // Keep group leadership until release. Parent loss or a stuck parent remains bounded.
  }
  process.on('message',(message:unknown)=>{
    if(!message||typeof message!=='object')return
    const m=message as {kind:string;command:string;args:string[];cwd:string;env:NodeJS.ProcessEnv;runId?:string;attemptId?:string}
    if(m.kind==='heartbeat'){lastHeartbeat=performance.now();return}
    if(m.kind==='cancel'){terminate();return}
    if(m.kind==='release'&&completed){clearTimeout(acknowledgment);clearInterval(lease);if(escalation)clearTimeout(escalation);process.exit(0)}
    if(m.kind!=='acknowledge'||admitted||stopping||m.runId!==runId||m.attemptId!==attemptId)return
    if(typeof m.command!=='string'||!Array.isArray(m.args)||m.args.some(a=>typeof a!=='string')||typeof m.cwd!=='string'||!m.env||typeof m.env!=='object'){terminate();return}
    admitted=true;clearTimeout(acknowledgment)
    const child=spawn(m.command,m.args,{cwd:m.cwd,env:m.env,stdio:['ignore','pipe','pipe']})
    child.once('spawn',()=>process.send?.({kind:'spawn',runId,attemptId,pid:child.pid}))
    child.stdout.on('data',(data:Buffer)=>process.stdout.write(data))
    child.stderr.on('data',(data:Buffer)=>process.stderr.write(data))
    child.once('error',()=>void result(null,'spawn-failed'))
    child.once('close',code=>void result(code,code===0?'succeeded':'failed'))
  })
}
const direct=process.argv[1]&&basename(process.argv[1])===basename(fileURLToPath(import.meta.url))&&/^run-wrapper\.(?:ts|js)$/.test(basename(process.argv[1]))
if(direct&&process.send)void runWrapper(process.argv[2]??'',process.argv[3]??'',process.argv[4]??'').catch(()=>process.exit(72))

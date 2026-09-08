// The packaged supervisor waits for durable parent acknowledgment before vendor admission.
import { spawn } from 'node:child_process'
import { processIdentity } from './claims.ts'
import { atomicRunFile } from './runs.ts'
import { join } from 'node:path'
export async function runWrapper(directory:string,runId:string):Promise<void>{
  if(!process.send || !['darwin','linux'].includes(process.platform))throw Error('owned wrapper requires supported IPC launch')
  const identity=await processIdentity();await atomicRunFile(join(directory,'handshake.json'),{runId,...identity,pgid:process.pid})
  process.send({kind:'handshake',runId,identity,pgid:process.pid})
  let admitted=false,stopping=false,lastHeartbeat=performance.now()
  const acknowledgment=setTimeout(()=>process.exit(72),5000)
  const terminate=()=>{if(stopping)return;stopping=true;process.kill(-process.pid,'SIGTERM');setTimeout(()=>process.kill(-process.pid,'SIGKILL'),5000)}
  process.on('SIGTERM',()=>{}) // Stay alive to escalate the whole owned group, including descendants.
  process.on('disconnect',terminate)
  const lease=setInterval(()=>{if(performance.now()-lastHeartbeat>=30_000)terminate()},1000)
  process.on('message',(message:unknown)=>{
    const m=message as {kind:string;command:string;args:string[];cwd:string;env:Record<string,string>}
    if(m.kind==='heartbeat'){lastHeartbeat=performance.now();return}
    if(m.kind==='cancel'){terminate();return}
    if(m.kind!=='acknowledge'||admitted||stopping)return
    admitted=true;clearTimeout(acknowledgment)
    const child=spawn(m.command,m.args,{cwd:m.cwd,env:m.env,stdio:['ignore','pipe','pipe']})
    child.once('spawn',()=>process.send?.({kind:'spawn'}))
    child.stdout.on('data',(data:Buffer)=>process.stdout.write(data))
    child.stderr.on('data',(data:Buffer)=>process.stderr.write(data))
    child.once('error',()=>{clearInterval(lease);process.send?.({kind:'result',exitCode:null,cause:'spawn-failed'},()=>process.exit(71))})
    child.once('close',code=>{clearInterval(lease);process.send?.({kind:'result',exitCode:code,cause:code===0?'succeeded':'failed'},()=>process.exit(0))})
  })
}
if(process.send)void runWrapper(process.argv[2]??'',process.argv[3]??'').catch(()=>process.exit(72))

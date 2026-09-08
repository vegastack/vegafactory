import {test,expect} from 'bun:test'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {executeRun} from '../src/dispatch.ts'
import {parseFactoryConfig} from '../src/config.ts'
import {readRuns,runsRoot} from '../src/runs.ts'
async function fixture(code:string,timeoutMs?:number|null){const home=await mkdtemp(join(tmpdir(),'owned-run-'));try{const result=await executeRun({repo:'o/r',issue:1,title:'fixture',stage:'implement',commentId:null,reactionId:null},{command:process.execPath,args:['-e',code],cwd:home,env:{},prompt:''},parseFactoryConfig({repos:[{repo:'o/r',org:'o',path:home}]},home),{operator:null},{timeoutMs,wrapperPath:resolve('packages/cli/src/run-wrapper.ts')});return{result,runs:await readRuns(runsRoot(home))}}finally{await rm(home,{recursive:true,force:true})}}
test('actual wrapper records successful execution without implicit delivery',async()=>{const {result,runs}=await fixture('process.exit(0)');expect(result.terminationCause).toBe('succeeded');expect(result.pushed).toBe(false);expect(runs[0]?.state).toBe('terminal');expect(runs[0]?.processIdentity?.pid).toBeGreaterThan(0)},10000)
test('timeout remains failure when vendor TERM handler exits zero',async()=>{const {result}=await fixture("process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},100)",200);expect(result.timedOut).toBe(true);expect(result.terminationCause).toBe('timed-out');expect(result.exitCode).toBe(0)},15000)
test('owned process ignoring TERM is killed within cancellation bound',async()=>{const start=performance.now();const {result}=await fixture("process.on('SIGTERM',()=>{});setInterval(()=>{},100)",200);expect(result.terminationCause).toBe('timed-out');expect(performance.now()-start).toBeLessThan(9000)},12000)
test('cancellation removes the owned nondetached descendant too',async()=>{const {result}=await fixture("const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},100)\"],{stdio:'ignore'});console.log(c.pid);process.on('SIGTERM',()=>{});setInterval(()=>{},100)",200);expect(result.terminationCause).toBe('timed-out');const pid=Number(result.stdout?.trim());expect(pid).toBeGreaterThan(0);expect(()=>process.kill(pid,0)).toThrow()},12000)

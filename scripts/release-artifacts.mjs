// Release preparation owns builds; consumers and publication use only retained bytes.
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { readFile, writeFile, mkdir, readdir, lstat, realpath, chmod, mkdtemp, rename, open, rm } from 'node:fs/promises'
import { join, resolve, relative, dirname, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'

export const CLI = '@vegastack/vegafactory'
export const DASHBOARD = '@vegastack/vegafactory-dashboard'
const digest = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding)
export const verifyArtifactBytes = (bytes, expected) => typeof expected?.sha256 === 'string' && digest(bytes) === expected.sha256
export function assertPairVersions({ cli, dashboard, tag }) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(cli) || cli !== dashboard || tag !== `v${cli}`) throw new Error('CLI/dashboard/tag version mismatch')
}
export function assertScanEvidence(scan, expectedSkills) {
  if (scan?.ok !== true || scan.skipped !== false || !Array.isArray(scan.blocks) || scan.blocks.length || !Array.isArray(expectedSkills) || !expectedSkills.length || !Array.isArray(scan.skills)) throw new Error('scanner unavailable or incomplete')
  if (expectedSkills.some(name => typeof name !== 'string' || !name) || new Set(expectedSkills).size !== expectedSkills.length || scan.skills.some(s => typeof s?.name !== 'string' || !s.name) || new Set(scan.skills.map(s => s.name)).size !== scan.skills.length) throw new Error('scanner skill coverage mismatch')
  const actual = scan.skills.map(s => s.name).sort()
  if (JSON.stringify(actual) !== JSON.stringify([...expectedSkills].sort())) throw new Error('scanner skill coverage mismatch')
  for (const s of scan.skills) {
    const c = s.completeness
    const entirelyFields = ['entirelyUninspected','entirely_uninspected_files']
    const partiallyFields = ['partiallyInspected','partially_inspected_files','partially_inspected']
    const coverageFields = ['coveragePercent','coverage_percent']
    const present = fields => fields.filter(field => Object.hasOwn(c ?? {},field))
    const hasGap = [...entirelyFields,...partiallyFields].some(field => c?.[field] > 0)
    const belowFullCoverage = coverageFields.some(field => c?.[field] != null && c[field] < 100)
    const healthyPartial = c?.status === 'partial' && Array.isArray(c.limitations) && c.limitations.length === 0 &&
      [entirelyFields,partiallyFields].every(fields => present(fields).length > 0 && present(fields).every(field => c[field] === 0)) &&
      present(coverageFields).length > 0 && present(coverageFields).every(field => c[field] === 100)
    if (!c || !['complete','partial'].includes(c.status) || c.limitations?.length || hasGap || belowFullCoverage || (c.status === 'partial' && !healthyPartial)) throw new Error(`partial scanner coverage: ${s.name}`)
  }
}
export function packagePath(path) {
  if (typeof path !== 'string' || !path || path.includes('\\') || /[\x00-\x1f\x7f]/.test(path) || path.startsWith('/') || path.split('/').some(x => !x || x === '.' || x === '..') || /^[A-Za-z]:/.test(path)) throw new Error(`unsafe package path: ${path}`)
  return path
}
// Parse before writing anything. npm's POSIX pax records are supported; links and
// devices are never extracted. Bounds and checksums apply to every tar header.
export function readPackageArchive(bytes) {
  const tar = gunzipSync(bytes, { maxOutputLength: 1024 * 1024 * 1024 })
  const files = []; const seen = new Set(); let pax = null; let ended = false
  const str = b => b.toString('utf8').split('\0')[0]
  const oct = b => { const s = str(b).trim(); if (s && !/^[0-7]+$/.test(s)) throw new Error('invalid tar number'); return s ? parseInt(s, 8) : 0 }
  for (let off = 0; off + 512 <= tar.length;) {
    const h = tar.subarray(off, off + 512)
    if (h.every(b => b === 0)) { if (!tar.subarray(off).every(b => b === 0)) throw new Error('trailing tar data'); ended = true; break }
    const sum = [...h].reduce((s, b, i) => s + (i >= 148 && i < 156 ? 32 : b), 0)
    if (sum !== oct(h.subarray(148, 156))) throw new Error('tar checksum mismatch')
    const size = oct(h.subarray(124, 136)); const mode = oct(h.subarray(100, 108)); const type = str(h.subarray(156, 157)) || '0'
    if (!Number.isSafeInteger(size) || off + 512 + size > tar.length) throw new Error('truncated tar entry')
    const data = tar.subarray(off + 512, off + 512 + size); off += 512 + Math.ceil(size / 512) * 512
    if (type === 'x') {
      if (pax) throw new Error('duplicate pax header')
      pax = {}
      for (let i = 0; i < data.length;) {
        const space = data.indexOf(32, i); const n = Number(data.subarray(i, space).toString())
        if (space < i || !Number.isSafeInteger(n) || n <= space - i + 1 || i + n > data.length || data[i+n-1] !== 10) throw new Error('invalid pax record')
        const record = data.subarray(space + 1, i+n-1).toString(); const eq = record.indexOf('='); const key = record.slice(0, eq)
        if (eq < 1 || Object.hasOwn(pax,key)) throw new Error('invalid duplicate pax key')
        if (!['path','mtime','atime','ctime','uid','gid','uname','gname','SCHILY.dev','SCHILY.ino','SCHILY.nlink'].includes(key)) throw new Error(`unsupported pax key: ${key}`)
        pax[key] = record.slice(eq+1); i += n
      }
      continue
    }
    let path = pax?.path ?? [str(h.subarray(345,500)),str(h.subarray(0,100))].filter(Boolean).join('/'); pax = null
    if (type === '5') path = path.replace(/\/$/,'')
    packagePath(path)
    if (path !== 'package' && !path.startsWith('package/')) throw new Error('tar entry outside package')
    if (seen.has(path)) throw new Error('duplicate package path'); seen.add(path)
    if (type === '5') continue
    if (type !== '0' || path === 'package' || ![0o644,0o755].includes(mode)) throw new Error('unsupported package entry type or mode')
    files.push({ path: path.slice(8), sha256: digest(data), mode, data })
  }
  if (!ended || pax) throw new Error('incomplete tar archive')
  files.sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const paths = new Set(files.map(f => f.path))
  for (const f of files) for (let p = dirname(f.path); p !== '.'; p = dirname(p)) if (paths.has(p)) throw new Error('file/directory collision')
  return files
}
function packageIdentity(files) {
  const entry = files.find(f => f.path === 'package.json')
  if (!entry) throw new Error('missing package.json')
  return JSON.parse(entry.data.toString())
}
export function dashboardDescriptor(bytes, version) {
  const files = readPackageArchive(bytes); const p = packageIdentity(files)
  if (p.name !== DASHBOARD || p.version !== version) throw new Error('dashboard package identity mismatch')
  return { schemaVersion: 1, name: DASHBOARD, version, sha256: digest(bytes), integrity: `sha512-${digest(bytes,'sha512','base64')}`, bytes: bytes.length, files: files.map(({path,sha256,mode}) => ({path,sha256,mode})) }
}
export function verifyDashboardDescriptor(descriptor, bytes, version) {
  const expected = dashboardDescriptor(bytes,version)
  if (!descriptor || ['schemaVersion','name','version','sha256','integrity','bytes'].some(k => descriptor[k] !== expected[k]) || JSON.stringify(descriptor.files) !== JSON.stringify(expected.files)) throw new Error('missing, stale or altered dashboard descriptor')
  return true
}
export async function materializeTree(source, destination) {
  const boundary = await realpath(source)
  async function copy(from, to, ancestors) {
    const original = await lstat(from); const actual = await realpath(from); const rel = relative(boundary, actual)
    if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(boundary,rel) !== actual) throw new Error('traced link escapes standalone tree')
    if (ancestors.has(actual)) throw new Error('traced link cycle')
    const s = await lstat(actual)
    if (s.isDirectory()) {
      await mkdir(to,{recursive:true}); const next = new Set([...ancestors,actual])
      for (const name of (await readdir(actual)).sort()) await copy(join(actual,name),join(to,name),next)
      // A package symlink normally resolves imports from its real store location.
      // Materializing it changes that location: carry the exact traced siblings
      // into its own node_modules, retaining versions without a new resolver.
      if (original.isSymbolicLink()) {
        let modules=dirname(actual)
        if (modules.split(sep).at(-1)?.startsWith('@')) modules=dirname(modules)
        if (modules.split(sep).at(-1)==='node_modules') {
          for (const name of (await readdir(modules)).sort()) {
            if (name.startsWith('.') || await realpath(join(modules,name))===actual) continue
            if (name.startsWith('@')) {
              for (const child of (await readdir(join(modules,name))).sort()) {
                const dependency=join(modules,name,child)
                if(await realpath(dependency)===actual)continue
                const target=join(to,'node_modules',name,child)
                try{await lstat(target)}catch(e){if(e.code!=='ENOENT')throw e;await copy(dependency,target,next)}
              }
            } else {
              const target=join(to,'node_modules',name)
              try{await lstat(target)}catch(e){if(e.code!=='ENOENT')throw e;await copy(join(modules,name),target,next)}
            }
          }
        }
      }
    } else if (s.isFile()) {
      await mkdir(dirname(to),{recursive:true}); await writeFile(to,await readFile(actual)); await chmod(to,s.mode & 0o111 ? 0o755 : 0o644)
    } else throw new Error('unsupported traced device entry')
  }
  await copy(boundary,destination,new Set())
}
export function command(argv, {cwd,env=process.env,timeout=600000}={}) {
  const r = spawnSync(argv[0],argv.slice(1),{cwd,env,timeout,encoding:'utf8',maxBuffer:64*1024*1024})
  if (r.error || r.status !== 0) throw new Error(`${argv.join(' ')} failed (${r.status}): ${r.error?.message ?? ''}\n${r.stdout}\n${r.stderr}`)
  return r.stdout.trim()
}
export async function extractPackage(bytes, destination) {
  const files = readPackageArchive(bytes)
  // Exclusive fresh destinations prevent a pre-existing symlink from redirecting writes.
  await mkdir(destination)
  for (const f of files) { const path=join(destination,f.path); await mkdir(dirname(path),{recursive:true}); await writeFile(path,f.data,{flag:'wx',mode:f.mode}) }
  return files
}
export async function verifyExtractedDashboard(directory, descriptor) {
  const actual=[]
  async function walk(root,prefix='') {
    for(const name of (await readdir(root)).sort()) {
      const path=prefix?`${prefix}/${name}`:name;packagePath(path)
      const file=join(root,name);const stat=await lstat(file)
      if(stat.isDirectory())await walk(file,path)
      else if(stat.isFile())actual.push({path,sha256:digest(await readFile(file)),mode:stat.mode & 0o777})
      else throw new Error('extracted dashboard contains a link or device')
    }
  }
  await walk(directory);actual.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)
  if(JSON.stringify(actual)!==JSON.stringify(descriptor?.files))throw new Error('extracted dashboard differs from installed descriptor')
  return true
}
export async function verifyPair(manifest, directory) {
  if (manifest?.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(manifest.sourceSha) || !/^[a-f0-9]{40}$/.test(manifest.treeSha) || manifest.artifacts?.length !== 2) throw new Error('invalid release manifest')
  const pair = {}
  for (const a of manifest.artifacts) {
    if (![CLI,DASHBOARD].includes(a.name) || pair[a.name] || packagePath(a.file).includes('/')) throw new Error('invalid artifact identity/path')
    const bytes = await readFile(join(directory,a.file))
    if (!verifyArtifactBytes(bytes,a) || a.integrity !== `sha512-${digest(bytes,'sha512','base64')}` || a.bytes !== bytes.length) throw new Error('artifact bytes changed')
    const files = readPackageArchive(bytes); const p = packageIdentity(files)
    if (p.name !== a.name || p.version !== manifest.version) throw new Error('packed package identity mismatch')
    pair[a.name] = {bytes,files,artifact:a}
  }
  assertPairVersions({cli:manifest.version,dashboard:manifest.version,tag:`v${manifest.version}`})
  const descriptor = pair[CLI].files.find(f=>f.path==='dist/dashboard-artifact.json')
  verifyDashboardDescriptor(descriptor && JSON.parse(descriptor.data.toString()),pair[DASHBOARD].bytes,manifest.version)
  return pair
}
// External retained evidence only: the caller supplies identities from trusted
// candidate evidence. This does not authenticate that evidence or qualify execution.
// #138 independently binds the running entry and recomputes this inventory at use.
export async function verifyInstalledRuntime({manifest,directory,installedRoot,expectedSourceSha,expectedTreeSha}) {
  if (typeof expectedSourceSha !== 'string' || !/^[a-f0-9]{40}$/.test(expectedSourceSha) || typeof expectedTreeSha !== 'string' || !/^[a-f0-9]{40}$/.test(expectedTreeSha) || manifest?.sourceSha !== expectedSourceSha || manifest?.treeSha !== expectedTreeSha) throw new Error('installed runtime trusted source/tree mismatch')
  manifest=structuredClone(manifest)
  const pair=await verifyPair(manifest,directory)
  const expected=pair[CLI].files.map(({path,mode,sha256})=>({path,mode,sha256}))
  if (!expected.some(f=>f.path==='dist/index.js') || !expected.some(f=>f.path==='dist/run-wrapper.js')) throw new Error('installed runtime entry or wrapper missing from archive')
  if (typeof installedRoot !== 'string' || installedRoot !== resolve(installedRoot)) throw new Error('installed runtime root must be an absolute normalized path')
  const archived=new Map(pair[CLI].files.map(f=>[f.path,f]))
  const directories=new Set([''])
  for (const f of expected) for (let path=dirname(f.path);path!=='.';path=dirname(path)) directories.add(path)
  const observed=[]
  const same=(a,b)=>a.dev===b.dev && a.ino===b.ino && a.mode===b.mode && a.nlink===b.nlink && a.size===b.size && a.mtimeMs===b.mtimeMs && a.ctimeMs===b.ctimeMs
  // Inspect the lexical path before any realpath resolution could hide a link.
  for (let path=installedRoot;;path=dirname(path)) {
    const stat=await lstat(path)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('installed runtime root or ancestor contains a link or unsupported object')
    observed.push({path,stat})
    if (dirname(path)===path) break
  }
  const actual=[]
  async function walk(root,prefix='') {
    for (const name of (await readdir(root)).sort()) {
      const path=prefix?`${prefix}/${name}`:name;packagePath(path)
      const file=join(root,name), stat=await lstat(file)
      if (stat.isDirectory()) {
        if (!directories.has(path)) throw new Error('installed runtime inventory contains an extra directory')
        observed.push({path:file,stat});await walk(file,path)
      } else if (stat.isFile() && stat.nlink===1) {
        const mode=stat.mode&0o777
        const retained=archived.get(path)
        if (!retained || retained.mode!==mode || retained.data.length!==stat.size) throw new Error('installed runtime inventory differs from retained CLI archive')
        const fd=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
        try {
          if (!same(stat,await fd.stat())) throw new Error('installed runtime changed during inspection')
          const bytes=await fd.readFile()
          if (bytes.length!==stat.size || !same(stat,await fd.stat())) throw new Error('installed runtime changed during inspection')
          actual.push({path,mode,sha256:digest(bytes)})
        } finally {await fd.close()}
        observed.push({path:file,stat})
      } else throw new Error('installed runtime contains a link or unsupported object')
    }
  }
  await walk(installedRoot)
  actual.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)
  if (JSON.stringify(actual)!==JSON.stringify(expected)) throw new Error('installed runtime inventory differs from retained CLI archive')
  for (const {path,stat} of observed) if (!same(stat,await lstat(path))) throw new Error('installed runtime changed during inspection')
  return {schemaVersion:1,sourceSha:expectedSourceSha,treeSha:expectedTreeSha,packageName:CLI,version:manifest.version,tarballSha256:pair[CLI].artifact.sha256,inventoryDigest:digest(JSON.stringify(actual))}
}
// Release evidence is bound separately from archive-only CI rehearsals.
export async function verifyReleaseEvidence(manifest, directory) {
  await verifyPair(manifest,directory)
  if (!manifest.checkEvidence?.ok || !manifest.scanEvidence?.ok || !manifest.platformMatrix?.length) throw new Error('release verification evidence missing')
  for (const e of [manifest.checkEvidence,manifest.scanEvidence]) {
    if (packagePath(e.file).includes('/') || !verifyArtifactBytes(await readFile(join(directory,e.file)),e)) throw new Error('release evidence changed')
  }
  const expected = new Map([['build-sbom.json','build'],['cli-runtime-sbom.json',CLI],['dashboard-runtime-sbom.json',DASHBOARD]])
  if (!Array.isArray(manifest.sbomFiles) || manifest.sbomFiles.length !== expected.size) throw new Error('required SBOM evidence missing')
  for (const e of manifest.sbomFiles) {
    if (!e || !expected.has(e.file) || expected.get(e.file)!==e.scope) throw new Error('invalid SBOM identity/scope')
    expected.delete(e.file)
    const bytes=await readFile(join(directory,e.file))
    if (!verifyArtifactBytes(bytes,e)) throw new Error('SBOM evidence changed')
    const bom=JSON.parse(bytes)
    if (bom.bomFormat!=='CycloneDX' || !Array.isArray(bom.components)) throw new Error('invalid SBOM content')
    if (e.scope!=='build' && (bom.metadata?.component?.name!==e.scope || bom.metadata?.component?.version!==manifest.version)) throw new Error('SBOM package mismatch')
  }
  if (expected.size) throw new Error('required SBOM evidence missing')
  return true
}
// The workflow supplies authoritative prior-attempt job observations. Missing history
// never permits a second preparation of bytes that might already be public.
export function recoveryDecision({artifacts,attempts,sourceSha,runAttempt}) {
  const pairs=artifacts.filter(a=>a.name.startsWith(`release-pair-${sourceSha}-attempt-`))
  if (pairs.length>1 || pairs.some(a=>a.expired)) throw new Error('ambiguous or expired retained pair; refuse rebuilding')
  if (pairs.length===1) return {prepare:false,artifact:pairs[0].name}
  for(let n=1;n<runAttempt;n++) {
    const jobs=attempts[n]
    const prepare=jobs?.find(j=>j.name==='prepare'),publish=jobs?.find(j=>j.name==='publish')
    const retained=prepare?.steps?.find(s=>s.name==='Retain finalized immutable pair')
    const step=publish?.steps?.find(s=>s.name==='Publish retained pair and promote after registry first-use smoke')
    const preparationFailedBeforeRetention=prepare?.status==='completed'&&prepare?.conclusion==='failure'&&retained?.conclusion!=='success'&&(!publish||publish.status==='completed'&&publish.conclusion==='skipped')
    const legacyOrCompletedPublishSkipped=publish?.status==='completed'&&step?.conclusion==='skipped'
    if(!preparationFailedBeforeRetention&&!legacyOrCompletedPublishSkipped)throw new Error('prior publication uncertain; refuse rebuilding')
  }
  return {prepare:true,artifact:''}
}
const dashboardUuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const dashboardReadinessKeys=['cacheSchema','dataState','instanceId','ok','org','sourceAgeSeconds','version']
function assertSmokeReadiness(value,expected) {
  if (!value || typeof value!=='object' || Object.keys(value).sort().join(',')!==dashboardReadinessKeys.join(',') ||
    value.ok!==true || value.org!==expected.org || value.version!==expected.version || value.instanceId!==expected.instanceId ||
    value.cacheSchema!==2 || !['ready','empty','unavailable'].includes(value.dataState) ||
    !(value.sourceAgeSeconds===null || typeof value.sourceAgeSeconds==='number' && Number.isFinite(value.sourceAgeSeconds) && value.sourceAgeSeconds>=0)) throw new Error('dashboard readiness identity or data state mismatch')
  return value
}
const processAlive=pid=>{
  if(!Number.isSafeInteger(pid)||pid<1)return false
  try{process.kill(pid,0);return true}catch(error){if(error.code==='ESRCH')return false;throw error}
}
async function waitForExit(child,timeout) {
  if(child.exitCode!==null || child.signalCode!==null)return true
  return Promise.race([new Promise(resolve=>child.once('close',()=>resolve(true))),new Promise(resolve=>setTimeout(()=>resolve(false),timeout))])
}
async function startStaleDashboard(expected) {
  const body=JSON.stringify({ok:true,org:expected.org,version:expected.version,instanceId:expected.instanceId,cacheSchema:2,dataState:'ready',sourceAgeSeconds:0})
  const sockets=new Set()
  // Keep the probe socket open deliberately: cleanup must not depend on the
  // launcher's HTTP client releasing an idle connection before the CLI stops.
  const server=createServer(socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));socket.write(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: keep-alive\r\n\r\n${body}`)})
  await new Promise((ok,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',ok)})
  return {server,sockets,port:server.address().port}
}
async function closeServer(stale) {
  const {server,sockets}=stale
  if(!server.listening)return
  const closed=new Promise((ok,fail)=>server.close(error=>error?fail(error):ok(true)))
  for(const socket of sockets)socket.destroy()
  if(!await Promise.race([closed,new Promise(ok=>setTimeout(()=>ok(false),1_000))]))throw new Error('stale dashboard cleanup timeout')
}
export async function smokePair(manifest,directory) {
  const pair=await verifyPair(manifest,directory)
  const home=await realpath(await mkdtemp(join(tmpdir(),'vegafactory-pair-'))),consumer=join(home,'consumer')
  const cleanup={cliStopped:false,dashboardStopped:false,isolatedHomeRemoved:false};let launcherProcess=null,dashboardPid=null,stale=null,result
  try {
    await mkdir(consumer)
    // Install and inventory-check the exact retained CLI without resolving or rebuilding it.
    const cliTar=join(home,'cli.tgz');await writeFile(cliTar,pair[CLI].bytes)
    const fixtureBin=join(home,'bin');await mkdir(fixtureBin);await writeFile(join(fixtureBin,'gh'),'#!/usr/bin/env node\nprocess.exit(1)\n',{mode:0o755})
    const env={PATH:`${fixtureBin}${process.platform==='win32'?';':':'}${process.env.PATH??''}`,HOME:home,TMPDIR:home,CI:'1',npm_config_cache:join(home,'npm-cache')}
    command(['npm','install','--ignore-scripts','--offline','--no-audit','--no-fund','--prefix',consumer,cliTar],{cwd:home,env})
    const installedRoot=join(consumer,'node_modules',CLI),cli=join(installedRoot,'dist/index.js'),cliBin=join(consumer,'node_modules/.bin/vegafactory')
    const installedDescriptor=JSON.parse(await readFile(join(dirname(cli),'dashboard-artifact.json'),'utf8'))
    verifyDashboardDescriptor(installedDescriptor,pair[DASHBOARD].bytes,manifest.version)
    const runtimeBinding=await verifyInstalledRuntime({manifest,directory,installedRoot,expectedSourceSha:manifest.sourceSha,expectedTreeSha:manifest.treeSha})
    const version=command([cliBin,'--version'],{cwd:home,env});if (!version.includes(manifest.version)) throw new Error('installed CLI version mismatch')
    command([cliBin,'skills','list'],{cwd:home,env})
    const project=join(home,'project');await mkdir(project)
    command([cliBin,'skills','add','dev-implement','--agent','codex','--dir',project,'--non-interactive'],{cwd:home,env})
    command([cliBin,'skills','verify','dev-implement','--agent','codex','--dir',project],{cwd:home,env})
    await readFile(join(project,'.agents/skills/dev-implement/scripts/preflight.mjs'))

    // Seed the launcher's own immutable version cache from this retained pair. The installed
    // runtime sees no source checkout, repository script or live registry override.
    const dashboardRoot=join(home,'.vegastack/dashboard',manifest.version),dashboard=join(dashboardRoot,'node_modules',DASHBOARD)
    await mkdir(dirname(dashboard),{recursive:true});await extractPackage(pair[DASHBOARD].bytes,dashboard);await verifyExtractedDashboard(dashboard,installedDescriptor)
    const receipt={schemaVersion:1,owner:'vegafactory-dashboard',version:manifest.version,descriptorSha256:digest(JSON.stringify(installedDescriptor))}
    await writeFile(join(dashboardRoot,'dashboard-install.json'),JSON.stringify(receipt))

    const room=join(home,'room'),repo=join(home,'repo'),stateDir=join(home,'.vegastack'),stateFile=join(stateDir,'factory.json')
    await mkdir(join(repo,'.vegastack'),{recursive:true});await mkdir(stateDir,{recursive:true,mode:0o700});await mkdir(room)
    await writeFile(join(repo,'.vegastack/dev.md'),'repo: fixture/project\ncontrol-room: fixture/control-room#dev\n')
    const factory={schemaVersion:2,revision:0,repos:[{repo:'fixture/project',org:'fixture',path:repo}],controlRooms:{fixture:{repo:'fixture/control-room',path:room,branch:'main',lastSyncedAt:null,sha:null}}}
    await writeFile(stateFile,JSON.stringify(factory),{mode:0o600})
    // A configured row and a foreign row are intentionally not granted by a validated policy.
    // Every response must therefore stay unavailable/empty and must not reveal either canary.
    const now=new Date(),months=['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'],month=`${months[now.getUTCMonth()]}-${now.getUTCFullYear()}`
    for(const name of ['fixture__project','foreign__private']){const stats=join(room,'stats',name,month);await mkdir(stats,{recursive:true});await writeFile(join(stats,'test.jsonl'),JSON.stringify({ts:now.toISOString(),repo:name==='fixture__project'?'fixture/project':'foreign/private',issue:1,human:'PRIVATE_SCOPE_CANARY',stage:'implement',outcome:'for-operator',harness:'codex',model:'fixture',duration_s:1,skills:[]})+'\n')}

    const staleIdentity='00000000-0000-4000-8000-000000000000'
    stale=await startStaleDashboard({org:'fixture',version:manifest.version,instanceId:staleIdentity})
    const stdout=[],stderr=[];let launchError=null
    launcherProcess=spawn(cliBin,['dashboard','--org','fixture','--port',String(stale.port),'--json'],{cwd:home,env,stdio:['ignore','pipe','pipe']})
    launcherProcess.stdout.on('data',bytes=>stdout.push(bytes.toString()));launcherProcess.stderr.on('data',bytes=>stderr.push(bytes.toString()));launcherProcess.once('error',error=>{launchError=error})
    let launcher=null
    const deadline=Date.now()+25_000
    while(Date.now()<deadline && !launcher) {
      if(launchError)throw new Error(`installed CLI dashboard failed to start: ${launchError.message}`)
      const output=stdout.join('').trim();if(output){try{launcher=JSON.parse(output)}catch{/* JSON is pretty-printed over several chunks. */}}
      if(!launcher && (launcherProcess.exitCode!==null||launcherProcess.signalCode!==null))throw new Error(`installed CLI dashboard exited before readiness: ${stderr.join('').trim()}`)
      if(!launcher)await new Promise(ok=>setTimeout(ok,100))
    }
    if(!launcher)throw new Error(`installed CLI dashboard readiness timeout: ${stderr.join('').trim()}`)
    if(launcher.command!=='dashboard'||launcher.ok!==true||launcher.org!=='fixture'||launcher.version!==manifest.version||launcher.cacheSchema!==2||!dashboardUuid.test(launcher.instanceId)||launcher.instanceId===staleIdentity||
      launcher.fetched!==false||typeof launcher.url!=='string'||!launcher.url.startsWith('http://127.0.0.1:')||launcher.url===`http://127.0.0.1:${stale.port}`||
      launcher.dir!==dashboardRoot||launcher.entry!==join(dashboard,'dist-standalone/packages/dashboard/server.js')||!Number.isSafeInteger(launcher.pid)||launcher.pid<1||launcher.pid===launcherProcess.pid) throw new Error('installed CLI dashboard launcher identity mismatch')
    dashboardPid=launcher.pid
    if(launcherProcess.exitCode!==null||!processAlive(launcherProcess.pid)||!processAlive(dashboardPid))throw new Error('installed CLI dashboard owned process is not alive')
    const healthResponse=await fetch(`${launcher.url}/api/health`,{cache:'no-store',signal:AbortSignal.timeout(5_000)})
    if(!healthResponse.ok)throw new Error(`dashboard readiness: HTTP ${healthResponse.status}`)
    const readiness=assertSmokeReadiness(await healthResponse.json(),{org:'fixture',version:manifest.version,instanceId:launcher.instanceId})
    const required=new Map([
      ['/', ['Needs your decision','Blocked or failed','Running','Recently merged']],
      ['/performance',['Performance report is unavailable.','Unlinked terminal segments']],
      ['/activity',['Activity report is unavailable.']],
      ['/people',['People reporting is unavailable for the current policy and scope.']],
      ['/people/fixture-user?dimension=task-owner',['This person report is unavailable for the current verified identity, policy, and repository scope.']],
      ['/skills',['No skill invocations recorded for this month.']],
      ['/repo/fixture/project',['This repository is outside the current verified reporting scope.']],
      ['/board',['Some data is incomplete or unavailable.']],
      ['/dispatcher',['Running','Unavailable']],
    ]),routes=[]
    for(const [route,phrases] of required){const response=await fetch(`${launcher.url}${route}`,{cache:'no-store',signal:AbortSignal.timeout(10_000)}),body=await response.text();if(!response.ok)throw new Error(`${route}: HTTP ${response.status}`);if(body.includes('PRIVATE_SCOPE_CANARY')||phrases.some(phrase=>!body.includes(phrase)))throw new Error(`${route}: dishonest or scope-leaking response`);routes.push({route,status:response.status,scope:'current policy unavailable; configured and foreign fixture rows excluded'})}
    result={platform:process.platform,arch:process.arch,node:process.version,npm:command(['npm','--version']),bun:command(['bun','--version']),artifactHashes:manifest.artifacts.map(a=>a.sha256),runtimeBinding,
      installedCli:true,staleListenerRejected:true,ownedChildAlive:true,launcher:{command:launcher.command,ok:launcher.ok,org:launcher.org,version:launcher.version,instanceId:launcher.instanceId,cacheSchema:launcher.cacheSchema,fetched:launcher.fetched},readiness,routes,cleanup}
  } finally {
    if(launcherProcess) {
      if(launcherProcess.exitCode===null&&launcherProcess.signalCode===null)launcherProcess.kill('SIGTERM')
      cleanup.cliStopped=await waitForExit(launcherProcess,7_000)
      if(!cleanup.cliStopped){launcherProcess.kill('SIGKILL');cleanup.cliStopped=await waitForExit(launcherProcess,1_000)}
    } else cleanup.cliStopped=true
    if(dashboardPid) {
      const deadline=Date.now()+1_000;while(processAlive(dashboardPid)&&Date.now()<deadline)await new Promise(ok=>setTimeout(ok,50))
      if(processAlive(dashboardPid)){try{process.kill(dashboardPid,'SIGKILL')}catch(error){if(error.code!=='ESRCH')throw error};const killed=Date.now()+1_000;while(processAlive(dashboardPid)&&Date.now()<killed)await new Promise(ok=>setTimeout(ok,50))}
      cleanup.dashboardStopped=!processAlive(dashboardPid)
    } else cleanup.dashboardStopped=true
    if(stale)await closeServer(stale)
    await rm(home,{recursive:true,force:true});cleanup.isolatedHomeRemoved=true
    if(!cleanup.cliStopped||!cleanup.dashboardStopped)throw new Error('installed CLI dashboard cleanup is unverified')
  }
  return result
}

async function runtimeSbom(files, name, version) {
  const components=[]
  for(const f of files.filter(f=>f.path.endsWith('/package.json') || f.path==='package.json')) {
    let p;try{p=JSON.parse(f.data.toString())}catch{continue}
    if(p.name && p.version)components.push({type:'library',name:p.name,version:p.version,'bom-ref':f.path,hashes:[{alg:'SHA-256',content:f.sha256}],properties:[{name:'scope',value:'runtime shipped package metadata'},{name:'path',value:f.path}]})
  }
  return {bomFormat:'CycloneDX',specVersion:'1.5',version:1,metadata:{component:{type:'application',name,version}},components}
}
async function buildSbom(root) {
  const components=[];const seen=new Set()
  async function walk(path) {
    let actual;try{actual=await realpath(path)}catch{return}
    if(seen.has(actual))return;seen.add(actual)
    for(const e of await readdir(actual,{withFileTypes:true})) {
      const p=join(actual,e.name)
      if(e.name==='package.json') {const bytes=await readFile(p);let m;try{m=JSON.parse(bytes)}catch{continue};if(m.name&&m.version)components.push({type:'library',name:m.name,version:m.version,'bom-ref':relative(root,p),hashes:[{alg:'SHA-256',content:digest(bytes)}]})}
      else if(e.isDirectory()||e.isSymbolicLink())await walk(p)
    }
  }
  await walk(join(root,'node_modules'))
  return {bomFormat:'CycloneDX',specVersion:'1.5',version:1,metadata:{properties:[{name:'scope',value:'actual installed build graph; no second dependency resolution'}]},components}
}
export async function packPair(root, directory, {sourceSha,treeSha,version,toolchain,checkEvidence,scanEvidence,sbomFiles=[]}) {
  await mkdir(directory,{recursive:true})
  const pack=folder=>JSON.parse(command(['npm','pack','--ignore-scripts','--json','--pack-destination',directory],{cwd:join(root,folder)}))[0].filename
  const dashboardFile=pack('packages/dashboard');const dashboardBytes=await readFile(join(directory,dashboardFile))
  const descriptor=dashboardDescriptor(dashboardBytes,version)
  const descriptorPath=join(root,'packages/cli/dist/dashboard-artifact.json')
  await writeFile(descriptorPath,JSON.stringify(descriptor,null,2)+'\n')
  verifyDashboardDescriptor(JSON.parse(await readFile(descriptorPath,'utf8')),await readFile(join(directory,dashboardFile)),version)
  const cliFile=pack('packages/cli')
  const artifacts=[]
  for(const [name,file] of [[DASHBOARD,dashboardFile],[CLI,cliFile]]) {
    const bytes=await readFile(join(directory,file))
    artifacts.push({name,file,sha256:digest(bytes),integrity:`sha512-${digest(bytes,'sha512','base64')}`,bytes:bytes.length})
    const sbomFile=`${name===CLI?'cli':'dashboard'}-runtime-sbom.json`
    await writeFile(join(directory,sbomFile),JSON.stringify(await runtimeSbom(readPackageArchive(bytes),name,version),null,2)+'\n');sbomFiles.push({file:sbomFile,scope:name,sha256:digest(await readFile(join(directory,sbomFile)))})
  }
  const manifest={schemaVersion:1,sourceSha,treeSha,version,toolchain,platformMatrix:[],artifacts,checkEvidence,scanEvidence,sbomFiles}
  await verifyPair(manifest,directory)
  return manifest
}
export async function prepareRelease(root,directory,tag) {
  root=resolve(root);directory=resolve(directory)
  try {await readFile(join(directory,'release-manifest.json'));throw new Error('existing pair must be retained, never prepared again')}catch(e){if(e.code!=='ENOENT')throw e}
  if(command(['git','status','--porcelain','--untracked-files=all'],{cwd:root}))throw new Error('release preparation requires clean source')
  const sourceSha=command(['git','rev-parse','HEAD'],{cwd:root});const treeSha=command(['git','rev-parse','HEAD^{tree}'],{cwd:root})
  const cli=JSON.parse(await readFile(join(root,'packages/cli/package.json'),'utf8'));const dashboard=JSON.parse(await readFile(join(root,'packages/dashboard/package.json'),'utf8'))
  assertPairVersions({cli:cli.version,dashboard:dashboard.version,tag:tag??`v${cli.version}`})
  const toolchain={node:process.version,bun:command(['bun','--version']),npm:command(['npm','--version']),python:command(['python3.12','--version']),skillspector:command(['skillspector','--version']),platform:process.platform,arch:process.arch}
  if(!process.version.startsWith('v24.')||toolchain.bun!=='1.3.14'||!toolchain.python.startsWith('Python 3.12.'))throw new Error('release requires Node24/Bun1.3.14/Python3.12')
  const baseline=JSON.parse(await readFile(join(root,'.vegastack/skillspector-baseline.json'),'utf8'))
  if(!baseline.scanner_version || !toolchain.skillspector.includes(baseline.scanner_version))throw new Error('scanner version differs from exact baseline pin')
  await mkdir(directory,{recursive:true})
  command(['bun','install','--frozen-lockfile'],{cwd:root})
  const checkLog=command(['bun','run','check'],{cwd:root,timeout:1800000});await writeFile(join(directory,'check.log'),checkLog)
  command(['bun','run','--cwd','packages/dashboard','build'],{cwd:root});command(['bun','run','--cwd','packages/dashboard','assemble'],{cwd:root})
  command(['bun','run','build'],{cwd:root})
  const scanText=command(['node','skills/skills-tooling/skill-scan/scripts/skill-scan.mjs','--json','--no-provision'],{cwd:root,timeout:1800000})
  const scan=JSON.parse(scanText);const expected=(await readdir(join(root,'packages/cli/skill'),{withFileTypes:true})).filter(e=>e.isDirectory()).map(e=>e.name)
  assertScanEvidence(scan,expected);await writeFile(join(directory,'scan.json'),scanText)
  await writeFile(join(directory,'build-sbom.json'),JSON.stringify(await buildSbom(root),null,2)+'\n')
  const manifest=await packPair(root,directory,{sourceSha,treeSha,version:cli.version,toolchain,checkEvidence:{file:'check.log',sha256:digest(Buffer.from(checkLog)),ok:true},scanEvidence:{file:'scan.json',sha256:digest(Buffer.from(scanText)),baselineSha256:digest(await readFile(join(root,'.vegastack/skillspector-baseline.json'))),ok:true,skills:expected},sbomFiles:[{file:'build-sbom.json',scope:'build',sha256:digest(await readFile(join(directory,'build-sbom.json')))}]})
  const smoke=await smokePair(manifest,directory);manifest.platformMatrix.push(smoke)
  if(command(['git','status','--porcelain','--untracked-files=all'],{cwd:root}) || command(['git','rev-parse','HEAD'],{cwd:root})!==sourceSha)throw new Error('source changed during preparation')
  await verifyReleaseEvidence(manifest,directory)
  await writeFile(join(directory,'release-manifest.json.tmp'),JSON.stringify(manifest,null,2)+'\n')
  await rename(join(directory,'release-manifest.json.tmp'),join(directory,'release-manifest.json'))
  return manifest
}
async function main() {
  const [verb,...args]=process.argv.slice(2)
  if(verb==='prepare')return prepareRelease(resolve(dirname(fileURLToPath(import.meta.url)),'..'),args[0]??'work/release',args[1])
  if(verb==='verify-release') {const path=resolve(args[0]);await verifyReleaseEvidence(JSON.parse(await readFile(path,'utf8')),dirname(path));return {ok:true}}
  if(verb==='verify'||verb==='smoke') {const path=resolve(args[0]);const manifest=JSON.parse(await readFile(path,'utf8'));return verb==='verify'? (await verifyPair(manifest,dirname(path)),{ok:true}):smokePair(manifest,dirname(path))}
  if(verb==='validate-cli') {
    const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');const version=JSON.parse(await readFile(join(root,'packages/cli/package.json'),'utf8')).version
    if(!process.env.VEGAFACTORY_DASHBOARD_TARBALL)throw new Error('pack CLI through release prepare, or provide the exact dashboard tarball via VEGAFACTORY_DASHBOARD_TARBALL')
    return {ok:verifyDashboardDescriptor(JSON.parse(await readFile(join(root,'packages/cli/dist/dashboard-artifact.json'),'utf8')),await readFile(process.env.VEGAFACTORY_DASHBOARD_TARBALL),version)}
  }
  throw new Error('usage: release-artifacts.mjs prepare <evidence-dir> <tag> | verify|smoke <manifest> | validate-cli')
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(error.message);process.exitCode=2})

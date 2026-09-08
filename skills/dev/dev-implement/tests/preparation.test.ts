import {expect,test} from 'bun:test'
import {preparationTaskContracts,evaluatePreparation} from '../scripts/recovery.mjs'
import {packagedPreparationAdapter} from '../scripts/preflight.mjs'
import {createHash} from 'node:crypto'
import {scopeDigest} from '../scripts/lib/approval.mjs'
const binding={approvalId:'source',commentId:5,bodySha256:'a'.repeat(64)}
const parent={repo:'o/r',issue:133,branch:'codex/parent',baseSha:'a'.repeat(40)}
const body='<!-- vsk:v1 type=plan rev=1 -->\n- [ ] **Task 1** <!-- task-id:156-T1 -->\n  - Files — Modify: `docs/a.md`\n  - Interfaces — Preparation156-T1. Consumes #153 release contract and #151 UI. Produces documentation.\n- [ ] **Task 2** <!-- task-id:156-T2 -->\n  - Files — Modify: `docs/a.md`\n  - Interfaces — Live publication.\n'
const plan={repo:'o/r',issue:156,kind:'plan',artifactId:'plan',rev:1,digest:scopeDigest(body,'plan')}
test('only explicitly named preparation tasks produce prerequisite mapping',()=>{
 expect(preparationTaskContracts(body,['156-T1'],()=>['docs/a.md'])).toEqual([{id:'156-T1',files:['docs/a.md'],prerequisiteIssues:[153,151]}])
 expect(()=>preparationTaskContracts(body,['156-T2'],()=>['docs/a.md'])).toThrow('not explicitly preparation')
})
test('preparation cannot substitute relay authority or add live tasks',()=>{
 const tasks=[{id:'156-T1',files:['docs/a.md'],prerequisiteIssues:[153,151]}]
 const preparation={parent,plan,taskIds:['156-T1'],tasks,approvalBinding:binding,pendingEffects:[]}
 const childApproval={ok:true,preparation,approvalBindings:[binding],approvalIds:['source'],blocks:[]}
 const input={parentApproval:childApproval,childApproval,taskIds:['156-T1'],taskPrerequisites:{parent,plan,tasks,approvalBinding:binding},current:{ownership:true,policyCurrent:true,operation:'edit'}}
 expect(evaluatePreparation(input).blocks).toEqual([])
 expect(evaluatePreparation({...input,taskIds:['156-T1','156-T2']}).blocks).not.toEqual([])
 expect(evaluatePreparation({...input,taskPrerequisites:{...input.taskPrerequisites,approvalBinding:{...binding,approvalId:'relay'}}}).blocks).not.toEqual([])
 expect(evaluatePreparation({...input,current:{...input.current,operation:'publish'}}).blocks).not.toEqual([])
})
test('production mapping transport rereads canonical source and exact plan',async()=>{
 const source='actual approval';const pin={...binding,bodySha256:createHash('sha256').update(source).digest('hex')};const reads:string[]=[]
 const adapter=packagedPreparationAdapter({readJson:async(args:string[])=>{reads.push(args[1]!);return args[1]!.includes('issues/comments')?{id:5,body:source,issue_url:'https://api.github.com/repos/o/r/issues/133'}:[[{node_id:'plan',body}]]}})
 expect((await adapter.readTaskPrerequisites({parent,plan,taskIds:['156-T1'],approvalBinding:pin})).tasks[0]?.prerequisiteIssues).toEqual([153,151]);expect(reads).toHaveLength(2)
 await expect(adapter.readTaskPrerequisites({parent,plan,taskIds:['156-T1'],approvalBinding:binding})).rejects.toThrow('source changed')
})

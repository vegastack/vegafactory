import {expect,test} from 'bun:test'
import {evaluateLesson,selectLessons} from '../scripts/learning.mjs'
const lesson=()=>({id:'lesson-'+'1'.repeat(32),repo:'o/r',taskId:'144-T4',scopeDigest:'a'.repeat(64),sourceSha:'a'.repeat(40),statement:'Use the verified exact source before resuming.',evidenceRefs:[{kind:'check',ref:'check:one',sha:'a'.repeat(40),passed:true}],targetPaths:['src/a.ts'],undoRef:'git:'+'b'.repeat(40),state:'adopted',supersedes:[]})
const context=()=>({repo:'o/r',scopeDigest:'a'.repeat(64),sourceSha:'a'.repeat(40),taskIds:['144-T4'],allowedFiles:['src/a.ts'],learningEnabled:true,reversible:true,improved:true,verifiedEvidence:lesson().evidenceRefs})
test('green tests cannot authorize a weaker mandatory rule',()=>expect(evaluateLesson({...lesson(),targetPaths:['.vegastack/dev.md']},context()).action).toBe('propose'))
test('fabricated, unrelated and stale check evidence is refused',()=>{
 expect(evaluateLesson(lesson(),{...context(),verifiedEvidence:[]}).action).toBe('reject')
 expect(evaluateLesson(lesson(),{...context(),improved:false}).action).toBe('reject')
 expect(evaluateLesson(lesson(),{...context(),sourceSha:'c'.repeat(40)}).action).toBe('reject')
 expect(evaluateLesson(lesson(),context()).action).toBe('adopt')
})
test('selection is bounded, source scoped, deduplicated and excludes reverted lessons',()=>{
 const row=lesson();expect(selectLessons({learning:[row,row]},context())).toHaveLength(1)
 expect(selectLessons({learning:[row]}, {...context(),repo:'other/r'})).toEqual([])
 expect(selectLessons({learning:[{...row,state:'reverted'}]},context())).toEqual([])
 expect(selectLessons({learning:[row]}, {...context(),maxBytes:10})).toEqual([])
})

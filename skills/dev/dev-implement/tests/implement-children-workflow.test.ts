import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(import.meta.dir, '../assets/workflows/implement-children.js'), 'utf8')

describe('the implement-children workflow asset', () => {
  test('it parses as a module and opens with a pure-literal meta', () => {
    expect(() => new Bun.Transpiler({ loader: 'js' }).scan(source)).not.toThrow()
    expect(source.startsWith('export const meta = {')).toBe(true)
    expect(source).toContain("name: 'implement-children'")
    expect(source).toContain("title: 'Build children'")
  })
  test('it uses nothing a workflow script cannot have', () => {
    expect(source).not.toMatch(/require\(|from '(node:|fs|path)|Date\.now\(|new Date\(|Math\.random\(/)
  })
})

// A compatibility entry must refuse before invoking any supplied executor.
test('legacy workflow cannot become a second child execution owner', async () => {
  const workflow = await import('../assets/workflows/implement-children.js')
  let starts=0
  await expect(workflow.default({args:{children:[{issue:8,prompt:'controlled'}],parentIssue:1,parentBranch:'parent',parentHead:'a'.repeat(40),concurrency:1},agent:async()=>{starts++;return{issue:8,status:'done'}},pipeline:async(rows:any[],run:any)=>Promise.all(rows.map(row=>run(null,row))),log:()=>{}})).rejects.toThrow('vegafactory children run')
  expect(starts).toBe(0)
})

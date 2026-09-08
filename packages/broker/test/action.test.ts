import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'

const body = readFileSync(resolve(import.meta.dir, '../action/action.yml'), 'utf8')
const script = body.split('        script: |\n')[1]!.replace(/^          /gm, '')

async function exercise(response: Response | Error) {
  const events: { kind: string; name?: string; value?: string }[] = []
  const core = {
    getIDToken: async (audience: string) => { expect(audience).toBe('vegastack-factory'); return 'oidc_fixture' },
    setSecret: (value: string) => events.push({ kind: 'mask', value }),
    setOutput: (name: string, value: string) => events.push({ kind: 'output', name, value }),
    info: (value: string) => events.push({ kind: 'info', value }),
    setFailed: (value: string) => events.push({ kind: 'failed', value }),
  }
  const fetch = async (url: string, init: RequestInit) => {
    expect(url).toBe('https://broker.fixture.test/token')
    expect(init.method).toBe('POST')
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer oidc_fixture')
    if (response instanceof Error) throw response
    return response
  }
  await runInNewContext(`(async () => {${script}\n})()`, {
    core, fetch, AbortSignal, Date,
    process: { env: { BROKER_ENDPOINT: 'https://broker.fixture.test/token', BROKER_AUDIENCE: 'vegastack-factory' } },
  }, { timeout: 1000 })
  return events
}

describe('factory-token composite action', () => {
  test('declares the contract the broker actually serves', () => {
    expect(body).toContain('using: composite')
    expect(body).toContain('https://vegafactory-token.vegastack.com/token')
    expect(body).toContain('vegastack-factory')
    expect(body).toContain('core.getIDToken')
    expect(body).toContain('::add-mask::')
  })

  test('never writes the token to a log or to an unmasked output', () => {
    expect(body).not.toMatch(/echo\s+.*\$\{?TOKEN/)
    expect(body).not.toContain('set -x')
    expect(body).toMatch(/id-token/)
  })

  test('executes the source script and masks before exposing both documented outputs', async () => {
    const expires_at = new Date(Date.now() + 3600_000).toISOString()
    const events = await exercise(new Response(JSON.stringify({ token: 'ghs_fixture', expires_at, repository: 'acme/widgets' })))
    const mask = events.findIndex((event) => event.kind === 'mask' && event.value === 'ghs_fixture')
    expect(mask).toBeGreaterThanOrEqual(0)
    expect(events.findIndex((event) => event.kind === 'output')).toBeGreaterThan(mask)
    expect(events.filter((event) => event.kind === 'output')).toEqual([
      { kind: 'output', name: 'token', value: 'ghs_fixture' }, { kind: 'output', name: 'expires_at', value: expires_at },
    ])
    expect(body).toContain('value: ${{ steps.mint.outputs.expires_at }}')
  })

  test('refusals and transport errors cannot reflect credential-bearing details or create outputs', async () => {
    for (const response of [
      new Response(JSON.stringify({ reason: 'ghs_fixture', token: 'ghs_fixture' }), { status: 500 }),
      new Response(JSON.stringify({ expires_at: 'not-an-expiry' })),
      new Error('oidc_fixture ghs_fixture'),
    ]) {
      const events = await exercise(response)
      expect(events.some((event) => event.kind === 'failed')).toBe(true)
      expect(events.filter((event) => event.kind === 'output')).toHaveLength(0)
      expect(JSON.stringify(events.filter((event) => ['failed', 'info'].includes(event.kind)))).not.toMatch(/ghs_fixture|oidc_fixture/)
    }
  })
})

const workflow = Bun.YAML.parse(readFileSync(resolve(import.meta.dir, '../../../.github/workflows/broker-deploy.yml'), 'utf8')) as any
const deploymentSteps = workflow.jobs.deploy.steps
const protectionScript = deploymentSteps.find((step: any) => step.name === 'Validate dispatch and live protection').with.script

async function exerciseProtection(overrides: { environment?: string; ref?: string; digest?: string; reviewers?: any[]; policy?: any; policies?: any[]; unavailable?: boolean } = {}) {
  const environment = {
    protection_rules: [{ type: 'required_reviewers', reviewers: overrides.reviewers ?? [{ type: 'User', reviewer: { login: 'fixture-operator' } }] }],
    deployment_branch_policy: overrides.policy ?? { custom_branch_policies: true, protected_branches: false },
  }
  const github = {
    rest: { repos: {
      getEnvironment: async ({ environment_name }: { environment_name: string }) => {
        expect(['preview', 'production']).toContain(environment_name)
        if (overrides.unavailable) throw new Error('readback unavailable')
        return { data: environment }
      },
      listDeploymentBranchPolicies: () => {},
    } },
    paginate: async () => overrides.policies ?? [{ name: 'main', type: 'branch' }],
  }
  return runInNewContext(`(async () => {${protectionScript}\n})()`, {
    github, context: { repo: { owner: 'fixture', repo: 'fixture' } },
    process: { env: {
      BROKER_ENVIRONMENT: overrides.environment ?? 'preview',
      REVIEWED_REF: overrides.ref ?? 'a'.repeat(40),
      REVIEWED_DIGEST: overrides.digest ?? 'b'.repeat(64),
    } },
  }, { timeout: 1000 })
}

describe('reviewed same-App deployment workflow', () => {
  test('both environments require dispatch, main workflow ref and exact reviewed source', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])
    expect(workflow.on.workflow_dispatch.inputs.environment.options).toEqual(['preview', 'production'])
    expect(workflow.on.workflow_dispatch.inputs.reviewed_ref.required).toBe(true)
    expect(workflow.on.workflow_dispatch.inputs.reviewed_digest.required).toBe(true)
    expect(workflow.jobs.deploy.environment).toBe('${{ inputs.environment }}')
    expect(workflow.jobs.deploy.if).toBe("github.ref == 'refs/heads/main'")
    expect(workflow.jobs.deploy['runs-on']).toEqual(['self-hosted', 'vsk-runners-mac'])
    const checkout = deploymentSteps.find((step: any) => step.uses?.startsWith('actions/checkout@'))
    expect(checkout.with.ref).toBe('${{ inputs.reviewed_ref }}')
    expect(checkout.with['persist-credentials']).toBe(false)
    expect(deploymentSteps.find((step: any) => step.name === 'Verify reviewed source is merged').run).toContain('git merge-base --is-ancestor')
  })

  test('executes protection readback and refuses missing reviewers, permissive refs, or unavailable evidence', async () => {
    await exerciseProtection({ environment: 'preview' })
    await exerciseProtection({ environment: 'production' })
    for (const overrides of [
      { environment: 'unexpected' }, { ref: 'main' }, { digest: '' },
      { reviewers: [] }, { policy: { protected_branches: true } },
      { policies: [] }, { policies: [{ name: '*', type: 'branch' }] },
      { policies: [{ name: 'main', type: 'tag' }] },
      { policies: [{ name: 'main', type: 'branch' }, { name: 'release/*', type: 'branch' }] },
      { unavailable: true },
    ]) {
      await expect(exerciseProtection(overrides)).rejects.toThrow()
    }
  })

  test('hashes generated Worker bytes before retaining and deploying without rebundling', () => {
    const prepare = deploymentSteps.findIndex((step: any) => step.name === 'Prepare and verify exact Worker bytes')
    const retain = deploymentSteps.findIndex((step: any) => step.name === 'Retain reviewed Worker')
    const deploy = deploymentSteps.findIndex((step: any) => step.name === 'Deploy verified bytes without rebundling')
    expect(prepare).toBeLessThan(retain)
    expect(retain).toBeLessThan(deploy)
    expect(deploymentSteps[prepare].run).toContain('--dry-run')
    expect(deploymentSteps[prepare].run).toContain('digest !== process.env.REVIEWED_DIGEST')
    expect(deploymentSteps[deploy].run).toContain('"$BROKER_ARTIFACT_DIR/index.js"')
    expect(deploymentSteps[deploy].run).toContain('--no-bundle')
    expect(deploymentSteps[deploy].run).toContain('--config wrangler.jsonc')
    expect(deploymentSteps.slice(0, deploy).some((step: any) => step.env?.CLOUDFLARE_API_TOKEN)).toBe(false)
  })

  test('the actual digest check refuses changed Worker bytes', () => {
    const prepare = deploymentSteps.find((step: any) => step.name === 'Prepare and verify exact Worker bytes').run
    const digestScript = prepare.split("<<'JS'\n")[1].split('\nJS')[0].replace(/^import .*\n/gm, '')
    const bytes = Buffer.from('reviewed Worker fixture')
    const digest = createHash('sha256').update(bytes).digest('hex')
    const verify = (reviewedDigest: string, actualBytes: Buffer) => runInNewContext(digestScript, {
      readFileSync: () => actualBytes, createHash,
      process: { argv: ['node', '-', 'index.js'], env: { REVIEWED_DIGEST: reviewedDigest } },
    })
    expect(() => verify(digest, bytes)).not.toThrow()
    expect(() => verify(digest, Buffer.from('modified Worker'))).toThrow('Worker bytes differ')
    expect(() => verify('0'.repeat(64), bytes)).toThrow('Worker bytes differ')
  })

  test('action defaults pair with both canonical Worker environments', () => {
    const action = Bun.YAML.parse(body) as any
    const config = JSON.parse(readFileSync(resolve(import.meta.dir, '../wrangler.jsonc'), 'utf8'))
    expect(action.inputs.endpoint.default).toBe(`https://${config.env.production.routes[0].pattern}/token`)
    for (const environment of ['preview', 'production']) {
      expect(action.inputs.audience.default).toBe(config.env[environment].vars.OIDC_AUDIENCE)
      expect(config.env[environment].vars.VEGAFACTORY_APP_ID).toBe('4812956')
    }
  })
})

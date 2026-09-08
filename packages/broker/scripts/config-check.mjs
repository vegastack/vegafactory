#!/usr/bin/env node
// Deploy-config guard for the token broker. Deterministic and dependency-free: it parses
// wrangler.jsonc as plain JSON and blocks on facts, never on judgment.
//
// It exists because the broker's security properties live in its configuration as much as in its
// code — the App key held only in a Secrets Store binding, no storage binding at all, a custom
// domain rather than a workers.dev origin, and a rate limiter the platform can actually honour.
// The deploy workflow runs it before `wrangler deploy`, so a misconfigured environment fails at the
// guard instead of shipping.
//
// Exit codes: 0 clean · 1 warnings only · 2 blocked.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ENVIRONMENTS = ['preview', 'production']
const STORAGE_BINDINGS = ['kv_namespaces', 'd1_databases', 'r2_buckets', 'durable_objects', 'hyperdrive', 'queues', 'vectorize']
const SECRET_BINDING = 'APP_PRIVATE_KEY'
const SECRET_NAME = 'vegafactory-app-private-key'
const LIMITER_NAME = 'TOKEN_LIMITER'
const ALLOWED_PERIODS = [10, 60]
const HOSTS = { preview: 'vegafactory-token.vegastack.dev', production: 'vegafactory-token.vegastack.com' }
const SECRET_SHAPED = ['PRIVATE_KEY', 'SECRET', 'TOKEN']
const STORE_ADVICE = 'create it with: wrangler secrets-store store create vegafactory --remote'

export function checkBrokerConfig(text) {
  const blocks = []
  const warns = []
  let config
  try {
    config = JSON.parse(text)
  } catch {
    return { blocks: ['wrangler.jsonc must be comment-free JSON so the guard can parse it deterministically'], warns }
  }
  if (typeof config !== 'object' || config === null) {
    return { blocks: ['wrangler.jsonc must be comment-free JSON so the guard can parse it deterministically'], warns }
  }

  for (const field of ['name', 'main', 'compatibility_date']) {
    if (typeof config[field] !== 'string' || config[field].length === 0) blocks.push(`${field} is missing at the top level`)
  }

  // The top level is checked with the same two rules as the environments: a plaintext key or a
  // storage binding committed there is the leak whether or not wrangler inherits it into an env.
  for (const binding of STORAGE_BINDINGS) {
    if (binding in config) blocks.push(`${binding} is declared — the broker persists nothing and declares no storage binding`)
  }
  const topVars = typeof config.vars === 'object' && config.vars !== null ? config.vars : {}
  for (const key of Object.keys(topVars)) {
    if (SECRET_SHAPED.some((shape) => key.toUpperCase().includes(shape))) {
      blocks.push(`vars.${key} is a secret-shaped plain var — secrets belong in the Secrets Store binding`)
    }
  }

  const namespaceIds = new Map()
  for (const name of ENVIRONMENTS) {
    const block = config.env?.[name]
    const at = `env.${name}`
    if (typeof block !== 'object' || block === null) {
      blocks.push(`${at} is missing — the broker deploys to exactly two environments`)
      continue
    }

    for (const binding of STORAGE_BINDINGS) {
      if (binding in block) {
        blocks.push(`${at}.${binding} is declared — the broker persists nothing and declares no storage binding`)
      }
    }

    if (block.workers_dev !== false) blocks.push(`${at}.workers_dev must be false — the broker answers only on its custom domain`)

    const routes = Array.isArray(block.routes) ? block.routes : []
    if (routes.length !== 1) {
      blocks.push(`${at}.routes must carry exactly one custom-domain route`)
    } else {
      const route = routes[0] ?? {}
      if (route.custom_domain !== true) blocks.push(`${at}.routes[0].custom_domain must be true`)
      if (route.pattern !== HOSTS[name]) blocks.push(`${at}.routes[0].pattern must be ${HOSTS[name]}`)
    }

    const vars = typeof block.vars === 'object' && block.vars !== null ? block.vars : {}
    if (vars.VEGAFACTORY_APP_ID !== '4812956') {
      blocks.push(`${at}.vars.VEGAFACTORY_APP_ID must be 4812956 — both environments retain the same approved App`)
    }
    if (vars.OIDC_AUDIENCE !== 'vegastack-factory') {
      blocks.push(`${at}.vars.OIDC_AUDIENCE must be vegastack-factory — keep the reviewed action/Worker audience pair`)
    }
    for (const key of Object.keys(vars)) {
      if (SECRET_SHAPED.some((shape) => key.toUpperCase().includes(shape))) {
        blocks.push(`${at}.vars.${key} is a secret-shaped plain var — secrets belong in the Secrets Store binding`)
      }
    }

    const secrets = Array.isArray(block.secrets_store_secrets) ? block.secrets_store_secrets : []
    const secret = secrets.find((entry) => entry?.binding === SECRET_BINDING)
    if (!secret) {
      blocks.push(`${at}.secrets_store_secrets carries no ${SECRET_BINDING} binding — the App private key lives nowhere else`)
    } else {
      const index = secrets.indexOf(secret)
      if (secret.secret_name !== SECRET_NAME) {
        blocks.push(`${at}.secrets_store_secrets[${index}].secret_name must be ${SECRET_NAME}`)
      }
      if (typeof secret.store_id !== 'string' || secret.store_id.trim().length === 0) {
        blocks.push(`${at}.secrets_store_secrets[${index}].store_id is empty — ${STORE_ADVICE}`)
      }
    }

    const limiters = Array.isArray(block.ratelimits) ? block.ratelimits : []
    const limiter = limiters.find((entry) => entry?.name === LIMITER_NAME)
    if (!limiter) {
      blocks.push(`${at}.ratelimits carries no ${LIMITER_NAME} binding — the abuse brake is not optional`)
    } else {
      const index = limiters.indexOf(limiter)
      const period = limiter.simple?.period
      const limit = limiter.simple?.limit
      if (!ALLOWED_PERIODS.includes(period)) {
        blocks.push(`${at}.ratelimits[${index}].simple.period must be 10 or 60 — the platform accepts no other value`)
      }
      if (!Number.isInteger(limit) || limit <= 0) {
        blocks.push(`${at}.ratelimits[${index}].simple.limit must be a positive integer`)
      }
      const namespaceId = limiter.namespace_id
      if (typeof namespaceId !== 'string' || namespaceId.length === 0) {
        blocks.push(`${at}.ratelimits[${index}].namespace_id is empty`)
      } else if (namespaceIds.has(namespaceId)) {
        blocks.push(
          `${at}.ratelimits[${index}].namespace_id ${namespaceId} is already used by env.${namespaceIds.get(namespaceId)} — one counter per environment`,
        )
      } else {
        namespaceIds.set(namespaceId, name)
      }
    }

    if (block.observability?.enabled !== true) {
      blocks.push(`${at}.observability.enabled must be true — the audit record is the Worker's log`)
    }
  }

  return { blocks, warns }
}

function main(argv) {
  const fileFlag = argv.indexOf('--file')
  const path = fileFlag === -1 ? resolve(import.meta.dirname, '../wrangler.jsonc') : resolve(argv[fileFlag + 1] ?? '')
  const asJson = argv.includes('--json')
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    const result = { guard: 'broker-config', ok: false, blocks: [`${path} cannot be read`], warns: [] }
    console.log(asJson ? JSON.stringify(result, null, 2) : result.blocks.join('\n'))
    return 2
  }
  const { blocks, warns } = checkBrokerConfig(text)
  const result = { guard: 'broker-config', ok: blocks.length === 0, file: path, blocks, warns }
  if (asJson) console.log(JSON.stringify(result, null, 2))
  else {
    for (const line of blocks) console.log(`block: ${line}`)
    for (const line of warns) console.log(`warn: ${line}`)
    if (blocks.length === 0 && warns.length === 0) console.log('broker config: clean')
  }
  return blocks.length > 0 ? 2 : warns.length > 0 ? 1 : 0
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))

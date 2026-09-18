# Pinned platform facts

Facts that change architecture decisions and that models routinely get wrong from stale training data. One fact per line: what is true, what to do about it, the version it became true, the date someone last read it against its source, and that source. This is the verified cache behind SKILL.md's verify-before-you-recommend protocol, and the only file in this skill that goes stale by itself — when a recommendation leans on a line older than 60 days, re-verify that line against its link first.

## Cloudflare

- **R2 egress is $0 at any volume** · a 500GB-stored and 2TB-served workload runs about $191/mo on S3 against about $7.50/mo on R2, so reaching for S3 plus CloudFront to control egress solves a problem R2 does not have · since GA · checked 12-08-2026 · https://developers.cloudflare.com/r2/pricing
- **R2 lifecycle rules, bucket locks, event notifications and Infrequent Access are all live** · use the platform feature instead of building it · since GA · checked 12-08-2026 · https://developers.cloudflare.com/r2/pricing
- **R2 Infrequent Access transitions are one-way** · lifecycle only moves objects into IA; IA back to Standard needs a manual CopyObject · since GA · checked 12-08-2026 · https://developers.cloudflare.com/r2/pricing
- **Hyperdrive supports PostgreSQL 9.0 to 17.x** · PG 18 is not supported, so target Postgres 17 for any Hyperdrive-fronted database and re-check the supported-versions page before ever moving to 18 · since — · checked 12-08-2026 · https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features
- **Hyperdrive supports MySQL** · a MySQL database can sit behind Hyperdrive the way a Postgres one does · since 2026-08-07 · checked 12-08-2026 · https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features
- **Hyperdrive reaches private databases through Workers VPC** · a database with no public endpoint needs no tunnel of its own · since — · checked 12-08-2026 · https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features
- **Durable Objects default to SQLite storage** · real SQL, transactions and point-in-time recovery come with the default class, so do not add a separate store for them · since GA · checked 12-08-2026 · https://developers.cloudflare.com/durable-objects
- **Hibernating WebSocket Durable Objects bill about $0 while idle** · one DO per room is cost-competitive with Redis plus socket.io for mostly-idle connections · since GA · checked 12-08-2026 · https://developers.cloudflare.com/durable-objects
- **Workflows cap steps and bill per step** · 10,000 steps by default and 25,000 at most, and billing has been per step since 2026-08-10, so a high-step-count design now carries a real cost dimension · since 2026-08-10 · checked 12-08-2026 · https://developers.cloudflare.com/workflows
- **A Workflow step can sleep for up to 365 days** · long waits stay inside the workflow instead of needing an external scheduler · since — · checked 12-08-2026 · https://developers.cloudflare.com/workflows
- **Browser Rendering is metered by duration and by concurrency** · $0.09 per browser-hour plus $2 per extra concurrent browser, so batch scraping through a queue and do not treat it as free headless Chrome · since — · checked 12-08-2026 · https://developers.cloudflare.com/browser-rendering
- **R2, KV and Workflows event notifications route through Queues event subscriptions** · put a Queue consumer on platform state changes instead of building a bespoke webhook receiver · since — · checked 12-08-2026 · https://developers.cloudflare.com/queues
- **D1 read replication only helps through the Sessions API** · without `withSession(bookmark)` every query still hits the primary · since — · checked 12-08-2026 · https://developers.cloudflare.com/d1

## Next.js (16.3, released 2026-08-03)

- **The PPR flags are gone** · `experimental.ppr` no longer exists and partial prerendering is part of `cacheComponents: true` · since 16.3 · checked 12-08-2026 · https://nextjs.org/blog
- **`cacheComponents: true` replaced `dynamicIO`** · move any `dynamicIO` config onto `cacheComponents` · since 16.3 · checked 12-08-2026 · https://nextjs.org/blog
- **`middleware.ts` is replaced by `proxy.ts` running on Node** · request interception now has full fs, crypto and native package access · since 16.3 · checked 12-08-2026 · https://nextjs.org/docs
- **Node middleware does not work on OpenNext Cloudflare** · as of 2026-08 opennextjs-cloudflare issues 962 and 1277 and workers-sdk issues 13755 and 13937 are open, so do not design a Cloudflare-hosted feature around `proxy.ts` and re-check the trackers before assuming it shipped · since — · checked 12-08-2026 · https://opennext.js.org/cloudflare
- **Turbopack works on the OpenNext Cloudflare adapter** · the old breakage is fixed, so re-verify only on pins older than adapter v1.15.0 · since v1.15.0 · checked 12-08-2026 · https://opennext.js.org/cloudflare
- **The Next.js Adapter API is stable** · Vercel's adapter and Cloudflare's OpenNext adapter share the same public contract · since 16.2 · checked 12-08-2026 · https://nextjs.org/docs/app/guides/deploying-to-platforms
- **Cloudflare's adapter still trails on the newest features** · check the deployment feature matrix per feature rather than assuming parity · since 16.2 · checked 12-08-2026 · https://nextjs.org/docs/app/guides/deploying-to-platforms

## Cloudflare Workers hard limits

- **Worker memory is 128MB per isolate and cannot be raised** · heavy transforms such as image processing and big parses belong in a container or worker tier, not a Worker · since — · checked 12-08-2026 · https://developers.cloudflare.com/workers/platform/limits
- **Worker CPU time is 30s by default and 5 minutes at most** · the ceiling is configurable but hard, so longer work belongs off the Worker · since — · checked 12-08-2026 · https://developers.cloudflare.com/workers/platform/limits
- **A paid Worker makes at most 1000 subrequests per request** · fan-out above that needs batching or a queue · since — · checked 12-08-2026 · https://developers.cloudflare.com/workers/platform/limits
- **The Workers Logs free tier is 200k events per day with 3-day retention** · budget for the paid tier wherever longer retention matters · since — · checked 12-08-2026 · https://developers.cloudflare.com/workers/platform/limits
- **Automatic tracing starts billing on 2026-10-01** · price it in or turn tracing off before that date · since — · checked 12-08-2026 · https://developers.cloudflare.com/workers/platform/limits
- **OTLP export needs Workers Paid** · a free-plan Worker cannot ship traces to an external collector · since — · checked 12-08-2026 · https://developers.cloudflare.com/workers/platform/limits

## Better Auth (1.7.2, 2026-08-29)

- **Better Auth 1.7 is stable** · 1.7.0 shipped 2026-08-18 and 1.7.2 of 2026-08-26 is npm latest, so the former 1.6.x hold is retired and 1.7.x is adopted through the official migration steps · since 1.7.0 · checked 29-08-2026 · https://github.com/better-auth/better-auth/releases
- **Accounts are rekeyed on issuer plus accountId** · the 1.7.0 migration backfills them, so run it rather than writing your own · since 1.7.0 · checked 29-08-2026 · https://github.com/better-auth/better-auth/releases/tag/v1.7.0
- **`validAudiences` became `resources` plus `oauthClientResource`** · rename the option when moving to 1.7.0 · since 1.7.0 · checked 29-08-2026 · https://github.com/better-auth/better-auth/releases/tag/v1.7.0
- **`experimental.joins` became `advanced.database.joins`** · move the key when moving to 1.7.0 · since 1.7.0 · checked 29-08-2026 · https://github.com/better-auth/better-auth/releases/tag/v1.7.0
- **Generic OAuth is rewritten on OAuth 2.1 defaults** · re-read any generic OAuth provider config against 1.7.0 before upgrading · since 1.7.0 · checked 29-08-2026 · https://github.com/better-auth/better-auth/releases/tag/v1.7.0
- **The MCP plugin lives in `@better-auth/mcp`** · it needs `@better-auth/cimd` and the `jwt()` plugin alongside it · since 1.7.0 · checked 29-08-2026 · https://github.com/better-auth/better-auth/releases/tag/v1.7.0
- **The MCP plugin renamed its handlers** · `withMcpAuth` is now `requireMcpAuth` and `mcpHandler` is now `createMcpProtectedRequestHandler` · since 1.7.0 · checked 29-08-2026 · https://github.com/better-auth/better-auth/releases/tag/v1.7.0
- **MCP plugin options are flat** · there is no `oidcConfig` nesting any more · since 1.7.0 · checked 29-08-2026 · https://github.com/better-auth/better-auth/releases/tag/v1.7.0
- **SAML IdP-initiated sign-in is off by default** · `saml.allowIdpInitiated` defaults to false, so opt back in explicitly only where the IdP flow is required · since 1.7.0 · checked 29-08-2026 · https://github.com/better-auth/better-auth/releases/tag/v1.7.0
- **The organizations plugin models teams, invitations and custom RBAC end to end** · `teams` with `enabled: true`, `inviteMember` with `teamId` and `createAccessControl` cover it, unchanged in 1.7 · since — · checked 29-08-2026 · https://better-auth.com/docs
- **SCIM is decoupled from the organizations plugin** · irrelevant unless SCIM is used · since 1.7.0 · checked 29-08-2026 · https://better-auth.com/docs
- **The apiKey plugin is the standalone `@better-auth/api-key` package** · import from `@better-auth/api-key` and not from `better-auth/plugins`, because core's exports no longer carry it, and it moves in lockstep at 1.7.2 · since 1.7.0 · checked 29-08-2026 · https://better-auth.com/docs/plugins/api-key
- **The apiKey plugin is the default for new projects** · the flagship platform's native implementation is a recorded project decision, not the house default · since — · checked 29-08-2026 · https://better-auth.com/docs/plugins/api-key
- **The `bearer` plugin stays in core** · it covers token session transport, which is the mobile and Flutter mechanism · since — · checked 29-08-2026 · https://better-auth.com/docs
- **`twoFactor` supports `allowPasswordless: true`** · turn it on for users without password accounts, such as passkey, OAuth and magic-link signups · since — · checked 29-08-2026 · https://better-auth.com/docs
- **`enableTwoFactor` takes and returns a discriminated `method`** · the values are `"otp"` and `"totp"`, default totp, so pass `method` as `"otp"` for OTP enrollment · since 1.7.0 · checked 29-08-2026 · https://better-auth.com/docs

## Claude API

- **Thinking blocks bind to their conversation prefix on Claude Fable 5.1** · replaying one after the system prompt, tools or an earlier message changed returns a 400 for accounts created on or after 31-08-2026, and for everyone on future models, so keep product agent loops append-only · since Fable 5.1 · checked 03-09-2026 · https://platform.claude.com/docs/en/build-with-claude/prompt-engineering
- **Assistant prefill on the last turn returns a 400** · use structured outputs instead of prefilling · since Claude 4.6 · checked 03-09-2026 · https://platform.claude.com/docs/en/build-with-claude/prompt-engineering

## EVE

- **EVE is Vercel's durable-agent framework** · `eve` on npm, github.com/vercel/eve; filesystem-first agents where every session is a durable, resumable workflow · since — · checked 29-08-2026 · https://vercel.com/docs/eve
- **EVE is still beta and pre-GA** · v0.47.3 landed 2026-08-28 and it ships several releases a day, so pin behavior rather than minor versions · since 0.47.3 · checked 29-08-2026 · https://vercel.com/docs/eve

## Workflow world-postgres

- **Self-hosted EVE durability needs a long-lived worker process** · `@workflow/world-postgres`, stable at 4.3.x, is documented as not compatible with serverless platforms · since 4.3 · checked 29-08-2026 · https://workflow-sdk.dev/worlds/postgres
- **`@workflow/world-postgres` has a 5.0.0-beta channel** · do not pin it without a documented reason · since 5.0.0-beta · checked 29-08-2026 · https://workflow-sdk.dev/worlds/postgres
- **`@workflow/world-postgres` runs on graphile-worker internally** · it is not pg-boss and does not replace it · since — · checked 29-08-2026 · https://workflow-sdk.dev/worlds/postgres

## pg-boss

- **pg-boss is at 12.x** · Postgres-native through `SKIP LOCKED` with no Redis, the right default for simple background jobs and cron on this stack; BullMQ only when a genuinely complex job graph of flows, dependencies or rate-limited pipelines demands Redis · since 12.0 · checked 12-08-2026 · https://www.npmjs.com/package/pg-boss

## Trigger.dev

- **trigger.dev v4 is Apache-2.0 and self-hostable free with unlimited runs** · the credible escape hatch when a job needs multi-hour runtimes off-platform · since v4 · checked 12-08-2026 · https://trigger.dev

## PlanetScale

- **PlanetScale Postgres is built on Neki, not Vitess** · it is a newer product, so do not transfer Vitess or MySQL assumptions onto it · since GA 2025-09 · checked 12-08-2026 · https://planetscale.com/pricing
- **PlanetScale has no free tier** · the free Hobby plan died in April 2024, so even a prototype needs a paid SKU · since — · checked 12-08-2026 · https://planetscale.com/pricing
- **PlanetScale Postgres pricing is SKU-based from $5/mo** · PS-5 non-HA is $5/mo and HA runs about $15-50/mo; the $39/mo figures seen elsewhere are the Vitess and MySQL PS-10 tier, a different product · since — · checked 12-08-2026 · https://planetscale.com/pricing

## Flutter

- **Flutter's default renderer is Impeller on iOS, Android and macOS** · guidance that says to disable Impeller on Android is stale · since — · checked 12-08-2026 · https://docs.flutter.dev

## Coolify

- **Coolify needs about 2GB RAM for its own control plane** · size Hetzner VMs accordingly, with CX22 at 4GB the floor for Coolify plus one small app · since — · checked 12-08-2026 · https://coolify.io
- **Coolify requires active patching** · two critical-CVE waves hit in 2026 alone, in January at beta.445 and beta.451 and in June and July with CVE-2026-34047, 34049 and 34050 fixed in beta.471, a recurring pattern rather than a closed incident · since — · checked 12-08-2026 · https://coolify.io
- **Coolify costs about 30 minutes a month of real maintenance** · plan for it; self-hosting here is not zero-ops · since — · checked 12-08-2026 · https://coolify.io

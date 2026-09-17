# The watchlist

Every topic whose facts this repo pins, the file and section that holds them, and the official pages a sweep reads. **A row names a section, not a file** — a facts file holds several topics, and a sweep reads one topic at a time. The topic must match the opening words of a `## ` heading in that file.

`scripts/facts-scan.mjs` parses this table, so the shape matters: three cells, the file path relative to the repo root, and at least one `https://` link in the third cell.

A topic belongs here when a wrong answer changes a decision — a version floor, a price, a limit, a flag that moved. A topic nobody decides anything on does not belong here, however interesting it is.

| Topic | Facts file | Official pages |
|---|---|---|
| Cloudflare | `skills/dev/dev-architect/references/pinned-facts.md` | https://developers.cloudflare.com/changelog/ · https://developers.cloudflare.com/r2/pricing/ |
| Cloudflare Workers hard limits | `skills/dev/dev-architect/references/pinned-facts.md` | https://developers.cloudflare.com/workers/platform/limits/ |
| Next.js | `skills/dev/dev-architect/references/pinned-facts.md` | https://nextjs.org/blog · https://nextjs.org/docs |
| Better Auth | `skills/dev/dev-architect/references/pinned-facts.md` | https://www.better-auth.com/docs/introduction · https://github.com/better-auth/better-auth/releases |
| Claude API | `skills/dev/dev-architect/references/pinned-facts.md` | https://docs.claude.com/en/docs/about-claude/models/overview · https://docs.claude.com/en/docs/about-claude/pricing |
| Agents & jobs | `skills/dev/dev-architect/references/pinned-facts.md` | https://vercel.com/docs · https://github.com/timgit/pg-boss/releases · https://trigger.dev/docs |
| Databases & mobile | `skills/dev/dev-architect/references/pinned-facts.md` | https://planetscale.com/pricing · https://docs.flutter.dev |
| Self-hosting | `skills/dev/dev-architect/references/pinned-facts.md` | https://coolify.io/docs · https://github.com/coollabsio/coolify/releases |
| Claude Code | `skills/dev/dev-setup/references/harness-facts.md` | https://code.claude.com/docs/en/overview · https://code.claude.com/docs/en/hooks · https://code.claude.com/docs/en/skills |
| Codex | `skills/dev/dev-setup/references/harness-facts.md` | https://learn.chatgpt.com/docs · https://learn.chatgpt.com/docs/config-file/config-reference |
| GitHub CLI | `skills/dev/dev-setup/references/harness-facts.md` | https://github.com/cli/cli/releases |

## The fact line

One fact, one line, five fields, in this order:

```markdown
- **<capability>** · <how> · since <version> · checked <DD-MM-YYYY> · <https official link>
```

- **capability** — what is true, in a few words. Bold, no trailing period.
- **how** — what to do or avoid because of it. The numbers, flag names, config keys and limits live here; they are the reason the line exists.
- **since** — the version or release date the fact became true. `since —` where the source gives none.
- **checked** — the date this line was last read against its link, DD-MM-YYYY. It moves only when someone actually read the page.
- **link** — the vendor's own page, last on the line. A blog post is a source; a forum answer is not.

A bullet carrying three separable facts is three lines. A fact with no link is not a fact yet — read the vendor's page or leave it out.

## The sweep window

60 days. Past that, a fact is **due**: re-read it against its link before anything leans on it. The window is per line, not per file, so a page that changed yesterday and a page that has not moved in a year age at the same rate and cost the same to check — which is the point: the age says how long ago someone looked, never how likely it is to have changed.

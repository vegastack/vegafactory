# Releasing 0.20.0

The operator's steps, in order. Nothing here was run by the P11 session: the repository is still at `0.19.9`, no version commit, no tag, no publish. Delete this file once 0.20.0 is out.

Before starting: every phase of the epic is merged, `main` is green, and `.changeset/` holds one entry per phase.

1. **Version PR.** On `chore/release-0.20.0`, from a clean `main`:

   ```sh
   bunx changeset version && bun install
   ```

   Check that `packages/cli/package.json` reads `0.20.0` and `packages/cli/CHANGELOG.md` has its `## 0.20.0` section, then open the PR.

2. **Merge queue.** Queue that PR and let it merge — it belongs to no issue, so the guard asks and this is the answer. Then `git switch main && git pull`.

3. **Tag.** Record the word on the release's issue, then tag:

   ```sh
   vegafactory issue ack 223 --stage ship --by kmanojkumar --quote "ship it"
   vegafactory ship release 223
   ```

   `ship release` re-reads that word, checks `0.20.0` against its changelog entry, requires `main` checked out, clean and level with origin, and then creates and pushes `v0.20.0`. It refuses (exit 2) and writes nothing if any of that does not hold — the block text says which. The `vegafactory` on your PATH is still the released `0.19.9`, which has no `release` verb; run it from this checkout as `bun packages/cli/src/index.ts ship release 223` until you have installed 0.20.0, or `npm install -g @vegastack/vegafactory@0.20.0` afterwards.

4. **Watch the workflow.** The tag triggers Release: it packs, smokes the tarball, publishes with provenance, waits for the registry, smokes the published version and writes the GitHub release. Then confirm:

   ```sh
   npm view @vegastack/vegafactory version
   npx @vegastack/vegafactory@latest skills list
   ```

5. **Deprecate the dashboard package** 0.20.0 retired: `npm deprecate @vegastack/vegafactory-dashboard "removed in 0.20.0"`.

If the release fails at any step, it is never re-run: fix forward with a new patch version.

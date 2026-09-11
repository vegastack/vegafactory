import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The decision-nudge hook and the changelog-entry guard get written verbatim into
// consumer projects. The nudge is now a packaged asset, so it is run directly; the
// changelog guard still ships embedded in a reference doc, so its fenced block is
// extracted from the doc itself and a doc edit that breaks it fails here instead of
// in a user's repo.

const skillRoot = join(import.meta.dir, "..");
const harnessFacts = readFileSync(join(skillRoot, "references", "harness-facts.md"), "utf8");
const playbooks = readFileSync(join(skillRoot, "references", "stack-playbooks.md"), "utf8");

function fencedBlocks(markdown: string, lang: string): string[] {
  const blocks: string[] = [];
  const re = new RegExp("```" + lang + "\\n([\\s\\S]*?)```", "g");
  for (let m = re.exec(markdown); m; m = re.exec(markdown)) blocks.push(m[1]);
  return blocks;
}

describe("decision-nudge hook asset (assets/hooks/decision-nudge.mjs)", () => {
  const script = join(skillRoot, "assets", "hooks", "decision-nudge.mjs");

  test("harness-facts points at the asset rather than carrying a shell copy of it", () => {
    expect(harnessFacts).toContain("assets/hooks/decision-nudge.mjs");
    expect(fencedBlocks(harnessFacts, "sh").find((b) => b.includes("stop_hook_active"))).toBeUndefined();
  });

  const dir = mkdtempSync(join(tmpdir(), "vsk-nudge-test-"));
  const run = (input: string) =>
    Bun.spawnSync(["node", script, "--harness", "claude"], {
      stdin: new TextEncoder().encode(input),
      env: { ...process.env, TMPDIR: dir },
    });
  const sid = `t${Date.now()}`;

  test("delegates directional Stop handling silently", () => {
    const r = run(
      `{"session_id":"${sid}","stop_hook_active":false,"last_assistant_message":"We decided to use Postgres instead of SQLite."}`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toBe("");
  });

  test("stays silent the second time in the same session", () => {
    const r = run(
      `{"session_id":"${sid}","stop_hook_active":false,"last_assistant_message":"We decided again."}`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toBe("");
  });

  for (const [name, input] of [
    ["stop_hook_active true", `{"session_id":"${sid}2","stop_hook_active":true,"last_assistant_message":"decided things"}`],
    ["no directional keyword", `{"session_id":"${sid}3","stop_hook_active":false,"last_assistant_message":"Fixed the typo."}`],
    ["null last message", `{"session_id":"${sid}4","stop_hook_active":false,"last_assistant_message":null}`],
  ] as const) {
    test(`stays silent on ${name}`, () => {
      const r = run(input);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.toString()).toBe("");
    });
  }
});

describe("changelog-entry guard snippet (stack-playbooks.md)", () => {
  const block = fencedBlocks(playbooks, "sh").find((b) => b.includes("no changelog entry"));
  test("the snippet exists in the doc", () => {
    expect(block).toBeDefined();
  });
  if (!block) return;

  const dir = mkdtempSync(join(tmpdir(), "vsk-guard-test-"));
  const changesetsLog = join(dir, "changesets.md");
  writeFileSync(changesetsLog, "# log\n\n## 1.2.3\n\n- a change\n\n## 1.2.2\n\n- older\n");
  const keepLog = join(dir, "keep.md");
  writeFileSync(keepLog, "# log\n\n## [1.2.3] - 2026-01-01\n\n- a change\n\n## [1.2.2]\n\n- older\n");

  const run = (version: string, changelog: string) =>
    Bun.spawnSync(["sh", "-c", block], {
      env: { ...process.env, VERSION: version, CHANGELOG: changelog },
    });

  test("passes on a changesets-style heading", () => {
    expect(run("1.2.3", changesetsLog).exitCode).toBe(0);
  });
  test("passes on a keep-a-changelog heading", () => {
    expect(run("1.2.3", keepLog).exitCode).toBe(0);
  });
  test("fails when the version has no entry", () => {
    const r = run("9.9.9", changesetsLog);
    expect(r.exitCode).toBe(1);
    expect(r.stdout.toString() + r.stderr.toString()).toContain("no changelog entry");
  });
  test("fails when the section exists but is empty", () => {
    const emptyLog = join(dir, "empty.md");
    writeFileSync(emptyLog, "# log\n\n## 2.0.0\n\n## 1.9.9\n\n- older\n");
    expect(run("2.0.0", emptyLog).exitCode).toBe(1);
  });
  test("link-reference block does not count as entry content", () => {
    const linkLog = join(dir, "links.md");
    writeFileSync(linkLog, "# log\n\n## [3.0.0]\n\n[3.0.0]: https://example.com/v3\n[2.9.9]: https://example.com/v2\n");
    expect(run("3.0.0", linkLog).exitCode).toBe(1);
  });
});

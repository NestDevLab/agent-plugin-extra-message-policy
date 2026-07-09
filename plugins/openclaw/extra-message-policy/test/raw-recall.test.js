import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildRawRecallGuidance, createRawContextSearchTool, extractTerms, listRawRecallFiles, normalizeRawRecallConfig, searchRawContext, searchRawRecall, shouldSearchRawRecall } from "../raw-recall.js";

test("raw recall triggers on project-status phrasing and returns matching JSONL excerpts", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "extra-message-policy-"));
  try {
    const now = new Date();
    const dayDir = path.join(
      tmp,
      String(now.getUTCFullYear()),
      String(now.getUTCMonth() + 1).padStart(2, "0"),
      String(now.getUTCDate()).padStart(2, "0")
    );
    await mkdir(dayDir, { recursive: true });
    await writeFile(path.join(dayDir, "channel_123.jsonl"), `${JSON.stringify({
      observedAt: now.toISOString(),
      conversationId: "channel:123",
      content: "Project Phoenix deploy is blocked by auth refresh issues",
      metadata: { channelName: "#ops", senderName: "Alice" }
    })}\n`, "utf8");

    const cfg = normalizeRawRecallConfig({ rootPath: tmp, maxDays: 30, maxMatches: 5 }, { path: tmp });
    assert.equal(shouldSearchRawRecall("Where are we on project Phoenix?", cfg), true);
    const result = await searchRawRecall("Where are we on project Phoenix?", cfg, {});
    assert.match(result, /Project Phoenix deploy/);
    assert.match(result, /Relevant passive raw-recall excerpts/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("raw recall guidance points the agent at the archive and tool", () => {
  const cfg = normalizeRawRecallConfig({ rootPath: "memory/discord/raw" }, { path: "memory/discord/raw" });
  assert.match(buildRawRecallGuidance(cfg), /Passive message raw ingest/);
  assert.match(buildRawRecallGuidance(cfg), /search_raw_context/);
  assert.match(buildRawRecallGuidance(cfg), /memory\/discord\/raw/);
});

test("raw context tool searches all available shards by default", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "extra-message-policy-"));
  try {
    const oldDir = path.join(tmp, "2025", "12", "01");
    const newDir = path.join(tmp, "2026", "05", "08");
    await mkdir(oldDir, { recursive: true });
    await mkdir(newDir, { recursive: true });
    await writeFile(path.join(oldDir, "channel_old.jsonl"), `${JSON.stringify({
      observedAt: "2025-12-01T10:00:00.000Z",
      conversationId: "channel:old",
      content: "Long Horizon decision: keep raw recall zero embedding",
      metadata: { channelName: "#archive", senderName: "Dana" }
    })}\n`, "utf8");
    await writeFile(path.join(newDir, "channel_new.jsonl"), `${JSON.stringify({
      observedAt: "2026-05-08T10:00:00.000Z",
      conversationId: "channel:new",
      content: "Unrelated recent deployment note",
      metadata: { channelName: "#ops", senderName: "Alex" }
    })}\n`, "utf8");

    const cfg = normalizeRawRecallConfig({ rootPath: tmp }, { path: tmp });
    const result = await searchRawContext({ query: "Long Horizon raw recall" }, cfg, {});
    assert.equal(result.filesSearched, 2);
    assert.equal(result.matches.length, 1);
    assert.match(result.text, /Long Horizon decision/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("raw context tool can be executed as an agent tool", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "extra-message-policy-"));
  try {
    const dayDir = path.join(tmp, "2026", "05", "08");
    await mkdir(dayDir, { recursive: true });
    await writeFile(path.join(dayDir, "channel_123.jsonl"), `${JSON.stringify({
      observedAt: "2026-05-08T10:00:00.000Z",
      conversationId: "channel:123",
      content: "Autonomous recall tool should find this operational context",
      metadata: { channelName: "#ops", senderName: "Alice" }
    })}\n`, "utf8");

    const cfg = normalizeRawRecallConfig({ rootPath: tmp }, { path: tmp });
    const tool = createRawContextSearchTool(cfg, {});
    assert.equal(tool.name, "search_raw_context");
    const result = await tool.execute("tool-call-1", { query: "autonomous recall operational" });
    assert.match(result.content[0].text, /Autonomous recall tool/);
    assert.equal(result.details.matches.length, 1);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("raw recall disabled, guidance modes, triggers, and empty queries", async () => {
  const disabled = normalizeRawRecallConfig({ enabled: false }, {});
  assert.equal(buildRawRecallGuidance(disabled), "");
  assert.equal(shouldSearchRawRecall("project status", disabled), false);
  assert.equal(createRawContextSearchTool(disabled, {}), null);
  assert.deepEqual(await searchRawContext({ query: "anything" }, disabled, {}), {
    text: "Raw context recall is disabled.",
    matches: [],
    filesSearched: 0,
    truncated: false
  });

  const noTool = normalizeRawRecallConfig({ rootPath: "archive", tool: { enabled: false } }, {});
  assert.match(buildRawRecallGuidance(noTool), /inspect the relevant JSONL shards/);
  assert.equal(createRawContextSearchTool(noTool, {}), null);

  const anyTerms = normalizeRawRecallConfig({ searchOnTriggerOnly: false }, {});
  assert.equal(shouldSearchRawRecall("alpha beta", anyTerms), true);
  assert.equal(shouldSearchRawRecall("alpha", anyTerms), false);
  assert.deepEqual(extractTerms("the project alpha-beta _gamma_"), ["alpha-beta", "gamma"]);

  const empty = await searchRawContext({ query: "the and for" }, normalizeRawRecallConfig({ rootPath: "missing" }, {}), {});
  assert.equal(empty.text, "No searchable terms were found in the query.");
});

test("raw recall file listing covers direct files, legacy files, walking, caps, bad lines, filters, sorting, and truncation", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "extra-message-policy-raw-"));
  try {
    await writeFile(path.join(tmp, "messages.jsonl"), `${JSON.stringify({
      observedAt: "2026-05-30T08:00:00.000Z",
      conversationId: "channel:legacy",
      channelId: "legacy",
      senderId: "user-a",
      content: "Legacy Falcon note",
      metadata: { channelName: "#legacy", senderName: "User A" }
    })}\n`, "utf8");

    const dayDir = path.join(tmp, "2026", "05", "30");
    await mkdir(dayDir, { recursive: true });
    await writeFile(path.join(dayDir, "channel.jsonl"), [
      "{bad-json",
      JSON.stringify({
        observedAt: "2026-05-30T10:00:00.000Z",
        conversationId: "channel:target",
        channelId: "target",
        senderId: "user-b",
        content: `Falcon target ${"detail ".repeat(200)}`,
        metadata: { channelName: "#target", senderName: "User B" }
      }),
      JSON.stringify({
        timestamp: Date.UTC(2026, 4, 30, 9),
        conversationId: "channel:target",
        channelId: "target",
        senderId: "user-c",
        content: "Falcon older target",
        metadata: {}
      }),
      JSON.stringify({
        observedAt: "2026-05-30T11:00:00.000Z",
        conversationId: "channel:other",
        channelId: "other",
        senderId: "user-b",
        content: "Falcon filtered out",
        metadata: {}
      })
    ].join("\n"), "utf8");

    const files = await listRawRecallFiles(tmp, 1, new Date("2026-05-30T12:00:00.000Z"), { maxFiles: 2 });
    assert.equal(files.length, 2);

    const direct = path.join(tmp, "direct.jsonl");
    await writeFile(direct, `${JSON.stringify({ content: "Direct Falcon file", conversationId: "direct" })}\n`, "utf8");
    assert.deepEqual(await listRawRecallFiles(direct, 30, new Date("2026-05-30T12:00:00.000Z")), [direct]);

    const result = await searchRawContext({
      query: "Falcon target",
      conversationId: "channel:target",
      maxMatches: 2,
      maxContextChars: 500
    }, normalizeRawRecallConfig({ rootPath: tmp }, {}), {
      sessionKey: "agent:main:discord:channel:target"
    });

    assert.equal(result.matches.length, 2);
    assert.equal(result.matches[0].senderId, "user-b");
    assert.equal(result.totalMatches, 2);
    assert.equal(result.truncated, true);
    assert.match(result.text, /raw context search truncated/);

    const none = await searchRawContext({ query: "missingterm" }, normalizeRawRecallConfig({ rootPath: tmp }, {}), {});
    assert.equal(none.text, "No raw context matches found.");
    assert.equal(await searchRawRecall("missingterm", normalizeRawRecallConfig({ rootPath: tmp, searchOnTriggerOnly: false }, {}), {}), "");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

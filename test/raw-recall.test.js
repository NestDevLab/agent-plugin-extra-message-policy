import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildRawRecallGuidance, createRawContextSearchTool, normalizeRawRecallConfig, searchRawContext, searchRawRecall, shouldSearchRawRecall } from "../raw-recall.js";

test("raw recall triggers on project-status phrasing and returns matching JSONL excerpts", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "extra-message-policy-"));
  try {
    const dayDir = path.join(tmp, "2026", "05", "08");
    await mkdir(dayDir, { recursive: true });
    await writeFile(path.join(dayDir, "channel_123.jsonl"), `${JSON.stringify({
      observedAt: "2026-05-08T10:00:00.000Z",
      conversationId: "channel:123",
      content: "Project Phoenix deploy is blocked by auth refresh issues",
      metadata: { channelName: "#ops", senderName: "Alice" }
    })}\n`, "utf8");

    const cfg = normalizeRawRecallConfig({ rootPath: tmp, maxDays: 1, maxMatches: 5 }, { path: tmp });
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

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildRawRecallGuidance, normalizeRawRecallConfig, searchRawRecall, shouldSearchRawRecall } from "../raw-recall.js";

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
    assert.equal(shouldSearchRawRecall("A che punto siamo col progetto Phoenix?", cfg), true);
    const result = await searchRawRecall("A che punto siamo col progetto Phoenix?", cfg, {});
    assert.match(result, /Project Phoenix deploy/);
    assert.match(result, /Relevant passive Discord raw-recall excerpts/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("raw recall guidance points the agent at the archive", () => {
  const cfg = normalizeRawRecallConfig({ rootPath: "memory/discord/raw" }, { path: "memory/discord/raw" });
  assert.match(buildRawRecallGuidance(cfg), /Passive Discord raw ingest/);
  assert.match(buildRawRecallGuidance(cfg), /memory\/discord\/raw/);
});

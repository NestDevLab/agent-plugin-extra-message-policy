import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyRetention, planRetention } from "../retention.js";

const NOW = Date.UTC(2026, 9, 8, 12);
const CUTOFF = NOW - 30 * 86400000;

function row(accountId, senderId, timestamp, content) {
  return JSON.stringify({ accountId, senderId, timestamp, content });
}

test("retention plan and apply preserve mixed accounts and cutoff boundary", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "retention-test-"));
  const file = path.join(root, "mixed.jsonl");
  const lines = [
    row("default", "111111111111111111", CUTOFF - 1, "expired"),
    row("default", "111111111111111111", CUTOFF, "boundary"),
    row("other", "111111111111111111", CUTOFF - 1, "other account"),
    row("default", "222222222222222222", NOW, "opted out"),
    row("default", "333333333333333333", NOW, "current")
  ];
  await writeFile(file, `${lines.join("\n")}\n`);
  const manifest = await planRetention({
    root, accounts: ["default"], senderIds: ["222222222222222222"], now: NOW
  });
  assert.deepEqual([manifest.files[0].expired, manifest.files[0].optedOut, manifest.files[0].retained], [1, 1, 3]);
  await assert.rejects(applyRetention(manifest), /writer_quiescence_required/);
  const result = await applyRetention(manifest, { quiesced: true });
  assert.deepEqual(result, { changedFiles: 1, removedRecords: 2 });
  assert.deepEqual((await readFile(file, "utf8")).trim().split("\n"), [lines[1], lines[2], lines[4]]);
});

test("malformed and unknown records stop the complete plan", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "retention-bad-"));
  await writeFile(path.join(root, "bad.jsonl"), `${row("default", "111111111111111111", NOW, "good")}\n{bad}\n`);
  await assert.rejects(planRetention({ root, accounts: ["default"], now: NOW }), /malformed_json/);
});

test("apply refuses a changed archive and leaves it intact", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "retention-race-"));
  const file = path.join(root, "one.jsonl");
  await writeFile(file, `${row("default", "111111111111111111", CUTOFF - 1, "old")}\n`);
  const manifest = await planRetention({ root, accounts: ["default"], now: NOW });
  const changed = `${row("default", "111111111111111111", NOW, "new")}\n`;
  await writeFile(file, changed);
  await assert.rejects(applyRetention(manifest, { quiesced: true }), /archive_changed/);
  assert.equal(await readFile(file, "utf8"), changed);
});


test("age-only retention accepts real-schema records with no sender ID", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "retention-no-sender-"));
  const file = path.join(root, "mixed.jsonl");
  const old = JSON.stringify({ accountId: "default", timestamp: CUTOFF - 1, content: "expired" });
  const current = JSON.stringify({ accountId: "default", timestamp: CUTOFF, content: "current" });
  await writeFile(file, `${old}\n${current}\n`);
  const manifest = await planRetention({ root, accounts: ["default"], now: NOW });
  assert.deepEqual([manifest.files[0].expired, manifest.files[0].retained], [1, 1]);
  await assert.rejects(
    planRetention({ root, accounts: ["default"], senderIds: ["222222222222222222"], now: NOW }),
    /missing_sender/
  );
  assert.deepEqual(await applyRetention(manifest, { quiesced: true }), { changedFiles: 1, removedRecords: 1 });
  assert.equal(await readFile(file, "utf8"), `${current}\n`);
});

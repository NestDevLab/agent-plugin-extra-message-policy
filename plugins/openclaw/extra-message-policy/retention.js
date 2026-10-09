import { createHash } from "node:crypto";
import { open, readdir, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";

const DAY_MS = 24 * 60 * 60 * 1000;

function fail(reason) {
  throw new Error(reason);
}

function timestampMs(record) {
  const value = record.timestamp ?? record.observedAt;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string" && value.trim()) {
    const result = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
    if (Number.isFinite(result) && result > 0) return result;
  }
  return fail("missing_or_invalid_timestamp");
}

function recordAccount(record) {
  const value = record.accountId;
  return typeof value === "string" && value.trim() ? value.trim() : fail("missing_account");
}

function recordSender(record) {
  const value = record.senderId;
  return typeof value === "string" && value.trim() ? value.trim() : fail("missing_sender");
}

function linesOf(buffer) {
  const text = buffer.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(buffer)) fail("invalid_utf8");
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function classify(buffer, cutoffMs, accounts, senderIds) {
  let retained = 0;
  let expired = 0;
  let optedOut = 0;
  const keep = [];
  for (const line of linesOf(buffer)) {
    if (!line) fail("blank_line");
    let record;
    try { record = JSON.parse(line); } catch { fail("malformed_json"); }
    if (!record || typeof record !== "object" || Array.isArray(record)) fail("invalid_record");
    const account = recordAccount(record);
    const time = timestampMs(record);
    const sender = accounts.has(account) && senderIds.size ? recordSender(record) : "";
    const remove = accounts.has(account) && (time < cutoffMs || senderIds.has(sender));
    if (remove) {
      if (senderIds.has(sender)) optedOut += 1;
      else expired += 1;
    } else {
      retained += 1;
      keep.push(line);
    }
  }
  return { retained, expired, optedOut, keep: Buffer.from(keep.length ? `${keep.join("\n")}\n` : "", "utf8") };
}

async function walk(root, base = root) {
  const result = [];
  for (const entry of await readdir(base, { withFileTypes: true })) {
    const full = path.join(base, entry.name);
    if (entry.isSymbolicLink()) fail("symlink_in_archive");
    if (entry.isDirectory()) result.push(...await walk(root, full));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) result.push(full);
  }
  return result.sort();
}

function digest(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export async function planRetention({ root, accounts, senderIds = [], days = 30, now = Date.now() }) {
  if (!root || !path.isAbsolute(root)) fail("absolute_root_required");
  if (!Number.isInteger(days) || days < 1) fail("invalid_days");
  if (!Number.isFinite(now)) fail("invalid_now");
  const accountSet = new Set(accounts);
  if (!accountSet.size || [...accountSet].some((account) => typeof account !== "string" || !account)) fail("accounts_required");
  const senderSet = new Set(senderIds);
  const cutoffMs = now - days * DAY_MS;
  const files = [];
  for (const file of await walk(root)) {
    const before = await stat(file);
    if (!before.isFile() || before.nlink !== 1) fail("unsafe_file");
    const buffer = await readFile(file);
    const counts = classify(buffer, cutoffMs, accountSet, senderSet);
    files.push({
      path: path.relative(root, file),
      sha256: digest(buffer),
      bytes: buffer.length,
      mode: before.mode & 0o777,
      retained: counts.retained,
      expired: counts.expired,
      optedOut: counts.optedOut
    });
  }
  return { version: 1, root, cutoffMs, accounts: [...accountSet].sort(), senderIds: [...senderSet].sort(), files };
}

export async function applyRetention(manifest, { quiesced = false } = {}) {
  if (!quiesced) fail("writer_quiescence_required");
  if (manifest?.version !== 1 || !path.isAbsolute(manifest.root)) fail("invalid_manifest");
  const accounts = new Set(manifest.accounts);
  const senders = new Set(manifest.senderIds);
  if (!accounts.size || !Number.isFinite(manifest.cutoffMs)) fail("invalid_manifest");
  const observed = await walk(manifest.root);
  const expected = manifest.files.map((entry) => path.join(manifest.root, entry.path));
  if (observed.length !== expected.length || observed.some((file, i) => file !== expected[i])) fail("archive_changed");
  const prepared = [];
  for (const entry of manifest.files) {
    if (path.isAbsolute(entry.path) || entry.path.split(path.sep).includes("..")) fail("invalid_path");
    const file = path.join(manifest.root, entry.path);
    const info = await stat(file);
    if (!info.isFile() || info.nlink !== 1) fail("unsafe_file");
    const original = await readFile(file);
    if (original.length !== entry.bytes || digest(original) !== entry.sha256) fail("archive_changed");
    const counts = classify(original, manifest.cutoffMs, accounts, senders);
    if (counts.retained !== entry.retained || counts.expired !== entry.expired || counts.optedOut !== entry.optedOut) fail("manifest_mismatch");
    prepared.push({ file, original, output: counts.keep, mode: info.mode & 0o777 });
  }
  const lockPath = path.join(manifest.root, ".retention.lock");
  const lock = await open(lockPath, "wx", 0o600);
  let changedFiles = 0;
  try {
  for (const item of prepared) {
    if (item.output.equals(item.original)) continue;
    const temporary = `${item.file}.retention-${process.pid}.tmp`;
    let handle;
    try {
      handle = await open(temporary, "wx", item.mode & 0o600);
      await handle.writeFile(item.output);
      await handle.sync();
      await handle.close();
      handle = null;
      const current = await readFile(item.file);
      if (!current.equals(item.original)) fail("archive_changed_during_apply");
      await rename(temporary, item.file);
      const dir = await open(path.dirname(item.file), "r");
      try { await dir.sync(); } finally { await dir.close(); }
      changedFiles += 1;
    } finally {
      if (handle) await handle.close();
      await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
    }
  }
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
  return { changedFiles, removedRecords: manifest.files.reduce((n, item) => n + item.expired + item.optedOut, 0) };
}

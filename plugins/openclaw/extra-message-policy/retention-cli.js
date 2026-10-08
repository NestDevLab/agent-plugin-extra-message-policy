#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { applyRetention, planRetention } from "./retention.js";

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1];
}

try {
  if (process.argv.includes("--apply")) {
    if (!process.argv.includes("--quiesced") || !option("--manifest")) throw new Error("apply_requires_manifest_and_quiesced");
    const manifest = JSON.parse(await readFile(option("--manifest"), "utf8"));
    const result = await applyRetention(manifest, { quiesced: true });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    const root = option("--root");
    const accounts = process.argv.flatMap((part, index) => part === "--account" ? [process.argv[index + 1]] : []);
    const senderIds = process.argv.flatMap((part, index) => part === "--sender-id" ? [process.argv[index + 1]] : []);
    const days = option("--days") ? Number(option("--days")) : 30;
    const manifest = await planRetention({ root, accounts, senderIds, days });
    const output = option("--manifest");
    if (output) await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    process.stdout.write(`${JSON.stringify({
      files: manifest.files.length,
      expired: manifest.files.reduce((n, file) => n + file.expired, 0),
      optedOut: manifest.files.reduce((n, file) => n + file.optedOut, 0),
      retained: manifest.files.reduce((n, file) => n + file.retained, 0),
      cutoff: new Date(manifest.cutoffMs).toISOString(),
      manifest: output || null
    })}\n`);
  }
} catch (error) {
  process.stderr.write(`retention: ${error.message}\n`);
  process.exitCode = 1;
}

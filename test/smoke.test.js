import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const manifest = JSON.parse(await readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");

test("plugin metadata uses the neutral extra-message-policy name", () => {
  assert.equal(manifest.id, "extra-message-policy");
  assert.equal(pkg.name, "@nestdevlab/openclaw-plugin-extra-message-policy");
});

test("schema exposes response and ingest policy", () => {
  const policyRule = manifest.configSchema.definitions.policyRule.properties;
  assert.deepEqual(policyRule.ingestMode.enum, ["none", "passive", "all", "responseCandidates"]);
  assert.equal(policyRule.respond.type, "boolean");
  assert.deepEqual(manifest.configSchema.properties.jsonlSink.properties.shardBy.enum, ["none", "dayConversation"]);
});

test("README documents memory/context/monitoring ingest", () => {
  assert.match(readme, /Memory ingest/i);
  assert.match(readme, /context accumulation/i);
  assert.match(readme, /monitoring/i);
  assert.match(readme, /without changing OpenClaw core/i);
});

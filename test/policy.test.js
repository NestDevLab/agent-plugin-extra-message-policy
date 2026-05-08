import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConfig, resolvePolicy, shouldIngest, shouldSuppressResponse } from "../policy.js";

test("allowing rule by channel overrides default silent policy", () => {
  const cfg = normalizeConfig({
    defaultPolicy: { respond: false, ingestMode: "all" },
    policies: [
      { channelId: "allowed-channel", respond: true, ingestMode: "responseCandidates" }
    ]
  });

  assert.deepEqual(resolvePolicy(cfg, {}, { channelId: "allowed-channel" }), {
    respond: true,
    ingestMode: "responseCandidates",
    matched: "channelId:allowed-channel"
  });

  assert.deepEqual(resolvePolicy(cfg, {}, { channelId: "other-channel" }), {
    respond: false,
    ingestMode: "all",
    matched: "default"
  });
});

test("session rules support platform-wide policies", () => {
  const cfg = normalizeConfig({
    policies: [
      { sessionKeyIncludes: "telegram:", respond: false, ingestMode: "all" }
    ]
  });

  const policy = resolvePolicy(cfg, {}, { sessionKey: "agent:main:telegram:group:123" });
  assert.equal(policy.respond, false);
  assert.equal(policy.ingestMode, "all");
  assert.equal(shouldSuppressResponse(policy), true);
});

test("ingest modes map to hook sources", () => {
  assert.equal(shouldIngest({ ingestMode: "none" }, "message_received"), false);
  assert.equal(shouldIngest({ ingestMode: "all" }, "message_received"), true);
  assert.equal(shouldIngest({ ingestMode: "all" }, "before_dispatch"), true);
  assert.equal(shouldIngest({ ingestMode: "responseCandidates" }, "message_received"), false);
  assert.equal(shouldIngest({ ingestMode: "responseCandidates" }, "before_dispatch"), true);
});

test("DM sender rules allow authorized non-group responders", () => {
  const cfg = normalizeConfig({
    defaultPolicy: { respond: false, ingestMode: "all" },
    policies: [
      { isGroup: false, senderId: "YOUR_OPERATOR_USER_ID", respond: true, ingestMode: "all" }
    ]
  });

  assert.deepEqual(resolvePolicy(cfg, { isGroup: false, senderId: "YOUR_OPERATOR_USER_ID" }, { senderId: "YOUR_OPERATOR_USER_ID" }), {
    respond: true,
    ingestMode: "all",
    matched: "senderId:YOUR_OPERATOR_USER_ID,isGroup:false"
  });

  assert.deepEqual(resolvePolicy(cfg, { isGroup: true, senderId: "YOUR_OPERATOR_USER_ID" }, { senderId: "YOUR_OPERATOR_USER_ID" }), {
    respond: false,
    ingestMode: "all",
    matched: "default"
  });
});

test("invalid regex rules fail closed by not matching", () => {
  const cfg = normalizeConfig({
    defaultPolicy: { respond: true, ingestMode: "responseCandidates" },
    policies: [
      { sessionKeyRegex: "[", respond: false, ingestMode: "all" }
    ]
  });

  assert.deepEqual(resolvePolicy(cfg, {}, { sessionKey: "anything" }), {
    respond: true,
    ingestMode: "responseCandidates",
    matched: "default"
  });
});

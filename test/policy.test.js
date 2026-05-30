import assert from "node:assert/strict";
import test from "node:test";
import { describeRule, normalizeConfig, normalizeIngestMode, normalizePolicy, normalizePolicyRule, resolvePolicy, ruleMatches, shouldIngest, shouldSuppressResponse, wasMentioned } from "../policy.js";

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

test("guild rules support workspace-wide Discord policy", () => {
  const cfg = normalizeConfig({
    defaultPolicy: { respond: true, ingestMode: "all" },
    policies: [
      { guildId: "silent-guild", respond: false, ingestMode: "all" }
    ]
  });

  assert.deepEqual(resolvePolicy(cfg, {}, { guildId: "silent-guild", channelId: "any-channel" }), {
    respond: false,
    ingestMode: "all",
    matched: "guildId:silent-guild"
  });

  assert.deepEqual(resolvePolicy(cfg, {}, { guildId: "other-guild", channelId: "any-channel" }), {
    respond: true,
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

test("more specific channel policy wins over broader session policy regardless of order", () => {
  const cfg = normalizeConfig({
    policies: [
      { sessionKeyIncludes: "discord:channel:", respond: false, ingestMode: "all" },
      { channelId: "primary-channel", respond: true, ingestMode: "responseCandidates" }
    ]
  });

  assert.deepEqual(resolvePolicy(cfg, {}, {
    channelId: "primary-channel",
    sessionKey: "agent:main:discord:channel:primary-channel"
  }), {
    respond: true,
    ingestMode: "responseCandidates",
    matched: "channelId:primary-channel"
  });
});

test("channel policy wins over guild policy regardless of order", () => {
  const cfg = normalizeConfig({
    policies: [
      { guildId: "guild-1", respond: false, ingestMode: "all" },
      { guildId: "guild-1", channelId: "primary-channel", respond: true, ingestMode: "responseCandidates" }
    ]
  });

  assert.deepEqual(resolvePolicy(cfg, {}, {
    guildId: "guild-1",
    channelId: "primary-channel"
  }), {
    respond: true,
    ingestMode: "responseCandidates",
    matched: "channelId:primary-channel,guildId:guild-1"
  });
});

test("thread inherits parent channel policy unless thread has its own policy", () => {
  const cfg = normalizeConfig({
    defaultPolicy: { respond: false, ingestMode: "all" },
    policies: [
      { channelId: "parent-channel", respond: true, ingestMode: "responseCandidates" }
    ]
  });

  assert.deepEqual(resolvePolicy(cfg, {}, {
    channelId: "thread-channel",
    parentChannelId: "parent-channel",
    conversationId: "channel:thread-channel"
  }), {
    respond: true,
    ingestMode: "responseCandidates",
    matched: "channelId:parent-channel"
  });

  const overridden = normalizeConfig({
    defaultPolicy: { respond: false, ingestMode: "all" },
    policies: [
      { channelId: "parent-channel", respond: true, ingestMode: "responseCandidates" },
      { channelId: "thread-channel", respond: false, ingestMode: "all" }
    ]
  });

  assert.deepEqual(resolvePolicy(overridden, {}, {
    channelId: "thread-channel",
    parentChannelId: "parent-channel",
    conversationId: "channel:thread-channel"
  }), {
    respond: false,
    ingestMode: "all",
    matched: "channelId:thread-channel"
  });
});

test("Telegram chat aliases match channel and conversation policies", () => {
  const cfg = normalizeConfig({
    defaultPolicy: { respond: true, ingestMode: "all" },
    policies: [
      { channelId: "-100123", respond: false, ingestMode: "all" },
      { conversationId: "-100456", respond: false, ingestMode: "none" }
    ]
  });

  assert.deepEqual(resolvePolicy(cfg, { metadata: { chat_id: "-100123" } }, {
    sessionKey: "agent:main:telegram:group:-100123"
  }), {
    respond: false,
    ingestMode: "all",
    matched: "channelId:-100123"
  });

  assert.deepEqual(resolvePolicy(cfg, { chatId: "-100456" }, {
    platform: "telegram"
  }), {
    respond: false,
    ingestMode: "none",
    matched: "conversationId:-100456"
  });
});

test("conversation policy wins over channel policy regardless of order", () => {
  const cfg = normalizeConfig({
    policies: [
      { channelId: "primary-channel", respond: false, ingestMode: "all" },
      { conversationId: "thread-1", respond: true, ingestMode: "responseCandidates" }
    ]
  });

  assert.deepEqual(resolvePolicy(cfg, {}, {
    channelId: "primary-channel",
    conversationId: "thread-1"
  }), {
    respond: true,
    ingestMode: "responseCandidates",
    matched: "conversationId:thread-1"
  });
});

test("account policy wins over sender, group, and session policies regardless of order", () => {
  const cfg = normalizeConfig({
    policies: [
      { sessionKeyIncludes: "discord:", respond: false, ingestMode: "all" },
      { isGroup: true, respond: false, ingestMode: "all" },
      { senderId: "operator", respond: false, ingestMode: "all" },
      { accountId: "default", respond: true, ingestMode: "responseCandidates" }
    ]
  });

  assert.deepEqual(resolvePolicy(cfg, { isGroup: true, senderId: "operator" }, {
    accountId: "default",
    senderId: "operator",
    sessionKey: "agent:main:discord:channel:primary-channel"
  }), {
    respond: true,
    ingestMode: "responseCandidates",
    matched: "accountId:default"
  });
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

test("normalizers handle fallback values, disabled config, sinks, and anonymous rules", () => {
  assert.equal(normalizeIngestMode("bad", "all"), "all");
  assert.deepEqual(normalizePolicy({ respond: "yes", ingestMode: "bad" }, { respond: false, ingestMode: "none", requireMention: true }), {
    respond: false,
    ingestMode: "none",
    requireMention: true
  });
  assert.deepEqual(normalizePolicyRule({ isGroup: "true", channelId: 123 }, { respond: true, ingestMode: "all" }).isGroup, undefined);
  assert.equal(describeRule({}), "anonymous-rule");

  const cfg = normalizeConfig({
    enabled: false,
    policies: [null, { respond: false }],
    jsonlSink: { enabled: true, path: "custom.jsonl", shardBy: "invalid" },
    httpSink: { enabled: true, url: " https://example.invalid ", accessToken: " token " },
    dedupeWindow: -1
  });
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.policies.length, 1);
  assert.equal(cfg.jsonlSink.shardBy, "none");
  assert.equal(cfg.httpSink.url, "https://example.invalid");
  assert.equal(cfg.dedupeWindow, 1);
});

test("rule matching covers metadata aliases, prefixes, regexes, text regexes, and failures", () => {
  assert.equal(ruleMatches({ guildId: "guild-meta" }, {}, { metadata: { guildId: "guild-meta" } }), true);
  assert.equal(ruleMatches({ guildId: "guild-meta" }, {}, { metadata: { guildId: "other" } }), false);
  assert.equal(ruleMatches({ accountId: "acct" }, {}, { AccountId: "acct" }), true);
  assert.equal(ruleMatches({ senderId: "sender" }, {}, { SenderId: "sender" }), true);
  assert.equal(ruleMatches({ conversationIdPrefix: "channel:" }, { metadata: { to: "channel:abc" } }, {}), true);
  assert.equal(ruleMatches({ conversationIdRegex: "^thread-[0-9]+$" }, { threadId: "thread-42" }, {}), true);
  assert.equal(ruleMatches({ conversationIdRegex: "[" }, { threadId: "thread-42" }, {}), false);
  assert.equal(ruleMatches({ sessionKeyRegex: "discord:channel" }, {}, { SessionKey: "agent:main:discord:channel:1" }), true);
  assert.equal(ruleMatches({ sessionKeyIncludes: "telegram:" }, {}, { sessionKey: "agent:main:discord:channel:1" }), false);
  assert.equal(ruleMatches({ isGroup: true }, { isGroup: "yes" }, {}), false);
});

test("mention detection covers metadata booleans, regex text sources, and invalid regexes", () => {
  assert.equal(wasMentioned({ metadata: { mentioned: true } }, {}, {}), true);
  assert.equal(wasMentioned({ metadata: { mention: { wasMentioned: false } } }, {}, {}), false);
  assert.equal(wasMentioned({ metadata: { caption: "hello bot" } }, {}, { mentionTextRegex: "hello bot" }), true);
  assert.equal(wasMentioned({ content: "hello bot" }, {}, { mentionTextRegex: "[" }), undefined);
  assert.equal(wasMentioned({}, { message: "ctx bot" }, { mentionTextRegex: "ctx bot" }), true);
});

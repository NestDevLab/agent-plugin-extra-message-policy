import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { registerExtraMessagePolicy } from "../plugin-runtime.js";

async function createHarness(pluginConfig = {}, runtimeConfig = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "extra-message-policy-"));
  const hooks = new Map();
  const logs = [];
  const tools = [];
  const commands = [];
  const interactiveHandlers = [];
  const builtComponentMessages = [];
  const api = {
    pluginConfig,
    config: runtimeConfig,
    runtime: {
      config: {
        current: () => runtimeConfig
      },
      state: {
        resolveStateDir: () => root
      }
    },
    logger: {
      info(message) {
        logs.push({ level: "info", message });
      },
      warn(message) {
        logs.push({ level: "warn", message });
      }
    },
    on(name, handler) {
      hooks.set(name, handler);
    },
    registerTool(factory, options) {
      tools.push({ factory, options });
    },
    registerCommand(command) {
      commands.push(command);
    },
    registerInteractiveHandler(handler) {
      interactiveHandlers.push(handler);
    }
  };

  const result = registerExtraMessagePolicy(api, {
    discordSdk: {
      buildDiscordComponentMessage(payload) {
        builtComponentMessages.push(payload);
        return {
          components: [{
            type: 17,
            isV2: true,
            components: [{ type: 1, payload }]
          }]
        };
      },
      registerBuiltDiscordComponentMessage(payload) {
        builtComponentMessages.push({ registered: payload });
      }
    }
  });

  return {
    root,
    logs,
    tools,
    commands,
    interactiveHandlers,
    builtComponentMessages,
    result,
    async emit(name, event = {}, ctx = {}) {
      const handler = hooks.get(name);
      return handler ? await handler(event, ctx) : undefined;
    }
  };
}

async function readJsonl(filePath) {
  const raw = await readFile(filePath, "utf8");
  return raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("golden flow: child Discord thread overrides suppressed parent policy", async () => {
  const jsonlPath = path.join(os.tmpdir(), `extra-policy-${Date.now()}-thread.jsonl`);
  const harness = await createHarness({
    defaultPolicy: { respond: true, ingestMode: "all" },
    policies: [
      { channelId: "forum-parent", respond: false, ingestMode: "all" },
      { channelId: "thread-42", respond: true, ingestMode: "all" }
    ],
    jsonlSink: { enabled: true, path: jsonlPath }
  });

  const event = {
    messageId: "msg-1",
    content: "plain thread message",
    timestamp: Date.now()
  };
  const ctx = {
    accountId: "default",
    guildId: "guild-1",
    channelId: "thread-42",
    parentChannelId: "forum-parent",
    conversationId: "channel:thread-42",
    sessionKey: "agent:main:discord:channel:thread-42",
    senderId: "user-1",
    messageId: "msg-1"
  };

  await harness.emit("inbound_claim", { ...event, wasMentioned: false }, ctx);
  await harness.emit("message_received", event, ctx);
  const dispatch = await harness.emit("before_dispatch", event, ctx);
  const outbound = await harness.emit("message_sending", { content: "reply" }, {
    ...ctx,
    messageId: "msg-1"
  });

  assert.equal(dispatch, undefined);
  assert.deepEqual(outbound, { replyTo: "msg-1" });

  const rows = await readJsonl(jsonlPath);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].policy.respond, true);
  assert.equal(rows[0].policy.matched, "channelId:thread-42");
});

test("golden flow: Telegram policy matches chat aliases and suppresses reply end-to-end", async () => {
  const jsonlPath = path.join(os.tmpdir(), `extra-policy-${Date.now()}-telegram.jsonl`);
  const harness = await createHarness({
    defaultPolicy: { respond: true, ingestMode: "all" },
    policies: [
      { channelId: "-100123", respond: false, ingestMode: "all" }
    ],
    jsonlSink: { enabled: true, path: jsonlPath }
  });

  const event = {
    messageId: "tg-1",
    content: "ciao",
    metadata: { chat_id: "-100123" },
    timestamp: Date.now()
  };
  const ctx = {
    accountId: "default",
    platform: "telegram",
    conversationId: "-100123",
    sessionKey: "agent:main:telegram:group:-100123",
    senderId: "user-1",
    messageId: "tg-1",
    metadata: { chat_id: "-100123" }
  };

  await harness.emit("message_received", event, ctx);
  const dispatch = await harness.emit("before_dispatch", event, ctx);
  const outbound = await harness.emit("message_sending", { content: "suppressed reply" }, ctx);

  assert.deepEqual(dispatch, { handled: true });
  assert.deepEqual(outbound, { cancel: true });

  const rows = await readJsonl(jsonlPath);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].policy.respond, false);
  assert.equal(rows[0].policy.matched, "channelId:-100123");
});

test("golden flow: runtime always override forces reply context over suppressed base policy", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "extra-message-policy-runtime-"));
  const statePath = path.join(root, "policy-state.json");
  await writeFile(statePath, JSON.stringify({
    scopes: {
      "discord:default:guild-1:thread-9": {
        policy: {
          responseMode: "always",
          ingestMode: "all"
        }
      }
    }
  }), "utf8");

  const harness = await createHarness({
    defaultPolicy: { respond: false, ingestMode: "all" },
    policyCommand: { statePath },
    policies: [
      { channelId: "forum-parent", respond: false, ingestMode: "all" }
    ]
  });

  const event = {
    messageId: "msg-rt-1",
    content: "unmentioned thread message",
    timestamp: Date.now()
  };
  const ctx = {
    accountId: "default",
    guildId: "guild-1",
    channelId: "thread-9",
    parentChannelId: "forum-parent",
    conversationId: "channel:thread-9",
    sessionKey: "agent:main:discord:channel:thread-9",
    senderId: "user-1",
    messageId: "msg-rt-1",
    wasMentioned: false
  };
  const replyDispatchEvent = {
    ctx: {
      AccountId: "default",
      GroupSpace: "guild-1",
      ChannelId: "thread-9",
      ParentChannelId: "forum-parent",
      OriginatingTo: "channel:thread-9",
      SessionKey: "agent:main:discord:channel:thread-9",
      SenderId: "user-1",
      WasMentioned: false,
      BodyForAgent: "unmentioned thread message",
      messageId: "msg-rt-1"
    }
  };

  const dispatch = await harness.emit("before_dispatch", event, ctx);
  await harness.emit("reply_dispatch", replyDispatchEvent);
  const outbound = await harness.emit("message_sending", { content: "reply" }, {
    ...ctx,
    messageId: "msg-rt-1"
  });

  assert.equal(dispatch, undefined);
  assert.equal(replyDispatchEvent.ctx.WasMentioned, true);
  assert.equal(replyDispatchEvent.ctx.ExplicitlyMentionedBot, true);
  assert.deepEqual(outbound, { replyTo: "msg-rt-1" });
  assert.match(
    harness.logs.map((entry) => entry.message).join("\n"),
    /forced reply context/
  );
});

test("golden flow: runtime always override beats native Discord requireMention gate", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "extra-message-policy-native-runtime-"));
  const statePath = path.join(root, "policy-state.json");
  await writeFile(statePath, JSON.stringify({
    scopes: {
      "discord:default:guild-1:thread-native": {
        policy: {
          responseMode: "always",
          ingestMode: "all"
        }
      }
    }
  }), "utf8");

  const harness = await createHarness({
    defaultPolicy: { respond: true, ingestMode: "all" },
    policyCommand: { statePath }
  }, {
    channels: {
      discord: {
        accounts: {
          default: {
            guilds: {
              "guild-1": {
                channels: {
                  "thread-native": { requireMention: true }
                }
              }
            }
          }
        }
      }
    }
  });

  const event = {
    messageId: "msg-native-rt",
    content: "not a mention",
    timestamp: Date.now()
  };
  const ctx = {
    accountId: "default",
    guildId: "guild-1",
    channelId: "thread-native",
    conversationId: "channel:thread-native",
    sessionKey: "agent:main:discord:channel:thread-native",
    senderId: "user-1",
    messageId: "msg-native-rt",
    wasMentioned: false
  };

  const dispatch = await harness.emit("before_dispatch", event, ctx);
  const outbound = await harness.emit("message_sending", { content: "reply" }, ctx);

  assert.equal(dispatch, undefined);
  assert.deepEqual(outbound, { replyTo: "msg-native-rt" });
});

test("golden flow: new Discord subthread inherits parent runtime always override", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "extra-message-policy-parent-runtime-"));
  const statePath = path.join(root, "policy-state.json");
  await writeFile(statePath, JSON.stringify({
    scopes: {
      "discord:default:guild-1:forum-parent": {
        policy: {
          responseMode: "always",
          ingestMode: "all"
        }
      }
    }
  }), "utf8");

  const harness = await createHarness({
    defaultPolicy: { respond: false, ingestMode: "all" },
    policyCommand: { statePath },
    policies: [
      { channelId: "forum-parent", respond: false, ingestMode: "all" }
    ]
  });

  const event = {
    messageId: "msg-child-inherit",
    content: "new subthread message",
    timestamp: Date.now(),
    metadata: { parent_id: "forum-parent" }
  };
  const ctx = {
    accountId: "default",
    guildId: "guild-1",
    channelId: "new-subthread",
    conversationId: "channel:new-subthread",
    sessionKey: "agent:main:discord:channel:new-subthread",
    senderId: "user-1",
    messageId: "msg-child-inherit",
    metadata: { parent_id: "forum-parent" }
  };
  const replyDispatchEvent = {
    ctx: {
      AccountId: "default",
      GroupSpace: "guild-1",
      ChannelId: "new-subthread",
      ParentId: "forum-parent",
      OriginatingTo: "channel:new-subthread",
      SessionKey: "agent:main:discord:channel:new-subthread",
      SenderId: "user-1",
      BodyForAgent: "new subthread message",
      messageId: "msg-child-inherit"
    }
  };

  const dispatch = await harness.emit("before_dispatch", event, ctx);
  await harness.emit("reply_dispatch", replyDispatchEvent);
  const outbound = await harness.emit("message_sending", { content: "reply" }, ctx);

  assert.equal(dispatch, undefined);
  assert.equal(replyDispatchEvent.ctx.WasMentioned, true);
  assert.deepEqual(outbound, { replyTo: "msg-child-inherit" });
});

test("golden flow: Telegram topic session is suppressed by group chat policy", async () => {
  const jsonlPath = path.join(os.tmpdir(), `extra-policy-${Date.now()}-telegram-topic.jsonl`);
  const harness = await createHarness({
    defaultPolicy: { respond: true, ingestMode: "all" },
    policies: [
      { channelId: "-1003890952306", respond: false, ingestMode: "all" }
    ],
    jsonlSink: { enabled: true, path: jsonlPath }
  });

  const event = {
    messageId: "tg-topic-1",
    content: "topic message",
    chat_id: "-1003890952306",
    metadata: {
      chat_id: "-1003890952306",
      message_thread_id: "724"
    },
    timestamp: Date.now()
  };
  const ctx = {
    accountId: "default",
    platform: "telegram",
    chat_id: "-1003890952306",
    conversationId: "-1003890952306",
    sessionKey: "agent:main:telegram:group:-1003890952306:topic:724",
    senderId: "user-1",
    messageId: "tg-topic-1",
    metadata: {
      chat_id: "-1003890952306",
      message_thread_id: "724"
    }
  };

  await harness.emit("message_received", event, ctx);
  const dispatch = await harness.emit("before_dispatch", event, ctx);
  const outbound = await harness.emit("message_sending", { content: "suppressed reply" }, ctx);

  assert.deepEqual(dispatch, { handled: true });
  assert.deepEqual(outbound, { cancel: true });

  const rows = await readJsonl(jsonlPath);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sessionKey, "agent:main:telegram:group:-1003890952306:topic:724");
  assert.equal(rows[0].policy.matched, "channelId:-1003890952306");
});

test("golden flow: Discord reply to bot satisfies requireMention policy", async () => {
  const harness = await createHarness({
    defaultPolicy: { respond: false, ingestMode: "all" },
    policies: [
      {
        channelId: "reply-channel",
        respond: true,
        ingestMode: "all",
        requireMention: true
      }
    ],
    mentionDetection: {
      accounts: {
        default: {
          botIds: ["1494581796120301598"]
        }
      }
    }
  });

  const event = {
    messageId: "msg-reply-mention",
    content: "yes, continue",
    metadata: {
      referenced_message: {
        author: { id: "1494581796120301598" }
      }
    },
    timestamp: Date.now()
  };
  const ctx = {
    accountId: "default",
    guildId: "guild-1",
    channelId: "reply-channel",
    conversationId: "channel:reply-channel",
    sessionKey: "agent:main:discord:channel:reply-channel",
    senderId: "user-1",
    messageId: "msg-reply-mention"
  };

  const dispatch = await harness.emit("before_dispatch", event, ctx);
  const outbound = await harness.emit("message_sending", { content: "reply" }, ctx);

  assert.equal(dispatch, undefined);
  assert.deepEqual(outbound, { replyTo: "msg-reply-mention" });
});

test("golden flow: configured @bot name satisfies requireMention policy while plain name does not", async () => {
  const harness = await createHarness({
    defaultPolicy: { respond: false, ingestMode: "all" },
    policies: [
      {
        channelId: "name-channel",
        respond: true,
        ingestMode: "all",
        requireMention: true
      }
    ],
    mentionDetection: {
      accounts: {
        default: {
          names: ["Policy Bot"]
        }
      }
    }
  });

  const ctx = {
    accountId: "default",
    guildId: "guild-1",
    channelId: "name-channel",
    conversationId: "channel:name-channel",
    sessionKey: "agent:main:discord:channel:name-channel",
    senderId: "user-1"
  };

  const plainDispatch = await harness.emit("before_dispatch", {
    messageId: "msg-name-plain",
    content: "Policy Bot can you check this?",
    timestamp: Date.now()
  }, { ...ctx, messageId: "msg-name-plain" });
  assert.deepEqual(plainDispatch, { handled: true });
  const plainOutbound = await harness.emit("message_sending", { content: "reply" }, { ...ctx, messageId: "msg-name-plain" });
  assert.deepEqual(plainOutbound, { cancel: true });

  const event = {
    messageId: "msg-name-mention",
    content: "@Policy Bot can you check this?",
    timestamp: Date.now()
  };
  const mentionedCtx = { ...ctx, messageId: "msg-name-mention" };
  const dispatch = await harness.emit("before_dispatch", event, mentionedCtx);
  const outbound = await harness.emit("message_sending", { content: "reply" }, mentionedCtx);

  assert.equal(dispatch, undefined);
  assert.deepEqual(outbound, { replyTo: "msg-name-mention" });
});

test("golden flow: approval prompt replacement preserves native Discord reply target", async () => {
  const harness = await createHarness({
    defaultPolicy: { respond: true, ingestMode: "all" },
    approvalPromptHandling: {
      mode: "replace",
      replacementText: "NO_REPLY"
    }
  });

  const outbound = await harness.emit("message_sending", {
    content: "approval-pending\nUse:\n`/approve abc123`"
  }, {
    accountId: "default",
    guildId: "guild-1",
    channelId: "approval-channel",
    conversationId: "channel:approval-channel",
    sessionKey: "agent:main:discord:channel:approval-channel",
    messageId: "msg-approval-source"
  });

  assert.deepEqual(outbound, {
    replyTo: "msg-approval-source",
    content: "NO_REPLY"
  });
});

test("golden flow: Discord runtime-shaped context suppresses unmentioned replies", async () => {
  const harness = await createHarness({
    defaultPolicy: { respond: true, ingestMode: "all" },
    policies: [
      { channelId: "runtime-channel", respond: true, ingestMode: "all", requireMention: true }
    ]
  });

  const event = {
    MessageId: "msg-runtime-suppress",
    content: "not addressed to the bot",
    WasMentioned: false,
    timestamp: Date.now()
  };
  const ctx = {
    AccountId: "default",
    GroupSpace: "guild-1",
    ChannelId: "runtime-channel",
    NativeChannelId: "runtime-channel",
    OriginatingTo: "channel:runtime-channel",
    SessionKey: "agent:main:discord:channel:runtime-channel",
    SenderId: "user-1",
    MessageId: "msg-runtime-suppress",
    WasMentioned: false
  };

  const dispatch = await harness.emit("before_dispatch", event, ctx);
  const outbound = await harness.emit("message_sending", { content: "should not send" }, {
    MessageId: "msg-runtime-suppress"
  });

  assert.deepEqual(dispatch, { handled: true });
  assert.deepEqual(outbound, { cancel: true });
});

test("golden flow: explicit response modes override native requireMention end-to-end", async () => {
  const harness = await createHarness({
    defaultPolicy: { respond: false, ingestMode: "none" },
    policies: [
      { channelId: "always-channel", respond: true, ingestMode: "all" },
      { channelId: "off-channel", respond: false, ingestMode: "all" },
      { channelId: "mention-channel", respond: true, ingestMode: "all", requireMention: true }
    ]
  }, {
    channels: {
      discord: {
        accounts: {
          default: {
            botUserId: "1494581796120301598",
            guilds: {
              "guild-1": {
                channels: {
                  "*": { requireMention: true },
                  "always-channel": { requireMention: true },
                  "off-channel": { requireMention: false },
                  "mention-channel": { requireMention: false }
                }
              }
            }
          }
        }
      }
    }
  });

  const alwaysCtx = {
    accountId: "default",
    guildId: "guild-1",
    channelId: "always-channel",
    conversationId: "channel:always-channel",
    sessionKey: "agent:main:discord:channel:always-channel",
    senderId: "user-1",
    messageId: "msg-always-native-on"
  };
  const alwaysDispatch = await harness.emit("before_dispatch", {
    messageId: "msg-always-native-on",
    content: "plain message that native would normally skip",
    wasMentioned: false,
    timestamp: Date.now()
  }, alwaysCtx);
  const alwaysOutbound = await harness.emit("message_sending", { content: "reply" }, alwaysCtx);
  assert.equal(alwaysDispatch, undefined);
  assert.deepEqual(alwaysOutbound, { replyTo: "msg-always-native-on" });

  for (const scenario of [
    {
      suffix: "plain",
      event: { content: "plain but explicitly disabled", wasMentioned: false }
    },
    {
      suffix: "mention",
      event: { content: "<@1494581796120301598> explicitly disabled", wasMentioned: true }
    },
    {
      suffix: "reply",
      event: {
        content: "reply to bot but explicitly disabled",
        metadata: { referenced_message: { author: { id: "1494581796120301598" } } }
      }
    }
  ]) {
    const messageId = `msg-off-${scenario.suffix}`;
    const ctx = {
      accountId: "default",
      guildId: "guild-1",
      channelId: "off-channel",
      conversationId: "channel:off-channel",
      sessionKey: "agent:main:discord:channel:off-channel",
      senderId: "user-1",
      messageId
    };
    const dispatch = await harness.emit("before_dispatch", {
      messageId,
      timestamp: Date.now(),
      ...scenario.event
    }, ctx);
    const outbound = await harness.emit("message_sending", { content: "should not send" }, ctx);
    assert.deepEqual(dispatch, { handled: true }, `respond:false must suppress ${scenario.suffix}`);
    assert.deepEqual(outbound, { cancel: true }, `respond:false outbound guard must cancel ${scenario.suffix}`);
  }

  const mentionPlainCtx = {
    accountId: "default",
    guildId: "guild-1",
    channelId: "mention-channel",
    conversationId: "channel:mention-channel",
    sessionKey: "agent:main:discord:channel:mention-channel",
    senderId: "user-1",
    messageId: "msg-mention-plain"
  };
  const mentionPlainDispatch = await harness.emit("before_dispatch", {
    messageId: "msg-mention-plain",
    content: "plain message with native off but plugin mention mode",
    wasMentioned: false,
    timestamp: Date.now()
  }, mentionPlainCtx);
  const mentionPlainOutbound = await harness.emit("message_sending", { content: "should not send" }, mentionPlainCtx);
  assert.deepEqual(mentionPlainDispatch, { handled: true });
  assert.deepEqual(mentionPlainOutbound, { cancel: true });

  const mentionReplyCtx = {
    accountId: "default",
    guildId: "guild-1",
    channelId: "mention-channel",
    conversationId: "channel:mention-channel",
    sessionKey: "agent:main:discord:channel:mention-channel",
    senderId: "user-1",
    messageId: "msg-mention-reply"
  };
  const mentionReplyDispatch = await harness.emit("before_dispatch", {
    messageId: "msg-mention-reply",
    content: "reply to bot in plugin mention mode",
    metadata: { referenced_message: { author: { id: "1494581796120301598" } } },
    timestamp: Date.now()
  }, mentionReplyCtx);
  const mentionReplyOutbound = await harness.emit("message_sending", { content: "reply" }, mentionReplyCtx);
  assert.equal(mentionReplyDispatch, undefined);
  assert.deepEqual(mentionReplyOutbound, { replyTo: "msg-mention-reply" });
});

test("golden flow: guild-scoped Discord policy suppresses rawGuildId runtime contexts", async () => {
  const jsonlPath = path.join(os.tmpdir(), `extra-policy-${Date.now()}-raw-guild.jsonl`);
  const harness = await createHarness({
    defaultPolicy: { respond: true, ingestMode: "all" },
    policies: [
      { accountId: "chromiecraft-bot", guildId: "788063059926712341", respond: false, ingestMode: "all" },
      { accountId: "chromiecraft-bot", channelId: "1507016260620255392", respond: true, ingestMode: "all" }
    ],
    jsonlSink: { enabled: true, path: jsonlPath }
  });

  const event = {
    MessageId: "msg-raw-guild-suppress",
    content: "public channel message",
    timestamp: Date.now()
  };
  const ctx = {
    accountId: "chromiecraft-bot",
    rawGuildId: "788063059926712341",
    channelId: "1513433142198014025",
    conversationId: "channel:1513433142198014025",
    sessionKey: "agent:chromiecraft-bot:discord:channel:1513433142198014025",
    senderId: "user-1",
    messageId: "msg-raw-guild-suppress"
  };

  await harness.emit("message_received", event, ctx);
  const dispatch = await harness.emit("before_dispatch", event, ctx);
  const outbound = await harness.emit("message_sending", { content: "should not send" }, ctx);

  assert.deepEqual(dispatch, { handled: true });
  assert.deepEqual(outbound, { cancel: true });
  const rows = await readJsonl(jsonlPath);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].policy.respond, false);
  assert.equal(rows[0].policy.ingestMode, "all");
  assert.equal(rows[0].policy.matched, "guildId:788063059926712341,accountId:chromiecraft-bot");
});

test("golden flow: accountless guild policy suppresses Discord contexts missing account id", async () => {
  const jsonlPath = path.join(os.tmpdir(), `extra-policy-${Date.now()}-accountless-guild.jsonl`);
  const harness = await createHarness({
    defaultPolicy: { respond: true, ingestMode: "all" },
    policies: [
      { guildId: "788063059926712341", respond: false, ingestMode: "all" },
      { channelId: "1507016260620255392", respond: true, ingestMode: "all" }
    ],
    jsonlSink: { enabled: true, path: jsonlPath }
  });

  const event = {
    MessageId: "msg-accountless-guild-suppress",
    content: "hey chromie",
    timestamp: Date.now()
  };
  const ctx = {
    rawGuildId: "788063059926712341",
    channelId: "1284884380661055568",
    conversationId: "channel:1284884380661055568",
    sessionKey: "agent:chromiecraft-bot:discord:channel:1284884380661055568",
    senderId: "user-1",
    messageId: "msg-accountless-guild-suppress"
  };

  await harness.emit("message_received", event, ctx);
  const dispatch = await harness.emit("before_dispatch", event, ctx);
  const outbound = await harness.emit("message_sending", { content: "should not send" }, ctx);

  assert.deepEqual(dispatch, { handled: true });
  assert.deepEqual(outbound, { cancel: true });
  const rows = await readJsonl(jsonlPath);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].policy.respond, false);
  assert.equal(rows[0].policy.matched, "guildId:788063059926712341");
});

test("golden flow: runtime mention fact survives uppercase inbound fields", async () => {
  const harness = await createHarness({
    defaultPolicy: { respond: true, ingestMode: "all" },
    policies: [
      { channelId: "uppercase-mention", respond: true, ingestMode: "all", requireMention: true }
    ]
  });

  await harness.emit("inbound_claim", {
    MessageId: "msg-uppercase-mention",
    WasMentioned: true,
    content: "bot was addressed"
  }, {
    AccountId: "default",
    GroupSpace: "guild-1",
    ChannelId: "uppercase-mention",
    OriginatingTo: "channel:uppercase-mention",
    SessionKey: "agent:main:discord:channel:uppercase-mention",
    SenderId: "user-1",
    MessageId: "msg-uppercase-mention",
    WasMentioned: true
  });

  const dispatch = await harness.emit("before_dispatch", {
    MessageId: "msg-uppercase-mention",
    content: "bot was addressed"
  }, {
    AccountId: "default",
    GroupSpace: "guild-1",
    ChannelId: "uppercase-mention",
    OriginatingTo: "channel:uppercase-mention",
    SessionKey: "agent:main:discord:channel:uppercase-mention",
    SenderId: "user-1",
    MessageId: "msg-uppercase-mention"
  });
  const outbound = await harness.emit("message_sending", { content: "should not send" }, {
    MessageId: "msg-uppercase-mention"
  });

  assert.equal(dispatch, undefined);
  assert.equal(outbound, undefined);
});

test("golden flow: runtime always override matches Discord runtime-shaped context", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "extra-message-policy-runtime-shaped-"));
  const statePath = path.join(root, "policy-state.json");
  await writeFile(statePath, JSON.stringify({
    scopes: {
      "discord:default:guild-1:runtime-always": {
        policy: {
          responseMode: "always",
          ingestMode: "all"
        }
      }
    }
  }), "utf8");

  const harness = await createHarness({
    defaultPolicy: { respond: false, ingestMode: "none" },
    policyCommand: { statePath },
    policies: [
      { channelId: "runtime-always", respond: false, ingestMode: "none" }
    ]
  });

  const event = {
    MessageId: "msg-runtime-always",
    content: "dynamic policy should allow this",
    timestamp: Date.now()
  };
  const ctx = {
    AccountId: "default",
    GroupSpace: "guild-1",
    ChannelId: "runtime-always",
    NativeChannelId: "runtime-always",
    OriginatingTo: "channel:runtime-always",
    SessionKey: "agent:main:discord:channel:runtime-always",
    SenderId: "user-1",
    MessageId: "msg-runtime-always",
    WasMentioned: false
  };

  const dispatch = await harness.emit("before_dispatch", event, ctx);
  const outbound = await harness.emit("message_sending", { content: "reply" }, {
    MessageId: "msg-runtime-always"
  });

  assert.equal(dispatch, undefined);
  assert.equal(outbound, undefined);
});

test("golden flow: runtime ingest all matches Discord runtime-shaped context", async () => {
  const jsonlPath = path.join(os.tmpdir(), `extra-policy-${Date.now()}-runtime-ingest.jsonl`);
  const root = await mkdtemp(path.join(os.tmpdir(), "extra-message-policy-runtime-ingest-"));
  const statePath = path.join(root, "policy-state.json");
  await writeFile(statePath, JSON.stringify({
    scopes: {
      "discord:default:guild-1:runtime-ingest": {
        policy: {
          responseMode: "off",
          ingestMode: "all"
        }
      }
    }
  }), "utf8");

  const harness = await createHarness({
    defaultPolicy: { respond: false, ingestMode: "none" },
    policyCommand: { statePath },
    jsonlSink: { enabled: true, path: jsonlPath }
  });

  const event = {
    MessageId: "msg-runtime-ingest",
    content: "this should be ingested",
    timestamp: Date.now()
  };
  const ctx = {
    AccountId: "default",
    GroupSpace: "guild-1",
    ChannelId: "runtime-ingest",
    NativeChannelId: "runtime-ingest",
    OriginatingTo: "channel:runtime-ingest",
    SessionKey: "agent:main:discord:channel:runtime-ingest",
    SenderId: "user-1",
    MessageId: "msg-runtime-ingest"
  };

  await harness.emit("message_received", event, ctx);
  const dispatch = await harness.emit("before_dispatch", event, ctx);

  assert.deepEqual(dispatch, { handled: true });
  const rows = await readJsonl(jsonlPath);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].policy.ingestMode, "all");
  assert.equal(rows[0].policy.respond, false);
});

test("runtime registration exits early when plugin is disabled", async () => {
  const harness = await createHarness({ enabled: false });

  assert.equal(harness.result, undefined);
  assert.equal(harness.commands.length, 0);
  assert.equal(harness.tools.length, 0);
  assert.match(harness.logs.map((entry) => entry.message).join("\n"), /disabled/);
});

test("golden flow: JSONL sharding, HTTP sink, dedupe, and sink failures", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "extra-policy-sinks-"));
  const httpRecords = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, request) => {
    httpRecords.push({ url, request });
    return { ok: true, status: 204 };
  };

  try {
    const harness = await createHarness({
      defaultPolicy: { respond: true, ingestMode: "all" },
      jsonlSink: {
        enabled: true,
        path: path.join(tmp, "messages.jsonl"),
        shardBy: "dayConversation"
      },
      httpSink: {
        enabled: true,
        url: "https://example.invalid/ingest",
        accessToken: "test-token"
      },
      dedupeWindow: 1
    });

    const event = {
      messageId: "msg-sink-1",
      content: "sink coverage",
      timestamp: Date.UTC(2026, 4, 30, 12)
    };
    const ctx = {
      accountId: "default",
      guildId: "guild-1",
      channelId: "channel with spaces",
      conversationId: "channel:channel with spaces",
      sessionKey: "agent:main:discord:channel:channel-with-spaces",
      senderId: "sender-1",
      messageId: "msg-sink-1"
    };

    await harness.emit("message_received", event, ctx);
    await harness.emit("message_received", event, ctx);
    const shardPath = path.join(tmp, "2026", "05", "30", "channel_channel_with_spaces.jsonl");
    const rows = await readJsonl(shardPath);

    assert.equal(rows.length, 1);
    assert.equal(httpRecords.length, 1);
    assert.equal(httpRecords[0].url, "https://example.invalid/ingest");
    assert.equal(httpRecords[0].request.headers.authorization, "Bearer test-token");

    globalThis.fetch = async () => ({ ok: false, status: 500 });
    await harness.emit("message_received", { ...event, messageId: "msg-sink-2" }, { ...ctx, messageId: "msg-sink-2" });
    assert.match(harness.logs.map((entry) => entry.message).join("\n"), /ingest failed: Error: http_500/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("golden flow: startup raw recall and registered search tool handle success and failure", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "extra-policy-raw-"));
  const now = new Date();
  const dayDir = path.join(
    tmp,
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    String(now.getUTCDate()).padStart(2, "0")
  );
  await writeFile(path.join(tmp, "placeholder"), "", "utf8").catch(() => {});
  await import("node:fs/promises").then(({ mkdir }) => mkdir(dayDir, { recursive: true }));
  await writeFile(path.join(dayDir, "channel.jsonl"), `${JSON.stringify({
    observedAt: now.toISOString(),
    conversationId: "channel:raw",
    content: "Runtime startup recall should find Falcon context",
    metadata: { channelName: "#ops", senderName: "Tester" }
  })}\n`, "utf8");

  const harness = await createHarness({
    rawRecall: {
      rootPath: tmp,
      maxDays: 1,
      triggerPhrases: ["falcon"],
      tool: { enabled: true }
    }
  });

  const startup = await harness.emit("before_agent_start", { prompt: "falcon status" }, {
    conversationId: "channel:raw"
  });
  assert.match(startup.appendSystemContext, /Passive message raw ingest/);
  assert.match(startup.prependContext, /Falcon context/);

  const tool = harness.tools[0].factory({});
  const toolResult = await tool.execute("tool-call", { query: "Falcon context" });
  assert.match(toolResult.content[0].text, /Falcon context/);

  const failing = await createHarness({
    rawRecall: {
      rootPath: path.join(tmp, "missing", "archive"),
      triggerPhrases: ["falcon"]
    }
  });
  const noRecall = await failing.emit("before_agent_start", { prompt: "falcon status" }, {});
  assert.match(noRecall.appendSystemContext, /Passive message raw ingest/);
  assert.equal(noRecall.prependContext, "");
});

test("policy audit tool lists accessible Discord channels with effective policy", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.TEST_DISCORD_TOKEN;
  process.env.TEST_DISCORD_TOKEN = "test-token";
  globalThis.fetch = async (url) => {
    const textUrl = String(url);
    if (textUrl.endsWith("/guilds/788063059926712341/channels")) {
      return {
        ok: true,
        status: 200,
        async text() {
          const overflowChannels = Array.from({ length: 255 }, (_, index) => ({
            id: `900000000000000${String(index).padStart(3, "0")}`,
            name: `overflow-${index}`,
            type: 0
          }));
          return JSON.stringify([
            { id: "1505467773466443807", name: "chromie-garden", type: 0 },
            { id: "1284884380661055568", name: "gm-general", type: 0 },
            { id: "1513056955319713872", name: "Chromie's Citadel", type: 4 },
            ...overflowChannels,
            { id: "1509999999999999999", name: "late-readable", type: 0 }
          ]);
        }
      };
    }
    if (textUrl.endsWith("/channels/1505467773466443807/messages?limit=1")) {
      return { ok: true, status: 200, async text() { return "[]"; } };
    }
    if (textUrl.endsWith("/channels/1509999999999999999/messages?limit=1")) {
      return { ok: true, status: 200, async text() { return "[]"; } };
    }
    if (textUrl.endsWith("/channels/1513056955319713872/messages?limit=1")) {
      return { ok: true, status: 200, async text() { return "[]"; } };
    }
    if (textUrl.endsWith("/channels/1497843035126632548")) {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            id: "1497843035126632548",
            name: "other-guild-channel",
            type: 0,
            guild_id: "1495100643952693258"
          });
        }
      };
    }
    if (textUrl.endsWith("/channels/1284884380661055568/messages?limit=1")) {
      return { ok: false, status: 403, async text() { return "{}"; } };
    }
    return { ok: false, status: 404, async text() { return "{}"; } };
  };

  try {
    const harness = await createHarness({
      defaultPolicy: { respond: true, ingestMode: "all" },
      policies: [
        { guildId: "788063059926712341", respond: false, ingestMode: "all" },
        { channelId: "1505467773466443807", respond: true, ingestMode: "all" },
        { channelId: "1497843035126632548", respond: true, ingestMode: "all" }
      ]
    }, {
      channels: {
        discord: {
          enabled: true,
          accounts: {
            "chromiecraft-bot": {
              enabled: true,
              token: { source: "env", id: "TEST_DISCORD_TOKEN" },
              guilds: {
                "788063059926712341": {
                  channels: {
                    "*": { enabled: true, requireMention: false },
                    "1284884380661055568": { enabled: false, requireMention: true },
                    "1505467773466443807": { enabled: true, requireMention: false }
                  }
                }
              }
            }
          }
        }
      }
    });

    const tool = harness.tools.find((entry) => entry.options?.name === "list_extra_message_policies").factory({});
    const accessible = await tool.execute("tool-call", {
      accountId: "chromiecraft-bot",
      guildId: "788063059926712341"
    });
    assert.match(accessible.content[0].text, /chromie-garden/);
    assert.match(accessible.content[0].text, /late-readable/);
    assert.doesNotMatch(accessible.content[0].text, /gm-general/);
    assert.doesNotMatch(accessible.content[0].text, /Chromie's Citadel/);
    assert.doesNotMatch(accessible.content[0].text, /other-guild-channel/);
    assert.equal(accessible.details.totalCandidates, 260);
    assert.equal(accessible.details.totalGuildCandidates, 259);
    assert.equal(accessible.details.channels.length, 2);
    const garden = accessible.details.channels.find((channel) => channel.id === "1505467773466443807");
    assert.equal(garden.access, "readable");
    assert.equal(garden.policy.respond, true);
    const late = accessible.details.channels.find((channel) => channel.id === "1509999999999999999");
    assert.equal(late.access, "readable");

    const all = await tool.execute("tool-call", {
      accountId: "chromiecraft-bot",
      guildId: "788063059926712341",
      onlyAccessible: false
    });
    const gm = all.details.channels.find((channel) => channel.id === "1284884380661055568");
    assert.equal(gm.access, "no_access");
    assert.equal(gm.native.enabled, false);
    assert.equal(gm.policy.respond, false);
    assert.equal(gm.accountlessPolicy.respond, false);
    const category = all.details.channels.find((channel) => channel.id === "1513056955319713872");
    assert.equal(category.access, "not_message_channel");
    const crossGuild = all.details.channels.find((channel) => channel.id === "1497843035126632548");
    assert.equal(crossGuild, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.TEST_DISCORD_TOKEN;
    else process.env.TEST_DISCORD_TOKEN = originalToken;
  }
});

test("golden flow: command and interactive handlers cover dashboard actions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "extra-policy-command-"));
  const statePath = path.join(root, "policy-state.json");
  const harness = await createHarness({
    policyCommand: { statePath },
    defaultPolicy: { respond: true, ingestMode: "responseCandidates" }
  }, {
    channels: {
      discord: {
        accounts: {
          default: {
            guilds: {
              "guild-1": {
                channels: {
                  "channel-1": { requireMention: false }
                }
              }
            }
          }
        }
      }
    }
  });

  assert.equal(harness.commands.length, 1);
  assert.equal(harness.interactiveHandlers.length, 1);

  const commandCtx = {
    args: "response always",
    accountId: "default",
    guildId: "guild-1",
    channelId: "channel-1",
    conversationId: "channel:channel-1",
    senderId: "operator",
    sessionKey: "agent:main:discord:channel:channel-1"
  };
  const result = await harness.commands[0].handler(commandCtx);
  assert.match(result.text, /Message policy/);
  assert.equal(result.channelData.discord.components.length, 1);
  assert.equal(result.channelData.discord.components[0].type, 1);
  await stat(statePath);

  const help = await harness.commands[0].handler({ ...commandCtx, args: "help" });
  assert.match(help.text, /Usage:/);

  const callback = result.channelData.discord.components[0].payload.spec.blocks
    .flatMap((block) => block.buttons || [])
    .find((button) => button.label === "Details").callbackData;
  const edits = [];
  const handled = await harness.interactiveHandlers[0].handler({
    ...commandCtx,
    interaction: { payload: callback },
    respond: {
      editMessage(payload) {
        edits.push(payload);
      }
    }
  });
  assert.deepEqual(handled, { handled: true });
  assert.match(edits[0].text, /Details/);

  const dismissCallback = result.channelData.discord.components[0].payload.spec.blocks
    .flatMap((block) => block.buttons || [])
    .find((button) => button.label === "Dismiss").callbackData;
  const dismiss = await harness.interactiveHandlers[0].handler({
    ...commandCtx,
    interaction: { payload: dismissCallback },
    respond: {
      clearComponents(payload) {
        edits.push(payload);
      }
    }
  });
  assert.deepEqual(dismiss, { handled: true });
  assert.match(edits.at(-1).text, /dismissed/);
});

test("approval prompt handling covers persisted strings, arrays, text fields, cancel mode, and non-prompts", async () => {
  const replaceHarness = await createHarness({
    approvalPromptHandling: {
      mode: "replace",
      replacementText: "NO_REPLY"
    }
  });

  assert.deepEqual(await replaceHarness.emit("tool_result_persist", {
    message: { content: [{ type: "text", text: "Use:\n/approve abc-123" }] }
  }, { sessionKey: "session-1" }), {
    message: { content: [{ type: "text", text: "NO_REPLY" }] }
  });

  assert.deepEqual(await replaceHarness.emit("tool_result_persist", {
    message: { text: "approval-pending" }
  }, { sessionKey: "session-1" }), {
    message: { text: "NO_REPLY" }
  });

  assert.equal(await replaceHarness.emit("tool_result_persist", {
    message: { content: "ordinary tool result" }
  }, {}), undefined);

  const cancelHarness = await createHarness({
    approvalPromptHandling: { mode: "cancel" }
  });
  assert.deepEqual(await cancelHarness.emit("message_sending", {
    text: "approval-pending"
  }, {
    sessionKey: "agent:main:discord:channel:approval"
  }), { cancel: true });
});

test("response suppression memory prunes old keys after many dispatches", async () => {
  const harness = await createHarness({
    defaultPolicy: { respond: false, ingestMode: "none" }
  });

  for (let i = 0; i < 2005; i += 1) {
    await harness.emit("before_dispatch", {
      messageId: `msg-${i}`,
      content: "suppressed"
    }, {
      channelId: "bulk",
      conversationId: "channel:bulk",
      sessionKey: `agent:main:discord:channel:bulk:${i}`,
      messageId: `msg-${i}`
    });
  }

  assert.equal(await harness.emit("message_sending", { content: "old" }, {
    messageId: "msg-0"
  }), undefined);
  assert.deepEqual(await harness.emit("message_sending", { content: "new" }, {
    messageId: "msg-2004"
  }), { cancel: true });
});

test("policy command handler falls back to help for unknown action", async () => {
  const harness = await createHarness({
    policyCommand: { statePath: path.join(await mkdtemp(path.join(os.tmpdir(), "extra-policy-help-")), "policy-state.json") }
  });

  const result = await harness.commands[0].handler({
    args: "nonsense",
    accountId: "default",
    guildId: "guild-1",
    channelId: "channel-1",
    conversationId: "channel:channel-1"
  });

  assert.match(result.text, /Usage: \/policy status/);
});

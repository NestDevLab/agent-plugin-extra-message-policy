import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { registerExtraMessagePolicy } from "../plugin-runtime.js";

async function createHarness(pluginConfig = {}, runtimeConfig = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "extra-message-policy-"));
  const hooks = new Map();
  const logs = [];
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
    registerTool() {},
    registerCommand() {},
    registerInteractiveHandler() {}
  };

  registerExtraMessagePolicy(api);

  return {
    root,
    logs,
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

test("golden flow: configured plain bot name satisfies requireMention policy", async () => {
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
          names: ["Karan S'Jet"]
        }
      }
    }
  });

  const event = {
    messageId: "msg-name-mention",
    content: "Karan S'Jet puoi controllare?",
    timestamp: Date.now()
  };
  const ctx = {
    accountId: "default",
    guildId: "guild-1",
    channelId: "name-channel",
    conversationId: "channel:name-channel",
    sessionKey: "agent:main:discord:channel:name-channel",
    senderId: "user-1",
    messageId: "msg-name-mention"
  };

  const dispatch = await harness.emit("before_dispatch", event, ctx);
  const outbound = await harness.emit("message_sending", { content: "reply" }, ctx);

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

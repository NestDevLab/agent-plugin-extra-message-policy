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

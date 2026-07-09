import assert from "node:assert/strict";
import test from "node:test";
import { applyNativeReplyHandling, normalizeNativeReplyHandling } from "../native-reply.js";
import {
  deriveNativeReplyMentionFact,
  deriveMentionFact,
  forceMentionedDispatchContext,
  pruneMentionFacts,
  recalledMentionFact,
  rememberMentionFact,
  withDerivedMentionFact,
  withRecalledMentionFact
} from "../runtime-context.js";

test("recalled mention facts enrich reduced before_dispatch events", () => {
  const state = { mentionFacts: new Map() };
  const ctx = {
    accountId: "default",
    conversationId: "channel:room-1",
    sessionKey: "agent:main:discord:channel:room-1",
    senderId: "operator"
  };

  rememberMentionFact(state, { wasMentioned: true, ...ctx }, ctx);
  const enriched = withRecalledMentionFact(state, { sessionKey: ctx.sessionKey }, {
    conversationId: ctx.conversationId,
    senderId: ctx.senderId
  });

  assert.equal(enriched.event.wasMentioned, true);
  assert.equal(enriched.ctx.wasMentioned, true);
});

test("native reply handling adds Discord replyTo from dispatch context", () => {
  const result = applyNativeReplyHandling({}, {
    sessionKey: "agent:main:discord:channel:room-1",
    messageId: "source-message-1"
  }, normalizeNativeReplyHandling());

  assert.deepEqual(result, { replyTo: "source-message-1" });
});

test("native reply handling accepts Discord guild context without Discord session key", () => {
  const result = applyNativeReplyHandling({}, {
    sessionKey: "agent:main:exampleorg-runtime",
    guildId: "guild-1",
    trigger: { messageId: "source-message-1" }
  }, normalizeNativeReplyHandling());

  assert.deepEqual(result, { replyTo: "source-message-1" });
});

test("native reply handling preserves explicit outbound reply target", () => {
  const result = applyNativeReplyHandling({ replyTo: "explicit-message" }, {
    sessionKey: "agent:main:discord:channel:room-1",
    messageId: "source-message-1"
  }, normalizeNativeReplyHandling());

  assert.equal(result, null);
});

test("native reply handling ignores non-Discord contexts", () => {
  const result = applyNativeReplyHandling({}, {
    sessionKey: "agent:main:telegram:group:room-1",
    messageId: "source-message-1"
  }, normalizeNativeReplyHandling());

  assert.equal(result, null);
});

test("always reply dispatch context marks the turn as addressed", () => {
  const ctx = { GroupSystemPrompt: "Existing group guidance." };

  forceMentionedDispatchContext(ctx);

  assert.equal(ctx.WasMentioned, true);
  assert.equal(ctx.wasMentioned, true);
  assert.equal(ctx.ExplicitlyMentionedBot, true);
  assert.equal(ctx.MentionSource, "extra-message-policy:always-reply");
  assert.match(ctx.GroupSystemPrompt, /Existing group guidance/);
  assert.match(ctx.GroupSystemPrompt, /Always Reply is enabled/);
});

test("derived mention facts detect Discord bot id mentions from account token", () => {
  const botId = "111111111111111111";
  const cfg = {
    channels: {
      discord: {
        accounts: {
          default: {
            token: `${Buffer.from(botId, "utf8").toString("base64url")}.redacted.redacted`
          }
        }
      }
    }
  };
  const event = {
    content: `<@${botId}> can you reply?`,
    accountId: "default",
    sessionKey: "agent:main:discord:channel:room-1"
  };

  assert.equal(deriveMentionFact(event, {}, cfg), true);
});

test("native Discord reply to configured bot overrides explicit false mention fact", () => {
  const botId = "111111111111111111";
  const cfg = {
    channels: {
      discord: {
        accounts: {
          default: { botUserId: botId }
        }
      }
    }
  };
  const event = {
    content: "yes, do that",
    accountId: "default",
    sessionKey: "agent:main:discord:channel:room-1",
    wasMentioned: false,
    metadata: {
      referenced_message: { author: { id: botId } }
    }
  };

  const enriched = withDerivedMentionFact({ mentionFacts: new Map() }, event, {}, cfg, {});

  assert.equal(enriched.event.wasMentioned, true);
  assert.equal(enriched.ctx.wasMentioned, true);
});

test("derived mention facts detect configured account names only with @ by default", () => {
  const plain = withDerivedMentionFact(
    { mentionFacts: new Map() },
    {
      content: "Agent Alpha can you reply?",
      accountId: "default",
      sessionKey: "agent:main:discord:channel:room-1"
    },
    {},
    {},
    { mentionDetection: { accounts: { default: { names: ["Agent Alpha"] } } } }
  );
  assert.equal(plain.event.wasMentioned, undefined);

  const event = {
    content: "@Agent Alpha can you reply?",
    accountId: "default",
    sessionKey: "agent:main:discord:channel:room-1"
  };
  const enriched = withDerivedMentionFact(
    { mentionFacts: new Map() },
    event,
    {},
    {},
    { mentionDetection: { accounts: { default: { names: ["Agent Alpha"] } } } }
  );

  assert.equal(enriched.event.wasMentioned, true);
  assert.equal(enriched.ctx.wasMentioned, true);
});

test("native Discord replies to the configured bot satisfy mention policy", () => {
  const botId = "111111111111111111";
  const cfg = {
    channels: {
      discord: {
        accounts: {
          default: {
            botUserId: botId
          }
        }
      }
    }
  };
  const event = {
    accountId: "default",
    sessionKey: "agent:main:discord:channel:room-1",
    referenced_message: {
      author: { id: botId }
    }
  };

  assert.equal(deriveNativeReplyMentionFact(event, {}, cfg), true);
  assert.equal(deriveMentionFact(event, {}, cfg), true);
});

test("native Discord replies without target author do not satisfy mention policy", () => {
  const cfg = {
    channels: {
      discord: {
        accounts: {
          default: {
            botUserId: "111111111111111111"
          }
        }
      }
    }
  };
  const event = {
    accountId: "default",
    sessionKey: "agent:main:discord:channel:room-1",
    message_reference: {
      message_id: "source-message-1"
    }
  };

  assert.equal(deriveNativeReplyMentionFact(event, {}, cfg), undefined);
  assert.equal(deriveMentionFact(event, {}, cfg), undefined);
});

test("mention fact memory ignores missing booleans, prunes stale entries, and preserves explicit facts", () => {
  const state = {
    mentionFacts: new Map([
      ["stale", { mentioned: true, ts: 0 }],
      ["empty", null]
    ])
  };

  rememberMentionFact(state, { content: "no boolean" }, {});
  assert.equal(state.mentionFacts.size, 2);
  pruneMentionFacts(state, 200000, 120000);
  assert.equal(state.mentionFacts.size, 0);
  assert.equal(recalledMentionFact(state, {}, {}), undefined);

  const explicit = withRecalledMentionFact(state, { wasMentioned: false }, {});
  assert.equal(explicit.event.wasMentioned, false);
});

test("derived mention facts cover configured patterns, invalid patterns, arrays, and global agent config", () => {
  const cfg = {
    agents: {
      main: {
        identity: { name: "Main Agent" },
        groupChat: { mentionPatterns: ["agent-main"] }
      }
    },
    channels: {
      discord: {
        botId: "222222222222222222",
        accounts: {
          default: {
            botUserName: "Default Bot"
          }
        }
      }
    },
    messages: {
      groupChat: {
        mentionPatterns: ["global-agent"]
      }
    }
  };

  assert.equal(deriveMentionFact({
    content: "agent-main please",
    accountId: "default",
    sessionKey: "agent:main:discord:channel:room"
  }, {}, cfg), true);

  assert.equal(deriveMentionFact({
    content: "hello @Default Bot",
    accountId: "default",
    sessionKey: "agent:other:discord:channel:room"
  }, {}, cfg), true);

  assert.equal(deriveMentionFact({
    content: "global-agent please",
    accountId: "default",
    sessionKey: "agent:other:discord:channel:room"
  }, {}, cfg), true);

  assert.equal(deriveMentionFact({
    content: "ordinary text",
    accountId: "default",
    sessionKey: "agent:other:discord:channel:room"
  }, {}, cfg, {
    mentionDetection: {
      names: ["   "],
      patterns: ["["]
    }
  }), undefined);
});

test("native reply mention facts cover Discord metadata shapes", () => {
  const cfg = {
    channels: {
      discord: {
        applicationId: "333333333333333333"
      }
    }
  };

  assert.equal(deriveNativeReplyMentionFact({
    metadata: {
      discord: {
        referencedMessage: {
          author: { id: "333333333333333333" }
        }
      }
    }
  }, {
    sessionKey: "agent:main:discord:channel:room"
  }, cfg), true);
  assert.equal(deriveNativeReplyMentionFact({
    metadata: {
      discord: {
        referencedMessage: {
          author: { id: "444444444444444444" }
        }
      }
    }
  }, {
    sessionKey: "agent:main:discord:channel:room"
  }, cfg), undefined);
});

test("native reply handling covers disabled, custom platform list, number ids, and nested source ids", () => {
  assert.equal(applyNativeReplyHandling({}, { messageId: "m1" }, normalizeNativeReplyHandling({ enabled: false })), null);
  assert.deepEqual(applyNativeReplyHandling({}, { platform: "discord", messageId: "m1" }, normalizeNativeReplyHandling({ platforms: [] })), { replyTo: "m1" });
  assert.equal(applyNativeReplyHandling({}, { platform: "discord", messageId: "m1" }, normalizeNativeReplyHandling({ platforms: ["telegram"] })), null);
  assert.deepEqual(applyNativeReplyHandling({}, {
    platform: "discord",
    source: { id: 12345 }
  }, normalizeNativeReplyHandling({ platforms: ["discord"] })), { replyTo: "12345" });
  assert.deepEqual(applyNativeReplyHandling({}, {
    metadata: { platform: "discord", sourceMessageId: "source-meta" }
  }, normalizeNativeReplyHandling()), { replyTo: "source-meta" });
});

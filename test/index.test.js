import assert from "node:assert/strict";
import test from "node:test";
import { applyNativeReplyHandling, normalizeNativeReplyHandling } from "../native-reply.js";
import {
  deriveNativeReplyMentionFact,
  deriveMentionFact,
  forceMentionedDispatchContext,
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

test("derived mention facts detect configured account names", () => {
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

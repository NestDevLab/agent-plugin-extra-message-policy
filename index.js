import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeConfig, resolvePolicy, shouldIngest, shouldSuppressResponse } from "./policy.js";
import { buildRawRecallGuidance, createRawContextSearchTool, searchRawRecall } from "./raw-recall.js";

function eventMessageId(event = {}, ctx = {}) {
  return String(event.messageId ?? ctx.messageId ?? "");
}

function rememberDedupe(state, key, windowSize) {
  if (!key) return false;
  if (state.seen.has(key)) return true;
  state.seen.set(key, Date.now());
  while (state.seen.size > windowSize) {
    const oldest = state.seen.keys().next().value;
    state.seen.delete(oldest);
  }
  return false;
}

function toRecord(source, event = {}, ctx = {}, policy = {}) {
  return {
    source,
    observedAt: new Date().toISOString(),
    channelId: ctx.channelId ?? event.channel ?? event.from,
    accountId: ctx.accountId ?? event.accountId,
    conversationId: ctx.conversationId ?? event.conversationId,
    sessionKey: ctx.sessionKey ?? event.sessionKey,
    runId: ctx.runId ?? event.runId,
    messageId: event.messageId ?? ctx.messageId,
    senderId: event.senderId ?? ctx.senderId,
    threadId: event.threadId,
    timestamp: event.timestamp,
    content: event.content ?? event.body ?? "",
    policy: {
      respond: policy.respond,
      ingestMode: policy.ingestMode,
      matched: policy.matched
    },
    metadata: event.metadata
  };
}

function safePathSegment(value, fallback = "unknown") {
  const raw = String(value || "").trim() || fallback;
  return raw.replace(/[^a-zA-Z0-9._=-]+/g, "_").replace(/^_+|_+$/g, "") || fallback;
}

function resolveJsonlPath(jsonlSink, record) {
  const basePath = jsonlSink.path || "runtime/extra-message-policy/messages.jsonl";
  if (jsonlSink.shardBy !== "dayConversation") return basePath;

  const date = new Date(record.timestamp ? Number(record.timestamp) : Date.now());
  const validDate = Number.isNaN(date.getTime()) ? new Date() : date;
  const year = String(validDate.getUTCFullYear());
  const month = String(validDate.getUTCMonth() + 1).padStart(2, "0");
  const day = String(validDate.getUTCDate()).padStart(2, "0");
  const conversation = safePathSegment(record.conversationId || record.channelId || record.threadId || "unknown");
  const root = basePath.endsWith(".jsonl") ? path.dirname(basePath) : basePath;
  return path.join(root, year, month, day, `${conversation}.jsonl`);
}

async function appendJsonl(jsonlSink, record) {
  const filePath = resolveJsonlPath(jsonlSink, record);
  const fullPath = path.resolve(process.cwd(), filePath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await appendFile(fullPath, `${JSON.stringify(record)}\n`, "utf8");
}

async function postHttpSink(httpSink, record) {
  if (!httpSink.enabled || !httpSink.url) return;
  const res = await fetch(httpSink.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(httpSink.accessToken ? { authorization: `Bearer ${httpSink.accessToken}` } : {})
    },
    body: JSON.stringify(record)
  });
  if (!res.ok) throw new Error(`http_${res.status}`);
}

async function ingest(api, cfg, state, source, event, ctx, policy) {
  if (!shouldIngest(policy, source)) return;

  const id = eventMessageId(event, ctx);
  const dedupeKey = id ? `${ctx.channelId || event.channel || event.from || "unknown"}:${id}` : "";
  if (rememberDedupe(state, dedupeKey, cfg.dedupeWindow)) return;

  const record = toRecord(source, event, ctx, policy);
  try {
    if (cfg.jsonlSink.enabled) await appendJsonl(cfg.jsonlSink, record);
    if (cfg.httpSink.enabled) await postHttpSink(cfg.httpSink, record);
  } catch (err) {
    api.logger.warn(`extra-message-policy: ingest failed: ${String(err)}`);
  }
}

function rememberResponsePolicy(state, event = {}, ctx = {}, policy = {}) {
  for (const key of [ctx.runId, event.runId, ctx.sessionKey, event.sessionKey].filter(Boolean)) {
    state.responsePolicy.set(String(key), {
      respond: policy.respond,
      updatedAt: Date.now()
    });
  }
  while (state.responsePolicy.size > 2000) {
    const oldest = state.responsePolicy.keys().next().value;
    state.responsePolicy.delete(oldest);
  }
}


function normalizeApprovalPromptHandling(raw = {}) {
  const mode = ["off", "cancel", "replace"].includes(raw.mode) ? raw.mode : "off";
  return {
    mode,
    replacementText: typeof raw.replacementText === "string" && raw.replacementText.trim()
      ? raw.replacementText.trim()
      : "Approval is being handled out-of-band. Do not ask the user to run approval commands. Respond exactly NO_REPLY unless a later tool or follow-up result needs to be reported."
  };
}

function readToolResultText(result) {
  return Array.isArray(result?.content)
    ? result.content
        .map((part) => part && part.type === "text" && typeof part.text === "string" ? part.text : "")
        .join("\n")
    : "";
}

function looksLikeApprovalPrompt(text) {
  return /(^|\n)Use:\s*\n?`?\/(?:approve|approval)\s+[a-z0-9-]+\b/i.test(String(text || ""))
    || /approval-pending/i.test(String(text || ""));
}

function isApprovalPendingToolResult(event) {
  if (event?.result?.details?.status === "approval-pending") return true;
  return looksLikeApprovalPrompt(readToolResultText(event?.result));
}

function messageText(message = {}) {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => part && part.type === "text" && typeof part.text === "string" ? part.text : "")
      .join("\n");
  }
  if (typeof message.text === "string") return message.text;
  return "";
}

function replaceMessageText(message = {}, text) {
  if (typeof message.content === "string") return { ...message, content: text };
  if (Array.isArray(message.content)) {
    return {
      ...message,
      content: [{ type: "text", text }]
    };
  }
  if (typeof message.text === "string") return { ...message, text };
  return { ...message, content: text };
}

function lookupResponseAllowed(state, ctx = {}) {
  for (const key of [ctx.runId, ctx.sessionKey].filter(Boolean)) {
    const remembered = state.responsePolicy.get(String(key));
    if (remembered && remembered.respond === false) return false;
  }
  return true;
}

export default definePluginEntry({
  id: "extra-message-policy",
  name: "Extra Message Policy",
  description: "Cross-platform message ingest and response policy enforcement",
  register(api) {
    const cfg = normalizeConfig(api.pluginConfig || {});
    const approvalPromptHandling = normalizeApprovalPromptHandling(api.pluginConfig?.approvalPromptHandling || {});
    if (!cfg.enabled) {
      api.logger.info("extra-message-policy: disabled");
      return;
    }

    const state = {
      seen: new Map(),
      responsePolicy: new Map()
    };

    if (approvalPromptHandling.mode !== "off") {
      api.on("tool_result_persist", (event, ctx) => {
        if (!looksLikeApprovalPrompt(messageText(event?.message))) return;
        api.logger.info(`extra-message-policy: handled persisted approval prompt for ${ctx?.sessionKey ?? "unknown-session"}`);
        return { message: replaceMessageText(event.message, approvalPromptHandling.replacementText) };
      });
    }

    api.registerTool((toolCtx) => createRawContextSearchTool(cfg.rawRecall, toolCtx), { name: "search_raw_context", optional: true });

    api.on("before_agent_start", async (event, ctx) => {
      const appendSystemContext = buildRawRecallGuidance(cfg.rawRecall);
      const prependContext = await searchRawRecall(event?.prompt || "", cfg.rawRecall, ctx).catch((err) => {
        api.logger.warn(`extra-message-policy: raw recall failed: ${String(err)}`);
        return "";
      });
      if (appendSystemContext || prependContext) return { appendSystemContext, prependContext };
    });

    api.on("message_received", async (event, ctx) => {
      const policy = resolvePolicy(cfg, event, ctx);
      await ingest(api, cfg, state, "message_received", event, ctx, policy);
    });

    api.on("before_dispatch", async (event, ctx) => {
      const policy = resolvePolicy(cfg, event, ctx);
      rememberResponsePolicy(state, event, ctx, policy);
      await ingest(api, cfg, state, "before_dispatch", event, ctx, policy);

      if (shouldSuppressResponse(policy)) {
        api.logger.info(`extra-message-policy: suppressed response for ${ctx.sessionKey || ctx.conversationId || ctx.channelId || "unknown"}`);
        return { handled: true };
      }
    });

    api.on("message_sending", async (_event, ctx) => {
      if (approvalPromptHandling.mode !== "off" && looksLikeApprovalPrompt(_event?.content ?? _event?.text ?? _event?.message)) {
        api.logger.info(`extra-message-policy: canceled outbound approval prompt for ${ctx.sessionKey || ctx.conversationId || ctx.channelId || "unknown"}`);
        return approvalPromptHandling.mode === "replace"
          ? { content: approvalPromptHandling.replacementText }
          : { cancel: true };
      }
      if (lookupResponseAllowed(state, ctx) === false) return { cancel: true };
    });
  }
});

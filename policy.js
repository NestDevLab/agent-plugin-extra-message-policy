import { normalizeRawRecallConfig } from "./raw-recall.js";

export const INGEST_MODES = Object.freeze(["none", "passive", "all", "responseCandidates"]);

export const DEFAULT_POLICY = Object.freeze({
  respond: true,
  ingestMode: "responseCandidates",
  requireMention: false
});

function asBool(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function asString(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function messageText(event = {}, ctx = {}) {
  const metadata = event?.metadata && typeof event.metadata === "object" ? event.metadata : {};
  for (const value of [
    event.content,
    event.text,
    event.message,
    event.body,
    metadata.content,
    metadata.text,
    metadata.message,
    metadata.body,
    metadata.caption,
    ctx.content,
    ctx.text,
    ctx.message
  ]) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

function regexMatchesText(pattern, text) {
  if (!pattern || !text) return false;
  try {
    return new RegExp(pattern).test(text);
  } catch {
    return false;
  }
}

export function normalizeIngestMode(value, fallback = DEFAULT_POLICY.ingestMode) {
  return INGEST_MODES.includes(value) ? value : fallback;
}

export function normalizePolicy(raw = {}, fallback = DEFAULT_POLICY) {
  const requireMention = asBool(raw.requireMention, fallback.requireMention === true);
  return {
    respond: asBool(raw.respond, fallback.respond),
    ingestMode: normalizeIngestMode(raw.ingestMode, fallback.ingestMode),
    ...(requireMention ? { requireMention: true } : {})
  };
}

export function normalizePolicyRule(raw = {}, defaultPolicy = DEFAULT_POLICY) {
  return {
    ...normalizePolicy(raw, defaultPolicy),
    channelId: asString(raw.channelId),
    guildId: asString(raw.guildId),
    accountId: asString(raw.accountId),
    conversationId: asString(raw.conversationId),
    conversationIdPrefix: asString(raw.conversationIdPrefix),
    conversationIdRegex: asString(raw.conversationIdRegex),
    senderId: asString(raw.senderId),
    isGroup: typeof raw.isGroup === "boolean" ? raw.isGroup : undefined,
    mentionTextRegex: asString(raw.mentionTextRegex),
    sessionKeyIncludes: asString(raw.sessionKeyIncludes),
    sessionKeyRegex: asString(raw.sessionKeyRegex)
  };
}

export function normalizeConfig(raw = {}) {
  const defaultPolicy = normalizePolicy(raw.defaultPolicy || {}, DEFAULT_POLICY);
  const jsonlSink = {
    enabled: raw.jsonlSink?.enabled === true,
    path: asString(raw.jsonlSink?.path, "runtime/extra-message-policy/messages.jsonl"),
    shardBy: ["none", "dayConversation"].includes(raw.jsonlSink?.shardBy) ? raw.jsonlSink.shardBy : "none"
  };
  return {
    enabled: raw.enabled !== false,
    defaultPolicy,
    policies: Array.isArray(raw.policies)
      ? raw.policies.filter(Boolean).map((rule) => normalizePolicyRule(rule, defaultPolicy))
      : [],
    jsonlSink,
    rawRecall: normalizeRawRecallConfig(raw.rawRecall || {}, jsonlSink),
    httpSink: {
      enabled: raw.httpSink?.enabled === true,
      url: asString(raw.httpSink?.url),
      accessToken: asString(raw.httpSink?.accessToken)
    },
    dedupeWindow: Number.isFinite(raw.dedupeWindow) ? Math.max(1, Number(raw.dedupeWindow)) : 2000
  };
}

function ctxValue(ctx = {}, event = {}, key) {
  return String(ctx?.[key] ?? event?.[key] ?? "");
}

function stripConversationPrefix(value) {
  return String(value || "").replace(/^(channel|chat|user):/, "");
}

function metadataValues(ctx = {}, event = {}, keys = []) {
  const values = [];
  for (const key of keys) {
    values.push(ctx?.[key], event?.[key], ctx?.metadata?.[key], event?.metadata?.[key]);
  }
  return values;
}

function channelIdValues(ctx = {}, event = {}) {
  const exact = new Set();
  const parent = new Set();
  for (const value of [
    ctx?.channelId,
    ctx?.channel,
    event?.channelId,
    event?.channel,
    event?.metadata?.channelId,
    event?.metadata?.channel_id,
    ctx?.metadata?.channelId,
    ctx?.metadata?.channel_id,
    ...metadataValues(ctx, event, ["chatId", "chat_id", "to", "from", "conversationId"])
  ]) {
    const text = stripConversationPrefix(String(value || "").trim());
    if (text) exact.add(text);
  }
  for (const value of [
    ctx?.parentChannelId,
    ctx?.parentConversationId,
    ctx?.parentId,
    ctx?.threadParentId,
    event?.parentChannelId,
    event?.parentConversationId,
    event?.parentId,
    event?.threadParentId,
    event?.metadata?.parentChannelId,
    event?.metadata?.parent_channel_id,
    event?.metadata?.parentId,
    event?.metadata?.parent_id,
    event?.metadata?.threadParentId,
    event?.metadata?.thread_parent_id,
    ctx?.metadata?.parentChannelId,
    ctx?.metadata?.parent_channel_id,
    ctx?.metadata?.parentId,
    ctx?.metadata?.parent_id,
    ctx?.metadata?.threadParentId,
    ctx?.metadata?.thread_parent_id
  ]) {
    const text = stripConversationPrefix(String(value || "").trim());
    if (text) parent.add(text);
  }
  return { exact: [...exact], parent: [...parent] };
}

function channelMatchKind(rule, ctx = {}, event = {}) {
  if (!rule.channelId) return "";
  const expected = stripConversationPrefix(rule.channelId);
  const values = channelIdValues(ctx, event);
  if (values.exact.includes(expected)) return "exact";
  if (values.parent.includes(expected)) return "parent";
  return "";
}

function conversationValues(ctx = {}, event = {}) {
  const values = new Set();
  for (const value of [
    ctx?.conversationId,
    event?.conversationId,
    event?.metadata?.to,
    event?.metadata?.originatingTo,
    event?.metadata?.threadId,
    ctx?.threadId,
    event?.threadId,
    ...metadataValues(ctx, event, ["channelId", "channel_id", "chatId", "chat_id", "to", "from"])
  ]) {
    const text = String(value || "").trim();
    if (!text) continue;
    values.add(text);
    values.add(stripConversationPrefix(text));
  }
  return [...values];
}

function anyConversationMatches(ctx, event, predicate) {
  return conversationValues(ctx, event).some(predicate);
}

export function ruleMatches(rule, event = {}, ctx = {}) {
  if (rule.channelId && !channelMatchKind(rule, ctx, event)) return false;
  if (rule.guildId && rule.guildId !== ctxValue(ctx, event, "guildId") && rule.guildId !== ctxValue(ctx, event, "guild") && rule.guildId !== String(event?.metadata?.guildId ?? "")) return false;
  if (rule.accountId && rule.accountId !== ctxValue(ctx, event, "accountId")) return false;
  if (rule.conversationId && !anyConversationMatches(ctx, event, (value) => value === rule.conversationId || stripConversationPrefix(value) === stripConversationPrefix(rule.conversationId))) return false;
  if (rule.conversationIdPrefix && !anyConversationMatches(ctx, event, (value) => value.startsWith(rule.conversationIdPrefix))) return false;
  if (rule.conversationIdRegex) {
    try {
      const re = new RegExp(rule.conversationIdRegex);
      if (!anyConversationMatches(ctx, event, (value) => re.test(value))) return false;
    } catch {
      return false;
    }
  }
  if (rule.senderId && rule.senderId !== ctxValue(ctx, event, "senderId")) return false;
  if (typeof rule.isGroup === "boolean") {
    const value = event?.isGroup;
    if (typeof value !== "boolean" || value !== rule.isGroup) return false;
  }

  const sessionKey = ctxValue(ctx, event, "sessionKey");
  if (rule.sessionKeyIncludes && !sessionKey.includes(rule.sessionKeyIncludes)) return false;
  if (rule.sessionKeyRegex) {
    try {
      if (!new RegExp(rule.sessionKeyRegex).test(sessionKey)) return false;
    } catch {
      return false;
    }
  }

  return true;
}

export function describeRule(rule) {
  const parts = [];
  for (const key of ["channelId", "guildId", "accountId", "conversationId", "conversationIdPrefix", "conversationIdRegex", "senderId", "mentionTextRegex", "sessionKeyIncludes", "sessionKeyRegex"]) {
    if (rule[key]) parts.push(`${key}:${rule[key]}`);
  }
  if (typeof rule.isGroup === "boolean") parts.push(`isGroup:${rule.isGroup}`);
  return parts.join(",") || "anonymous-rule";
}

function ruleSpecificity(rule = {}, event = {}, ctx = {}) {
  let score = 0;
  if (rule.conversationId) score += 64;
  if (rule.conversationIdRegex) score += 60;
  if (rule.conversationIdPrefix) score += 56;
  if (rule.channelId) score += channelMatchKind(rule, ctx, event) === "parent" ? 28 : 32;
  if (rule.guildId) score += 24;
  if (rule.accountId) score += 16;
  if (rule.senderId) score += 8;
  if (typeof rule.isGroup === "boolean") score += 4;
  if (rule.sessionKeyRegex) score += 2;
  if (rule.sessionKeyIncludes) score += 1;
  return score;
}

function firstBoolean(...values) {
  for (const value of values) {
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function nestedValue(obj, path) {
  let cursor = obj;
  for (const key of path) {
    if (!cursor || typeof cursor !== "object" || !(key in cursor)) return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

export function wasMentioned(event = {}, ctx = {}, policy = {}) {
  const metadata = event?.metadata && typeof event.metadata === "object" ? event.metadata : {};
  const explicit = firstBoolean(
    event.wasMentioned,
    ctx.wasMentioned,
    metadata.wasMentioned,
    metadata.mentioned,
    nestedValue(metadata, ["mention", "wasMentioned"]),
    nestedValue(metadata, ["mentions", "wasMentioned"]),
    nestedValue(metadata, ["discord", "wasMentioned"]),
    nestedValue(metadata, ["message", "wasMentioned"])
  );
  if (typeof explicit === "boolean") return explicit;
  if (regexMatchesText(policy.mentionTextRegex, messageText(event, ctx))) return true;
  return undefined;
}

function withMentionDecision(policy, event = {}, ctx = {}) {
  if (!policy.requireMention) return policy;
  const mentioned = wasMentioned(event, ctx, policy) === true;
  return {
    ...policy,
    mentionRequired: true,
    mentionSatisfied: mentioned,
    respond: policy.respond && mentioned
  };
}

export function resolvePolicy(cfg, event = {}, ctx = {}) {
  let bestRule = null;
  let bestScore = -1;

  for (const rule of cfg.policies) {
    if (!ruleMatches(rule, event, ctx)) continue;
    const score = ruleSpecificity(rule, event, ctx);
    if (score > bestScore) {
      bestRule = rule;
      bestScore = score;
    }
  }

  if (bestRule) {
    return withMentionDecision({
      respond: bestRule.respond,
      ingestMode: bestRule.ingestMode,
      ...(bestRule.requireMention ? { requireMention: true } : {}),
      ...(bestRule.mentionTextRegex ? { mentionTextRegex: bestRule.mentionTextRegex } : {}),
      matched: describeRule(bestRule)
    }, event, ctx);
  }
  return withMentionDecision({ ...cfg.defaultPolicy, matched: "default" }, event, ctx);
}

export function shouldIngest(policy, source) {
  if (!policy || policy.ingestMode === "none") return false;
  if (policy.ingestMode === "passive") return source === "message_received";
  if (policy.ingestMode === "all") return source === "message_received" || source === "before_dispatch";
  return policy.ingestMode === "responseCandidates" && source === "before_dispatch";
}

export function shouldSuppressResponse(policy) {
  return policy?.respond === false || (policy?.requireMention === true && policy?.mentionSatisfied === false);
}

import { normalizeRawRecallConfig } from "./raw-recall.js";

export const INGEST_MODES = Object.freeze(["none", "all", "responseCandidates"]);

export const DEFAULT_POLICY = Object.freeze({
  respond: true,
  ingestMode: "responseCandidates"
});

function asBool(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function asString(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

export function normalizeIngestMode(value, fallback = DEFAULT_POLICY.ingestMode) {
  return INGEST_MODES.includes(value) ? value : fallback;
}

export function normalizePolicy(raw = {}, fallback = DEFAULT_POLICY) {
  return {
    respond: asBool(raw.respond, fallback.respond),
    ingestMode: normalizeIngestMode(raw.ingestMode, fallback.ingestMode)
  };
}

export function normalizePolicyRule(raw = {}, defaultPolicy = DEFAULT_POLICY) {
  return {
    ...normalizePolicy(raw, defaultPolicy),
    channelId: asString(raw.channelId),
    guildId: asString(raw.guildId),
    accountId: asString(raw.accountId),
    conversationId: asString(raw.conversationId),
    senderId: asString(raw.senderId),
    isGroup: typeof raw.isGroup === "boolean" ? raw.isGroup : undefined,
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

export function ruleMatches(rule, event = {}, ctx = {}) {
  if (rule.channelId && rule.channelId !== ctxValue(ctx, event, "channelId") && rule.channelId !== ctxValue(ctx, event, "channel")) return false;
  if (rule.guildId && rule.guildId !== ctxValue(ctx, event, "guildId") && rule.guildId !== ctxValue(ctx, event, "guild")) return false;
  if (rule.accountId && rule.accountId !== ctxValue(ctx, event, "accountId")) return false;
  if (rule.conversationId && rule.conversationId !== ctxValue(ctx, event, "conversationId")) return false;
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
  for (const key of ["channelId", "guildId", "accountId", "conversationId", "senderId", "sessionKeyIncludes", "sessionKeyRegex"]) {
    if (rule[key]) parts.push(`${key}:${rule[key]}`);
  }
  if (typeof rule.isGroup === "boolean") parts.push(`isGroup:${rule.isGroup}`);
  return parts.join(",") || "anonymous-rule";
}

function ruleSpecificity(rule = {}) {
  let score = 0;
  if (rule.conversationId) score += 64;
  if (rule.channelId) score += 32;
  if (rule.guildId) score += 24;
  if (rule.accountId) score += 16;
  if (rule.senderId) score += 8;
  if (typeof rule.isGroup === "boolean") score += 4;
  if (rule.sessionKeyRegex) score += 2;
  if (rule.sessionKeyIncludes) score += 1;
  return score;
}

export function resolvePolicy(cfg, event = {}, ctx = {}) {
  let bestRule = null;
  let bestScore = -1;

  for (const rule of cfg.policies) {
    if (!ruleMatches(rule, event, ctx)) continue;
    const score = ruleSpecificity(rule);
    if (score > bestScore) {
      bestRule = rule;
      bestScore = score;
    }
  }

  if (bestRule) {
    return {
      respond: bestRule.respond,
      ingestMode: bestRule.ingestMode,
      matched: describeRule(bestRule)
    };
  }
  return { ...cfg.defaultPolicy, matched: "default" };
}

export function shouldIngest(policy, source) {
  if (!policy || policy.ingestMode === "none") return false;
  if (policy.ingestMode === "all") return source === "message_received" || source === "before_dispatch";
  return policy.ingestMode === "responseCandidates" && source === "before_dispatch";
}

export function shouldSuppressResponse(policy) {
  return policy?.respond === false;
}

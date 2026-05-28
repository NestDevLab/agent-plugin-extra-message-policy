function mentionFactKeys(event = {}, ctx = {}) {
  const keys = new Set();
  const sessionKey = event.sessionKey || ctx.sessionKey;
  const accountId = event.accountId || ctx.accountId || "";
  const conversationId = event.conversationId || ctx.conversationId || "";
  const channelId = event.channel || event.channelId || ctx.channelId || "";
  const senderId = event.senderId || ctx.senderId || "";
  const messageId = event.messageId || ctx.messageId || "";
  if (messageId) keys.add(`message:${messageId}`);
  if (sessionKey) keys.add(`session:${sessionKey}`);
  if (accountId || conversationId || senderId) keys.add(`scope:${accountId}:${conversationId}:${senderId}`);
  if (channelId || conversationId || senderId) keys.add(`channel:${channelId}:${conversationId}:${senderId}`);
  return [...keys].filter(Boolean);
}

export function pruneMentionFacts(state, now = Date.now(), ttlMs = 120000) {
  if (!state?.mentionFacts) return;
  for (const [key, value] of state.mentionFacts.entries()) {
    if (!value || now - value.ts > ttlMs) state.mentionFacts.delete(key);
  }
}

export function rememberMentionFact(state, event = {}, ctx = {}) {
  const mentioned = typeof event.wasMentioned === "boolean"
    ? event.wasMentioned
    : typeof ctx.wasMentioned === "boolean"
      ? ctx.wasMentioned
      : undefined;
  if (typeof mentioned !== "boolean") return;
  const now = Date.now();
  pruneMentionFacts(state, now);
  for (const key of mentionFactKeys(event, ctx)) {
    state.mentionFacts.set(key, { mentioned, ts: now });
  }
}

export function recalledMentionFact(state, event = {}, ctx = {}) {
  pruneMentionFacts(state);
  for (const key of mentionFactKeys(event, ctx)) {
    const fact = state.mentionFacts?.get(key);
    if (typeof fact?.mentioned === "boolean") return fact.mentioned;
  }
  return undefined;
}

export function withRecalledMentionFact(state, event = {}, ctx = {}) {
  if (typeof event.wasMentioned === "boolean" || typeof ctx.wasMentioned === "boolean") {
    return { event, ctx };
  }
  const mentioned = recalledMentionFact(state, event, ctx);
  if (typeof mentioned !== "boolean") return { event, ctx };
  return {
    event: { ...event, wasMentioned: mentioned },
    ctx: { ...ctx, wasMentioned: mentioned }
  };
}

function textValue(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function normalizeMentionText(text) {
  return String(text || "").replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, "").toLowerCase();
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
    ctx.message,
    ctx.BodyForCommands,
    ctx.CommandBody,
    ctx.RawBody,
    ctx.Body,
    ctx.BodyForAgent
  ]) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

export function agentIdFromSessionKey(...values) {
  for (const value of values) {
    const text = textValue(value);
    const match = /^agent:([^:]+):/.exec(text);
    if (match?.[1]) return match[1];
  }
  return "";
}

function resolveAgentConfig(cfg = {}, agentId = "") {
  if (!agentId) return null;
  const agents = cfg?.agents;
  if (Array.isArray(agents?.list)) return agents.list.find((agent) => agent?.id === agentId) || null;
  if (Array.isArray(agents)) return agents.find((agent) => agent?.id === agentId) || null;
  if (agents && typeof agents === "object") return agents[agentId] || null;
  return null;
}

function parseTokenUserId(token = "") {
  const first = String(token || "").split(".")[0];
  if (!first) return "";
  try {
    const decoded = Buffer.from(first, "base64url").toString("utf8").trim();
    return /^\d{15,25}$/.test(decoded) ? decoded : "";
  } catch {
    return "";
  }
}

function arrayValues(value) {
  if (Array.isArray(value)) return value.map((entry) => textValue(entry)).filter(Boolean);
  const text = textValue(value);
  return text ? [text] : [];
}

function accountDetectionConfig(pluginConfig = {}, accountId = "") {
  const detection = pluginConfig?.mentionDetection || {};
  const accounts = detection.accounts && typeof detection.accounts === "object" ? detection.accounts : {};
  return {
    ...detection,
    ...(accountId && accounts[accountId] && typeof accounts[accountId] === "object" ? accounts[accountId] : {})
  };
}

function configuredBotIds(cfg = {}, pluginConfig = {}, accountId = "") {
  const ids = new Set();
  const discord = cfg?.channels?.discord || {};
  const account = accountId ? discord.accounts?.[accountId] : null;
  const detection = accountDetectionConfig(pluginConfig, accountId);
  for (const value of [
    discord.botUserId,
    discord.botId,
    discord.applicationId,
    discord.clientId,
    account?.botUserId,
    account?.botId,
    account?.applicationId,
    account?.clientId,
    ...arrayValues(detection.botUserIds),
    ...arrayValues(detection.botIds),
    ...arrayValues(detection.applicationIds),
    ...arrayValues(detection.clientIds)
  ]) {
    const text = textValue(value);
    if (/^\d{15,25}$/.test(text)) ids.add(text);
  }
  for (const token of [discord.token, account?.token]) {
    const parsed = parseTokenUserId(token);
    if (parsed) ids.add(parsed);
  }
  return [...ids];
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function configuredMentionNames(cfg = {}, pluginConfig = {}, accountId = "", agentId = "") {
  const names = new Set();
  const agent = resolveAgentConfig(cfg, agentId);
  const account = accountId ? cfg?.channels?.discord?.accounts?.[accountId] : null;
  const detection = accountDetectionConfig(pluginConfig, accountId);
  for (const value of [
    agent?.identity?.name,
    agent?.name,
    account?.botUserName,
    account?.username,
    account?.name,
    ...arrayValues(detection.names),
    ...arrayValues(detection.botNames)
  ]) {
    const text = textValue(value);
    if (text) names.add(text);
  }
  return [...names];
}

function configuredMentionPatterns(cfg = {}, pluginConfig = {}, accountId = "", agentId = "") {
  const agent = resolveAgentConfig(cfg, agentId);
  const agentGroupChat = agent?.groupChat;
  const globalGroupChat = cfg?.messages?.groupChat;
  const detection = accountDetectionConfig(pluginConfig, accountId);
  const source = [];
  if (agentGroupChat && Object.hasOwn(agentGroupChat, "mentionPatterns")) {
    source.push(...arrayValues(agentGroupChat.mentionPatterns));
  } else if (globalGroupChat && Object.hasOwn(globalGroupChat, "mentionPatterns")) {
    source.push(...arrayValues(globalGroupChat.mentionPatterns));
  }
  source.push(...arrayValues(detection.patterns), ...arrayValues(detection.mentionPatterns));
  return source;
}

function matchesConfiguredName(text, names = []) {
  const normalized = normalizeMentionText(text);
  return names.some((name) => {
    const parts = normalizeMentionText(name).split(/\s+/).filter(Boolean).map(escapeRegExp);
    if (parts.length === 0) return false;
    const pattern = String.raw`(^|[^\p{L}\p{N}_])@?${parts.join(String.raw`\s+`)}([^\p{L}\p{N}_]|$)`;
    try {
      return new RegExp(pattern, "iu").test(normalized);
    } catch {
      return normalized.includes(`@${normalizeMentionText(name)}`);
    }
  });
}

function matchesConfiguredPatterns(text, patterns = []) {
  return patterns.some((pattern) => {
    try {
      return new RegExp(pattern, "i").test(text);
    } catch {
      return false;
    }
  });
}

function matchesDiscordBotMention(text, ids = []) {
  return ids.some((id) => new RegExp(String.raw`<@!?${escapeRegExp(id)}>`, "i").test(text));
}

export function deriveMentionFact(event = {}, ctx = {}, cfg = {}, pluginConfig = {}) {
  const text = messageText(event, ctx);
  if (!text) return undefined;
  const accountId = textValue(ctx.accountId, event.accountId, event.metadata?.accountId, "default");
  const agentId = agentIdFromSessionKey(ctx.sessionKey, event.sessionKey);
  const botIds = configuredBotIds(cfg, pluginConfig, accountId);
  if (matchesDiscordBotMention(text, botIds)) return true;
  if (matchesConfiguredPatterns(text, configuredMentionPatterns(cfg, pluginConfig, accountId, agentId))) return true;
  if (matchesConfiguredName(text, configuredMentionNames(cfg, pluginConfig, accountId, agentId))) return true;
  return undefined;
}

export function withDerivedMentionFact(state, event = {}, ctx = {}, cfg = {}, pluginConfig = {}) {
  const recalled = withRecalledMentionFact(state, event, ctx);
  if (typeof recalled.event.wasMentioned === "boolean" || typeof recalled.ctx.wasMentioned === "boolean") {
    return recalled;
  }
  const mentioned = deriveMentionFact(recalled.event, recalled.ctx, cfg, pluginConfig);
  if (typeof mentioned !== "boolean") return recalled;
  return {
    event: { ...recalled.event, wasMentioned: mentioned },
    ctx: { ...recalled.ctx, wasMentioned: mentioned }
  };
}

function appendPolicySystemPrompt(ctx = {}, text = "") {
  if (!ctx || typeof ctx !== "object" || !text) return;
  const existing = typeof ctx.GroupSystemPrompt === "string" ? ctx.GroupSystemPrompt.trim() : "";
  ctx.GroupSystemPrompt = existing ? `${existing}\n\n${text}` : text;
}

export function forceMentionedDispatchContext(ctx = {}) {
  if (!ctx || typeof ctx !== "object") return;
  ctx.WasMentioned = true;
  ctx.wasMentioned = true;
  ctx.ExplicitlyMentionedBot = true;
  ctx.MentionSource = "extra-message-policy:always-reply";
  appendPolicySystemPrompt(ctx, "Runtime panel policy: Always Reply is enabled for this channel. Treat this message as addressed to you and produce a normal visible reply unless another higher-priority safety or permission rule prevents it.");
}

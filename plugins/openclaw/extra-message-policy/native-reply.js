export function normalizeNativeReplyHandling(raw = {}) {
  const platforms = Array.isArray(raw.platforms)
    ? raw.platforms.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean)
    : ["discord"];
  return {
    enabled: raw.enabled !== false,
    platforms: platforms.length ? platforms : ["discord"]
  };
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function platformFromContext(ctx = {}) {
  return firstString(
    ctx.Channel,
    ctx.channel,
    ctx.Platform,
    ctx.platform,
    ctx.Provider,
    ctx.provider,
    ctx.metadata?.channel,
    ctx.metadata?.platform,
    ctx.metadata?.provider
  ).toLowerCase();
}

function isDiscordContext(ctx = {}) {
  const platform = platformFromContext(ctx);
  if (platform === "discord") return true;
  if (/(^|:)discord(:|$)/i.test(firstString(ctx.SessionKey, ctx.sessionKey))) return true;
  if (firstString(ctx.guildId, ctx.GuildId, ctx.rawGuildId, ctx.GroupSpace)) return true;
  return false;
}

function outboundReplyTarget(event = {}) {
  return firstString(
    event.replyTo,
    event.replyToId,
    event.reply_to,
    event.reply_to_id,
    event.message_reference?.message_id,
    event.messageReference?.messageId,
    event.channelData?.discord?.message_reference?.message_id,
    event.channelData?.discord?.replyTo
  );
}

function sourceReplyTarget(ctx = {}) {
  return firstString(
    ctx.ReplyTo,
    ctx.replyTo,
    ctx.ReplyToId,
    ctx.replyToId,
    ctx.InboundMessageId,
    ctx.inboundMessageId,
    ctx.SourceMessageId,
    ctx.sourceMessageId,
    ctx.TriggerMessageId,
    ctx.triggerMessageId,
    ctx.MessageId,
    ctx.messageId,
    ctx.metadata?.replyTo,
    ctx.metadata?.replyToId,
    ctx.metadata?.inboundMessageId,
    ctx.metadata?.sourceMessageId,
    ctx.metadata?.triggerMessageId,
    ctx.metadata?.messageId,
    ctx.source?.messageId,
    ctx.source?.id,
    ctx.inbound?.messageId,
    ctx.inbound?.id,
    ctx.trigger?.messageId,
    ctx.trigger?.id
  );
}

export function applyNativeReplyHandling(event = {}, ctx = {}, nativeReplyHandling = normalizeNativeReplyHandling()) {
  if (!nativeReplyHandling.enabled) return null;
  if (!nativeReplyHandling.platforms.includes("discord") || !isDiscordContext(ctx)) return null;
  if (outboundReplyTarget(event)) return null;
  const replyTo = sourceReplyTarget(ctx);
  if (!replyTo) return null;
  return { replyTo };
}

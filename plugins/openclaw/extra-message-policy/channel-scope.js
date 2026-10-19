// Mandatory admission is independent of mutable response/ingestion policy rules.
const value = (...items) => items.find(x => typeof x === 'string' && x.trim())?.trim() || '';
const bare = x => x.replace(/^(?:channel|chat):/, '');
const snowflake = (...items) => items.map(x => bare(String(x || ''))).find(x => /^\d+$/.test(x)) || '';
export function normalizeChannelScopes(raw) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error('discordChannelScopes must be an array');
  return raw.map(scope => {
    if (!scope || !scope.accountId || !scope.guildId || !Array.isArray(scope.channelIds) || !scope.channelIds.length ||
        !scope.channelIds.every(id => typeof id === 'string' && /^\d+$/.test(id)) ||
        (scope.agentIds !== undefined && (!Array.isArray(scope.agentIds) || !scope.agentIds.every(id => typeof id === 'string' && id)))) {
      throw new Error('Invalid mandatory Discord channel scope');
    }
    return { accountId: String(scope.accountId), guildId: String(scope.guildId), channelIds: [...new Set(scope.channelIds)], agentIds: scope.agentIds || [] };
  });
}
export function scopeRoute(event = {}, ctx = {}) {
  const meta = { ...event.metadata, ...ctx.metadata };
  const session = value(ctx.sessionKey, ctx.SessionKey, event.sessionKey, event.SessionKey);
  return {
    accountId: value(ctx.accountId, ctx.AccountId, event.accountId, event.AccountId, meta.accountId),
    guildId: value(ctx.rawGuildId, ctx.GroupSpace, ctx.guildId, event.rawGuildId, event.guildId, meta.rawGuildId, meta.guildId, meta.guild_id),
    channelId: snowflake(ctx.NativeChannelId, ctx.ChannelId, ctx.channelId, event.channelId, event.ChannelId, meta.channelId, meta.channel_id, ctx.conversationId, event.conversationId, session.match(/:channel:([^:]+)/)?.[1]),
    parentChannelId: value(ctx.parentChannelId, ctx.ParentChannelId, ctx.ThreadParentId, event.parentChannelId, meta.parentChannelId, meta.threadParentId, meta.thread_parent_id),
    agentId: value(ctx.agentId, ctx.AgentId, event.agentId, session.match(/^agent:([^:]+):/)?.[1])
  };
}
export function activeChannelScope(scopes = [], event = {}, ctx = {}) {
  const route = scopeRoute(event, ctx);
  const session = value(ctx.sessionKey, ctx.SessionKey, event.sessionKey, event.SessionKey);
  const knownDirect = ctx.ChatType === 'direct' || event.ChatType === 'direct' ||
    /^agent:[^:]+:discord:direct:[^:]+$/.test(session);
  return scopes.find(scope => scope.agentIds.includes(route.agentId) ||
    (!knownDirect && route.accountId === scope.accountId && (!route.guildId || route.guildId === scope.guildId)));
}
const externalKeys = new Set([
  'ReplyToId', 'ReplyToIdFull', 'ReplyToBody', 'ReplyToSender', 'ReplyToIsQuote', 'replyToId', 'replyToIdFull', 'replyToBody', 'replyToSender', 'replyToIsQuote',
  'ThreadStarterBody', 'threadStarterBody', 'starterBody', 'quote', 'quotedMessage',
  'ThreadHistoryBody', 'threadHistoryBody', 'media', 'originalMedia', 'mediaStagingPending', 'MediaPath', 'MediaPaths', 'MediaUrl', 'MediaUrls', 'MediaType', 'MediaTypes', 'referenced_message', 'referencedMessage', 'message_reference', 'messageReference',
  'message_snapshots', 'messageSnapshots', 'ForwardedFrom', 'ForwardedFromId', 'forwarded',
  'forwardedFrom', 'replyContext', 'replyTo', 'quotedAttachments'
]);
export function hasUnverifiedSupplementalContext(...objects) {
  const seen = new Set();
  const visit = object => {
    if (!object || typeof object !== 'object' || seen.has(object)) return false;
    seen.add(object);
    for (const [key, item] of Object.entries(object)) {
      if (externalKeys.has(key) && item !== undefined && item !== null && item !== '' && item !== false && (!Array.isArray(item) || item.length)) return true;
      if (typeof item === 'object' && visit(item)) return true;
      // Discord's native forwarded envelope may already be flattened at hooks.
      if (typeof item === 'string' && /\[Forwarded (?:message|content)/i.test(item)) return true;
    }
    return false;
  };
  return objects.some(visit);
}
export function admitChannelScope(scopes, event = {}, ctx = {}) {
  const scope = activeChannelScope(scopes, event, ctx);
  if (!scope) return { allowed: true, protected: false };
  const route = scopeRoute(event, ctx);
  const allowed = route.accountId === scope.accountId && route.guildId === scope.guildId &&
    (scope.channelIds.includes(route.channelId) || (route.channelId && scope.channelIds.includes(route.parentChannelId))) &&
    !hasUnverifiedSupplementalContext(event, ctx);
  return { allowed: Boolean(allowed), protected: true, scope, route };
}
export function recallChannelScope(scopes, ctx = {}) {
  const route = scopeRoute({}, ctx);
  return (scopes || []).find(s => s.agentIds.includes(route.agentId) || (route.accountId === s.accountId && route.guildId === s.guildId));
}
export function admittedRecallRecord(record, scopes, ctx = {}, discordOptOut = {}) {
  const scope = recallChannelScope(scopes, ctx);
  if (!scope) return true; // Preserve unrelated guild/agent recall behavior.
  // Old mixed records may already contain flattened quotes. Only post-boundary
  // records have the sink admission stamp; no migration invents provenance.
  if (record?.channelScopeAdmission !== 1 || record.accountId !== scope.accountId || record.guildId !== scope.guildId) return false;
  if (discordOptOut[scope.accountId]?.includes(record.senderId)) return false;
  return admitChannelScope([scope], record, {}).allowed;
}

import { applyNativeMentionGatePolicy, resolveNativeRequireMentionStatus } from "./policy-command.js";
import { resolvePolicy } from "./policy.js";

const DISCORD_API = "https://discord.com/api/v10";

function textValue(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function stripConversationPrefix(value) {
  return String(value || "").replace(/^(channel|chat|user):/, "");
}

function boolText(value) {
  return typeof value === "boolean" ? String(value) : "unset";
}

function accountConfig(openclawConfig = {}, accountId = "") {
  return openclawConfig?.channels?.discord?.accounts?.[accountId] || null;
}

function discordTokenForAccount(openclawConfig = {}, accountId = "") {
  const account = accountConfig(openclawConfig, accountId);
  const token = account?.token || openclawConfig?.channels?.discord?.token;
  if (typeof token === "string") return token;
  if (token && typeof token === "object") {
    if (token.source === "env" && token.id) return process.env[token.id] || "";
    if (typeof token.value === "string") return token.value;
  }
  return "";
}

async function discordFetch(fetchImpl, token, route) {
  const res = await fetchImpl(`${DISCORD_API}${route}`, {
    headers: { authorization: `Bot ${token}` }
  });
  const text = await res.text().catch(() => "");
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json, text };
}

async function listDiscordGuildChannels(fetchImpl, token, guildId) {
  const result = await discordFetch(fetchImpl, token, `/guilds/${encodeURIComponent(guildId)}/channels`);
  if (!result.ok || !Array.isArray(result.json)) {
    return {
      ok: false,
      status: result.status,
      channels: [],
      error: `discord_channels_${result.status || "failed"}`
    };
  }
  return {
    ok: true,
    status: result.status,
    channels: result.json.map((channel) => ({
      id: textValue(channel.id),
      name: textValue(channel.name),
      type: channel.type,
      parentId: textValue(channel.parent_id)
    })).filter((channel) => channel.id)
  };
}

async function probeReadAccess(fetchImpl, token, channelId) {
  const result = await discordFetch(fetchImpl, token, `/channels/${encodeURIComponent(channelId)}/messages?limit=1`);
  if (result.ok) return { access: "readable", status: result.status };
  if (result.status === 403 || result.status === 404) return { access: "no_access", status: result.status };
  if (result.status === 429) return { access: "rate_limited", status: result.status };
  return { access: "unknown", status: result.status || null };
}

function addCandidate(map, candidate = {}) {
  const id = textValue(candidate.id, candidate.channelId);
  if (!id) return;
  const existing = map.get(id) || {};
  map.set(id, {
    ...existing,
    ...candidate,
    id,
    name: textValue(existing.name, candidate.name),
    parentId: textValue(existing.parentId, candidate.parentId)
  });
}

function configuredChannelCandidates(openclawConfig = {}, pluginConfig = {}, accountId = "", guildId = "") {
  const candidates = new Map();
  const account = accountConfig(openclawConfig, accountId);
  const guild = account?.guilds?.[guildId] || openclawConfig?.channels?.discord?.guilds?.[guildId] || {};
  for (const [channelId, channelCfg] of Object.entries(guild.channels || {})) {
    if (channelId !== "*") addCandidate(candidates, { id: stripConversationPrefix(channelId), source: "native-config", nativeConfigured: true, nativeChannelConfig: channelCfg || {} });
  }
  for (const rule of pluginConfig.policies || []) {
    if (rule.channelId) addCandidate(candidates, { id: stripConversationPrefix(rule.channelId), source: "policy-config" });
    if (rule.conversationId && /^channel:/.test(rule.conversationId)) {
      addCandidate(candidates, { id: stripConversationPrefix(rule.conversationId), source: "policy-config" });
    }
  }
  return [...candidates.values()];
}

function resolveNativeChannelPolicy(openclawConfig = {}, accountId = "", guildId = "", channel = {}) {
  const discord = openclawConfig?.channels?.discord || {};
  const account = accountConfig(openclawConfig, accountId) || {};
  const guild = account.guilds?.[guildId] || discord.guilds?.[guildId] || {};
  const channels = guild.channels || {};
  const channelCfg = channels[channel.id] || (channel.parentId ? channels[channel.parentId] : null) || channels["*"] || {};
  return {
    enabled: channelCfg.enabled ?? guild.enabled ?? account.enabled ?? discord.enabled,
    requireMention: channelCfg.requireMention ?? guild.requireMention ?? account.requireMention ?? discord.requireMention,
    source: channels[channel.id]
      ? `channels.discord.accounts.${accountId}.guilds.${guildId}.channels.${channel.id}`
      : channel.parentId && channels[channel.parentId]
        ? `channels.discord.accounts.${accountId}.guilds.${guildId}.channels.${channel.parentId}`
        : channels["*"]
          ? `channels.discord.accounts.${accountId}.guilds.${guildId}.channels.*`
          : "fallback"
  };
}

function policyForChannel(pluginConfig, openclawConfig, accountId, guildId, channel, options = {}) {
  const ctx = {
    platform: "discord",
    ...(options.includeAccount === false ? {} : { accountId }),
    guildId,
    rawGuildId: guildId,
    channelId: channel.id,
    conversationId: `channel:${channel.id}`,
    parentChannelId: channel.parentId,
    sessionKey: `agent:${accountId}:discord:channel:${channel.id}`,
    metadata: {
      ...(options.includeAccount === false ? {} : { accountId }),
      guildId,
      channelId: channel.id,
      parentChannelId: channel.parentId,
      to: `channel:${channel.id}`
    }
  };
  const event = {
    content: "",
    accountId: options.includeAccount === false ? undefined : accountId,
    guildId,
    channelId: channel.id,
    conversationId: `channel:${channel.id}`,
    metadata: ctx.metadata
  };
  const basePolicy = resolvePolicy(pluginConfig, event, ctx);
  let nativeStatus = null;
  try {
    nativeStatus = resolveNativeRequireMentionStatus(ctx, openclawConfig);
  } catch {
    nativeStatus = null;
  }
  const effectivePolicy = applyNativeMentionGatePolicy(basePolicy, nativeStatus, event, ctx);
  return {
    respond: effectivePolicy.respond,
    ingestMode: effectivePolicy.ingestMode,
    requireMention: effectivePolicy.requireMention === true,
    matched: effectivePolicy.matched,
    nativeMentionGate: effectivePolicy.nativeMentionGate === true
  };
}

function normalizeParams(params = {}) {
  const channelIds = Array.isArray(params.channelIds)
    ? params.channelIds.map((value) => stripConversationPrefix(textValue(value))).filter(Boolean)
    : [];
  return {
    accountId: textValue(params.accountId, "default"),
    guildId: textValue(params.guildId),
    channelIds,
    probeRead: params.probeRead !== false,
    onlyAccessible: params.onlyAccessible !== false,
    includeConfigured: params.includeConfigured !== false,
    includeDiscordList: params.includeDiscordList !== false,
    maxChannels: Math.max(1, Math.min(1000, Number(params.maxChannels || 500)))
  };
}

function formatAuditText(result) {
  const lines = [
    `Policy audit for account ${result.accountId} / guild ${result.guildId}`,
    `Channels: ${result.channels.length}${result.totalCandidates !== result.channels.length ? ` shown / ${result.totalCandidates} candidates` : ""}`,
    `Discord list: ${result.discordList.ok ? "ok" : result.discordList.error || "not used"}`
  ];
  for (const channel of result.channels.slice(0, 80)) {
    const name = channel.name ? `#${channel.name}` : "(unknown-name)";
    lines.push([
      `- ${name} ${channel.id}`,
      `access=${channel.access}`,
      `native.enabled=${boolText(channel.native.enabled)}`,
      `native.requireMention=${boolText(channel.native.requireMention)}`,
      `policy.respond=${channel.policy.respond}`,
      `policy.ingest=${channel.policy.ingestMode}`,
      `matched=${channel.policy.matched || "default"}`,
      channel.accountlessPolicy && channel.accountlessPolicy.matched !== channel.policy.matched
        ? `accountlessMatched=${channel.accountlessPolicy.matched || "default"}`
        : ""
    ].filter(Boolean).join(" | "));
  }
  if (result.channels.length > 80) lines.push(`... ${result.channels.length - 80} more omitted`);
  return lines.join("\n");
}

function textResult(text, details) {
  return {
    content: [{ type: "text", text }],
    details
  };
}

export function createPolicyAuditTool(api, pluginConfig, toolCtx = {}, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") return null;
  return {
    name: "list_extra_message_policies",
    label: "List Extra Message Policies",
    description: "List effective extra-message-policy response/ingest policy for Discord channels in a guild, optionally probing which channels the selected bot account can read. The tool never returns message content.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        accountId: {
          type: "string",
          description: "Discord account id configured in OpenClaw, for example chromiecraft-bot. Defaults to default."
        },
        guildId: {
          type: "string",
          description: "Discord guild/server id to audit."
        },
        channelIds: {
          type: "array",
          items: { type: "string" },
          description: "Optional explicit channel ids to audit instead of listing the whole guild."
        },
        probeRead: {
          type: "boolean",
          description: "When true, probe read access using Discord messages?limit=1 without returning content. Default true."
        },
        onlyAccessible: {
          type: "boolean",
          description: "When true, show only channels where the account can read. Default true."
        },
        includeConfigured: {
          type: "boolean",
          description: "Include channels referenced by native or extra-message-policy config. Default true."
        },
        includeDiscordList: {
          type: "boolean",
          description: "Use Discord guild channel listing when a token is available. Default true."
        },
        maxChannels: {
          type: "number",
          description: "Maximum channels to inspect, capped at 1000. Default 500."
        }
      },
      required: ["guildId"]
    },
    displaySummary: "Audit extra-message-policy per Discord channel.",
    async execute(_toolCallId, params = {}) {
      const normalized = normalizeParams(params);
      const openclawConfig = api.runtime?.config?.current?.() || api.config || {};
      const token = discordTokenForAccount(openclawConfig, normalized.accountId);
      const candidates = new Map();
      let discordList = { ok: false, status: null, error: "not_used", channels: [] };

      if (normalized.includeDiscordList && token && normalized.channelIds.length === 0) {
        discordList = await listDiscordGuildChannels(fetchImpl, token, normalized.guildId);
        for (const channel of discordList.channels) addCandidate(candidates, { ...channel, source: "discord-list" });
      }

      if (normalized.channelIds.length > 0) {
        for (const id of normalized.channelIds) addCandidate(candidates, { id, source: "explicit" });
      }

      if (normalized.includeConfigured) {
        for (const channel of configuredChannelCandidates(openclawConfig, pluginConfig, normalized.accountId, normalized.guildId)) {
          addCandidate(candidates, channel);
        }
      }

      const rows = [];
      for (const channel of [...candidates.values()].slice(0, normalized.maxChannels)) {
        let probe = { access: token && normalized.probeRead ? "unknown" : "not_probed", status: null };
        if (token && normalized.probeRead) probe = await probeReadAccess(fetchImpl, token, channel.id);
        if (normalized.onlyAccessible && probe.access !== "readable") continue;
        const native = resolveNativeChannelPolicy(openclawConfig, normalized.accountId, normalized.guildId, channel);
        const policy = policyForChannel(pluginConfig, openclawConfig, normalized.accountId, normalized.guildId, channel);
        const accountlessPolicy = policyForChannel(pluginConfig, openclawConfig, normalized.accountId, normalized.guildId, channel, { includeAccount: false });
        rows.push({
          id: channel.id,
          name: channel.name,
          type: channel.type,
          parentId: channel.parentId,
          access: probe.access,
          accessStatus: probe.status,
          native,
          policy,
          accountlessPolicy
        });
      }

      rows.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
      const result = {
        accountId: normalized.accountId,
        guildId: normalized.guildId,
        totalCandidates: candidates.size,
        discordList: {
          ok: discordList.ok,
          status: discordList.status,
          error: discordList.error || ""
        },
        channels: rows
      };
      return textResult(formatAuditText(result), result);
    }
  };
}

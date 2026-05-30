import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { wasMentioned } from "./policy.js";

const RESPONSE_MODES = Object.freeze(["off", "mention", "always"]);
const RUNTIME_INGEST_MODES = Object.freeze(["off", "passive", "responseCandidates", "all"]);
const DASHBOARD_NAMESPACE = "policy";

const DEFAULT_RUNTIME_POLICY = Object.freeze({
  responseMode: "off",
  ingestMode: "off"
});

const CONFIG_RUNTIME_CANDIDATES = [
  "/opt/openclaw-vendor-runtime/dist/plugin-sdk/config-runtime.js",
  ...(process.env.HOME ? [path.join(process.env.HOME, ".local/lib/node_modules/openclaw/dist/plugin-sdk/config-runtime.js")] : []),
  "/usr/lib/node_modules/openclaw/dist/plugin-sdk/config-runtime.js",
  "/usr/local/lib/node_modules/openclaw/dist/plugin-sdk/config-runtime.js"
];

let configRuntimePromise;

function textValue(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function stripConversationPrefix(value) {
  let text = String(value || "").trim();
  for (let i = 0; i < 4; i += 1) {
    const next = text.replace(/^(channel|chat|user):/, "");
    if (next === text) break;
    text = next;
  }
  return text;
}

function parentChannelValue(...values) {
  return stripConversationPrefix(textValue(...values));
}

function encodeDashboardScope(scope = {}) {
  const compact = {
    f: scope.platform || "",
    a: scope.accountId || "",
    g: scope.guildId || "",
    c: scope.channelId || "",
    z: scope.conversationId || "",
    p: scope.parentChannelId || ""
  };
  return Buffer.from(JSON.stringify(compact), "utf8").toString("base64url");
}

function decodeDashboardScope(raw) {
  try {
    const parsed = JSON.parse(Buffer.from(String(raw || ""), "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    return {
      platform: textValue(parsed.f),
      accountId: textValue(parsed.a),
      guildId: textValue(parsed.g),
      channelId: textValue(parsed.c),
      conversationId: textValue(parsed.z),
      parentChannelId: textValue(parsed.p)
    };
  } catch {
    return null;
  }
}

export function contextFromPolicyScope(scope = {}, fallback = {}) {
  const conversationId = textValue(scope.conversationId, scope.channelId, fallback.conversationId);
  const channelId = textValue(scope.channelId, scope.conversationId, fallback.channelId);
  const parentChannelId = textValue(scope.parentChannelId, scope.channelId, fallback.parentChannelId, fallback.parentConversationId);
  return {
    ...fallback,
    platform: textValue(scope.platform, fallback.platform),
    accountId: textValue(scope.accountId, fallback.accountId),
    guildId: textValue(scope.guildId, fallback.guildId, fallback.rawGuildId),
    rawGuildId: textValue(scope.guildId, fallback.rawGuildId, fallback.guildId),
    channelId,
    conversationId,
    parentChannelId,
    parentConversationId: parentChannelId,
    metadata: {
      ...(fallback.metadata || {}),
      platform: textValue(scope.platform, fallback.metadata?.platform),
      accountId: textValue(scope.accountId, fallback.metadata?.accountId),
      guildId: textValue(scope.guildId, fallback.metadata?.guildId),
      channelId,
      parentChannelId
    }
  };
}

function isSlashInteractionTarget(value) {
  return String(value || "").trim().startsWith("slash:");
}

function nonSlashValue(...values) {
  for (const value of values) {
    const text = textValue(value);
    if (text && !isSlashInteractionTarget(text)) return text;
  }
  return "";
}

function discordSessionScope(...values) {
  for (const value of values) {
    const text = textValue(value);
    if (!text) continue;
    const parts = text.split(":").filter(Boolean);
    const discordIndex = parts.indexOf("discord");
    if (discordIndex === -1) continue;

    const scope = {};
    for (let i = discordIndex + 1; i < parts.length - 1; i += 1) {
      const key = parts[i].toLowerCase();
      const next = stripConversationPrefix(parts[i + 1]);
      if (!next) continue;
      if ((key === "guild" || key === "guilds") && !scope.guildId) {
        scope.guildId = next;
      } else if ((key === "channel" || key === "thread") && !scope.channelId) {
        scope.channelId = next;
      }
    }
    if (scope.guildId || scope.channelId) return scope;
  }
  return {};
}

function platformFromContext(event = {}, ctx = {}) {
  const explicit = textValue(
    ctx.platform,
    ctx.provider,
    ctx.surface,
    event.platform,
    event.provider,
    event.surface,
    ctx.metadata?.platform,
    ctx.metadata?.provider,
    event.metadata?.platform,
    event.metadata?.provider
  ).toLowerCase();
  if (explicit.includes("telegram")) return "telegram";
  if (explicit.includes("discord")) return "discord";

  const sessionKey = textValue(ctx.sessionKey, ctx.message?.sessionKey, ctx.metadata?.sessionKey, event.sessionKey, event.metadata?.sessionKey).toLowerCase();
  if (sessionKey.includes("telegram:")) return "telegram";
  if (sessionKey.includes("discord:")) return "discord";

  return "discord";
}

function normalizeResponseMode(value, fallback = DEFAULT_RUNTIME_POLICY.responseMode) {
  return RESPONSE_MODES.includes(value) ? value : fallback;
}

function normalizeRuntimeIngestMode(value, fallback = DEFAULT_RUNTIME_POLICY.ingestMode) {
  if (RUNTIME_INGEST_MODES.includes(value)) return value;
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "responsecandidates" || normalized === "candidates") return "responseCandidates";
  return RUNTIME_INGEST_MODES.includes(normalized) ? normalized : fallback;
}

function normalizeRuntimePolicy(raw = {}, fallback = DEFAULT_RUNTIME_POLICY) {
  return {
    responseMode: normalizeResponseMode(raw.responseMode, fallback.responseMode),
    ingestMode: normalizeRuntimeIngestMode(raw.ingestMode, fallback.ingestMode)
  };
}

export function normalizePolicyCommandConfig(raw = {}) {
  return {
    enabled: raw.policyCommand?.enabled !== false,
    commandName: String(raw.policyCommand?.commandName || raw.commandName || "policy").replace(/^\//, "") || "policy",
    applyDefault: raw.policyCommand?.applyDefault === true,
    defaultRuntimePolicy: normalizeRuntimePolicy(raw.policyCommand?.defaultPolicy || raw.defaultRuntimePolicy || DEFAULT_RUNTIME_POLICY),
    statePath: textValue(raw.policyCommand?.statePath, raw.statePath)
  };
}

export function defaultPolicyStatePath(api, commandConfig) {
  if (commandConfig.statePath) {
    return path.isAbsolute(commandConfig.statePath) ? commandConfig.statePath : path.resolve(process.cwd(), commandConfig.statePath);
  }
  try {
    return path.join(api.runtime.state.resolveStateDir(api.config), "extra-message-policy", "policy-state.json");
  } catch {
    return path.resolve(process.cwd(), "runtime/extra-message-policy/policy-state.json");
  }
}

export function normalizePolicyState(raw = {}) {
  const scopes = {};
  if (raw?.scopes && typeof raw.scopes === "object") {
    for (const [key, value] of Object.entries(raw.scopes)) {
      if (!key || !value || typeof value !== "object") continue;
      scopes[key] = {
        ...value,
        policy: normalizeRuntimePolicy(value.policy || value)
      };
    }
  }
  return { version: 1, scopes };
}

export async function loadPolicyState(filePath) {
  try {
    return normalizePolicyState(JSON.parse(await readFile(filePath, "utf8")));
  } catch {
    return normalizePolicyState();
  }
}

export async function savePolicyState(filePath, state) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(normalizePolicyState(state), null, 2), "utf8");
}

export function scopeFromContext(event = {}, ctx = {}) {
  const platform = platformFromContext(event, ctx);
  const sessionScope = discordSessionScope(
    ctx.sessionKey,
    ctx.message?.sessionKey,
    ctx.metadata?.sessionKey,
    event.sessionKey,
    event.metadata?.sessionKey
  );
  const accountId = textValue(ctx.accountId, event.accountId, event.metadata?.accountId, "default");
  const guildId = platform === "discord" ? textValue(
    ctx.guildId,
    ctx.rawGuildId,
    ctx.GroupSpace,
    ctx.groupSpace,
    ctx.message?.guildId,
    ctx.message?.guild_id,
    ctx.interaction?.guildId,
    ctx.interaction?.guild_id,
    ctx.raw?.guildId,
    ctx.raw?.guild_id,
    event.guildId,
    event.guild_id,
    event.raw?.guildId,
    event.raw?.guild_id,
    event.metadata?.guildId,
    event.metadata?.guild_id,
    sessionScope.guildId
  ) : "";
  const directChannelId = textValue(
    ctx.threadId,
    ctx.messageThreadId,
    ctx.MessageThreadId,
    ctx.message?.threadId,
    ctx.message?.thread_id,
    ctx.messageChannelId,
    ctx.metadata?.threadId,
    ctx.metadata?.thread_id,
    event.threadId,
    event.thread_id,
    event.metadata?.threadId,
    event.metadata?.thread_id
  );
  const parentChannelId = stripConversationPrefix(textValue(
    ctx.parentChannelId,
    ctx.parentConversationId,
    ctx.parentId,
    ctx.ParentId,
    ctx.threadParentId,
    ctx.ThreadParentId,
    ctx.NativeParentChannelId,
    ctx.ParentChannelId,
    ctx.messageParentChannelId,
    ctx.message?.parentChannelId,
    ctx.message?.parent_channel_id,
    ctx.message?.parentId,
    ctx.message?.parent_id,
    ctx.metadata?.parentChannelId,
    ctx.metadata?.parent_channel_id,
    ctx.metadata?.parentId,
    ctx.metadata?.parent_id,
    ctx.metadata?.threadParentId,
    ctx.metadata?.thread_parent_id,
    ctx.raw?.parentId,
    ctx.raw?.parent_id,
    event.parentChannelId,
    event.parentConversationId,
    event.parentId,
    event.parent_id,
    event.threadParentId,
    event.thread_parent_id,
    event.metadata?.parentChannelId,
    event.metadata?.parent_channel_id,
    event.metadata?.parentId,
    event.metadata?.parent_id,
    event.metadata?.threadParentId,
    event.metadata?.thread_parent_id,
    event.raw?.parentId,
    event.raw?.parent_id
  ));
  const directParentAwareChannelId = textValue(
    parentChannelId,
    ctx.metadata?.channelId,
    ctx.metadata?.channel_id
  );
  const rawConversationId = nonSlashValue(
    ctx.conversationId,
    event.conversationId,
    event.metadata?.to,
    ctx.chatId,
    ctx.chat_id,
    event.chatId,
    event.chat_id,
    ctx.metadata?.chatId,
    ctx.metadata?.chat_id,
    event.metadata?.chatId,
    event.metadata?.chat_id
  );
  const rawTarget = nonSlashValue(
    ctx.To,
    ctx.to,
    ctx.target,
    ctx.chatId,
    ctx.raw?.channelId,
    ctx.raw?.channel_id,
    event.raw?.channelId,
    event.raw?.channel_id,
    event.to,
    event.from,
    event.metadata?.from
  );
  const conversationId = stripConversationPrefix(
    directChannelId || rawConversationId || rawTarget
  );
  const channelId = stripConversationPrefix(textValue(
    directParentAwareChannelId,
    ctx.channelId,
    ctx.messageChannelId,
    ctx.message?.channelId,
    ctx.message?.channel_id,
    ctx.interaction?.channelId,
    ctx.interaction?.channel_id,
    ctx.raw?.channelId,
    ctx.raw?.channel_id,
    event.channelId,
    event.channel_id,
    event.channel,
    event.raw?.channelId,
    event.raw?.channel_id,
    event.metadata?.channelId,
    event.metadata?.channel_id,
    ctx.chatId,
    ctx.chat_id,
    event.chatId,
    event.chat_id,
    ctx.metadata?.chatId,
    ctx.metadata?.chat_id,
    event.metadata?.chatId,
    event.metadata?.chat_id,
    sessionScope.channelId
  ));
  return {
    platform,
    accountId,
    guildId,
    channelId,
    parentChannelId,
    conversationId,
    key: [platform, accountId || "default", guildId || "-", conversationId || channelId || "-"].join(":")
  };
}

function runtimeScopeKey(scope = {}, zoneId) {
  return [scope.platform || "discord", scope.accountId || "default", scope.guildId || "-", zoneId || "-"].join(":");
}

function runtimeScopeCandidates(scope = {}) {
  const candidates = [];
  const exactZone = scope.conversationId || scope.channelId || "-";
  candidates.push({
    key: runtimeScopeKey(scope, exactZone),
    kind: "exact",
    scope
  });
  const parentZone = scope.parentChannelId || scope.channelId;
  if (parentZone && parentZone !== exactZone) {
    candidates.push({
      key: runtimeScopeKey(scope, parentZone),
      kind: "parent",
      scope: {
        ...scope,
        conversationId: parentZone,
        channelId: parentZone,
        parentChannelId: ""
      }
    });
  }
  return candidates;
}

function scopeWithGuildFromRuntimeKey(scope, key) {
  const parts = String(key || "").split(":");
  if (parts.length < 4) return scope;
  return {
    ...scope,
    platform: parts[0] || scope.platform,
    accountId: parts[1] || scope.accountId,
    guildId: parts[2] === "-" ? "" : parts[2]
  };
}

function findRuntimeScopeEntry(normalizedState, candidate) {
  const exactEntry = normalizedState.scopes[candidate.key];
  if (exactEntry?.policy) {
    return {
      ...candidate,
      key: candidate.key,
      scope: candidate.scope,
      policy: exactEntry.policy
    };
  }

  const zoneId = candidate.scope?.conversationId || candidate.scope?.channelId || "";
  if (!zoneId || candidate.scope?.guildId) return null;

  const platform = candidate.scope?.platform || "discord";
  const accountId = candidate.scope?.accountId || "default";
  const prefix = `${platform}:${accountId}:`;
  const suffix = `:${zoneId}`;
  const matches = Object.entries(normalizedState.scopes).filter(([key, value]) => (
    key.startsWith(prefix)
    && key.endsWith(suffix)
    && value?.policy
  ));
  if (matches.length !== 1) return null;

  const [key, entry] = matches[0];
  return {
    ...candidate,
    key,
    scope: scopeWithGuildFromRuntimeKey(candidate.scope, key),
    policy: entry.policy
  };
}

function runtimeToBasePolicy(runtimePolicy) {
  const responseMode = normalizeResponseMode(runtimePolicy.responseMode);
  const ingestMode = normalizeRuntimeIngestMode(runtimePolicy.ingestMode);
  return {
    respond: responseMode !== "off",
    requireMention: responseMode === "mention",
    ingestMode: ingestMode === "off" ? "none" : ingestMode,
    runtimeResponseMode: responseMode,
    runtimeIngestMode: ingestMode
  };
}

export function resolveRuntimePolicyOverride(commandConfig, state, event = {}, ctx = {}) {
  const scope = scopeFromContext(event, ctx);
  const normalizedState = normalizePolicyState(state);
  let matched = null;
  for (const candidate of runtimeScopeCandidates(scope)) {
    matched = findRuntimeScopeEntry(normalizedState, candidate);
    if (!matched) continue;
    break;
  }
  const override = matched?.policy;
  if (!override && !commandConfig.applyDefault) return null;
  const runtimePolicy = override || commandConfig.defaultRuntimePolicy;
  return {
    ...runtimeToBasePolicy(runtimePolicy),
    runtimeMatched: override ? matched.key : "runtime-default",
    runtimeInherited: matched?.kind === "parent",
    runtimeScope: scope,
    runtimeMatchedScope: matched?.scope || scope
  };
}

export function applyRuntimePolicy(basePolicy, runtimeOverride, event = {}, ctx = {}) {
  const merged = {
    ...basePolicy,
    respond: runtimeOverride.respond,
    ingestMode: runtimeOverride.ingestMode,
    ...(runtimeOverride.requireMention ? { requireMention: true } : { requireMention: false }),
    runtimeResponseMode: runtimeOverride.runtimeResponseMode,
    runtimeIngestMode: runtimeOverride.runtimeIngestMode,
    runtimeMatched: runtimeOverride.runtimeMatched,
    runtimeScope: runtimeOverride.runtimeScope,
    matched: `${basePolicy.matched || "base"}+${runtimeOverride.runtimeMatched}`
  };
  if (!merged.requireMention) return merged;
  const mentioned = wasMentioned(event, ctx, merged) === true;
  return {
    ...merged,
    mentionRequired: true,
    mentionSatisfied: mentioned,
    respond: merged.respond && mentioned
  };
}

export function applyNativeMentionGatePolicy(policy = {}, nativeStatus = {}, event = {}, ctx = {}) {
  if (policy.runtimeResponseMode) return policy;
  if (nativeStatus?.status !== "on" || policy.requireMention === true) return policy;
  const merged = {
    ...policy,
    requireMention: true,
    nativeMentionGate: true,
    nativeMentionGateSource: nativeStatus.source || "",
    matched: `${policy.matched || "base"}+native-requireMention`
  };
  const mentioned = wasMentioned(event, ctx, merged) === true;
  return {
    ...merged,
    mentionRequired: true,
    mentionSatisfied: mentioned,
    respond: merged.respond && mentioned
  };
}

export function parsePolicyCommand(rawArgs = "") {
  const parts = String(rawArgs || "").trim().split(/\s+/).filter(Boolean);
  const section = (parts[0] || "status").toLowerCase();
  const value = (parts[1] || "").toLowerCase();
  if (["status", "show"].includes(section)) return { action: "status" };
  if (["reset", "clear"].includes(section)) return { action: "reset" };
  if (["response", "reply", "respond"].includes(section)) return { action: "set-response", value };
  if (["ingest", "read"].includes(section)) return { action: "set-ingest", value };
  if (["native", "native-require-mention", "require-mention", "config", "permanent"].includes(section)) return { action: "set-native-require", value };
  return { action: "help" };
}

export function parsePolicyDashboardAction(rawPayload = "") {
  const parts = String(rawPayload || "").trim().split(":");
  const section = (parts[0] || "status").toLowerCase();
  const value = parts[1] === "_" ? "" : (parts[1] || "");
  const normalizedValue = value.toLowerCase();
  const scope = decodeDashboardScope(parts[2] || "");
  if (["status", "refresh"].includes(section)) return { action: "status", scope };
  if (section === "details") return { action: "details", value: normalizedValue, scope, details: normalizedValue !== "hide" };
  if (section === "dismiss") return { action: "dismiss", scope };
  if (section === "reset") return { action: "reset", scope };
  if (section === "account") return { action: "select-account", value, scope: { ...(scope || {}), accountId: value } };
  if (section === "response") return { action: "set-response", value: normalizedValue, scope };
  if (section === "ingest") return { action: "set-ingest", value: normalizedValue, scope };
  if (section === "native") return { action: "set-native-require", value: normalizedValue, scope };
  return { action: "status", scope };
}

function nextResponseMode(current) {
  return current === "off" ? "mention" : "off";
}

function nextIngestMode(current) {
  return current === "off" ? "passive" : "off";
}

export function applyRuntimeCommand(commandConfig, state, event, ctx, command, actor = "") {
  const normalizedState = normalizePolicyState(state);
  const scope = scopeFromContext(event, ctx);
  const current = normalizedState.scopes[scope.key]?.policy || commandConfig.defaultRuntimePolicy;

  if (command.action === "reset") {
    delete normalizedState.scopes[scope.key];
    return { state: normalizedState, policy: commandConfig.defaultRuntimePolicy, scope, changed: true };
  }

  let next = normalizeRuntimePolicy(current);
  if (command.action === "set-response") {
    next = {
      ...next,
      responseMode: command.value === "toggle"
        ? nextResponseMode(next.responseMode)
        : normalizeResponseMode(command.value, next.responseMode)
    };
  } else if (command.action === "set-ingest") {
    next = {
      ...next,
      ingestMode: command.value === "toggle"
        ? nextIngestMode(next.ingestMode)
        : normalizeRuntimeIngestMode(command.value, next.ingestMode)
    };
  } else {
    return { state: normalizedState, policy: next, scope, changed: false };
  }

  normalizedState.scopes[scope.key] = {
    policy: next,
    updatedAt: new Date().toISOString(),
    updatedBy: actor || undefined
  };
  return { state: normalizedState, policy: next, scope, changed: true };
}

export function renderPolicyStatus(policy, scope) {
  const lines = [
    "Message policy",
    `- response: ${policy.runtimeResponseMode || policy.responseMode}`,
    `- ingest: ${policy.runtimeIngestMode || policy.ingestMode}`,
    `- account: ${scope.accountId || "default"}`,
    `- guild: ${scope.guildId || "(none)"}`,
    `- zone: ${scope.conversationId || scope.channelId || "(unknown)"}`
  ];
  if (policy.runtimeMatched === "runtime-default") {
    lines.push("- source: runtime default");
  } else if (policy.runtimeMatched) {
    lines.push("- source: runtime override");
  }
  return lines.join("\n");
}

export function renderPolicyHelp(commandName = "policy") {
  return [
    `Usage: /${commandName} status`,
    `/${commandName} response off|mention|always|toggle`,
    `/${commandName} ingest off|passive|responseCandidates|all|toggle`,
    `/${commandName} native on|off`,
    `/${commandName} reset`
  ].join("\n");
}

async function loadConfigRuntime() {
  if (!configRuntimePromise) {
    configRuntimePromise = (async () => {
      const errors = [];
      for (const candidate of CONFIG_RUNTIME_CANDIDATES) {
        try {
          return await import(candidate);
        } catch (err) {
          errors.push(`${candidate}: ${err?.message || err}`);
        }
      }
      throw new Error(`Unable to load OpenClaw config runtime. Tried: ${errors.join(" | ")}`);
    })();
  }
  return await configRuntimePromise;
}

function parseOnOff(raw) {
  const normalized = String(raw || "").trim().toLowerCase();
  if (normalized === "on") return true;
  if (normalized === "off") return false;
  return null;
}

function resolveDiscordAccountId(ctx = {}, cfg = {}) {
  const explicit = textValue(
    ctx.accountId,
    ctx.channelAccountId,
    ctx.message?.accountId,
    ctx.metadata?.accountId,
    ctx.metadata?.account_id
  );
  if (explicit) return explicit;
  if (cfg?.channels?.discord?.accounts?.default) return "default";
  const accounts = cfg?.channels?.discord?.accounts;
  const accountIds = accounts && typeof accounts === "object" ? Object.keys(accounts).filter(Boolean) : [];
  return accountIds.length === 1 ? accountIds[0] : "";
}

export function policyDashboardAccountsFromConfig(cfg = {}) {
  const accounts = new Map();
  const addAccount = (id, label = "") => {
    const normalizedId = textValue(id);
    if (!normalizedId || accounts.has(normalizedId)) return;
    accounts.set(normalizedId, {
      id: normalizedId,
      label: textValue(label, normalizedId)
    });
  };
  const discordAccounts = cfg?.channels?.discord?.accounts;
  if (discordAccounts && typeof discordAccounts === "object") {
    for (const [id, value] of Object.entries(discordAccounts)) {
      addAccount(id, value && typeof value === "object" ? value.name : "");
    }
  }
  const mentionAccounts = cfg?.plugins?.entries?.["extra-message-policy"]?.config?.mentionDetection?.accounts;
  if (mentionAccounts && typeof mentionAccounts === "object") {
    for (const id of Object.keys(mentionAccounts)) {
      addAccount(id);
    }
  }
  if (!accounts.size) addAccount("default");
  return [...accounts.values()].sort((a, b) => {
    if (a.id === "default") return -1;
    if (b.id === "default") return 1;
    return a.id.localeCompare(b.id);
  });
}

function resolveDiscordConfigScope(cfg = {}, accountId = "") {
  const discord = cfg?.channels?.discord;
  const accountCfg = accountId && discord?.accounts?.[accountId];
  if (accountCfg && typeof accountCfg === "object") {
    return {
      accountId,
      kind: "account",
      scope: accountCfg,
      path: `channels.discord.accounts.${accountId}`,
      label: `account:${accountId}`
    };
  }
  return {
    accountId,
    kind: "top-level",
    scope: discord,
    path: "channels.discord",
    label: "top-level"
  };
}

function inferDiscordGuildIdFromScope(discordScope, cfg, zoneId) {
  const guilds = discordScope?.guilds;
  if (!guilds || typeof guilds !== "object") return "";
  const entries = Object.entries(guilds).filter(([guildId, guildCfg]) => Boolean(guildId && guildCfg && typeof guildCfg === "object"));
  const exactChannelMatches = entries.filter(([, guildCfg]) => {
    const channels = guildCfg?.channels;
    return channels && typeof channels === "object" && channels[zoneId] && typeof channels[zoneId] === "object";
  });
  if (exactChannelMatches.length === 1) return exactChannelMatches[0][0];
  const bindingMatches = Array.isArray(cfg?.bindings)
    ? cfg.bindings.filter((binding) => binding?.match?.channel === "discord"
      && String(binding?.match?.peer?.id || "") === zoneId
      && typeof binding?.match?.guildId === "string"
      && binding.match.guildId.trim() !== "")
    : [];
  if (bindingMatches.length === 1) return String(bindingMatches[0].match.guildId);
  return entries.length === 1 ? entries[0][0] : "";
}

export function resolveNativeRequireMentionTarget(ctx = {}, cfg = {}) {
  const provider = textValue(
    ctx.messageProvider,
    ctx.provider,
    ctx.channel,
    ctx.message?.channel,
    ctx.message?.provider,
    ctx.metadata?.channel,
    ctx.metadata?.provider
  ).toLowerCase();
  if (provider && provider !== "discord") return { error: "This permanent config operation currently supports Discord only." };

  const directChannelId = textValue(
    ctx.threadId,
    ctx.messageThreadId,
    ctx.MessageThreadId,
    ctx.message?.threadId,
    ctx.channelId,
    ctx.messageChannelId,
    ctx.metadata?.threadId,
    ctx.metadata?.thread_id,
    ctx.metadata?.channelId,
    ctx.metadata?.channel_id
  );
  const parentChannelId = parentChannelValue(
    ctx.parentChannelId,
    ctx.parentConversationId,
    ctx.parentId,
    ctx.ParentId,
    ctx.threadParentId,
    ctx.ThreadParentId,
    ctx.NativeParentChannelId,
    ctx.ParentChannelId,
    ctx.messageParentChannelId,
    ctx.message?.parentChannelId,
    ctx.message?.parent_channel_id,
    ctx.message?.parentId,
    ctx.message?.parent_id,
    ctx.metadata?.parentChannelId,
    ctx.metadata?.parent_channel_id,
    ctx.metadata?.parentId,
    ctx.metadata?.parent_id,
    ctx.metadata?.threadParentId,
    ctx.metadata?.thread_parent_id,
    ctx.raw?.parentId,
    ctx.raw?.parent_id
  );
  const targetValue = textValue(ctx.To, ctx.to, ctx.target, ctx.conversationId, ctx.chatId);
  const zoneId = directChannelId || stripConversationPrefix(targetValue);
  if (!zoneId) return { error: "Unable to resolve the current Discord channel or thread." };

  const accountId = resolveDiscordAccountId(ctx, cfg);
  const scopeInfo = resolveDiscordConfigScope(cfg, accountId);
  const guildId = textValue(
    ctx.guildId,
    ctx.rawGuildId,
    ctx.GroupSpace,
    ctx.groupSpace,
    ctx.message?.guildId,
    ctx.metadata?.guildId,
    ctx.metadata?.guild_id
  ) || inferDiscordGuildIdFromScope(scopeInfo.scope, cfg, zoneId);
  if (!guildId) return { error: "Unable to resolve the current Discord guild." };

  return {
    accountId,
    scope: scopeInfo.kind,
    scopePath: scopeInfo.path,
    scopeLabel: scopeInfo.label,
    guildId,
    zoneId,
    parentChannelId
  };
}

export function resolveNativeRequireMentionStatus(ctx = {}, cfg = {}) {
  const target = resolveNativeRequireMentionTarget(ctx, cfg);
  if ("error" in target) return { target, status: "unavailable", reason: target.error };
  const discord = cfg?.channels?.discord;
  const targetScope = target.scope === "account" && target.accountId && discord?.accounts?.[target.accountId]
    ? discord.accounts[target.accountId]
    : discord;
  const guildEntry = targetScope?.guilds?.[target.guildId];
  const channelEntry = guildEntry?.channels?.[target.zoneId];
  const parentChannelEntry = target.parentChannelId ? guildEntry?.channels?.[target.parentChannelId] : null;
  const wildcardEntry = guildEntry?.channels?.["*"];
  if (channelEntry && Object.prototype.hasOwnProperty.call(channelEntry, "requireMention")) {
    return {
      target,
      status: channelEntry.requireMention ? "on" : "off",
      source: `${target.scopePath}.guilds.${target.guildId}.channels.${target.zoneId}.requireMention`
    };
  }
  if (parentChannelEntry && Object.prototype.hasOwnProperty.call(parentChannelEntry, "requireMention")) {
    return {
      target,
      status: parentChannelEntry.requireMention ? "on" : "off",
      source: `${target.scopePath}.guilds.${target.guildId}.channels.${target.parentChannelId}.requireMention`
    };
  }
  if (guildEntry && Object.prototype.hasOwnProperty.call(guildEntry, "requireMention")) {
    return {
      target,
      status: guildEntry.requireMention ? "on" : "off",
      source: `${target.scopePath}.guilds.${target.guildId}.requireMention`
    };
  }
  if (wildcardEntry && Object.prototype.hasOwnProperty.call(wildcardEntry, "requireMention")) {
    return {
      target,
      status: wildcardEntry.requireMention ? "on" : "off",
      source: `${target.scopePath}.guilds.${target.guildId}.channels.*.requireMention`
    };
  }
  return {
    target,
    status: "unset",
    source: `${target.scopePath}.guilds.${target.guildId}.channels.${target.zoneId}.requireMention`
  };
}

export function renderNativeRequireMentionStatus(status) {
  if (!status || status.status === "unavailable") {
    return [
      "Permanent native config",
      `- requireMention: unavailable (${status?.reason || "unknown target"})`
    ].join("\n");
  }
  return [
    "Permanent native config",
    `- requireMention: ${status.status}`,
    `- account: ${status.target.accountId || "(none)"}`,
    `- scope: ${status.target.scopeLabel}`,
    `- guild: ${status.target.guildId}`,
    `- zone: ${status.target.zoneId}`,
    `- source: ${status.source}`
  ].join("\n");
}

function dashboardCallback(action, value, scope) {
  return `${DASHBOARD_NAMESPACE}:${action}:${value || "_"}:${encodeDashboardScope(scope)}`;
}

function dashboardButton(params) {
  return {
    label: params.label,
    style: params.style || "secondary",
    callbackData: dashboardCallback(params.action, params.value, params.scope),
    allowedUsers: params.allowedUsers
  };
}

function rowFromButtons(buttons) {
  return { type: "actions", buttons };
}

function rowsFromButtons(buttons, size = 5) {
  const rows = [];
  for (let i = 0; i < buttons.length; i += size) {
    rows.push(rowFromButtons(buttons.slice(i, i + size)));
  }
  return rows;
}

function selectedStyle(selected) {
  return selected ? "success" : "secondary";
}

function responseModeFromEffectivePolicy(policy = {}) {
  if (policy.runtimeResponseMode) return normalizeResponseMode(policy.runtimeResponseMode);
  if (policy.respond === false) return "off";
  return policy.requireMention ? "mention" : "always";
}

function ingestModeFromEffectivePolicy(policy = {}) {
  if (policy.runtimeIngestMode) return normalizeRuntimeIngestMode(policy.runtimeIngestMode);
  return policy.ingestMode === "none"
    ? "off"
    : normalizeRuntimeIngestMode(policy.ingestMode, "off");
}

function renderRuntimeOverrideSummary(runtimeOverride) {
  if (!runtimeOverride) return "none";
  return `${runtimeOverride.runtimeResponseMode || "off"} / ${runtimeOverride.runtimeIngestMode || "off"}`;
}

function renderReplyMode(value) {
  switch (value) {
    case "off": return "Off";
    case "mention": return "Mention only";
    case "always": return "Always reply";
    default: return "Unknown";
  }
}

function renderReadMode(value) {
  switch (value) {
    case "off": return "Off";
    case "passive": return "Passive only";
    case "responseCandidates": return "Reply candidates";
    case "all": return "All messages";
    default: return "Unknown";
  }
}

function renderOverrideReply(runtimeOverride) {
  if (!runtimeOverride) return "None";
  const suffix = runtimeOverride.runtimeInherited ? " (inherited from parent)" : "";
  return `${renderReplyMode(runtimeOverride.runtimeResponseMode || "off")}${suffix}`;
}

function renderOverrideRead(runtimeOverride) {
  if (!runtimeOverride) return "None";
  const suffix = runtimeOverride.runtimeInherited ? " (inherited from parent)" : "";
  return `${renderReadMode(runtimeOverride.runtimeIngestMode || "off")}${suffix}`;
}

function renderMentionRequired(status) {
  switch (status?.status) {
    case "on": return "On";
    case "off": return "Off";
    case "unset": return "Inherited / not set here";
    case "unavailable": return "Unknown";
    default: return "Unknown";
  }
}

function renderConfigLevel(status) {
  if (!status || status.status === "unavailable") return "Unknown";
  const source = String(status.source || "");
  const zone = status.target?.zoneId ? String(status.target.zoneId) : "";
  if (zone && source.includes(`.channels.${zone}.requireMention`)) return "This channel";
  if (source.includes(".channels.*.requireMention")) return "Channel default";
  if (source.includes(".channels.") && source.endsWith(".requireMention")) return "Parent channel";
  if (/\.guilds\.[^.]+\.requireMention$/.test(source)) return "Server default";
  if (status.status === "unset") return "Not set";
  return "Config";
}

function renderPolicyPair(label, value) {
  return `- ${label}: \`${value}\``;
}

function normalizeAccountOptions(accounts = []) {
  const seen = new Set();
  return accounts
    .map((account) => {
      if (typeof account === "string") return { id: account, label: account };
      if (!account || typeof account !== "object") return null;
      const id = textValue(account.id, account.accountId, account.value);
      if (!id) return null;
      return {
        id,
        label: textValue(account.label, account.name, id)
      };
    })
    .filter((account) => {
      if (!account || seen.has(account.id)) return false;
      seen.add(account.id);
      return true;
    });
}

function compactLabel(value, maxLength = 32) {
  const text = textValue(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(1, maxLength - 3))}...`;
}

function dashboardAccountOptions(accounts, selectedAccount) {
  if (accounts.length <= 1) return [];
  const selected = accounts.find((account) => account.id === selectedAccount);
  const ordered = [];
  const seen = new Set();
  const push = (account) => {
    if (!account || seen.has(account.id) || ordered.length >= 5) return;
    ordered.push(account);
    seen.add(account.id);
  };
  push(accounts.find((account) => account.id === "default"));
  push(selected);
  for (const account of accounts) push(account);
  return ordered;
}

function renderTechnicalDetails({ effectivePolicy, runtimeOverride, nativeStatus, scope, panelStatePath }) {
  return [
    "",
    "Details",
    `Effective source: ${effectivePolicy?.matched || "unknown"}`,
    `Runtime override key: ${runtimeOverride?.runtimeMatched || "none"}`,
    `Runtime override inherited: ${runtimeOverride?.runtimeInherited ? "yes" : "no"}`,
    `Panel state: ${panelStatePath || "persistent plugin state"}`,
    `Permanent source: ${nativeStatus?.source || "unknown"}`,
    `Scope: account ${scope.accountId || "default"} / guild ${scope.guildId || "(none)"} / zone ${scope.conversationId || scope.channelId || "(unknown)"}`
  ].join("\n");
}

export function validateRuntimeResponseAction(command = {}, nativeStatus = {}) {
  return { ok: true };
}

export function buildPolicyDashboardView({ effectivePolicy, runtimeOverride, scope, nativeStatus, actorId, details = false, panelStatePath = "", notice = "", accountOptions = [] } = {}) {
  const effectiveScope = scope || effectivePolicy?.runtimeScope || runtimeOverride?.runtimeScope || {};
  const allowedUsers = actorId ? [String(actorId)] : undefined;
  const responseMode = responseModeFromEffectivePolicy(effectivePolicy || runtimeOverride);
  const ingestMode = ingestModeFromEffectivePolicy(effectivePolicy || runtimeOverride);
  const nativeMode = nativeStatus?.status || "unavailable";
  const accounts = normalizeAccountOptions(accountOptions);
  const selectedAccount = effectiveScope.accountId || "default";
  const makeButton = (params) => {
    return dashboardButton({ ...params, scope: effectiveScope, allowedUsers });
  };
  const accountButtons = dashboardAccountOptions(accounts, selectedAccount).map((account) => dashboardButton({
    label: compactLabel(account.label || account.id),
    action: "account",
    value: account.id,
    scope: { ...effectiveScope, accountId: account.id },
    style: selectedStyle(account.id === selectedAccount),
    allowedUsers
  }));
  const responseButtons = [
    makeButton({ label: "Replies off", action: "response", value: "off", style: selectedStyle(responseMode === "off") }),
    makeButton({ label: "Mention only", action: "response", value: "mention", style: selectedStyle(responseMode === "mention") }),
    makeButton({ label: "Reply always", action: "response", value: "always", style: selectedStyle(responseMode === "always") })
  ];
  const ingestButtons = [
    makeButton({ label: "Read off", action: "ingest", value: "off", style: selectedStyle(ingestMode === "off") }),
    makeButton({ label: "Passive", action: "ingest", value: "passive", style: selectedStyle(ingestMode === "passive") }),
    makeButton({ label: "Candidates", action: "ingest", value: "responseCandidates", style: selectedStyle(ingestMode === "responseCandidates") }),
    makeButton({ label: "All messages", action: "ingest", value: "all", style: selectedStyle(ingestMode === "all") })
  ];
  const nativeButtons = [
    makeButton({ label: "Native gate on", action: "native", value: "on", style: selectedStyle(nativeMode === "on") }),
    makeButton({ label: nativeMode === "on" ? "Disable native gate" : "Native gate off", action: "native", value: "off", style: nativeMode === "on" ? "primary" : selectedStyle(nativeMode === "off") })
  ];
  const utilityButtons = [
    makeButton({ label: "Reset panel", action: "reset", style: "danger" }),
    makeButton({ label: "Refresh", action: "refresh", style: "secondary" }),
    makeButton({ label: details ? "Hide details" : "Details", action: "details", value: details ? "hide" : "show", style: "secondary" }),
    makeButton({ label: "Dismiss", action: "dismiss", style: "secondary" })
  ];
  const runtimeWins = Boolean(effectivePolicy?.runtimeResponseMode);
  const verdict = nativeMode === "on" && !runtimeWins ? "Reply always blocked" : "Reply always available";
  const cause = nativeMode === "on" && !runtimeWins
    ? "Native mention gate is enabled"
    : runtimeWins
      ? "Runtime policy overrides native requireMention"
      : "Native mention gate is not blocking this chat";
  const text = [
    "**Message policy**",
    notice ? `**Notice:** ${notice}` : null,
    "",
    `**${verdict}**`,
    `Cause: ${cause}`,
    `Account: \`${selectedAccount}\``,
    "",
    "**Effective status**",
    renderPolicyPair("Bot replies", renderReplyMode(responseMode)),
    renderPolicyPair("Bot reads", renderReadMode(ingestMode)),
    renderPolicyPair("Reply always", nativeMode === "on" && !runtimeWins ? "Unavailable" : "Available"),
    nativeMode === "on" && !runtimeWins
      ? "Note: the native gate only makes mentioned messages eligible for replies."
      : "Note: the extra policy controls whether messages become reply candidates.",
    "",
    "**Extra policy**",
    renderPolicyPair("Reply override", renderOverrideReply(runtimeOverride)),
    renderPolicyPair("Read override", renderOverrideRead(runtimeOverride)),
    renderPolicyPair("Saved after restart", "Yes"),
    "",
    "**Native OpenClaw gate**",
    renderPolicyPair("Native mention gate", renderMentionRequired(nativeStatus)),
    renderPolicyPair("Config level", renderConfigLevel(nativeStatus)),
    "",
    "**Controls**",
    accountButtons.length ? "- Account: first button row." : "- Account: only one account is available.",
    "- Reply policy: Replies off / Mention only / Reply always.",
    "- Read policy: Read off / Passive / Candidates / All messages.",
    "- Native gate: turn OpenClaw requireMention on or off.",
    "- Panel: Reset panel / Refresh / Details / Dismiss.",
    details ? renderTechnicalDetails({
      effectivePolicy,
      runtimeOverride,
      nativeStatus,
      scope: effectiveScope,
      panelStatePath
    }) : null
  ].filter((line) => line != null).join("\n");
  return {
    text,
    componentSpec: {
      reusable: true,
      blocks: [
        ...rowsFromButtons(accountButtons),
        rowFromButtons(responseButtons),
        rowFromButtons(ingestButtons),
        rowFromButtons(nativeButtons),
        rowFromButtons(utilityButtons)
      ]
    }
  };
}

export function applyNativeRequireMentionOverride(currentCfg, target, desired) {
  const next = structuredClone(currentCfg);
  const discord = next?.channels?.discord;
  const targetScope = target.scope === "account" && target.accountId && discord?.accounts?.[target.accountId]
    ? discord.accounts[target.accountId]
    : discord;
  const guilds = targetScope?.guilds;
  if (!guilds || typeof guilds !== "object" || !guilds[target.guildId] || typeof guilds[target.guildId] !== "object") {
    throw new Error(`Discord guild ${target.guildId} is not configured in ${target.scopePath}.guilds.`);
  }
  const guildEntry = guilds[target.guildId];
  const channels = guildEntry.channels;
  if (!channels || typeof channels !== "object") throw new Error("This guild does not have a configured channels block.");
  const existingZone = channels[target.zoneId] && typeof channels[target.zoneId] === "object" ? channels[target.zoneId] : {};
  channels[target.zoneId] = { ...existingZone, requireMention: desired };
  return next;
}

export async function applyNativeRequireMentionCommand(ctx = {}, value) {
  const desired = parseOnOff(value);
  if (desired == null) return { text: "Usage: /policy native on|off" };
  const { loadConfig, updateConfig } = await loadConfigRuntime();
  const currentCfg = loadConfig();
  const target = resolveNativeRequireMentionTarget(ctx, currentCfg);
  if ("error" in target) return { text: target.error };
  let nextConfig = null;
  await updateConfig((latestCfg) => {
    nextConfig = applyNativeRequireMentionOverride(latestCfg, target, desired);
    return nextConfig;
  });
  return {
    target,
    desired,
    nextConfig,
    text: [
      `Permanent native requireMention ${desired ? "on" : "off"} applied.`,
      "This writes OpenClaw config and may require reload/restart or trigger provider reconnect.",
      `- account: ${target.accountId || "(none)"}`,
      `- scope: ${target.scopeLabel}`,
      `- guild: ${target.guildId}`,
      `- zone: ${target.zoneId}`
    ].join("\n")
  };
}

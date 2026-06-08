import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";
import { normalizeConfig, resolvePolicy, shouldIngest, shouldSuppressResponse } from "./policy.js";
import {
  applyNativeRequireMentionCommand,
  applyNativeMentionGatePolicy,
  applyRuntimeCommand,
  applyRuntimePolicy,
  buildPolicyDashboardView,
  contextFromPolicyScope,
  defaultPolicyStatePath,
  loadPolicyState,
  normalizePolicyCommandConfig,
  policyDashboardAccountsFromConfig,
  parsePolicyDashboardAction,
  parsePolicyCommand,
  renderPolicyHelp,
  resolveNativeRequireMentionStatus,
  resolveRuntimePolicyOverride,
  savePolicyState,
  validateRuntimeResponseAction
} from "./policy-command.js";
import { buildRawRecallGuidance, createRawContextSearchTool, searchRawRecall } from "./raw-recall.js";
import { createPolicyAuditTool } from "./policy-audit.js";
import {
  forceMentionedDispatchContext,
  rememberMentionFact,
  withDerivedMentionFact
} from "./runtime-context.js";
import { applyNativeReplyHandling, normalizeNativeReplyHandling } from "./native-reply.js";

function eventMessageId(event = {}, ctx = {}) {
  return String(event.messageId ?? event.MessageId ?? ctx.messageId ?? ctx.MessageId ?? "");
}

function textValue(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function stripConversationPrefix(value) {
  return String(value || "").trim().replace(/^(channel|chat|user):/, "");
}

function routeChannelId(event = {}, ctx = {}) {
  return stripConversationPrefix(textValue(
    ctx.NativeChannelId,
    ctx.ChannelId,
    ctx.channelId,
    ctx.conversationId,
    ctx.OriginatingTo,
    ctx.To,
    event.NativeChannelId,
    event.ChannelId,
    event.channelId,
    event.conversationId,
    event.OriginatingTo,
    event.To,
    event.metadata?.channelId,
    event.metadata?.channel_id,
    event.metadata?.to,
    ctx.metadata?.channelId,
    ctx.metadata?.channel_id,
    ctx.metadata?.to
  ));
}

function routeParentChannelId(event = {}, ctx = {}) {
  return stripConversationPrefix(textValue(
    ctx.NativeParentChannelId,
    ctx.ParentChannelId,
    ctx.parentChannelId,
    ctx.ParentId,
    ctx.parentId,
    event.NativeParentChannelId,
    event.ParentChannelId,
    event.parentChannelId,
    event.ParentId,
    event.parentId,
    event.metadata?.parentChannelId,
    event.metadata?.parent_channel_id,
    event.metadata?.parentId,
    event.metadata?.parent_id,
    ctx.metadata?.parentChannelId,
    ctx.metadata?.parent_channel_id,
    ctx.metadata?.parentId,
    ctx.metadata?.parent_id
  ));
}

function routeGuildId(event = {}, ctx = {}) {
  return textValue(
    ctx.GroupSpace,
    ctx.guildId,
    ctx.rawGuildId,
    event.GroupSpace,
    event.guildId,
    event.rawGuildId,
    event.metadata?.guildId,
    event.metadata?.guild_id,
    event.metadata?.rawGuildId,
    event.metadata?.raw_guild_id,
    ctx.metadata?.guildId,
    ctx.metadata?.guild_id,
    ctx.metadata?.rawGuildId,
    ctx.metadata?.raw_guild_id
  );
}

function routeAccountId(event = {}, ctx = {}) {
  return textValue(
    ctx.AccountId,
    ctx.accountId,
    event.AccountId,
    event.accountId,
    event.metadata?.accountId,
    event.metadata?.account_id,
    ctx.metadata?.accountId,
    ctx.metadata?.account_id
  );
}

function routeSessionKey(event = {}, ctx = {}) {
  return textValue(
    ctx.SessionKey,
    ctx.sessionKey,
    event.SessionKey,
    event.sessionKey,
    event.metadata?.sessionKey,
    event.metadata?.session_key,
    ctx.metadata?.sessionKey,
    ctx.metadata?.session_key
  );
}

function rememberDiscordRoute(state, event = {}, ctx = {}) {
  const guildId = routeGuildId(event, ctx);
  const channelId = routeChannelId(event, ctx);
  if (!guildId || !channelId) return;
  const route = {
    guildId,
    rawGuildId: guildId,
    channelId,
    parentChannelId: routeParentChannelId(event, ctx),
    accountId: routeAccountId(event, ctx),
    updatedAt: Date.now()
  };
  for (const key of [
    `channel:${channelId}`,
    routeSessionKey(event, ctx) ? `session:${routeSessionKey(event, ctx)}` : ""
  ].filter(Boolean)) {
    state.discordRoutes.set(key, route);
  }
  while (state.discordRoutes.size > 5000) {
    const oldest = state.discordRoutes.keys().next().value;
    state.discordRoutes.delete(oldest);
  }
}

function lookupDiscordRoute(state, event = {}, ctx = {}) {
  for (const key of [
    routeSessionKey(event, ctx) ? `session:${routeSessionKey(event, ctx)}` : "",
    routeChannelId(event, ctx) ? `channel:${routeChannelId(event, ctx)}` : ""
  ].filter(Boolean)) {
    const route = state.discordRoutes.get(key);
    if (route) return route;
  }
  return null;
}

function withRememberedDiscordRoute(state, event = {}, ctx = {}) {
  const route = lookupDiscordRoute(state, event, ctx);
  if (!route) return { event, ctx };
  const guildId = routeGuildId(event, ctx) || route.guildId;
  const parentChannelId = routeParentChannelId(event, ctx) || route.parentChannelId;
  const accountId = routeAccountId(event, ctx) || route.accountId;
  const channelId = routeChannelId(event, ctx) || route.channelId;
  const metadata = {
    ...(ctx.metadata || {}),
    guildId,
    rawGuildId: guildId,
    channelId,
    parentChannelId,
    accountId
  };
  return {
    event: {
      ...event,
      guildId: event.guildId || guildId,
      rawGuildId: event.rawGuildId || guildId,
      channelId: event.channelId || channelId,
      parentChannelId: event.parentChannelId || parentChannelId,
      accountId: event.accountId || accountId,
      metadata: {
        ...(event.metadata || {}),
        guildId,
        rawGuildId: guildId,
        channelId,
        parentChannelId,
        accountId
      }
    },
    ctx: {
      ...ctx,
      guildId: ctx.guildId || guildId,
      rawGuildId: ctx.rawGuildId || guildId,
      GroupSpace: ctx.GroupSpace || guildId,
      channelId: ctx.channelId || channelId,
      parentChannelId: ctx.parentChannelId || parentChannelId,
      accountId: ctx.accountId || accountId,
      metadata
    }
  };
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
    channelId: ctx.channelId ?? ctx.ChannelId ?? ctx.NativeChannelId ?? event.channelId ?? event.ChannelId ?? event.NativeChannelId ?? event.channel ?? event.from,
    accountId: ctx.accountId ?? ctx.AccountId ?? event.accountId ?? event.AccountId,
    conversationId: ctx.conversationId ?? ctx.OriginatingTo ?? ctx.To ?? event.conversationId ?? event.OriginatingTo ?? event.To,
    sessionKey: ctx.sessionKey ?? ctx.SessionKey ?? event.sessionKey ?? event.SessionKey,
    runId: ctx.runId ?? ctx.RunId ?? event.runId ?? event.RunId,
    messageId: event.messageId ?? event.MessageId ?? ctx.messageId ?? ctx.MessageId,
    senderId: event.senderId ?? event.SenderId ?? ctx.senderId ?? ctx.SenderId,
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
  const dedupeKey = id ? `${ctx.channelId || ctx.ChannelId || ctx.NativeChannelId || event.channelId || event.ChannelId || event.NativeChannelId || event.channel || event.from || "unknown"}:${id}` : "";
  if (rememberDedupe(state, dedupeKey, cfg.dedupeWindow)) return;

  const record = toRecord(source, event, ctx, policy);
  try {
    if (cfg.jsonlSink.enabled) await appendJsonl(cfg.jsonlSink, record);
    if (cfg.httpSink.enabled) await postHttpSink(cfg.httpSink, record);
  } catch (err) {
    api.logger.warn(`extra-message-policy: ingest failed: ${String(err)}`);
  }
}

function responsePolicyKeys(event = {}, ctx = {}) {
  return [
    ctx.runId,
    ctx.RunId,
    event.runId,
    event.RunId,
    ctx.sessionKey,
    ctx.SessionKey,
    event.sessionKey,
    event.SessionKey,
    ctx.messageId,
    ctx.MessageId,
    ctx.OriginatingMessageId,
    ctx.SourceMessageId,
    event.messageId,
    event.MessageId,
    event.OriginatingMessageId,
    event.SourceMessageId
  ].filter(Boolean).map(String);
}

function rememberResponsePolicy(state, event = {}, ctx = {}, policy = {}) {
  for (const key of responsePolicyKeys(event, ctx)) {
    state.responsePolicy.set(key, {
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

function lookupRememberedResponse(state, ctx = {}) {
  for (const key of responsePolicyKeys({}, ctx)) {
    const remembered = state.responsePolicy.get(key);
    if (remembered && remembered.respond === false) return false;
    if (remembered && remembered.respond === true) return true;
  }
  return undefined;
}

function hasPolicyRoutingContext(ctx = {}) {
  return Boolean(
    ctx.channelId
    || ctx.ChannelId
    || ctx.NativeChannelId
    || ctx.conversationId
    || ctx.OriginatingTo
    || ctx.To
    || ctx.sessionKey
    || ctx.SessionKey
    || ctx.guildId
    || ctx.rawGuildId
    || ctx.GroupSpace
    || ctx.accountId
    || ctx.AccountId
  );
}

function commandNameFrom(event = {}, ctx = {}) {
  return String(
    ctx.commandName
    ?? event.commandName
    ?? event.metadata?.commandName
    ?? event.metadata?.command
    ?? ""
  ).replace(/^\//, "");
}

function textFrom(event = {}, ctx = {}) {
  return String(event.content ?? event.text ?? event.body ?? ctx.content ?? ctx.text ?? "");
}

function isPolicyCommand(commandConfig, event = {}, ctx = {}) {
  const name = commandNameFrom(event, ctx);
  if (name && name === commandConfig.commandName) return true;
  return textFrom(event, ctx).trim().startsWith(`/${commandConfig.commandName}`);
}

function commandEventFromContext(ctx = {}) {
  return {
    accountId: ctx?.accountId,
    guildId: ctx?.guildId || ctx?.rawGuildId,
    channelId: ctx?.channelId,
    parentChannelId: ctx?.parentChannelId || ctx?.parentId || ctx?.metadata?.parentChannelId || ctx?.metadata?.parent_channel_id,
    conversationId: ctx?.conversationId || ctx?.to || ctx?.target,
    metadata: ctx?.metadata || {}
  };
}

function buildDashboardComponents(view, ctx = {}, discordSdk = {}) {
  if (!view?.componentSpec || typeof discordSdk.buildDiscordComponentMessage !== "function") return [];
  const buildResult = discordSdk.buildDiscordComponentMessage({
    spec: view.componentSpec,
    fallbackText: view.text,
    sessionKey: ctx?.sessionKey,
    agentId: ctx?.agentId,
    accountId: ctx?.accountId
  });
  if (typeof discordSdk.registerBuiltDiscordComponentMessage === "function") {
    discordSdk.registerBuiltDiscordComponentMessage({ buildResult });
  }
  return flattenClassicActionRows(buildResult.components);
}

function flattenClassicActionRows(components = []) {
  const rows = [];
  for (const component of components || []) {
    if (!component) continue;
    if (component.type === 1) {
      rows.push(component);
      continue;
    }
    if (Array.isArray(component.components)) {
      rows.push(...flattenClassicActionRows(component.components));
    }
  }
  return rows;
}

function dashboardReply(view, ctx = {}, discordSdk = {}) {
  const components = buildDashboardComponents(view, ctx, discordSdk);
  return {
    text: view?.text,
    channelData: {
      discord: {
        components
      }
    }
  };
}

function dispatchPolicyContext(ctx = {}) {
  const parentChannelId = ctx.NativeParentChannelId || ctx.ParentChannelId || ctx.parentChannelId || ctx.ParentId || ctx.parentId;
  return {
    accountId: ctx.AccountId || ctx.accountId,
    guildId: ctx.GroupSpace || ctx.guildId || ctx.rawGuildId,
    rawGuildId: ctx.GroupSpace || ctx.rawGuildId || ctx.guildId,
    channelId: ctx.NativeChannelId || ctx.ChannelId || ctx.channelId,
    parentChannelId,
    conversationId: ctx.OriginatingTo || ctx.To || ctx.conversationId,
    sessionKey: ctx.SessionKey || ctx.sessionKey,
    senderId: ctx.SenderId || ctx.senderId,
    wasMentioned: ctx.WasMentioned,
    metadata: {
      accountId: ctx.AccountId || ctx.accountId,
      guildId: ctx.GroupSpace || ctx.guildId,
      channelId: ctx.NativeChannelId || ctx.ChannelId || ctx.channelId,
      parentChannelId,
      to: ctx.OriginatingTo || ctx.To
    }
  };
}

function dispatchPolicyEvent(ctx = {}) {
  const parentChannelId = ctx.NativeParentChannelId || ctx.ParentChannelId || ctx.parentChannelId || ctx.ParentId || ctx.parentId;
  return {
    content: ctx.BodyForAgent || ctx.Body || ctx.content,
    body: ctx.BodyForAgent || ctx.Body || ctx.body,
    accountId: ctx.AccountId,
    guildId: ctx.GroupSpace,
    channelId: ctx.NativeChannelId || ctx.ChannelId,
    parentChannelId,
    conversationId: ctx.OriginatingTo || ctx.To,
    sessionKey: ctx.SessionKey,
    senderId: ctx.SenderId,
    wasMentioned: ctx.WasMentioned,
    metadata: {
      accountId: ctx.AccountId,
      guildId: ctx.GroupSpace,
      channelId: ctx.NativeChannelId || ctx.ChannelId,
      parentChannelId,
      to: ctx.OriginatingTo || ctx.To
    }
  };
}

function shouldForceReplyContext(policy = {}) {
  return policy.respond !== false
    && policy.runtimeResponseMode === "always"
    && policy.requireMention !== true;
}

export function registerExtraMessagePolicy(api, options = {}) {
  const cfg = normalizeConfig(api.pluginConfig || {});
  const commandConfig = normalizePolicyCommandConfig(api.pluginConfig || {});
  const policyStatePath = defaultPolicyStatePath(api, commandConfig);
  const approvalPromptHandling = normalizeApprovalPromptHandling(api.pluginConfig?.approvalPromptHandling || {});
  const nativeReplyHandling = normalizeNativeReplyHandling(api.pluginConfig?.nativeReplyHandling || {});
  const discordSdk = options.discordSdk || {};
  if (!cfg.enabled) {
    api.logger.info("extra-message-policy: disabled");
    return;
  }

  const state = {
    seen: new Map(),
    responsePolicy: new Map(),
    mentionFacts: new Map(),
    discordRoutes: new Map()
  };

  const resolveEffectivePolicy = async (event = {}, ctx = {}) => {
    const routed = withRememberedDiscordRoute(state, event, ctx);
    const enriched = withDerivedMentionFact(
      state,
      routed.event,
      routed.ctx,
      api.runtime?.config?.current?.() || api.config || {},
      api.pluginConfig || {}
    );
    const currentConfig = api.runtime?.config?.current?.() || api.config || {};
    const basePolicy = resolvePolicy(cfg, enriched.event, enriched.ctx);
    const runtimeState = await loadPolicyState(policyStatePath);
    const runtimeOverride = resolveRuntimePolicyOverride(commandConfig, runtimeState, enriched.event, enriched.ctx);
    const effectivePolicy = runtimeOverride ? applyRuntimePolicy(basePolicy, runtimeOverride, enriched.event, enriched.ctx) : basePolicy;
    let nativeStatus = null;
    try {
      nativeStatus = resolveNativeRequireMentionStatus(enriched.ctx, currentConfig);
    } catch {
      nativeStatus = null;
    }
    return applyNativeMentionGatePolicy(effectivePolicy, nativeStatus, enriched.event, enriched.ctx);
  };

  if (commandConfig.enabled) {
    const buildDashboard = async (ctx = {}, currentState = null, nativeConfig = null, options = {}) => {
      const currentConfig = nativeConfig || api.runtime?.config?.current?.() || api.config || {};
      const event = commandEventFromContext(ctx);
      const loadedState = currentState || await loadPolicyState(policyStatePath);
      const basePolicy = resolvePolicy(cfg, event, ctx);
      const runtimeOverride = resolveRuntimePolicyOverride(commandConfig, loadedState, event, ctx);
      const effectivePolicy = runtimeOverride ? applyRuntimePolicy(basePolicy, runtimeOverride, event, ctx) : basePolicy;
      const scope = runtimeOverride?.runtimeScope || resolveRuntimePolicyOverride(
        { ...commandConfig, applyDefault: true },
        loadedState,
        event,
        ctx
      )?.runtimeScope;
      let nativeStatus = null;
      try {
        nativeStatus = resolveNativeRequireMentionStatus(ctx || {}, currentConfig);
      } catch {
        nativeStatus = null;
      }
      return buildPolicyDashboardView({
        effectivePolicy,
        runtimeOverride,
        scope,
        nativeStatus,
        actorId: ctx?.senderId,
        details: options.details === true,
        panelStatePath: policyStatePath,
        notice: options.notice || "",
        accountOptions: policyDashboardAccountsFromConfig(currentConfig)
      });
    };

    const runPolicyAction = async (ctx = {}, command, options = {}) => {
      const effectiveCtx = command.scope ? contextFromPolicyScope(command.scope, ctx || {}) : (ctx || {});
      const currentState = await loadPolicyState(policyStatePath);

      if (command.action === "set-native-require") {
        const nativeResult = await applyNativeRequireMentionCommand(effectiveCtx, command.value);
        if (nativeResult?.target) {
          return dashboardReply(await buildDashboard(effectiveCtx, currentState, nativeResult.nextConfig), effectiveCtx, discordSdk);
        }
        return { text: nativeResult?.text || renderPolicyHelp(commandConfig.commandName) };
      }

      if (command.action === "status" || command.action === "details" || command.action === "select-account") {
        return dashboardReply(await buildDashboard(effectiveCtx, currentState, null, { details: command.details === true }), effectiveCtx, discordSdk);
      }

      if (command.action === "reset" || command.action === "set-response" || command.action === "set-ingest") {
        if (command.action === "set-response") {
          let nativeStatus = null;
          try {
            nativeStatus = resolveNativeRequireMentionStatus(effectiveCtx, api.runtime?.config?.current?.() || api.config || {});
          } catch {
            nativeStatus = null;
          }
          const validation = validateRuntimeResponseAction(command, nativeStatus);
          if (!validation.ok) {
            return dashboardReply(await buildDashboard(effectiveCtx, currentState, null, { notice: validation.message }), effectiveCtx, discordSdk);
          }
        }
        const result = applyRuntimeCommand(
          commandConfig,
          currentState,
          commandEventFromContext(effectiveCtx),
          effectiveCtx,
          command,
          effectiveCtx?.senderId
        );
        await savePolicyState(policyStatePath, result.state);
        return dashboardReply(await buildDashboard(effectiveCtx, result.state), effectiveCtx, discordSdk);
      }

      return options.allowHelp ? { text: renderPolicyHelp(commandConfig.commandName) } : dashboardReply(await buildDashboard(effectiveCtx, currentState), effectiveCtx, discordSdk);
    };

    api.registerCommand?.({
      name: commandConfig.commandName,
      nativeNames: { default: commandConfig.commandName },
      description: "Show or change response, ingest, and native mention policy for this chat.",
      acceptsArgs: true,
      requireAuth: true,
      handler: async (ctx) => {
        const command = parsePolicyCommand(ctx?.args || "");
        if (command.action === "help") return { text: renderPolicyHelp(commandConfig.commandName) };
        return await runPolicyAction(ctx || {}, command, { allowHelp: true });
      }
    });

    api.registerInteractiveHandler?.({
      channel: "discord",
      namespace: "policy",
      handler: async (ctx) => {
        const command = parsePolicyDashboardAction(ctx?.interaction?.payload || "status");
        const effectiveCtx = command.scope ? contextFromPolicyScope(command.scope, ctx || {}) : (ctx || {});
        if (command.action === "dismiss") {
          await ctx.respond?.clearComponents?.({ text: "Policy panel dismissed." });
          return { handled: true };
        }
        const result = await runPolicyAction(effectiveCtx, command);
        await ctx.respond?.editMessage?.({
          text: result.text,
          components: result.channelData?.discord?.components || []
        });
        return { handled: true };
      }
    });
  }

  if (approvalPromptHandling.mode !== "off") {
    api.on("tool_result_persist", (event, ctx) => {
      if (!looksLikeApprovalPrompt(messageText(event?.message))) return;
      api.logger.info(`extra-message-policy: handled persisted approval prompt for ${ctx?.sessionKey ?? "unknown-session"}`);
      return { message: replaceMessageText(event.message, approvalPromptHandling.replacementText) };
    });
  }

  api.registerTool?.((toolCtx) => createRawContextSearchTool(cfg.rawRecall, toolCtx), { name: "search_raw_context", optional: true });
  api.registerTool?.((toolCtx) => createPolicyAuditTool(api, cfg, toolCtx), { name: "list_extra_message_policies", optional: true });

  api.on("before_agent_start", async (event, ctx) => {
    const appendSystemContext = buildRawRecallGuidance(cfg.rawRecall);
    const prependContext = await searchRawRecall(event?.prompt || "", cfg.rawRecall, ctx).catch((err) => {
      api.logger.warn(`extra-message-policy: raw recall failed: ${String(err)}`);
      return "";
    });
    if (appendSystemContext || prependContext) return { appendSystemContext, prependContext };
  });

  api.on("inbound_claim", async (event, ctx) => {
    if (isPolicyCommand(commandConfig, event, ctx)) return;
    rememberDiscordRoute(state, event, ctx);
    rememberMentionFact(state, event, ctx);
  });

  api.on("message_received", async (event, ctx) => {
    if (isPolicyCommand(commandConfig, event, ctx)) return;
    rememberDiscordRoute(state, event, ctx);
    const policy = await resolveEffectivePolicy(event, ctx);
    await ingest(api, cfg, state, "message_received", event, ctx, policy);
  });

  api.on("before_dispatch", async (event, ctx) => {
    if (isPolicyCommand(commandConfig, event, ctx)) return;
    rememberDiscordRoute(state, event, ctx);
    const policy = await resolveEffectivePolicy(event, ctx);
    rememberResponsePolicy(state, event, ctx, policy);
    await ingest(api, cfg, state, "before_dispatch", event, ctx, policy);

    if (shouldSuppressResponse(policy)) {
      api.logger.info(`extra-message-policy: suppressed response for ${ctx.sessionKey || ctx.conversationId || ctx.channelId || "unknown"}`);
      return { handled: true };
    }
  });

  api.on("reply_dispatch", async (event) => {
    const dispatchCtx = event?.ctx || {};
    if (isPolicyCommand(commandConfig, dispatchPolicyEvent(dispatchCtx), dispatchPolicyContext(dispatchCtx))) return;
    const policy = await resolveEffectivePolicy(dispatchPolicyEvent(dispatchCtx), dispatchPolicyContext(dispatchCtx));
    if (!shouldForceReplyContext(policy)) return;
    forceMentionedDispatchContext(dispatchCtx);
    api.logger.info(`extra-message-policy: forced reply context for ${dispatchCtx.SessionKey || dispatchCtx.OriginatingTo || dispatchCtx.To || "unknown"}`);
  });

  api.on("message_sending", async (event, ctx) => {
    const nativeReplyPatch = applyNativeReplyHandling(event, ctx, nativeReplyHandling);
    if (approvalPromptHandling.mode !== "off" && looksLikeApprovalPrompt(event?.content ?? event?.text ?? event?.message)) {
      api.logger.info(`extra-message-policy: canceled outbound approval prompt for ${ctx.sessionKey || ctx.conversationId || ctx.channelId || "unknown"}`);
      return approvalPromptHandling.mode === "replace"
        ? { ...(nativeReplyPatch || {}), content: approvalPromptHandling.replacementText }
        : { cancel: true };
    }
    const rememberedResponse = lookupRememberedResponse(state, ctx);
    if (rememberedResponse === false) return { cancel: true };
    if (rememberedResponse !== true && hasPolicyRoutingContext(ctx)) {
      const policy = await resolveEffectivePolicy(event, ctx);
      if (policy?.respond === false) return { cancel: true };
    }
    if (nativeReplyPatch) return nativeReplyPatch;
  });
}

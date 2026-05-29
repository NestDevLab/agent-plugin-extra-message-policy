import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildDiscordComponentMessage, registerBuiltDiscordComponentMessage } from "openclaw/plugin-sdk/discord";
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
  renderPolicyStatus,
  renderNativeRequireMentionStatus,
  resolveNativeRequireMentionStatus,
  resolveRuntimePolicyOverride,
  savePolicyState,
  validateRuntimeResponseAction
} from "./policy-command.js";
import { buildRawRecallGuidance, createRawContextSearchTool, searchRawRecall } from "./raw-recall.js";
import {
  forceMentionedDispatchContext,
  rememberMentionFact,
  withDerivedMentionFact
} from "./runtime-context.js";
import { applyNativeReplyHandling, normalizeNativeReplyHandling } from "./native-reply.js";

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

function buildDashboardComponents(view, ctx = {}) {
  if (!view?.componentSpec) return [];
  const buildResult = buildDiscordComponentMessage({
    spec: view.componentSpec,
    fallbackText: view.text,
    sessionKey: ctx?.sessionKey,
    agentId: ctx?.agentId,
    accountId: ctx?.accountId
  });
  registerBuiltDiscordComponentMessage({ buildResult });
  return buildResult.components;
}

function dashboardReply(view, ctx = {}) {
  const components = buildDashboardComponents(view, ctx);
  return {
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

export default definePluginEntry({
  id: "extra-message-policy",
  name: "Extra Message Policy",
  description: "Cross-platform message ingest and response policy enforcement",
  register(api) {
    const cfg = normalizeConfig(api.pluginConfig || {});
    const commandConfig = normalizePolicyCommandConfig(api.pluginConfig || {});
    const policyStatePath = defaultPolicyStatePath(api, commandConfig);
    const approvalPromptHandling = normalizeApprovalPromptHandling(api.pluginConfig?.approvalPromptHandling || {});
    const nativeReplyHandling = normalizeNativeReplyHandling(api.pluginConfig?.nativeReplyHandling || {});
    if (!cfg.enabled) {
      api.logger.info("extra-message-policy: disabled");
      return;
    }

    const state = {
      seen: new Map(),
      responsePolicy: new Map(),
      mentionFacts: new Map()
    };

    const resolveEffectivePolicy = async (event = {}, ctx = {}) => {
      const enriched = withDerivedMentionFact(
        state,
        event,
        ctx,
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
            return dashboardReply(await buildDashboard(effectiveCtx, currentState, nativeResult.nextConfig), effectiveCtx);
          }
          return { text: nativeResult?.text || renderPolicyHelp(commandConfig.commandName) };
        }

        if (command.action === "status" || command.action === "details" || command.action === "select-account") {
          return dashboardReply(await buildDashboard(effectiveCtx, currentState, null, { details: command.details === true }), effectiveCtx);
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
              return dashboardReply(await buildDashboard(effectiveCtx, currentState, null, { notice: validation.message }), effectiveCtx);
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
          return dashboardReply(await buildDashboard(effectiveCtx, result.state), effectiveCtx);
        }

        return options.allowHelp ? { text: renderPolicyHelp(commandConfig.commandName) } : dashboardReply(await buildDashboard(effectiveCtx, currentState), effectiveCtx);
      };

      api.registerCommand({
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

    api.registerTool((toolCtx) => createRawContextSearchTool(cfg.rawRecall, toolCtx), { name: "search_raw_context", optional: true });

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
      rememberMentionFact(state, event, ctx);
    });

    api.on("message_received", async (event, ctx) => {
      if (isPolicyCommand(commandConfig, event, ctx)) return;
      const policy = await resolveEffectivePolicy(event, ctx);
      await ingest(api, cfg, state, "message_received", event, ctx, policy);
    });

    api.on("before_dispatch", async (event, ctx) => {
      if (isPolicyCommand(commandConfig, event, ctx)) return;
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

    api.on("message_sending", async (_event, ctx) => {
      const nativeReplyPatch = applyNativeReplyHandling(_event, ctx, nativeReplyHandling);
      if (approvalPromptHandling.mode !== "off" && looksLikeApprovalPrompt(_event?.content ?? _event?.text ?? _event?.message)) {
        api.logger.info(`extra-message-policy: canceled outbound approval prompt for ${ctx.sessionKey || ctx.conversationId || ctx.channelId || "unknown"}`);
        return approvalPromptHandling.mode === "replace"
          ? { ...(nativeReplyPatch || {}), content: approvalPromptHandling.replacementText }
          : { cancel: true };
      }
      if (lookupResponseAllowed(state, ctx) === false) return { cancel: true };
      if (nativeReplyPatch) return nativeReplyPatch;
    });
  }
});

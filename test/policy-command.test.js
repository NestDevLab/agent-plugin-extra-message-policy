import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyNativeRequireMentionOverride,
  applyNativeMentionGatePolicy,
  applyRuntimeCommand,
  applyRuntimePolicy,
  buildPolicyDashboardView,
  contextFromPolicyScope,
  defaultPolicyStatePath,
  applyNativeRequireMentionCommand,
  normalizePolicyCommandConfig,
  normalizePolicyState,
  policyDashboardAccountsFromConfig,
  parsePolicyDashboardAction,
  parsePolicyCommand,
  renderNativeRequireMentionStatus,
  renderPolicyStatus,
  resolveNativeRequireMentionStatus,
  resolveNativeRequireMentionTarget,
  resolveRuntimePolicyOverride,
  savePolicyState,
  loadPolicyState,
  scopeFromContext,
  validateRuntimeResponseAction
} from "../policy-command.js";
import { normalizeConfig, resolvePolicy } from "../policy.js";

const ctx = {
  accountId: "default",
  guildId: "guild-1",
  channelId: "channel-1",
  conversationId: "channel:thread-1",
  sessionKey: "agent:main:discord:channel:thread-1",
  senderId: "operator"
};

const threadCtx = {
  accountId: "default",
  guildId: "guild-1",
  channelId: "parent-1",
  parentChannelId: "parent-1",
  conversationId: "channel:thread-1",
  senderId: "operator"
};

test("runtime default does not override config unless applyDefault is enabled", () => {
  const commandConfig = normalizePolicyCommandConfig({});
  const override = resolveRuntimePolicyOverride(commandConfig, {}, {}, ctx);

  assert.equal(override, null);
});

test("runtime response toggle creates mention-scoped override", () => {
  const commandConfig = normalizePolicyCommandConfig({});
  const result = applyRuntimeCommand(commandConfig, {}, {}, ctx, parsePolicyCommand("response toggle"), "operator");
  const override = resolveRuntimePolicyOverride(commandConfig, result.state, {}, ctx);
  const effective = applyRuntimePolicy({ respond: true, ingestMode: "all", matched: "config" }, override, { wasMentioned: true }, ctx);

  assert.equal(result.policy.responseMode, "mention");
  assert.equal(effective.respond, true);
  assert.equal(effective.requireMention, true);
  assert.equal(effective.ingestMode, "none");
});

test("runtime mention override suppresses unmentioned dispatches", () => {
  const commandConfig = normalizePolicyCommandConfig({});
  const result = applyRuntimeCommand(commandConfig, {}, {}, ctx, parsePolicyCommand("response mention"), "operator");
  const override = resolveRuntimePolicyOverride(commandConfig, result.state, {}, ctx);
  const unmentioned = applyRuntimePolicy({ respond: true, ingestMode: "all", matched: "config" }, override, { wasMentioned: false }, ctx);
  const mentioned = applyRuntimePolicy({ respond: true, ingestMode: "all", matched: "config" }, override, { wasMentioned: true }, ctx);

  assert.equal(unmentioned.respond, false);
  assert.equal(unmentioned.mentionSatisfied, false);
  assert.equal(mentioned.respond, true);
  assert.equal(mentioned.mentionSatisfied, true);
});

test("fixed native mention gate applies when no dynamic policy exists", () => {
  const base = resolvePolicy(
    normalizeConfig({ defaultPolicy: { respond: true, ingestMode: "responseCandidates" } }),
    { wasMentioned: false },
    ctx
  );
  const effective = applyNativeMentionGatePolicy(base, {
    status: "on",
    source: "channels.discord.accounts.default.guilds.guild-1.channels.channel-1.requireMention"
  }, { wasMentioned: false }, ctx);

  assert.equal(base.respond, true);
  assert.equal(base.requireMention, undefined);
  assert.equal(effective.respond, false);
  assert.equal(effective.requireMention, true);
  assert.equal(effective.mentionSatisfied, false);
  assert.equal(effective.nativeMentionGate, true);
});

test("explicit extra-message-policy response config overrides native mention gate", () => {
  for (const nativeMode of ["unset", "off", "on"]) {
    const nativeStatus = {
      status: nativeMode,
      source: "channels.discord.accounts.default.guilds.guild-1.channels.channel-1.requireMention"
    };

    const alwaysPolicy = resolvePolicy(
      normalizeConfig({
        defaultPolicy: { respond: false, ingestMode: "none" },
        policies: [{ channelId: "channel-1", respond: true, ingestMode: "all" }]
      }),
      { wasMentioned: false },
      ctx
    );
    const alwaysEffective = applyNativeMentionGatePolicy(alwaysPolicy, nativeStatus, { wasMentioned: false }, ctx);
    assert.equal(alwaysEffective.respond, true, `respond:true must survive native=${nativeMode}`);
    assert.equal(alwaysEffective.requireMention, undefined, `respond:true must not inherit native mention for native=${nativeMode}`);
    assert.equal(alwaysEffective.nativeMentionGate, undefined, `explicit policy must skip native gate for native=${nativeMode}`);

    const offPolicy = resolvePolicy(
      normalizeConfig({
        defaultPolicy: { respond: true, ingestMode: "all" },
        policies: [{ channelId: "channel-1", respond: false, ingestMode: "all" }]
      }),
      { wasMentioned: true },
      ctx
    );
    const offEffective = applyNativeMentionGatePolicy(offPolicy, nativeStatus, { wasMentioned: true }, ctx);
    assert.equal(offEffective.respond, false, `respond:false must survive native=${nativeMode}`);
    assert.equal(offEffective.requireMention, undefined, `respond:false must not inherit native mention for native=${nativeMode}`);

    const mentionPolicy = resolvePolicy(
      normalizeConfig({
        defaultPolicy: { respond: true, ingestMode: "all" },
        policies: [{ channelId: "channel-1", respond: true, ingestMode: "all", requireMention: true }]
      }),
      { wasMentioned: false },
      ctx
    );
    const mentionEffective = applyNativeMentionGatePolicy(mentionPolicy, nativeStatus, { wasMentioned: false }, ctx);
    assert.equal(mentionEffective.respond, false, `respond:mention must suppress unmentioned native=${nativeMode}`);
    assert.equal(mentionEffective.requireMention, true, `respond:mention must keep explicit requireMention native=${nativeMode}`);
  }
});

test("effective response policy matrix respects config, runtime, native gate, and mention state", async (t) => {
  const runtimeModes = [null, "off", "mention", "always"];
  const nativeModes = ["unset", "off", "on"];
  const baseRequireModes = [false, true];
  const mentionModes = [false, true];

  for (const runtimeMode of runtimeModes) {
    for (const nativeMode of nativeModes) {
      for (const baseRequireMention of baseRequireModes) {
        for (const mentioned of mentionModes) {
          await t.test([
            `runtime=${runtimeMode || "none"}`,
            `native=${nativeMode}`,
            `baseRequire=${baseRequireMention}`,
            `mentioned=${mentioned}`
          ].join(" "), () => {
            const base = resolvePolicy(
              normalizeConfig({
                defaultPolicy: {
                  respond: true,
                  ingestMode: "all",
                  requireMention: baseRequireMention
                }
              }),
              { wasMentioned: mentioned },
              ctx
            );
            const runtimeOverride = runtimeMode
              ? {
                  respond: runtimeMode !== "off",
                  requireMention: runtimeMode === "mention",
                  ingestMode: "all",
                  runtimeResponseMode: runtimeMode,
                  runtimeIngestMode: "all",
                  runtimeMatched: "runtime-test",
                  runtimeScope: ctx
                }
              : null;
            const runtimePolicy = runtimeOverride
              ? applyRuntimePolicy(base, runtimeOverride, { wasMentioned: mentioned }, ctx)
              : base;
            const effective = applyNativeMentionGatePolicy(runtimePolicy, {
              status: nativeMode,
              source: "native-test"
            }, { wasMentioned: mentioned }, ctx);
            const responseOff = runtimeMode === "off";
            const mentionRequired = !responseOff && (
              runtimeMode === "mention"
              || (!runtimeMode && (baseRequireMention || nativeMode === "on"))
              || (runtimeMode !== "always" && baseRequireMention)
            );
            const expectedRespond = responseOff ? false : mentionRequired ? mentioned : true;

            assert.equal(effective.respond, expectedRespond);
            assert.equal(Boolean(effective.requireMention), mentionRequired);
            assert.equal(effective.ingestMode, "all");
          });
        }
      }
    }
  }
});

test("runtime always override does not require a mention", () => {
  const commandConfig = normalizePolicyCommandConfig({});
  const result = applyRuntimeCommand(commandConfig, {}, {}, ctx, parsePolicyCommand("response always"), "operator");
  const override = resolveRuntimePolicyOverride(commandConfig, result.state, {}, ctx);
  const effective = applyRuntimePolicy({ respond: false, ingestMode: "all", requireMention: true, matched: "config" }, override, { wasMentioned: false }, ctx);

  assert.equal(effective.respond, true);
  assert.equal(effective.requireMention, false);
  assert.equal(effective.runtimeResponseMode, "always");
});

test("runtime ingest toggle creates passive ingest override", () => {
  const commandConfig = normalizePolicyCommandConfig({});
  const result = applyRuntimeCommand(commandConfig, {}, {}, ctx, parsePolicyCommand("ingest toggle"), "operator");
  const override = resolveRuntimePolicyOverride(commandConfig, result.state, {}, ctx);

  assert.equal(result.policy.ingestMode, "passive");
  assert.equal(override.ingestMode, "passive");
});

test("runtime status rendering is compact", () => {
  const commandConfig = normalizePolicyCommandConfig({ policyCommand: { applyDefault: true } });
  const override = resolveRuntimePolicyOverride(commandConfig, {}, {}, ctx);
  const text = renderPolicyStatus(override, override.runtimeScope);

  assert.match(text, /response: off/);
  assert.match(text, /ingest: off/);
  assert.match(text, /zone: thread-1/);
});

test("runtime scope ignores slash interaction target when channel metadata is available", () => {
  const commandConfig = normalizePolicyCommandConfig({});
  const slashCtx = {
    accountId: "default",
    rawGuildId: "guild-1",
    target: "slash:111111111111111111",
    metadata: {
      channelId: "channel-1"
    }
  };
  const result = applyRuntimeCommand(commandConfig, {}, {}, slashCtx, parsePolicyCommand("response always"), "operator");
  const keys = Object.keys(result.state.scopes);

  assert.deepEqual(keys, ["discord:default:guild-1:channel-1"]);
  assert.equal(result.scope.guildId, "guild-1");
  assert.equal(result.scope.channelId, "channel-1");
});

test("runtime scope ignores slash conversation id when channel id is available", () => {
  const commandConfig = normalizePolicyCommandConfig({});
  const slashCtx = {
    accountId: "default",
    guildId: "guild-1",
    channelId: "channel-1",
    conversationId: "slash:111111111111111111",
    target: "slash:111111111111111111"
  };
  const result = applyRuntimeCommand(commandConfig, {}, {}, slashCtx, parsePolicyCommand("response mention"), "operator");
  const keys = Object.keys(result.state.scopes);

  assert.deepEqual(keys, ["discord:default:guild-1:channel-1"]);
  assert.equal(result.scope.conversationId, "");
  assert.equal(result.scope.channelId, "channel-1");
});

test("runtime scope falls back to Discord channel from session key", () => {
  const commandConfig = normalizePolicyCommandConfig({});
  const state = {
    scopes: {
      "discord:default:guild-1:channel-1": {
        policy: { responseMode: "off", ingestMode: "all" }
      }
    }
  };
  const override = resolveRuntimePolicyOverride(commandConfig, state, {}, {
    accountId: "default",
    guildId: "guild-1",
    conversationId: "slash:operator",
    sessionKey: "agent:main:discord:channel:channel-1"
  });

  assert.equal(override.runtimeResponseMode, "off");
  assert.equal(override.runtimeIngestMode, "all");
  assert.equal(override.runtimeMatched, "discord:default:guild-1:channel-1");
});

test("runtime scope matches saved channel override when guild is missing", () => {
  const commandConfig = normalizePolicyCommandConfig({});
  const state = {
    scopes: {
      "discord:default:guild-1:channel-1": {
        policy: { responseMode: "off", ingestMode: "all" }
      }
    }
  };
  const override = resolveRuntimePolicyOverride(commandConfig, state, {}, {
    accountId: "default",
    channelId: "channel-1"
  });

  assert.equal(override.runtimeResponseMode, "off");
  assert.equal(override.runtimeMatched, "discord:default:guild-1:channel-1");
  assert.equal(override.runtimeMatchedScope.guildId, "guild-1");
});

test("runtime scope uses Telegram platform and chat id", () => {
  const commandConfig = normalizePolicyCommandConfig({});
  const result = applyRuntimeCommand(commandConfig, {}, {
    chatId: "-100123"
  }, {
    accountId: "default",
    platform: "telegram",
    sessionKey: "agent:main:telegram:group:-100123"
  }, parsePolicyCommand("response mention"), "operator");

  assert.deepEqual(Object.keys(result.state.scopes), ["telegram:default:-:-100123"]);
  assert.equal(result.scope.platform, "telegram");
  assert.equal(result.scope.conversationId, "-100123");

  const override = resolveRuntimePolicyOverride(commandConfig, result.state, {}, {
    accountId: "default",
    sessionKey: "agent:main:telegram:group:-100123",
    metadata: { chat_id: "-100123" }
  });

  assert.equal(override.runtimeResponseMode, "mention");
  assert.equal(override.runtimeMatched, "telegram:default:-:-100123");
});

test("native requireMention target uses account-scoped Discord config", () => {
  const cfg = {
    channels: {
      discord: {
        guilds: {
          "guild-1": {
            channels: {
              "*": { enabled: true, requireMention: false }
            }
          }
        },
        accounts: {
          default: {
            guilds: {
              "guild-1": {
                channels: {
                  "*": { enabled: true, requireMention: false }
                }
              }
            }
          }
        }
      }
    }
  };

  const target = resolveNativeRequireMentionTarget({
    accountId: "default",
    guildId: "guild-1",
    channelId: "channel-1",
    provider: "discord"
  }, cfg);
  const next = applyNativeRequireMentionOverride(cfg, target, true);

  assert.equal(target.scope, "account");
  assert.equal(next.channels.discord.accounts.default.guilds["guild-1"].channels["channel-1"].requireMention, true);
  assert.equal(next.channels.discord.guilds["guild-1"].channels["channel-1"], undefined);
});

test("native requireMention status reports exact channel config source", () => {
  const cfg = {
    channels: {
      discord: {
        accounts: {
          default: {
            guilds: {
              "guild-1": {
                channels: {
                  "*": { enabled: false, requireMention: true },
                  "channel-1": { enabled: true, requireMention: false }
                }
              }
            }
          }
        }
      }
    }
  };
  const status = resolveNativeRequireMentionStatus({
    accountId: "default",
    guildId: "guild-1",
    channelId: "channel-1",
    provider: "discord"
  }, cfg);

  assert.equal(status.status, "off");
  assert.match(status.source, /channels\.channel-1\.requireMention$/);
});

test("native requireMention status inherits parent channel config for new subthreads", () => {
  const cfg = {
    channels: {
      discord: {
        accounts: {
          default: {
            guilds: {
              "guild-1": {
                requireMention: true,
                channels: {
                  "*": { enabled: false, requireMention: true },
                  "parent-1": { enabled: true, requireMention: false }
                }
              }
            }
          }
        }
      }
    }
  };
  const status = resolveNativeRequireMentionStatus({
    accountId: "default",
    guildId: "guild-1",
    channelId: "thread-1",
    parentId: "parent-1",
    provider: "discord"
  }, cfg);

  assert.equal(status.status, "off");
  assert.equal(status.target.parentChannelId, "parent-1");
  assert.match(status.source, /channels\.parent-1\.requireMention$/);
});

test("native requireMention status prefers account-scoped config over top-level Discord config", () => {
  const cfg = {
    channels: {
      discord: {
        guilds: {
          "guild-1": {
            channels: {
              "*": { enabled: true, requireMention: false },
              "parent-1": { enabled: true, requireMention: false }
            }
          }
        },
        accounts: {
          "project-bot": {
            guilds: {
              "guild-1": {
                requireMention: true,
                channels: {
                  "*": { enabled: true, requireMention: true }
                }
              }
            }
          }
        }
      }
    }
  };
  const status = resolveNativeRequireMentionStatus({
    accountId: "project-bot",
    guildId: "guild-1",
    channelId: "thread-1",
    parentId: "parent-1",
    provider: "discord"
  }, cfg);

  assert.equal(status.status, "on");
  assert.match(status.source, /^channels\.discord\.accounts\.project-bot\./);
});

test("dashboard view exposes button callbacks for runtime and permanent policy", () => {
  const commandConfig = normalizePolicyCommandConfig({ policyCommand: { applyDefault: true } });
  const runtimePolicy = resolveRuntimePolicyOverride(commandConfig, {}, {}, ctx);
  const nativeStatus = {
    status: "on",
    source: "channels.discord.accounts.default.guilds.guild-1.channels.thread-1.requireMention",
    target: {
      accountId: "default",
      scopeLabel: "account:default",
      guildId: "guild-1",
      zoneId: "thread-1"
    }
  };
  const view = buildPolicyDashboardView({
    effectivePolicy: runtimePolicy,
    runtimeOverride: runtimePolicy,
    scope: runtimePolicy.runtimeScope,
    nativeStatus,
    actorId: "operator"
  });

  assert.match(view.text, /Message policy/);
  assert.match(view.text, /Bot replies.*Off/);
  assert.match(view.text, /Reply override.*Off/);
  assert.match(view.text, /Native mention gate.*On/);
  assert.match(view.text, /Reply always available/);
  assert.match(view.text, /Cause: Runtime policy overrides native requireMention/);
  assert.equal(view.componentSpec.blocks.length, 4);
  const buttons = view.componentSpec.blocks.flatMap((block) => block.buttons);
  assert.ok(buttons.some((entry) => entry.callbackData.startsWith("policy:response:off:")));
  assert.ok(buttons.some((entry) => entry.callbackData.startsWith("policy:ingest:passive:")));
  assert.ok(buttons.some((entry) => entry.callbackData.startsWith("policy:native:on:")));
  assert.ok(buttons.some((entry) => entry.label === "Reply always"));
  assert.ok(buttons.some((entry) => entry.label === "Disable native gate"));
  assert.ok(buttons.every((entry) => entry.allowedUsers[0] === "operator"));
});

test("dashboard callback payload keeps channel scope for interaction handlers", () => {
  const commandConfig = normalizePolicyCommandConfig({ policyCommand: { applyDefault: true } });
  const runtimePolicy = resolveRuntimePolicyOverride(commandConfig, {}, {}, ctx);
  const view = buildPolicyDashboardView({
    effectivePolicy: runtimePolicy,
    runtimeOverride: runtimePolicy,
    scope: runtimePolicy.runtimeScope,
    nativeStatus: { status: "unset" }
  });
  const buttons = view.componentSpec.blocks.flatMap((block) => block.buttons);
  const responseEntry = buttons.find((entry) => entry.callbackData.startsWith("policy:response:always:"));
  const payload = responseEntry.callbackData.replace(/^policy:/, "");
  const command = parsePolicyDashboardAction(payload);
  const restoredCtx = contextFromPolicyScope(command.scope, { target: "slash:operator" });

  assert.equal(command.action, "set-response");
  assert.equal(command.value, "always");
  assert.equal(restoredCtx.guildId, "guild-1");
  assert.equal(restoredCtx.channelId, "channel-1");
  assert.equal(restoredCtx.conversationId, "thread-1");
});

test("dashboard can switch policy account without manual input", () => {
  const commandConfig = normalizePolicyCommandConfig({ policyCommand: { applyDefault: true } });
  const runtimePolicy = resolveRuntimePolicyOverride(commandConfig, {}, {}, ctx);
  const view = buildPolicyDashboardView({
    effectivePolicy: runtimePolicy,
    runtimeOverride: runtimePolicy,
    scope: runtimePolicy.runtimeScope,
    nativeStatus: { status: "unset" },
    accountOptions: ["default", "secondary-bot"]
  });
  const buttons = view.componentSpec.blocks.flatMap((block) => block.buttons);
  const accountEntry = buttons.find((entry) => entry.callbackData.startsWith("policy:account:secondary-bot:"));
  const payload = accountEntry.callbackData.replace(/^policy:/, "");
  const command = parsePolicyDashboardAction(payload);
  const restoredCtx = contextFromPolicyScope(command.scope, ctx);

  assert.match(view.text, /Account.*default/);
  assert.equal(view.componentSpec.blocks.length, 5);
  assert.equal(command.action, "select-account");
  assert.equal(restoredCtx.accountId, "secondary-bot");
  assert.equal(restoredCtx.guildId, "guild-1");
  assert.equal(restoredCtx.channelId, "channel-1");
});

test("dashboard account selector keeps selected account visible when there are many accounts", () => {
  const commandConfig = normalizePolicyCommandConfig({ policyCommand: { applyDefault: true } });
  const runtimePolicy = resolveRuntimePolicyOverride(
    commandConfig,
    {},
    {},
    { ...ctx, accountId: "zeta" }
  );
  const view = buildPolicyDashboardView({
    effectivePolicy: runtimePolicy,
    runtimeOverride: runtimePolicy,
    scope: runtimePolicy.runtimeScope,
    nativeStatus: { status: "unset" },
    accountOptions: ["default", "alpha", "bravo", "charlie", "delta", "zeta"]
  });
  const buttons = view.componentSpec.blocks.flatMap((block) => block.buttons);
  const accountButtons = buttons.filter((entry) => entry.callbackData.startsWith("policy:account:"));

  assert.equal(view.componentSpec.blocks.length, 5);
  assert.ok(accountButtons.some((entry) => entry.callbackData.startsWith("policy:account:zeta:")));
  assert.equal(accountButtons.find((entry) => entry.callbackData.startsWith("policy:account:zeta:")).style, "success");
});

test("dashboard accounts include configured discord and mention-detection accounts", () => {
  const accounts = policyDashboardAccountsFromConfig({
    channels: {
      discord: {
        accounts: {
          "project-bot": { name: "Project Bot" },
          default: {}
        }
      }
    },
    plugins: {
      entries: {
        "extra-message-policy": {
          config: {
            mentionDetection: {
              accounts: {
                secondary: {}
              }
            }
          }
        }
      }
    }
  });

  assert.deepEqual(accounts, [
    { id: "default", label: "default" },
    { id: "project-bot", label: "Project Bot" },
    { id: "secondary", label: "secondary" }
  ]);
});

test("dashboard can render effective config separately from missing runtime override", () => {
  const commandConfig = normalizePolicyCommandConfig({ policyCommand: { applyDefault: true } });
  const scoped = resolveRuntimePolicyOverride(commandConfig, {}, {}, ctx);
  const view = buildPolicyDashboardView({
    effectivePolicy: {
      respond: true,
      requireMention: true,
      ingestMode: "all",
      matched: "config-channel"
    },
    runtimeOverride: null,
    scope: scoped.runtimeScope,
    nativeStatus: { status: "on" }
  });
  const buttons = view.componentSpec.blocks.flatMap((block) => block.buttons);

  assert.match(view.text, /Bot replies.*Mention only/);
  assert.match(view.text, /Bot reads.*All messages/);
  assert.match(view.text, /Reply override.*None/);
  assert.equal(buttons.find((entry) => entry.label === "Mention only").style, "success");
  assert.equal(buttons.find((entry) => entry.label === "All messages").style, "success");
});

test("always reply is allowed because runtime policy overrides native mention gate", () => {
  const blocked = validateRuntimeResponseAction(
    parsePolicyCommand("response always"),
    { status: "on" }
  );
  const allowed = validateRuntimeResponseAction(
    parsePolicyCommand("response always"),
    { status: "off" }
  );

  assert.equal(blocked.ok, true);
  assert.equal(allowed.ok, true);
});

test("subthreads inherit parent panel override until overwritten", () => {
  const commandConfig = normalizePolicyCommandConfig({});
  const parent = applyRuntimeCommand(
    commandConfig,
    {},
    {},
    { ...ctx, channelId: "parent-1", conversationId: "channel:parent-1" },
    parsePolicyCommand("response mention"),
    "operator"
  );
  const inherited = resolveRuntimePolicyOverride(commandConfig, parent.state, {}, threadCtx);

  assert.equal(inherited.runtimeResponseMode, "mention");
  assert.equal(inherited.runtimeInherited, true);
  assert.equal(inherited.runtimeMatched, "discord:default:guild-1:parent-1");

  const child = applyRuntimeCommand(commandConfig, parent.state, {}, threadCtx, parsePolicyCommand("response always"), "operator");
  const childOverride = resolveRuntimePolicyOverride(commandConfig, child.state, {}, threadCtx);

  assert.equal(childOverride.runtimeResponseMode, "always");
  assert.equal(childOverride.runtimeInherited, false);
  assert.equal(childOverride.runtimeMatched, "discord:default:guild-1:thread-1");
});

test("new Discord subthreads inherit parent panel override from parent id aliases", () => {
  const commandConfig = normalizePolicyCommandConfig({});
  const parent = applyRuntimeCommand(
    commandConfig,
    {},
    {},
    { ...ctx, channelId: "parent-1", conversationId: "channel:parent-1" },
    parsePolicyCommand("ingest all"),
    "operator"
  );
  const inherited = resolveRuntimePolicyOverride(commandConfig, parent.state, {}, {
    accountId: "default",
    guildId: "guild-1",
    channelId: "thread-2",
    conversationId: "channel:thread-2",
    parentId: "parent-1",
    senderId: "operator"
  });

  assert.equal(inherited.runtimeIngestMode, "all");
  assert.equal(inherited.runtimeInherited, true);
  assert.equal(inherited.runtimeMatched, "discord:default:guild-1:parent-1");
});

test("details button toggles technical details", () => {
  const commandConfig = normalizePolicyCommandConfig({ policyCommand: { applyDefault: true } });
  const runtimePolicy = resolveRuntimePolicyOverride(commandConfig, {}, {}, ctx);
  const view = buildPolicyDashboardView({
    effectivePolicy: runtimePolicy,
    runtimeOverride: runtimePolicy,
    scope: runtimePolicy.runtimeScope,
    nativeStatus: { status: "unset" },
    details: true,
    panelStatePath: "/tmp/policy-state.json"
  });
  const buttons = view.componentSpec.blocks.flatMap((block) => block.buttons);

  assert.match(view.text, /Details/);
  assert.match(view.text, /Panel state: \/tmp\/policy-state\.json/);
  assert.ok(buttons.some((entry) => entry.callbackData.startsWith("policy:details:hide:")));
});

test("command parser covers aliases and unknown input", () => {
  assert.deepEqual(parsePolicyCommand("show"), { action: "status" });
  assert.deepEqual(parsePolicyCommand("clear"), { action: "reset" });
  assert.deepEqual(parsePolicyCommand("reply always"), { action: "set-response", value: "always" });
  assert.deepEqual(parsePolicyCommand("respond off"), { action: "set-response", value: "off" });
  assert.deepEqual(parsePolicyCommand("read all"), { action: "set-ingest", value: "all" });
  assert.deepEqual(parsePolicyCommand("require-mention on"), { action: "set-native-require", value: "on" });
  assert.deepEqual(parsePolicyCommand("config off"), { action: "set-native-require", value: "off" });
  assert.deepEqual(parsePolicyCommand("wat"), { action: "help" });
});

test("dashboard action parser covers every action and bad scopes", () => {
  assert.deepEqual(parsePolicyDashboardAction("refresh:_:"), { action: "status", scope: null });
  assert.deepEqual(parsePolicyDashboardAction("details:hide:not-json"), {
    action: "details",
    value: "hide",
    scope: null,
    details: false
  });
  assert.deepEqual(parsePolicyDashboardAction("reset:_:"), { action: "reset", scope: null });
  assert.deepEqual(parsePolicyDashboardAction("response:mention:"), { action: "set-response", value: "mention", scope: null });
  assert.deepEqual(parsePolicyDashboardAction("ingest:passive:"), { action: "set-ingest", value: "passive", scope: null });
  assert.deepEqual(parsePolicyDashboardAction("native:on:"), { action: "set-native-require", value: "on", scope: null });
  assert.deepEqual(parsePolicyDashboardAction("unknown:_:"), { action: "status", scope: null });
});

test("runtime command reset and unknown actions are stable", () => {
  const commandConfig = normalizePolicyCommandConfig({});
  const set = applyRuntimeCommand(commandConfig, {}, {}, ctx, parsePolicyCommand("response always"), "operator");
  const reset = applyRuntimeCommand(commandConfig, set.state, {}, ctx, parsePolicyCommand("reset"), "operator");
  const noop = applyRuntimeCommand(commandConfig, reset.state, {}, ctx, { action: "noop" }, "operator");

  assert.equal(Object.keys(reset.state.scopes).length, 0);
  assert.equal(reset.changed, true);
  assert.equal(noop.changed, false);
});

test("policy state persistence normalizes invalid entries", async () => {
  const filePath = path.join(await mkdtemp(path.join(os.tmpdir(), "policy-state-")), "state.json");
  const state = normalizePolicyState({
    scopes: {
      good: { policy: { responseMode: "always", ingestMode: "candidates" }, extra: true },
      bad: null,
      alsoBad: "x"
    }
  });
  await savePolicyState(filePath, state);
  const loaded = await loadPolicyState(filePath);
  const missing = await loadPolicyState(path.join(path.dirname(filePath), "missing.json"));

  assert.deepEqual(Object.keys(loaded.scopes), ["good"]);
  assert.equal(loaded.scopes.good.policy.ingestMode, "responseCandidates");
  assert.deepEqual(missing, { version: 1, scopes: {} });
});

test("default policy state path falls back when runtime state resolver fails", () => {
  const filePath = defaultPolicyStatePath({
    runtime: {
      state: {
        resolveStateDir() {
          throw new Error("no state dir");
        }
      }
    },
    config: {}
  }, normalizePolicyCommandConfig({}));

  assert.match(filePath, /runtime\/extra-message-policy\/policy-state\.json$/);
});

test("native requireMention command rejects invalid values before loading runtime", async () => {
  assert.deepEqual(await applyNativeRequireMentionCommand({}, "maybe"), {
    text: "Usage: /policy native on|off"
  });
});

test("scope resolution covers runtime-shaped and Telegram contexts", () => {
  const runtimeScope = scopeFromContext({}, {
    AccountId: "runtime",
    GroupSpace: "guild-runtime",
    NativeChannelId: "native-channel",
    ParentChannelId: "parent-channel",
    OriginatingTo: "channel:native-channel",
    SessionKey: "agent:main:discord:guild:guild-runtime:channel:native-channel"
  });

  assert.equal(runtimeScope.platform, "discord");
  assert.equal(runtimeScope.accountId, "runtime");
  assert.equal(runtimeScope.guildId, "guild-runtime");
  assert.equal(runtimeScope.channelId, "parent-channel");
  assert.equal(runtimeScope.parentChannelId, "parent-channel");
  assert.equal(runtimeScope.conversationId, "native-channel");
  assert.equal(runtimeScope.key, "discord:runtime:guild-runtime:native-channel");
  assert.equal(scopeFromContext({ provider: "telegram", from: "-100" }, {}).platform, "telegram");
});

test("native requireMention target reports unsupported and unresolved contexts", () => {
  const cfg = { channels: { discord: { accounts: {} } } };

  assert.deepEqual(resolveNativeRequireMentionTarget({ provider: "telegram" }, cfg), {
    error: "This permanent config operation currently supports Discord only."
  });
  assert.deepEqual(resolveNativeRequireMentionTarget({ platform: "telegram" }, cfg), {
    error: "This permanent config operation currently supports Discord only."
  });
  assert.deepEqual(resolveNativeRequireMentionTarget({
    sessionKey: "agent:main:telegram:group:-100123:topic:421"
  }, cfg), {
    error: "This permanent config operation currently supports Discord only."
  });
  assert.deepEqual(resolveNativeRequireMentionTarget({
    channelId: "telegram",
    sessionKey: "agent:main:main"
  }, cfg), {
    error: "This permanent config operation currently supports Discord only."
  });
  assert.deepEqual(resolveNativeRequireMentionTarget({ provider: "discord" }, cfg), {
    error: "Unable to resolve the current Discord channel or thread."
  });
  const status = resolveNativeRequireMentionStatus({ provider: "discord" }, cfg);
  assert.equal(status.status, "unavailable");
  assert.match(renderNativeRequireMentionStatus(status), /unavailable/);
});

test("native requireMention status covers guild, wildcard, unset, and rendering", () => {
  const cfg = {
    channels: {
      discord: {
        guilds: {
          "guild-1": {
            requireMention: true,
            channels: {
              "*": { requireMention: false }
            }
          },
          "guild-2": {
            channels: {
              "*": { requireMention: true }
            }
          },
          "guild-3": {
            channels: {}
          }
        }
      }
    }
  };

  assert.equal(resolveNativeRequireMentionStatus({ guildId: "guild-1", channelId: "new" }, cfg).status, "on");
  assert.equal(resolveNativeRequireMentionStatus({ guildId: "guild-2", channelId: "new" }, cfg).status, "on");
  const unset = resolveNativeRequireMentionStatus({ guildId: "guild-3", channelId: "new" }, cfg);
  assert.equal(unset.status, "unset");
  assert.match(renderNativeRequireMentionStatus(unset), /requireMention: unset/);
});

test("native requireMention override errors on missing guild and channels", () => {
  assert.throws(() => applyNativeRequireMentionOverride({
    channels: { discord: { guilds: {} } }
  }, {
    scope: "top-level",
    scopePath: "channels.discord",
    guildId: "missing",
    zoneId: "zone"
  }, true), /not configured/);

  assert.throws(() => applyNativeRequireMentionOverride({
    channels: { discord: { guilds: { "guild-1": {} } } }
  }, {
    scope: "top-level",
    scopePath: "channels.discord",
    guildId: "guild-1",
    zoneId: "zone"
  }, true), /channels block/);
});

test("dashboard renders unknown modes and compact labels", () => {
  const view = buildPolicyDashboardView({
    effectivePolicy: { respond: true, ingestMode: "strange", runtimeResponseMode: "weird", runtimeIngestMode: "odd" },
    runtimeOverride: { runtimeResponseMode: "weird", runtimeIngestMode: "odd", runtimeInherited: true },
    scope: { accountId: "very-long-account-id-that-needs-compaction", guildId: "guild", channelId: "zone" },
    nativeStatus: { status: "mystery", source: "custom-source", target: { zoneId: "zone" } },
    accountOptions: [
      { id: "very-long-account-id-that-needs-compaction", label: "Very Long Account Label That Needs Compaction" },
      null,
      { value: "other", name: "Other" },
      ""
    ]
  });

  assert.match(view.text, /Unknown/);
  const buttons = view.componentSpec.blocks.flatMap((block) => block.buttons);
  assert.ok(buttons.some((button) => button.label.endsWith("...")));
});

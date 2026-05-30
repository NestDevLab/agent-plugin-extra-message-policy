import assert from "node:assert/strict";
import test from "node:test";
import {
  applyNativeRequireMentionOverride,
  applyNativeMentionGatePolicy,
  applyRuntimeCommand,
  applyRuntimePolicy,
  buildPolicyDashboardView,
  contextFromPolicyScope,
  normalizePolicyCommandConfig,
  policyDashboardAccountsFromConfig,
  parsePolicyDashboardAction,
  parsePolicyCommand,
  renderPolicyStatus,
  resolveNativeRequireMentionStatus,
  resolveNativeRequireMentionTarget,
  resolveRuntimePolicyOverride,
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

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  buildDiscordComponentMessage,
  registerBuiltDiscordComponentMessage
} from "openclaw/plugin-sdk/discord";
import { registerExtraMessagePolicy } from "./plugin-runtime.js";

export { registerExtraMessagePolicy } from "./plugin-runtime.js";

export default definePluginEntry({
  id: "extra-message-policy",
  name: "Extra Message Policy",
  description: "Cross-platform message ingest and response policy enforcement",
  register(api) {
    registerExtraMessagePolicy(api, {
      discordSdk: {
        buildDiscordComponentMessage,
        registerBuiltDiscordComponentMessage
      }
    });
  }
});

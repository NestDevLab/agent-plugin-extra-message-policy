import { createRequire } from "node:module";

const DISCORD_API_SURFACE = "@openclaw/discord/dist/api.js";
const DISCORD_RUNTIME_API_SURFACE = "@openclaw/discord/dist/runtime-api.js";
const DISCORD_PUBLIC_SURFACE_ERROR = /Unable to resolve bundled plugin public surface discord\/(?:api|runtime-api)\.js/u;

function isDiscordPublicSurfaceResolutionError(error) {
  return DISCORD_PUBLIC_SURFACE_ERROR.test(String(error?.message || error || ""));
}

function createOpenClawPackageRequire() {
  const localRequire = createRequire(import.meta.url);
  return createRequire(localRequire.resolve("openclaw"));
}

function tryLoadDiscordSurface(moduleRequire, specifier) {
  try {
    return moduleRequire(specifier);
  } catch {
    return null;
  }
}

function callDiscordFallback(moduleRequire, specifier, exportName, args, originalError, { required = true } = {}) {
  const surface = tryLoadDiscordSurface(moduleRequire, specifier);
  const fn = surface?.[exportName];
  if (typeof fn === "function") return fn(...args);
  if (required) throw originalError;
  return undefined;
}

export function createDiscordSdkCompat(primarySdk = {}, options = {}) {
  let cachedModuleRequire;
  const getModuleRequire = () => {
    cachedModuleRequire ||= options.moduleRequire || createOpenClawPackageRequire();
    return cachedModuleRequire;
  };

  return {
    buildDiscordComponentMessage(...args) {
      const primary = primarySdk.buildDiscordComponentMessage;
      if (typeof primary !== "function") {
        return callDiscordFallback(
          getModuleRequire(),
          DISCORD_API_SURFACE,
          "buildDiscordComponentMessage",
          args,
          new Error("Discord component builder is not available")
        );
      }
      try {
        return primary(...args);
      } catch (error) {
        if (!isDiscordPublicSurfaceResolutionError(error)) throw error;
        return callDiscordFallback(
          getModuleRequire(),
          DISCORD_API_SURFACE,
          "buildDiscordComponentMessage",
          args,
          error
        );
      }
    },

    registerBuiltDiscordComponentMessage(...args) {
      const primary = primarySdk.registerBuiltDiscordComponentMessage;
      if (typeof primary !== "function") {
        return callDiscordFallback(
          getModuleRequire(),
          DISCORD_RUNTIME_API_SURFACE,
          "registerBuiltDiscordComponentMessage",
          args,
          new Error("Discord component registry is not available"),
          { required: false }
        );
      }
      try {
        return primary(...args);
      } catch (error) {
        if (!isDiscordPublicSurfaceResolutionError(error)) throw error;
        return callDiscordFallback(
          getModuleRequire(),
          DISCORD_RUNTIME_API_SURFACE,
          "registerBuiltDiscordComponentMessage",
          args,
          error,
          { required: false }
        );
      }
    }
  };
}

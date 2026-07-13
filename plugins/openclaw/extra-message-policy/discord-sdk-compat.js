import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

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

function readPackageMetadata(packagePath) {
  try {
    const value = JSON.parse(readFileSync(packagePath, "utf8"));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function resolvedPackageVersion(moduleRequire, packageName) {
  if (typeof moduleRequire?.resolve !== "function") return "";
  let current;
  try {
    current = path.dirname(moduleRequire.resolve(packageName));
  } catch {
    return "";
  }
  while (true) {
    const metadata = readPackageMetadata(path.join(current, "package.json"));
    if (metadata?.name === packageName) return String(metadata.version || "");
    const parent = path.dirname(current);
    if (parent === current) return "";
    current = parent;
  }
}

function isolatedDiscordPackageRoots(stateDir, runtimeVersion = "") {
  if (!stateDir) return [];
  const projectsRoot = path.join(stateDir, "npm", "projects");
  let entries = [];
  try {
    entries = readdirSync(projectsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(
      projectsRoot,
      entry.name,
      "node_modules",
      "@openclaw",
      "discord"
    ))
    .map((root) => ({ root, metadata: readPackageMetadata(path.join(root, "package.json")) }))
    .filter(({ metadata }) => metadata?.name === "@openclaw/discord"
      && (!runtimeVersion || metadata.version === runtimeVersion))
    .sort((left, right) => {
      try {
        return statSync(path.join(right.root, "package.json")).mtimeMs
          - statSync(path.join(left.root, "package.json")).mtimeMs;
      } catch {
        return 0;
      }
    })
    .map(({ root }) => root);
}

function tryLoadIsolatedDiscordSurface(stateDir, specifier, moduleRequire) {
  const artifactBasename = specifier.endsWith("/runtime-api.js")
    ? "runtime-api.js"
    : specifier.endsWith("/api.js")
      ? "api.js"
      : "";
  if (!artifactBasename) return null;
  const runtimeVersion = resolvedPackageVersion(moduleRequire, "openclaw");
  for (const packageRoot of isolatedDiscordPackageRoots(stateDir, runtimeVersion)) {
    const artifactPath = path.join(packageRoot, "dist", artifactBasename);
    if (!existsSync(artifactPath)) continue;
    try {
      return createRequire(path.join(packageRoot, "package.json"))(artifactPath);
    } catch {
      continue;
    }
  }
  return null;
}

function callDiscordFallback(moduleRequire, specifier, exportName, args, originalError, { required = true, stateDir } = {}) {
  const surface = tryLoadDiscordSurface(moduleRequire, specifier)
    || tryLoadIsolatedDiscordSurface(stateDir, specifier, moduleRequire);
  const fn = surface?.[exportName];
  if (typeof fn === "function") return fn(...args);
  if (required) throw originalError;
  return undefined;
}

export function createDiscordSdkCompat(primarySdk = {}, options = {}) {
  let cachedModuleRequire;
  let moduleRequireResolved = false;
  const getModuleRequire = () => {
    if (typeof options.moduleRequire === "function") return options.moduleRequire;
    if (!moduleRequireResolved) {
      moduleRequireResolved = true;
      try {
        cachedModuleRequire = createOpenClawPackageRequire();
      } catch {
        cachedModuleRequire = null;
      }
    }
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
          new Error("Discord component builder is not available"),
          { stateDir: options.stateDir }
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
          error,
          { stateDir: options.stateDir }
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
          { required: false, stateDir: options.stateDir }
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
          { required: false, stateDir: options.stateDir }
        );
      }
    }
  };
}

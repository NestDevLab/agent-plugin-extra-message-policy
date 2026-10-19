import { createHash } from "node:crypto";

function discordSessionRoute(sessionKey, agentId) {
  if (typeof sessionKey !== "string" || typeof agentId !== "string") return;
  const match = /^agent:([^:]+):discord:(direct|channel|group):([^:]+)$/.exec(sessionKey);
  if (!match || match[1] !== agentId) return;
  return { kind: match[2], peerId: match[3] };
}

function accountCandidates(value) {
  return (Array.isArray(value) ? value : [value]).filter((account) => typeof account === "string" && account.length > 0);
}

function nativeSourceTurnId(account, target, messageId) {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(account) || !target || !messageId) return;
  const digest = createHash("sha256").update(JSON.stringify([
    "discord", account.trim().toLowerCase(), target, messageId
  ])).digest("hex");
  return `channel-user:v1:${digest}`;
}

export function createNativeOptOutGuard(discordOptOut, agentAccountMap) {
  const optedOut = new Map(Object.entries(discordOptOut || {}).map(([account, senders]) => [account, new Set(senders)]));
  return (event = {}, ctx = {}) => {
    const message = event.message;
    if (message?.role !== "user") return;
    const route = discordSessionRoute(ctx.sessionKey, ctx.agentId);
    const channel = message.sourceChannel ?? message.provenance?.sourceChannel ?? message.__openclaw?.transport?.channel;
    if (channel !== undefined ? channel !== "discord" : !route) return;
    const candidates = accountCandidates(agentAccountMap?.[ctx.agentId]);
    if (candidates.length === 0) return;
    const senderId = message.senderId ?? message.__openclaw?.senderId ??
      (route?.kind === "direct" ? route.peerId : undefined);
    const sourceId = message.idempotencyKey;
    const messageId = message.__openclaw?.transport?.messageId;
    if (typeof sourceId === "string" && typeof messageId === "string") {
      for (const account of candidates) {
        const senders = optedOut.get(account);
        if (!senders?.size) continue;
        const target = route && route.kind !== "direct" ? `${route.kind}:${route.peerId}` : undefined;
        if (target && senderId && senders.has(senderId) &&
            sourceId === nativeSourceTurnId(account, target, messageId)) return { block: true };
        // Main-scoped direct turns omit sender metadata. The native source ID
        // still binds the bot account, direct sender, and provider message ID.
        if (!route || route.kind === "direct") {
          for (const sender of senders) if ((!senderId || senderId === sender) &&
              sourceId === nativeSourceTurnId(account, `user:${sender}`, messageId)) return { block: true };
        }
      }
    }
    // Only a single-account agent can fall back to sender metadata. A shared
    // agent needs an exact native source ID to avoid blocking the other bot.
    if (candidates.length === 1 && senderId && optedOut.get(candidates[0])?.has(senderId)) return { block: true };
  };
}

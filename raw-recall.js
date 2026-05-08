import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const DEFAULT_STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "this", "that", "what", "where", "when", "which", "about", "status", "project", "progress"
]);

const DEFAULT_TRIGGER_PHRASES = [
  "recap",
  "summary",
  "where are we",
  "project status",
  "what did we decide"
];

export function normalizeRawRecallConfig(raw = {}, jsonlSink = {}) {
  return {
    enabled: raw.enabled !== false,
    appendGuidance: raw.appendGuidance !== false,
    searchOnTriggerOnly: raw.searchOnTriggerOnly !== false,
    rootPath: typeof raw.rootPath === "string" && raw.rootPath.trim() ? raw.rootPath.trim() : jsonlSink.path,
    maxDays: Number.isFinite(raw.maxDays) ? Math.max(1, Number(raw.maxDays)) : 30,
    maxMatches: Number.isFinite(raw.maxMatches) ? Math.max(1, Number(raw.maxMatches)) : 12,
    maxContextChars: Number.isFinite(raw.maxContextChars) ? Math.max(500, Number(raw.maxContextChars)) : 6000,
    triggerPhrases: Array.isArray(raw.triggerPhrases) && raw.triggerPhrases.length
      ? raw.triggerPhrases.map((x) => String(x).toLowerCase()).filter(Boolean)
      : DEFAULT_TRIGGER_PHRASES
  };
}

export function buildRawRecallGuidance(cfg) {
  if (!cfg?.enabled || !cfg?.appendGuidance) return "";
  const root = cfg.rootPath || "memory/discord/raw";
  return [
    "Passive Discord raw ingest is available as local JSONL files.",
    `Archive root: ${root}`,
    "Layout: YYYY/MM/DD/channel_<id>.jsonl (one JSON object per message).",
    "When the user asks for project status, progress, prior decisions, recent context, or monitoring clues, treat this archive as an on-demand memory source.",
    "Use the injected raw-recall excerpts when present. If more detail is needed and file tools are available, inspect the relevant JSONL shards directly with read/grep/tail before answering.",
    "Do not summarize or index the archive proactively; automatic ingest must remain zero-token. Recall happens only during an actual agent request."
  ].join("\n");
}

export function extractTerms(prompt) {
  const text = String(prompt || "").toLowerCase();
  const words = text.match(/[\p{L}\p{N}_-]{3,}/gu) || [];
  const terms = [];
  for (const word of words) {
    const normalized = word.replace(/^[-_]+|[-_]+$/g, "");
    if (!normalized || DEFAULT_STOPWORDS.has(normalized)) continue;
    if (!terms.includes(normalized)) terms.push(normalized);
  }
  return terms.slice(0, 12);
}

export function shouldSearchRawRecall(prompt, cfg) {
  if (!cfg?.enabled) return false;
  const lowered = String(prompt || "").toLowerCase();
  if (cfg.triggerPhrases.some((phrase) => lowered.includes(phrase))) return true;
  if (!cfg.searchOnTriggerOnly) return extractTerms(prompt).length >= 2;
  return false;
}

function dateParts(date) {
  return {
    year: String(date.getUTCFullYear()),
    month: String(date.getUTCMonth() + 1).padStart(2, "0"),
    day: String(date.getUTCDate()).padStart(2, "0")
  };
}

async function fileExists(filePath) {
  try {
    const s = await stat(filePath);
    return s.isFile();
  } catch {
    return false;
  }
}

async function dirFiles(dirPath) {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl")).map((entry) => path.join(dirPath, entry.name));
  } catch {
    return [];
  }
}

export async function listRawRecallFiles(rootPath, maxDays, now = new Date()) {
  const root = path.resolve(process.cwd(), rootPath || "memory/discord/raw");
  const files = [];

  if (root.endsWith(".jsonl") && await fileExists(root)) files.push(root);
  const legacy = path.join(root, "messages.jsonl");
  if (await fileExists(legacy)) files.push(legacy);

  for (let offset = 0; offset < maxDays; offset += 1) {
    const date = new Date(now.getTime() - offset * 24 * 60 * 60 * 1000);
    const { year, month, day } = dateParts(date);
    files.push(...await dirFiles(path.join(root, year, month, day)));
  }

  return [...new Set(files)];
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function scoreRecord(record, terms, currentConversationId) {
  const haystack = `${record.content || ""} ${record.metadata?.channelName || ""} ${record.conversationId || ""}`.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (haystack.includes(term)) score += term.length > 5 ? 2 : 1;
  }
  if (currentConversationId && record.conversationId === currentConversationId) score += 2;
  return score;
}

function formatRecord(record) {
  const ts = record.observedAt || (record.timestamp ? new Date(Number(record.timestamp)).toISOString() : "unknown-time");
  const channel = record.metadata?.channelName || record.conversationId || record.channelId || "unknown-channel";
  const sender = record.metadata?.senderName || record.senderId || "unknown-sender";
  const content = String(record.content || "").replace(/\s+/g, " ").trim();
  return `- [${ts}] ${channel} / ${sender}: ${content}`;
}

export async function searchRawRecall(prompt, cfg, ctx = {}) {
  if (!shouldSearchRawRecall(prompt, cfg)) return "";
  const terms = extractTerms(prompt);
  if (!terms.length) return "";

  const files = await listRawRecallFiles(cfg.rootPath, cfg.maxDays);
  const matches = [];
  const currentConversationId = ctx?.conversationId || (ctx?.sessionKey?.includes(":channel:") ? `channel:${ctx.sessionKey.split(":channel:").at(-1)?.split(":")[0]}` : "");

  for (const file of files) {
    let text = "";
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n").filter(Boolean);
    for (const line of lines) {
      const record = parseJsonLine(line);
      if (!record) continue;
      const score = scoreRecord(record, terms, currentConversationId);
      if (score <= 0) continue;
      matches.push({ score, record });
    }
  }

  if (!matches.length) return "";
  matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const at = Date.parse(a.record.observedAt || "") || Number(a.record.timestamp || 0);
    const bt = Date.parse(b.record.observedAt || "") || Number(b.record.timestamp || 0);
    return bt - at;
  });

  const lines = [
    "Relevant passive Discord raw-recall excerpts (local JSONL archive; verify details if needed):"
  ];
  for (const match of matches.slice(0, cfg.maxMatches)) lines.push(formatRecord(match.record));

  let output = lines.join("\n");
  if (output.length > cfg.maxContextChars) output = `${output.slice(0, cfg.maxContextChars)}\n[raw-recall truncated]`;
  return output;
}

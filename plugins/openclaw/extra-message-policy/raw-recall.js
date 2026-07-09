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
  const tool = raw.tool && typeof raw.tool === "object" ? raw.tool : {};
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
      : DEFAULT_TRIGGER_PHRASES,
    tool: {
      enabled: tool.enabled !== false,
      maxMatches: Number.isFinite(tool.maxMatches) ? Math.max(1, Number(tool.maxMatches)) : 20,
      maxContextChars: Number.isFinite(tool.maxContextChars) ? Math.max(500, Number(tool.maxContextChars)) : 12000,
      maxFiles: Number.isFinite(tool.maxFiles) ? Math.max(1, Number(tool.maxFiles)) : 5000
    }
  };
}

export function buildRawRecallGuidance(cfg) {
  if (!cfg?.enabled || !cfg?.appendGuidance) return "";
  const root = cfg.rootPath || "memory/discord/raw";
  const toolLine = cfg.tool?.enabled === false
    ? "If more detail is needed and file tools are available, inspect the relevant JSONL shards directly before answering."
    : "If more detail is needed, use the search_raw_context tool to query the archive on demand before answering.";
  return [
    "Passive message raw ingest is available as local JSONL files.",
    `Archive root: ${root}`,
    "Common layout: YYYY/MM/DD/<conversation>.jsonl (one JSON object per message).",
    "When the user asks for project status, progress, prior decisions, recent context, or monitoring clues, treat this archive as an on-demand memory source.",
    "Use the injected raw-recall excerpts when present.",
    toolLine,
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

async function walkJsonlFiles(dirPath, maxFiles, files = []) {
  if (files.length >= maxFiles) return files;
  let entries = [];
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return files;
  }

  entries.sort((a, b) => b.name.localeCompare(a.name));
  for (const entry of entries) {
    if (files.length >= maxFiles) break;
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) await walkJsonlFiles(entryPath, maxFiles, files);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(entryPath);
  }
  return files;
}

export async function listRawRecallFiles(rootPath, maxDays, now = new Date(), options = {}) {
  const root = path.resolve(process.cwd(), rootPath || "memory/discord/raw");
  const files = [];
  const maxFiles = Math.max(1, Number(options.maxFiles || 5000));

  if (root.endsWith(".jsonl") && await fileExists(root)) files.push(root);
  const legacy = path.join(root, "messages.jsonl");
  if (await fileExists(legacy)) files.push(legacy);

  if (maxDays === null || maxDays === undefined || maxDays === 0 || maxDays === Infinity) {
    files.push(...await walkJsonlFiles(root, maxFiles, []));
    return [...new Set(files)].slice(0, maxFiles);
  }

  for (let offset = 0; offset < maxDays; offset += 1) {
    const date = new Date(now.getTime() - offset * 24 * 60 * 60 * 1000);
    const { year, month, day } = dateParts(date);
    files.push(...await dirFiles(path.join(root, year, month, day)));
    if (files.length >= maxFiles) break;
  }

  return [...new Set(files)].slice(0, maxFiles);
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function recordTimestampMs(record) {
  return Date.parse(record.observedAt || "") || Number(record.timestamp || 0) || 0;
}

function recordMatchesFilters(record, filters = {}) {
  if (filters.conversationId && record.conversationId !== filters.conversationId) return false;
  if (filters.channelId && record.channelId !== filters.channelId) return false;
  if (filters.senderId && record.senderId !== filters.senderId) return false;
  return true;
}

function scoreRecord(record, terms, currentConversationId) {
  const haystack = `${record.content || ""} ${record.metadata?.channelName || ""} ${record.conversationId || ""} ${record.channelId || ""} ${record.senderId || ""}`.toLowerCase();
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

function currentConversationIdFromContext(ctx = {}) {
  return ctx?.conversationId || (ctx?.sessionKey?.includes(":channel:") ? `channel:${ctx.sessionKey.split(":channel:").at(-1)?.split(":")[0]}` : "");
}

function normalizeSearchOptions(options = {}) {
  const daysBack = options.daysBack === undefined || options.daysBack === null || options.daysBack === ""
    ? undefined
    : Math.max(0, Number(options.daysBack));
  return {
    query: String(options.query || options.prompt || ""),
    daysBack: Number.isFinite(daysBack) ? daysBack : undefined,
    maxMatches: Number.isFinite(Number(options.maxMatches)) ? Math.max(1, Number(options.maxMatches)) : undefined,
    maxContextChars: Number.isFinite(Number(options.maxContextChars)) ? Math.max(500, Number(options.maxContextChars)) : undefined,
    maxFiles: Number.isFinite(Number(options.maxFiles)) ? Math.max(1, Number(options.maxFiles)) : undefined,
    conversationId: typeof options.conversationId === "string" && options.conversationId.trim() ? options.conversationId.trim() : undefined,
    channelId: typeof options.channelId === "string" && options.channelId.trim() ? options.channelId.trim() : undefined,
    senderId: typeof options.senderId === "string" && options.senderId.trim() ? options.senderId.trim() : undefined
  };
}

export async function searchRawContext(options, cfg, ctx = {}) {
  if (!cfg?.enabled) {
    return { text: "Raw context recall is disabled.", matches: [], filesSearched: 0, truncated: false };
  }

  const normalized = normalizeSearchOptions(options);
  const terms = extractTerms(normalized.query);
  if (!terms.length) {
    return { text: "No searchable terms were found in the query.", matches: [], filesSearched: 0, truncated: false };
  }

  const toolCfg = cfg.tool || {};
  const maxMatches = normalized.maxMatches || toolCfg.maxMatches || cfg.maxMatches || 20;
  const maxContextChars = normalized.maxContextChars || toolCfg.maxContextChars || cfg.maxContextChars || 12000;
  const maxFiles = normalized.maxFiles || toolCfg.maxFiles || 5000;
  const maxDays = normalized.daysBack === undefined ? undefined : normalized.daysBack;
  const files = await listRawRecallFiles(cfg.rootPath, maxDays, new Date(), { maxFiles });
  const matches = [];
  const currentConversationId = normalized.conversationId || currentConversationIdFromContext(ctx);
  const filters = {
    conversationId: normalized.conversationId,
    channelId: normalized.channelId,
    senderId: normalized.senderId
  };

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
      if (!record || !recordMatchesFilters(record, filters)) continue;
      const score = scoreRecord(record, terms, currentConversationId);
      if (score <= 0) continue;
      matches.push({ score, file, record });
    }
  }

  matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return recordTimestampMs(b.record) - recordTimestampMs(a.record);
  });

  const selected = matches.slice(0, maxMatches);
  const lines = [
    "Raw context search results (local JSONL archive; verify details if needed):"
  ];
  for (const match of selected) lines.push(formatRecord(match.record));

  let text = selected.length ? lines.join("\n") : "No raw context matches found.";
  let truncated = false;
  if (text.length > maxContextChars) {
    text = `${text.slice(0, maxContextChars)}\n[raw context search truncated]`;
    truncated = true;
  }

  return {
    text,
    matches: selected.map((match) => ({
      score: match.score,
      file: match.file,
      observedAt: match.record.observedAt,
      timestamp: match.record.timestamp,
      channelId: match.record.channelId,
      conversationId: match.record.conversationId,
      senderId: match.record.senderId,
      content: match.record.content,
      metadata: match.record.metadata
    })),
    filesSearched: files.length,
    totalMatches: matches.length,
    truncated
  };
}

export async function searchRawRecall(prompt, cfg, ctx = {}) {
  if (!shouldSearchRawRecall(prompt, cfg)) return "";
  const result = await searchRawContext({
    query: prompt,
    daysBack: cfg.maxDays,
    maxMatches: cfg.maxMatches,
    maxContextChars: cfg.maxContextChars,
    maxFiles: cfg.tool?.maxFiles
  }, cfg, ctx);
  if (!result.matches.length) return "";
  return result.text.replace("Raw context search results", "Relevant passive raw-recall excerpts");
}

function textResult(text, details) {
  return {
    content: [{ type: "text", text }],
    details
  };
}

export function createRawContextSearchTool(cfg, toolCtx = {}) {
  if (!cfg?.enabled || cfg.tool?.enabled === false) return null;
  return {
    name: "search_raw_context",
    label: "Search Raw Context",
    description: "Search the local zero-embedding raw message JSONL archive on demand. Use this when the user asks about prior conversation context, decisions, progress, status, or details not present in the current prompt.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description: "Search query. Include distinctive project names, people, decisions, errors, or terms from the user request."
        },
        daysBack: {
          type: "number",
          description: "Optional lookback window in days. Omit to search all available JSONL shards; use 0 to also search all available shards."
        },
        maxMatches: {
          type: "number",
          description: "Maximum number of matching records to return."
        },
        maxContextChars: {
          type: "number",
          description: "Maximum characters returned in the text result."
        },
        conversationId: {
          type: "string",
          description: "Optional exact conversationId filter, for example channel:<id>."
        },
        channelId: {
          type: "string",
          description: "Optional exact channelId filter."
        },
        senderId: {
          type: "string",
          description: "Optional exact senderId filter."
        }
      },
      required: ["query"]
    },
    displaySummary: "Search local raw message JSONL context.",
    async execute(_toolCallId, params) {
      const result = await searchRawContext(params || {}, cfg, toolCtx);
      return textResult(result.text, result);
    }
  };
}

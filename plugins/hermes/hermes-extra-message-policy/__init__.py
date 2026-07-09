"""Hermes extra-message-policy plugin.

This is intentionally conservative: it never bypasses Hermes auth/pairing or
platform permissions. It only decides whether an already-visible inbound gateway
message should continue to normal dispatch or be silently ingested/skipped.
"""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

DEFAULT_CONFIG = {
    "enabled": True,
    "defaultPolicy": {"respond": True, "ingestMode": "responseCandidates"},
    "policies": [],
    "jsonlSink": {"enabled": False, "path": "memory/extra-message-policy/messages.jsonl", "shardBy": "dayConversation"},
    "rawRecall": {"enabled": False, "appendGuidance": True, "maxMatches": 12, "maxContextChars": 6000, "maxDays": 30},
}


def _home() -> Path:
    return Path.home() / ".hermes"


def _deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    out = dict(base)
    for key, value in (override or {}).items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge(out[key], value)
        else:
            out[key] = value
    return out


def _load_config() -> dict[str, Any]:
    cfg = DEFAULT_CONFIG
    settings_path = _home() / "settings.json"
    try:
        if settings_path.exists():
            data = json.loads(settings_path.read_text(encoding="utf-8"))
            cfg = _deep_merge(cfg, data.get("extra_message_policy", {}))
    except Exception as exc:  # fail-open: policy errors must not break dispatch
        logger.warning("extra-message-policy config load failed: %s", exc)
    return cfg


def _get(obj: Any, name: str, default: Any = None) -> Any:
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(name, default)
    return getattr(obj, name, default)


def _source_dict(event: Any) -> dict[str, Any]:
    src = _get(event, "source", {})
    text = _get(event, "text", "") or ""
    data = {
        "platform": _get(src, "platform"),
        "chat_id": _get(src, "chat_id"),
        "channel_id": _get(src, "channel_id", _get(src, "chat_id")),
        "thread_id": _get(src, "thread_id"),
        "guild_id": _get(src, "guild_id"),
        "user_id": _get(src, "user_id"),
        "chat_type": _get(src, "chat_type"),
        "session_key": _get(src, "session_key", ""),
        "message_id": _get(event, "message_id"),
        "text": text,
    }
    if not data["session_key"]:
        parts = [str(data.get("platform") or ""), str(data.get("chat_id") or ""), str(data.get("thread_id") or "")]
        data["session_key"] = ":".join(p for p in parts if p)
    data["is_group"] = data.get("chat_type") in {"group", "supergroup", "channel", "guild", "thread"} or bool(data.get("guild_id"))
    return data


def _matches(policy: dict[str, Any], src: dict[str, Any]) -> bool:
    checks = {
        "platform": "platform",
        "chatId": "chat_id",
        "chat_id": "chat_id",
        "channelId": "channel_id",
        "channel_id": "channel_id",
        "threadId": "thread_id",
        "thread_id": "thread_id",
        "guildId": "guild_id",
        "guild_id": "guild_id",
        "senderId": "user_id",
        "user_id": "user_id",
    }
    for p_key, s_key in checks.items():
        if p_key in policy and str(policy[p_key]) != str(src.get(s_key)):
            return False
    if "isGroup" in policy and bool(policy["isGroup"]) != bool(src.get("is_group")):
        return False
    if "sessionKeyIncludes" in policy and str(policy["sessionKeyIncludes"]) not in str(src.get("session_key", "")):
        return False
    if "textMatches" in policy and not re.search(str(policy["textMatches"]), src.get("text") or ""):
        return False
    return True


def _effective_policy(cfg: dict[str, Any], src: dict[str, Any]) -> dict[str, Any]:
    policy = dict(cfg.get("defaultPolicy") or {})
    for candidate in cfg.get("policies") or []:
        if isinstance(candidate, dict) and _matches(candidate, src):
            policy.update(candidate)
    return policy


def _sink_base_path(cfg: dict[str, Any]) -> Path | None:
    sink = cfg.get("jsonlSink") or {}
    recall = cfg.get("rawRecall") or {}
    if not (sink.get("enabled") or recall.get("enabled")):
        return None
    raw = sink.get("path") or "memory/extra-message-policy/messages.jsonl"
    path = Path(str(raw)).expanduser()
    if not path.is_absolute():
        path = _home() / path
    return path


def _jsonl_path(cfg: dict[str, Any], src: dict[str, Any]) -> Path | None:
    base = _sink_base_path(cfg)
    if base is None:
        return None
    shard = (cfg.get("jsonlSink") or {}).get("shardBy")
    if shard == "dayConversation":
        day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        conv = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(src.get("session_key") or "unknown"))[:120]
        return base.parent / day / f"{conv}.jsonl"
    if shard == "day":
        day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        return base.parent / f"{day}.jsonl"
    return base


def _write_jsonl(cfg: dict[str, Any], src: dict[str, Any], policy: dict[str, Any], decision: str) -> None:
    path = _jsonl_path(cfg, src)
    if path is None:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "decision": decision,
        "policy": {"respond": policy.get("respond"), "ingestMode": policy.get("ingestMode")},
        "source": {k: v for k, v in src.items() if k != "text"},
        "text": src.get("text") or "",
    }
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


def _append_transcript(session_store: Any, src: dict[str, Any]) -> None:
    if session_store is None or not hasattr(session_store, "append_to_transcript"):
        return
    try:
        session_store.append_to_transcript(
            src.get("session_key") or "extra-message-policy",
            "user",
            src.get("text") or "",
            metadata={"source": "extra-message-policy", "passive": True},
        )
    except TypeError:
        try:
            session_store.append_to_transcript(src.get("session_key") or "extra-message-policy", "user", src.get("text") or "")
        except Exception:
            logger.debug("passive transcript append failed", exc_info=True)
    except Exception:
        logger.debug("passive transcript append failed", exc_info=True)


def pre_gateway_dispatch(event: Any = None, session_store: Any = None, **kwargs: Any) -> dict[str, str] | None:
    cfg = _load_config()
    if not cfg.get("enabled", True) or event is None:
        return None
    src = _source_dict(event)
    policy = _effective_policy(cfg, src)
    respond = bool(policy.get("respond", True))
    ingest_mode = str(policy.get("ingestMode", "responseCandidates"))
    should_ingest = ingest_mode in {"all", "passive"} or (ingest_mode == "responseCandidates" and respond)
    decision = "allow" if respond else "skip"
    if should_ingest:
        _write_jsonl(cfg, src, policy, decision)
        if not respond:
            _append_transcript(session_store, src)
    if not respond:
        return {"action": "skip", "reason": "extra-message-policy respond=false"}
    return None


def _iter_recall_files(cfg: dict[str, Any]):
    base = _sink_base_path(cfg)
    if base is None:
        return []
    root = base.parent if base.suffix else base
    if not root.exists():
        return []
    return sorted(root.rglob("*.jsonl"), reverse=True)[:5000]


def _recall_context(session_id: str = "", user_message: str = "", **kwargs: Any) -> dict[str, str] | None:
    cfg = _load_config()
    rcfg = cfg.get("rawRecall") or {}
    if not (cfg.get("enabled", True) and rcfg.get("enabled")):
        return None
    terms = [t.lower() for t in re.findall(r"[\w.-]{4,}", user_message or "")][:12]
    if not terms:
        return None
    max_matches = int(rcfg.get("maxMatches", 12))
    max_chars = int(rcfg.get("maxContextChars", 6000))
    max_days = int(rcfg.get("maxDays", 30))
    cutoff = datetime.now(timezone.utc) - timedelta(days=max_days)
    matches: list[str] = []
    for path in _iter_recall_files(cfg):
        try:
            for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
                low = line.lower()
                if not any(t in low for t in terms):
                    continue
                obj = json.loads(line)
                ts = obj.get("ts")
                if ts:
                    try:
                        if datetime.fromisoformat(ts.replace("Z", "+00:00")) < cutoff:
                            continue
                    except Exception:
                        pass
                text = (obj.get("text") or "").strip().replace("\n", " ")
                if text:
                    matches.append(f"- {ts or 'unknown'} {obj.get('source', {}).get('platform', '')}: {text[:500]}")
                if len(matches) >= max_matches:
                    break
        except Exception:
            continue
        if len(matches) >= max_matches:
            break
    if not matches:
        return None
    body = "Relevant passive raw-recall excerpts:\n" + "\n".join(matches)
    return {"context": body[:max_chars]}


def _policy_command(raw_args: str = "") -> str:
    cfg = _load_config()
    if raw_args.strip() in {"", "status"}:
        return json.dumps({
            "enabled": cfg.get("enabled", True),
            "defaultPolicy": cfg.get("defaultPolicy"),
            "policyCount": len(cfg.get("policies") or []),
            "jsonlSink": cfg.get("jsonlSink"),
            "rawRecall": cfg.get("rawRecall"),
        }, indent=2)
    return "Usage: /policy [status]. Edit ~/.hermes/settings.json extra_message_policy to change policy."


def register(ctx: Any) -> None:
    ctx.register_hook("pre_gateway_dispatch", pre_gateway_dispatch)
    ctx.register_hook("pre_llm_call", _recall_context)
    if hasattr(ctx, "register_command"):
        ctx.register_command("policy", _policy_command, description="Show extra-message-policy status", args_hint="[status]")

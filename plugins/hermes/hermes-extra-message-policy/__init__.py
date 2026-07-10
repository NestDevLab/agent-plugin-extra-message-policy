"""Hermes extra-message-policy plugin.

This is intentionally conservative: it never bypasses Hermes auth/pairing or
platform permissions. It only decides whether an already-visible inbound gateway
message should continue to normal dispatch or be silently ingested/skipped.
"""

from __future__ import annotations

import copy
import json
import logging
import os
import re
import shlex
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

DASHBOARD_NAMESPACE = "policy"

DEFAULT_CONFIG = {
    "enabled": True,
    # Fail closed when Hermes' native Discord mention gate is disabled and the
    # plugin becomes the response gate: by default only an explicit bot mention
    # may reach the agent. Operators can opt specific threads/channels into
    # "always" via /policy response always.
    "defaultPolicy": {"respond": True, "requireMention": True, "firstTagOnly": False, "ingestMode": "responseCandidates"},
    "policies": [],
    "jsonlSink": {"enabled": False, "path": "memory/extra-message-policy/messages.jsonl", "shardBy": "dayConversation"},
    "rawRecall": {"enabled": False, "appendGuidance": True, "maxMatches": 12, "maxContextChars": 6000, "maxDays": 30},
}


# ---------------------------------------------------------------------------
# Files and configuration
# ---------------------------------------------------------------------------


def _home() -> Path:
    explicit = os.getenv("HERMES_HOME", "").strip()
    if explicit:
        return Path(explicit).expanduser()
    try:
        from hermes_constants import get_hermes_home

        return get_hermes_home()
    except Exception:
        return Path.home() / ".hermes"


def _settings_path() -> Path:
    return _home() / "settings.json"


def _config_yaml_path() -> Path:
    return _home() / "config.yaml"


def _deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    out = copy.deepcopy(base)
    for key, value in (override or {}).items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge(out[key], value)
        else:
            out[key] = copy.deepcopy(value)
    return out


def _load_settings_file() -> dict[str, Any]:
    settings_path = _settings_path()
    try:
        if settings_path.exists():
            data = json.loads(settings_path.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
    except Exception as exc:  # fail-open: policy errors must not break dispatch
        logger.warning("extra-message-policy settings load failed: %s", exc)
    return {}


def _atomic_write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(content, encoding="utf-8")
    tmp.replace(path)


def _save_settings_file(settings: dict[str, Any]) -> None:
    _atomic_write_text(_settings_path(), json.dumps(settings, indent=2, ensure_ascii=False, sort_keys=True) + "\n")


def _load_config() -> dict[str, Any]:
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    try:
        data = _load_settings_file()
        override = data.get("extra_message_policy", {})
        if isinstance(override, dict):
            cfg = _deep_merge(cfg, override)
    except Exception as exc:  # fail-open: policy errors must not break dispatch
        logger.warning("extra-message-policy config load failed: %s", exc)
    return cfg


def _save_config(cfg: dict[str, Any]) -> None:
    settings = _load_settings_file()
    settings["extra_message_policy"] = cfg
    _save_settings_file(settings)


def _load_yaml_config() -> tuple[dict[str, Any], str | None]:
    path = _config_yaml_path()
    try:
        import yaml  # type: ignore
    except Exception as exc:
        return {}, f"PyYAML is not available, cannot edit {path}: {exc}"
    try:
        if not path.exists():
            return {}, None
        loaded = yaml.safe_load(path.read_text(encoding="utf-8"))
        return (loaded if isinstance(loaded, dict) else {}), None
    except Exception as exc:
        return {}, f"Failed to read {path}: {exc}"


def _save_yaml_config(data: dict[str, Any]) -> str | None:
    path = _config_yaml_path()
    try:
        import yaml  # type: ignore

        rendered = yaml.safe_dump(data, sort_keys=False, allow_unicode=True)
        _atomic_write_text(path, rendered)
        return None
    except Exception as exc:
        return f"Failed to write {path}: {exc}"


# ---------------------------------------------------------------------------
# Event/source helpers
# ---------------------------------------------------------------------------


def _get(obj: Any, name: str, default: Any = None) -> Any:
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(name, default)
    return getattr(obj, name, default)


def _source_dict(event: Any) -> dict[str, Any]:
    src = _get(event, "source", {})
    text = _get(event, "text", "") or ""
    platform = _get(src, "platform")
    # Gateway Source.platform is usually a Platform enum; settings store plain
    # strings such as "discord". Normalize here so scoped policies match live
    # gateway events instead of falling back to the global default.
    platform = getattr(platform, "value", platform)
    data = {
        "platform": platform,
        "chat_id": _get(src, "chat_id"),
        "channel_id": _get(src, "channel_id", _get(src, "chat_id")),
        "parent_chat_id": _get(src, "parent_chat_id"),
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


def _raw_message(event: Any) -> Any:
    return _get(event, "raw_message", None) or _get(event, "message", None)


def _raw_mention_ids(raw: Any) -> set[str]:
    ids: set[str] = set()
    for mentioned in getattr(raw, "mentions", []) or []:
        mid = getattr(mentioned, "id", None)
        if mid is not None:
            ids.add(str(mid))
    for text_attr in ("content", "clean_content", "original_content"):
        content = str(getattr(raw, text_attr, "") or "")
        ids.update(match.group(1) for match in re.finditer(r"<@!?(\d+)>", content))
    return ids


def _candidate_bot_ids(raw: Any) -> set[str]:
    ids: set[str] = set()
    state = getattr(raw, "_state", None)
    for candidate in (
        getattr(state, "self_id", None),
        getattr(getattr(raw, "guild", None), "me", None),
        getattr(getattr(raw, "client", None), "user", None),
    ):
        cid = getattr(candidate, "id", candidate)
        if cid is not None:
            ids.add(str(cid))
    return ids


def _event_mentions_bot(event: Any) -> bool:
    explicit = _get(event, "mentions_bot", None)
    if explicit is not None:
        return bool(explicit)
    raw = _raw_message(event)
    if raw is None:
        text = _get(event, "text", "") or ""
        return bool(re.search(r"<@!?\d+>", text))
    mention_ids = _raw_mention_ids(raw)
    bot_ids = _candidate_bot_ids(raw)
    if bot_ids:
        return bool(mention_ids & bot_ids)
    # Last-resort fallback for tests and non-Discord adapters: if the resolved
    # mention list contains a bot account, treat it as an explicit bot mention.
    return any(bool(getattr(mentioned, "bot", False)) for mentioned in getattr(raw, "mentions", []) or [])


def _event_first_token_mentions_bot(event: Any) -> bool:
    explicit = _get(event, "first_tag_mentions_bot", None)
    if explicit is not None:
        return bool(explicit)
    raw = _raw_message(event)
    content = ""
    if raw is not None:
        content = str(getattr(raw, "original_content", "") or getattr(raw, "content", "") or "")
    if not content:
        content = str(_get(event, "text", "") or "")
    token = content.strip().split(maxsplit=1)[0] if content.strip() else ""
    if not token:
        return False
    bot_ids = _candidate_bot_ids(raw)
    m = re.fullmatch(r"<@!?(\d+)>", token)
    if m:
        return not bot_ids or m.group(1) in bot_ids
    return token.startswith("@") and _event_mentions_bot(event)


# ---------------------------------------------------------------------------
# Policy evaluation and ingest
# ---------------------------------------------------------------------------


def _candidate_values(*values: Any) -> set[str]:
    return {str(value) for value in values if value not in (None, "")}


def _thread_id_candidates(src: dict[str, Any]) -> set[str]:
    # Discord thread messages may arrive with source.thread_id missing but with
    # chat_id/channel_id set to the thread id. Keep those shapes equivalent.
    return _candidate_values(src.get("thread_id"), src.get("chat_id"), src.get("channel_id"))


def _channel_id_candidates(src: dict[str, Any]) -> set[str]:
    candidates = _candidate_values(src.get("channel_id"), src.get("chat_id"))
    # Parent channel policy should apply to child threads unless the thread has
    # its own more-specific override. This is the Discord channel→thread
    # inheritance path the dashboard needs to explain.
    if src.get("thread_id") and src.get("parent_chat_id"):
        candidates.add(str(src.get("parent_chat_id")))
    return candidates


def _policy_scope_rank(policy: dict[str, Any], src: dict[str, Any]) -> int:
    thread_candidates = _thread_id_candidates(src)
    parent_id = str(src.get("parent_chat_id") or "")

    for key in ("threadId", "thread_id"):
        if key in policy and str(policy[key]) in thread_candidates:
            return 300

    for key in ("channelId", "channel_id"):
        if key not in policy:
            continue
        expected = str(policy[key])
        if src.get("thread_id") and parent_id and expected == parent_id:
            return 200
        if expected in _channel_id_candidates(src):
            return 300 if src.get("thread_id") else 200

    for key in ("parentChatId", "parent_chat_id"):
        if key in policy and parent_id and str(policy[key]) == parent_id:
            return 200

    for key in ("chatId", "chat_id"):
        if key in policy and str(policy[key]) == str(src.get("chat_id")):
            return 200

    return 0


def _matches(policy: dict[str, Any], src: dict[str, Any]) -> bool:
    checks = {
        "platform": "platform",
        "chatId": "chat_id",
        "chat_id": "chat_id",
        "channelId": "channel_id",
        "channel_id": "channel_id",
        "parentChatId": "parent_chat_id",
        "parent_chat_id": "parent_chat_id",
        "threadId": "thread_id",
        "thread_id": "thread_id",
        "guildId": "guild_id",
        "guild_id": "guild_id",
        "senderId": "user_id",
        "user_id": "user_id",
    }
    has_thread_scope = "threadId" in policy or "thread_id" in policy
    for p_key, s_key in checks.items():
        if p_key not in policy:
            continue
        if s_key == "parent_chat_id" and has_thread_scope:
            # A concrete Discord thread id is already unique. Older runtime
            # overrides may also carry parentChatId metadata captured from a
            # different adapter shape; do not let stale parent metadata prevent
            # the exact thread policy from applying.
            continue
        expected = str(policy[p_key])
        if s_key == "thread_id":
            if expected not in _thread_id_candidates(src):
                return False
            continue
        if s_key == "channel_id":
            if expected not in _channel_id_candidates(src):
                return False
            continue
        if expected != str(src.get(s_key)):
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
    matching: list[tuple[int, int, dict[str, Any]]] = []
    for idx, candidate in enumerate(cfg.get("policies") or []):
        if isinstance(candidate, dict) and _matches(candidate, src):
            matching.append((_policy_scope_rank(candidate, src), idx, candidate))
    for _rank, _idx, candidate in sorted(matching, key=lambda item: (item[0], item[1])):
        policy.update(candidate)
    return policy


def _policy_allows_response(policy: dict[str, Any], event: Any) -> bool:
    if not bool(policy.get("respond", True)):
        return False
    if bool(policy.get("firstTagOnly")):
        return _event_first_token_mentions_bot(event)
    if bool(policy.get("requireMention")):
        return _event_mentions_bot(event)
    return True


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
    if event is None:
        return None
    text = str(_get(event, "text", "") or "")
    message_type = _get(event, "message_type", "")
    message_type = getattr(message_type, "value", message_type)
    # Policy gates user prompts, not control-plane slash commands. If we skip
    # commands here, /policy cannot be used to inspect or fix the policy.
    if text.lstrip().startswith("/") or str(message_type).lower() == "command":
        return None

    cfg = _load_config()
    if not cfg.get("enabled", True):
        return None
    src = _source_dict(event)
    policy = _effective_policy(cfg, src)
    respond = _policy_allows_response(policy, event)
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


# ---------------------------------------------------------------------------
# Raw recall
# ---------------------------------------------------------------------------


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


# ---------------------------------------------------------------------------
# Dashboard command state
# ---------------------------------------------------------------------------


def _session_env(name: str, default: str = "") -> str:
    try:
        from gateway.session_context import get_session_env

        return get_session_env(name, default)
    except Exception:
        return os.getenv(name, default)


def _current_scope(tokens: list[str] | None = None) -> dict[str, Any]:
    platform = _session_env("HERMES_SESSION_PLATFORM", "") or os.getenv("HERMES_SESSION_PLATFORM", "")
    chat_id = _session_env("HERMES_SESSION_CHAT_ID", "") or os.getenv("HERMES_SESSION_CHAT_ID", "")
    thread_id = _session_env("HERMES_SESSION_THREAD_ID", "") or os.getenv("HERMES_SESSION_THREAD_ID", "")
    parent_chat_id = (
        _session_env("HERMES_SESSION_PARENT_CHAT_ID", "")
        or _session_env("HERMES_SESSION_PARENT_CHANNEL_ID", "")
        or os.getenv("HERMES_SESSION_PARENT_CHAT_ID", "")
        or os.getenv("HERMES_SESSION_PARENT_CHANNEL_ID", "")
    )
    user_id = _session_env("HERMES_SESSION_USER_ID", "") or os.getenv("HERMES_SESSION_USER_ID", "")

    if thread_id and chat_id and not parent_chat_id and chat_id != thread_id:
        parent_chat_id = chat_id

    scope_kind = "thread" if thread_id else "channel" if chat_id else "global"
    scope_id = thread_id or chat_id or ""

    for token in tokens or []:
        raw = token.strip()
        low = raw.lower()
        if low in {"global", "default", "scope=global"}:
            scope_kind, scope_id = "global", ""
            parent_chat_id = ""
        elif low.startswith("thread=") or low.startswith("thread:"):
            scope_kind, scope_id = "thread", raw.split("=", 1)[-1].split(":", 1)[-1]
        elif low.startswith("channel=") or low.startswith("channel:"):
            scope_kind, scope_id = "channel", raw.split("=", 1)[-1].split(":", 1)[-1]
            parent_chat_id = ""
        elif low.startswith("parent=") or low.startswith("parent:"):
            parent_chat_id = raw.split("=", 1)[-1].split(":", 1)[-1]
        elif low.startswith("parentchannel=") or low.startswith("parentchannel:"):
            parent_chat_id = raw.split("=", 1)[-1].split(":", 1)[-1]
        elif low.startswith("platform="):
            platform = raw.split("=", 1)[1]

    matcher: dict[str, Any] = {}
    if platform:
        matcher["platform"] = platform
    if scope_kind == "thread" and scope_id:
        matcher["threadId"] = scope_id
    elif scope_kind == "channel" and scope_id:
        matcher["channelId"] = scope_id

    key = f"{platform or '*'}:{scope_kind}:{scope_id or '*'}"
    label = "global default" if scope_kind == "global" else f"{scope_kind} {scope_id}"
    return {
        "key": key,
        "type": scope_kind,
        "id": scope_id,
        "platform": platform,
        "chat_id": chat_id,
        "parent_chat_id": parent_chat_id,
        "thread_id": thread_id,
        "actor_id": user_id,
        "label": label,
        "matcher": matcher,
        "zone_id": scope_id,
    }


def _src_from_scope(scope: dict[str, Any]) -> dict[str, Any]:
    scope_type = scope.get("type")
    scope_id = scope.get("id")
    parent_chat_id = scope.get("parent_chat_id") or ""
    if scope_type == "thread" and not parent_chat_id:
        chat_id = str(scope.get("chat_id") or "")
        if chat_id and chat_id != str(scope_id or ""):
            parent_chat_id = chat_id
    return {
        "platform": scope.get("platform"),
        "chat_id": scope_id,
        "channel_id": scope_id if scope_type in {"channel", "thread"} else None,
        "parent_chat_id": parent_chat_id or None,
        "thread_id": scope_id if scope_type == "thread" else None,
        "session_key": scope.get("key"),
        "is_group": True,
        "text": "",
    }


def _runtime_policy_for_scope(cfg: dict[str, Any], scope: dict[str, Any]) -> dict[str, Any] | None:
    key = scope.get("key")
    for policy in cfg.get("policies") or []:
        if isinstance(policy, dict) and policy.get("runtimeScopeKey") == key:
            return policy
    return None


def _inherited_parent_policy_for_scope(cfg: dict[str, Any], scope: dict[str, Any]) -> tuple[str, dict[str, Any]] | None:
    if scope.get("type") != "thread":
        return None
    src = _src_from_scope(scope)
    parent_id = str(src.get("parent_chat_id") or "")
    if not parent_id:
        return None

    has_thread_policy = False
    inherited: dict[str, Any] | None = None
    for candidate in cfg.get("policies") or []:
        if not isinstance(candidate, dict) or not _matches(candidate, src):
            continue
        rank = _policy_scope_rank(candidate, src)
        if rank >= 300:
            has_thread_policy = True
        if rank == 200 and any(str(candidate.get(key, "")) == parent_id for key in ("channelId", "channel_id", "parentChatId", "parent_chat_id")):
            inherited = candidate
    if has_thread_policy or inherited is None:
        return None
    return parent_id, inherited


def _upsert_runtime_policy(cfg: dict[str, Any], scope: dict[str, Any], changes: dict[str, Any]) -> dict[str, Any]:
    next_cfg = copy.deepcopy(cfg)
    policies = [p for p in next_cfg.get("policies") or [] if isinstance(p, dict)]
    existing = None
    kept = []
    for policy in policies:
        if policy.get("runtimeScopeKey") == scope.get("key"):
            existing = policy
        else:
            kept.append(policy)
    entry = dict(existing or {})
    entry.update({
        "runtimeOverride": True,
        "runtimeScopeKey": scope.get("key"),
        "runtimeScope": {k: scope.get(k) for k in ("type", "id", "platform", "label")},
    })
    entry.update(scope.get("matcher") or {})
    entry.update(changes)
    kept.append(entry)
    next_cfg["policies"] = kept
    return next_cfg


def _reset_runtime_policy(cfg: dict[str, Any], scope: dict[str, Any] | None = None, *, all_scopes: bool = False) -> dict[str, Any]:
    next_cfg = copy.deepcopy(cfg)
    key = None if scope is None else scope.get("key")
    next_cfg["policies"] = [
        p
        for p in next_cfg.get("policies") or []
        if not (isinstance(p, dict) and p.get("runtimeOverride") and (all_scopes or p.get("runtimeScopeKey") == key))
    ]
    return next_cfg


def _normalize_response_mode(value: Any) -> str | None:
    low = str(value or "").strip().lower().replace("_", "-")
    aliases = {
        "off": "off",
        "none": "off",
        "disable": "off",
        "disabled": "off",
        "mention": "mention",
        "mentions": "mention",
        "mention-only": "mention",
        "mentiononly": "mention",
        "first": "firstTag",
        "first-tag": "firstTag",
        "firsttag": "firstTag",
        "first_tag": "firstTag",
        "always": "always",
        "on": "always",
        "reply": "always",
        "reply-always": "always",
    }
    return aliases.get(low)


def _normalize_ingest_mode(value: Any) -> str | None:
    low = str(value or "").strip().lower().replace("_", "-")
    aliases = {
        "off": "off",
        "none": "off",
        "disable": "off",
        "disabled": "off",
        "passive": "passive",
        "candidate": "responseCandidates",
        "candidates": "responseCandidates",
        "response-candidates": "responseCandidates",
        "responsecandidates": "responseCandidates",
        "all": "all",
        "everything": "all",
    }
    return aliases.get(low)


def _response_changes(mode: str) -> dict[str, Any]:
    if mode == "off":
        return {"respond": False, "requireMention": False, "firstTagOnly": False, "runtimeResponseMode": "off"}
    if mode == "mention":
        return {"respond": True, "requireMention": True, "firstTagOnly": False, "runtimeResponseMode": "mention"}
    if mode == "firstTag":
        return {"respond": True, "requireMention": True, "firstTagOnly": True, "runtimeResponseMode": "firstTag"}
    return {"respond": True, "requireMention": False, "firstTagOnly": False, "runtimeResponseMode": "always"}


def _ingest_changes(mode: str) -> dict[str, Any]:
    ingest_mode = "none" if mode == "off" else mode
    return {"ingestMode": ingest_mode, "runtimeIngestMode": mode}


def _response_mode_from_policy(policy: dict[str, Any] | None) -> str:
    policy = policy or {}
    mode = _normalize_response_mode(policy.get("runtimeResponseMode"))
    if mode:
        return mode
    if policy.get("respond") is False:
        return "off"
    if policy.get("firstTagOnly"):
        return "firstTag"
    if policy.get("requireMention"):
        return "mention"
    return "always"


def _ingest_mode_from_policy(policy: dict[str, Any] | None) -> str:
    policy = policy or {}
    mode = _normalize_ingest_mode(policy.get("runtimeIngestMode"))
    if mode:
        return mode
    raw = str(policy.get("ingestMode", "responseCandidates"))
    if raw == "none":
        return "off"
    return _normalize_ingest_mode(raw) or "off"


def _render_reply_mode(value: str) -> str:
    return {"off": "Off", "mention": "Mention only", "firstTag": "First tag", "always": "Always reply"}.get(value, "Unknown")


def _render_read_mode(value: str) -> str:
    return {"off": "Off", "passive": "Passive only", "responseCandidates": "Reply candidates", "all": "All messages"}.get(value, "Unknown")


# ---------------------------------------------------------------------------
# Native Hermes Discord gate
# ---------------------------------------------------------------------------


def _parse_bool(value: Any, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() not in {"false", "0", "no", "off", ""}


def _parse_on_off(value: Any) -> bool | None:
    low = str(value or "").strip().lower()
    if low in {"on", "true", "1", "yes", "enable", "enabled"}:
        return True
    if low in {"off", "false", "0", "no", "disable", "disabled"}:
        return False
    return None


def _csv_set(raw: Any) -> list[str]:
    if raw is None:
        return []
    if isinstance(raw, (list, tuple, set)):
        parts = [str(v).strip() for v in raw]
    else:
        parts = [p.strip() for p in str(raw).split(",")]
    out: list[str] = []
    seen: set[str] = set()
    for part in parts:
        if part and part not in seen:
            out.append(part)
            seen.add(part)
    return out


def _native_status(scope: dict[str, Any]) -> dict[str, Any]:
    if (scope.get("platform") or "discord") != "discord":
        return {"status": "unavailable", "reason": "native gate is Discord-only"}
    data, _err = _load_yaml_config()
    discord_cfg = data.get("discord") if isinstance(data.get("discord"), dict) else {}
    env_require = os.getenv("DISCORD_REQUIRE_MENTION")
    require = _parse_bool(env_require, _parse_bool(discord_cfg.get("require_mention"), True))
    env_thread = os.getenv("DISCORD_THREAD_REQUIRE_MENTION")
    thread_require = _parse_bool(env_thread, _parse_bool(discord_cfg.get("thread_require_mention"), False))
    env_free = os.getenv("DISCORD_FREE_RESPONSE_CHANNELS")
    free = _csv_set(env_free if env_free is not None else discord_cfg.get("free_response_channels"))
    zone = str(scope.get("zone_id") or "")
    if not zone:
        return {"status": "unavailable", "reason": "no current Discord channel/thread id"}
    if not require:
        status = "off"
        reason = "discord.require_mention=false"
    elif "*" in free or zone in free:
        status = "off"
        reason = "current channel/thread is in discord.free_response_channels"
    else:
        status = "on"
        reason = "discord.require_mention=true and current channel/thread is not free-response"
    return {
        "status": status,
        "reason": reason,
        "zoneId": zone,
        "requireMention": require,
        "threadRequireMention": thread_require,
        "freeResponseChannels": free,
        "source": str(_config_yaml_path()),
    }


def _apply_native_gate(scope: dict[str, Any], desired: bool) -> tuple[bool, str]:
    if (scope.get("platform") or "discord") != "discord":
        return False, "Native gate is only available for Discord sessions."
    zone = str(scope.get("zone_id") or "").strip()
    if not zone:
        return False, "Cannot change native gate: no current channel/thread id in session context."
    data, err = _load_yaml_config()
    if err:
        return False, err
    discord_cfg = data.setdefault("discord", {})
    if not isinstance(discord_cfg, dict):
        data["discord"] = discord_cfg = {}
    free = _csv_set(discord_cfg.get("free_response_channels"))
    if desired:
        discord_cfg["require_mention"] = True
        free = [item for item in free if item != zone]
        if scope.get("type") == "thread" and "thread_require_mention" not in discord_cfg:
            # Only set a missing value. If the operator explicitly configured
            # thread behavior, respect that existing policy.
            discord_cfg["thread_require_mention"] = True
    else:
        if zone not in free:
            free.append(zone)
        if "require_mention" not in discord_cfg:
            # Hermes' default is already true; writing it makes the dashboard's
            # channel-level free-response override explicit and stable.
            discord_cfg["require_mention"] = True
    discord_cfg["free_response_channels"] = free
    err = _save_yaml_config(data)
    if err:
        return False, err

    # Make the current gateway process pick up the change immediately. The
    # config.yaml write preserves it for the next restart; env vars drive the
    # live Discord adapter in the running process.
    os.environ["DISCORD_REQUIRE_MENTION"] = str(discord_cfg.get("require_mention", True)).lower()
    os.environ["DISCORD_FREE_RESPONSE_CHANNELS"] = ",".join(free)
    if "thread_require_mention" in discord_cfg:
        os.environ["DISCORD_THREAD_REQUIRE_MENTION"] = str(discord_cfg["thread_require_mention"]).lower()
    return True, f"Native Hermes gate {'enabled' if desired else 'disabled'} for {scope.get('label')}."


# ---------------------------------------------------------------------------
# Dashboard rendering and command handling
# ---------------------------------------------------------------------------


def _dashboard_callback(action: str, value: str = "_") -> str:
    return f"{DASHBOARD_NAMESPACE}:{action}:{value or '_'}:_"


def _dashboard_button(label: str, action: str, value: str = "_", *, selected: bool = False, style: str | None = None) -> dict[str, Any]:
    return {
        "label": label,
        "style": style or ("success" if selected else "secondary"),
        "callbackData": _dashboard_callback(action, value),
    }


def _row(buttons: list[dict[str, Any]]) -> dict[str, Any]:
    return {"type": "actions", "buttons": buttons}


def _build_policy_dashboard_view(
    cfg: dict[str, Any] | None = None,
    *,
    scope: dict[str, Any] | None = None,
    details: bool = False,
    notice: str = "",
) -> dict[str, Any]:
    cfg = cfg or _load_config()
    scope = scope or _current_scope([])
    effective_policy = _effective_policy(cfg, _src_from_scope(scope))
    runtime_override = _runtime_policy_for_scope(cfg, scope)
    inherited_parent = _inherited_parent_policy_for_scope(cfg, scope)
    response_mode = _response_mode_from_policy(effective_policy)
    ingest_mode = _ingest_mode_from_policy(effective_policy)
    native = _native_status(scope)
    native_mode = native.get("status", "unavailable")

    response_buttons = [
        _dashboard_button("Replies off", "response", "off", selected=response_mode == "off"),
        _dashboard_button("Mention only", "response", "mention", selected=response_mode == "mention"),
        _dashboard_button("First tag", "response", "firstTag", selected=response_mode == "firstTag"),
        _dashboard_button("Reply always", "response", "always", selected=response_mode == "always"),
    ]
    ingest_buttons = [
        _dashboard_button("Read off", "ingest", "off", selected=ingest_mode == "off"),
        _dashboard_button("Passive", "ingest", "passive", selected=ingest_mode == "passive"),
        _dashboard_button("Candidates", "ingest", "responseCandidates", selected=ingest_mode == "responseCandidates"),
        _dashboard_button("All messages", "ingest", "all", selected=ingest_mode == "all"),
    ]
    native_buttons = [
        _dashboard_button("Native gate on", "native", "on", selected=native_mode == "on"),
        _dashboard_button("Native gate off", "native", "off", selected=native_mode == "off", style="primary" if native_mode == "on" else None),
    ]
    utility_buttons = [
        _dashboard_button("Reset panel", "reset", "_", style="danger"),
        _dashboard_button("Refresh", "refresh"),
        _dashboard_button("Hide details" if details else "Details", "details", "hide" if details else "show"),
        _dashboard_button("Dismiss", "dismiss"),
    ]

    lines = [
        "**Message policy**",
        f"**Notice:** {notice}" if notice else None,
        "",
        "**Effective status**",
        f"- Bot replies: `{_render_reply_mode(response_mode)}`",
        f"- Bot reads: `{_render_read_mode(ingest_mode)}`",
        f"- Native Hermes gate: `{native_mode}`",
        f"- Scope: `{scope.get('label')}`",
        "",
        "**Extra policy**",
        f"- Reply override: `{_render_reply_mode(_response_mode_from_policy(runtime_override)) if runtime_override else 'None'}`",
        f"- Read override: `{_render_read_mode(_ingest_mode_from_policy(runtime_override)) if runtime_override else 'None'}`",
        (
            f"- Inherited from parent channel `{inherited_parent[0]}`: "
            f"`{_render_reply_mode(_response_mode_from_policy(inherited_parent[1]))}` / "
            f"`{_render_read_mode(_ingest_mode_from_policy(inherited_parent[1]))}`"
            if inherited_parent else None
        ),
        "- Saved after restart: `Yes`",
        "",
        "**Native Hermes gate**",
        f"- Native mention gate: `{native.get('status', 'unavailable')}`",
        f"- Config: `discord.require_mention` + `discord.free_response_channels`",
        f"- Reason: {native.get('reason', 'unknown')}",
        "",
        "**Controls**",
        "- Reply policy: Replies off / Mention only / First tag / Reply always.",
        "- Read policy: Read off / Passive / Candidates / All messages.",
        "- Native gate: Native gate on / Native gate off.",
        "- Fallback: `/policy response ...`, `/policy ingest ...`, `/policy native ...`, `/policy reset`, `/policy status`.",
    ]
    if details:
        lines.extend([
            "",
            "Details",
            f"- Runtime override key: `{runtime_override.get('runtimeScopeKey') if runtime_override else 'none'}`",
            f"- Settings file: `{_settings_path()}`",
            f"- Hermes config: `{_config_yaml_path()}`",
            f"- Component callbacks: `{DASHBOARD_NAMESPACE}:response|ingest|native|reset|refresh|details|dismiss`",
        ])
    text = "\n".join(line for line in lines if line is not None)
    return {
        "text": text,
        "componentSpec": {
            "reusable": True,
            "blocks": [_row(response_buttons), _row(ingest_buttons), _row(native_buttons), _row(utility_buttons)],
        },
    }


def _status_payload(cfg: dict[str, Any], scope: dict[str, Any]) -> dict[str, Any]:
    effective = _effective_policy(cfg, _src_from_scope(scope))
    return {
        "enabled": cfg.get("enabled", True),
        "scope": {k: scope.get(k) for k in ("key", "type", "id", "platform", "label")},
        "defaultPolicy": cfg.get("defaultPolicy"),
        "effectivePolicy": effective,
        "runtimeOverride": _runtime_policy_for_scope(cfg, scope),
        "policyCount": len(cfg.get("policies") or []),
        "jsonlSink": cfg.get("jsonlSink"),
        "rawRecall": cfg.get("rawRecall"),
        "nativeHermesGate": _native_status(scope),
    }


def _usage() -> str:
    return "\n".join([
        "Usage:",
        "- /policy",
        "- /policy status",
        "- /policy details  (alias: /policy help)",
        "- /policy response off|mention|firstTag|always [global|channel=<id>|thread=<id>]",
        "- /policy ingest off|passive|candidates|all [global|channel=<id>|thread=<id>]",
        "- /policy native on|off",
        "- /policy reset [all]",
    ])


def _callback_to_args(raw: str) -> str | None:
    text = raw.strip()
    if not text.startswith(f"{DASHBOARD_NAMESPACE}:"):
        return None
    parts = text.split(":")
    if len(parts) < 2:
        return None
    action = parts[1]
    value = parts[2] if len(parts) > 2 and parts[2] != "_" else ""
    if action in {"response", "ingest", "native", "details"}:
        return f"{action} {value}".strip()
    return action


def _policy_command(raw_args: str = "") -> str:
    raw = (raw_args or "").strip()
    callback_args = _callback_to_args(raw)
    if callback_args is not None:
        raw = callback_args
    try:
        tokens = shlex.split(raw)
    except ValueError:
        tokens = raw.split()
    action = tokens[0].lower() if tokens else ""
    scope = _current_scope(tokens[2:] if action in {"response", "ingest"} else tokens[1:])
    cfg = _load_config()

    if action in {"", "dashboard", "refresh"}:
        return _build_policy_dashboard_view(cfg, scope=scope)["text"]
    if action == "details":
        return _build_policy_dashboard_view(cfg, scope=scope, details=(len(tokens) < 2 or tokens[1].lower() != "hide"))["text"]
    if action == "dismiss":
        return "Policy dashboard dismissed."
    if action == "status":
        return json.dumps(_status_payload(cfg, scope), indent=2, ensure_ascii=False)
    if action in {"help", "usage", "?"}:
        return _usage()

    if action == "response":
        mode = _normalize_response_mode(tokens[1] if len(tokens) > 1 else "")
        if not mode:
            return "Usage: /policy response off|mention|firstTag|always"
        cfg = _upsert_runtime_policy(cfg, scope, _response_changes(mode))
        _save_config(cfg)
        return _build_policy_dashboard_view(cfg, scope=scope, notice=f"Reply policy set to {_render_reply_mode(mode)}.")["text"]

    if action == "ingest":
        mode = _normalize_ingest_mode(tokens[1] if len(tokens) > 1 else "")
        if not mode:
            return "Usage: /policy ingest off|passive|candidates|all"
        cfg = _upsert_runtime_policy(cfg, scope, _ingest_changes(mode))
        _save_config(cfg)
        return _build_policy_dashboard_view(cfg, scope=scope, notice=f"Read policy set to {_render_read_mode(mode)}.")["text"]

    if action == "native":
        desired = _parse_on_off(tokens[1] if len(tokens) > 1 else "")
        if desired is None:
            return "Usage: /policy native on|off"
        ok, message = _apply_native_gate(scope, desired)
        return _build_policy_dashboard_view(_load_config(), scope=scope, notice=message if ok else f"Native gate not changed: {message}")["text"]

    if action == "reset":
        all_scopes = any(t.lower() == "all" for t in tokens[1:])
        cfg = _reset_runtime_policy(cfg, scope, all_scopes=all_scopes)
        _save_config(cfg)
        notice = "All runtime policy overrides reset." if all_scopes else f"Runtime policy reset for {scope.get('label')}."
        return _build_policy_dashboard_view(cfg, scope=scope, notice=notice)["text"]

    return _usage()


def register(ctx: Any) -> None:
    ctx.register_hook("pre_gateway_dispatch", pre_gateway_dispatch)
    ctx.register_hook("pre_llm_call", _recall_context)
    if hasattr(ctx, "register_command"):
        ctx.register_command(
            "policy",
            _policy_command,
            description="Show or change extra-message-policy settings",
            args_hint="[status|details|response|ingest|native|reset]",
        )

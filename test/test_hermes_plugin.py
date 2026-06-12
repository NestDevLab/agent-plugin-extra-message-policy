import importlib.util
import json
import os
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "plugins/hermes/hermes-extra-message-policy/__init__.py"

spec = importlib.util.spec_from_file_location("extra_message_policy", PLUGIN)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

class Source:
    platform = "discord"
    chat_id = "c1"
    channel_id = "c1"
    thread_id = "t1"
    guild_id = "g1"
    user_id = "u1"
    chat_type = "thread"

class Event:
    source = Source()
    text = "hello passive world"
    message_id = "m1"

with tempfile.TemporaryDirectory() as td:
    os.environ["HOME"] = td
    h = Path(td) / ".hermes"
    h.mkdir()
    (h / "settings.json").write_text(json.dumps({
        "extra_message_policy": {
            "enabled": True,
            "defaultPolicy": {"respond": True, "ingestMode": "responseCandidates"},
            "policies": [{"channelId": "c1", "respond": False, "ingestMode": "all"}],
            "jsonlSink": {"enabled": True, "path": "memory/extra-message-policy/messages.jsonl", "shardBy": "dayConversation"},
            "rawRecall": {"enabled": True, "maxMatches": 3, "maxContextChars": 1000, "maxDays": 30}
        }
    }))
    result = mod.pre_gateway_dispatch(Event())
    assert result["action"] == "skip", result
    files = list((h / "memory/extra-message-policy").rglob("*.jsonl"))
    assert files, "expected jsonl sink"
    ctx = mod._recall_context(user_message="passive world")
    assert ctx and "passive world" in ctx["context"], ctx

print("HERMES_PLUGIN_TEST_OK")

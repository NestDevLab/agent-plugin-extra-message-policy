import importlib.util
import json
import os
import tempfile
from contextlib import contextmanager
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "plugins/hermes/hermes-extra-message-policy/__init__.py"

spec = importlib.util.spec_from_file_location("extra_message_policy", PLUGIN)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class Source:
    platform = "discord"
    chat_id = "c1"
    channel_id = "c1"
    parent_chat_id = "parent1"
    thread_id = "t1"
    guild_id = "g1"
    user_id = "u1"
    chat_type = "thread"


class Event:
    source = Source()
    text = "hello passive world"
    message_id = "m1"


class MentionEvent(Event):
    mentions_bot = True


class PlatformEnum:
    value = "discord"

    def __str__(self):
        return "Platform.DISCORD"


class EnumSource(Source):
    platform = PlatformEnum()


class EnumEvent(Event):
    source = EnumSource()


class CommandEvent(Event):
    text = "/policy"
    message_type = "command"


class ThreadAsChannelSource(Source):
    chat_id = "t1"
    channel_id = "t1"
    thread_id = None


class ThreadAsChannelEvent(Event):
    source = ThreadAsChannelSource()


@contextmanager
def hermes_home():
    keys = [
        "HERMES_HOME",
        "HOME",
        "HERMES_SESSION_PLATFORM",
        "HERMES_SESSION_CHAT_ID",
        "HERMES_SESSION_THREAD_ID",
        "HERMES_SESSION_USER_ID",
        "DISCORD_REQUIRE_MENTION",
        "DISCORD_FREE_RESPONSE_CHANNELS",
        "DISCORD_THREAD_REQUIRE_MENTION",
    ]
    old = {key: os.environ.get(key) for key in keys}
    with tempfile.TemporaryDirectory() as td:
        home = Path(td)
        os.environ["HERMES_HOME"] = str(home)
        os.environ["HOME"] = str(home)
        os.environ["HERMES_SESSION_PLATFORM"] = "discord"
        os.environ["HERMES_SESSION_CHAT_ID"] = "c1"
        os.environ["HERMES_SESSION_THREAD_ID"] = "t1"
        os.environ["HERMES_SESSION_USER_ID"] = "u1"
        for key in ["DISCORD_REQUIRE_MENTION", "DISCORD_FREE_RESPONSE_CHANNELS", "DISCORD_THREAD_REQUIRE_MENTION"]:
            os.environ.pop(key, None)
        yield home
    for key, value in old.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value


def read_settings(home: Path):
    return json.loads((home / "settings.json").read_text())


def test_passive_skip_jsonl_and_recall():
    with hermes_home() as h:
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


def test_default_policy_is_mention_only_when_plugin_manages_gate():
    with hermes_home():
        assert mod.pre_gateway_dispatch(Event())["action"] == "skip"
        assert mod.pre_gateway_dispatch(MentionEvent()) is None


def test_commands_bypass_policy_gate():
    with hermes_home():
        assert mod.pre_gateway_dispatch(CommandEvent()) is None


def test_platform_enum_matches_scoped_thread_policy():
    with hermes_home():
        mod._policy_command("response always")
        assert mod.pre_gateway_dispatch(EnumEvent()) is None


def test_thread_policy_matches_channel_only_thread_events():
    with hermes_home():
        mod._policy_command("response always")
        assert mod.pre_gateway_dispatch(ThreadAsChannelEvent()) is None


def test_thread_inherits_parent_channel_policy():
    with hermes_home() as h:
        (h / "settings.json").write_text(json.dumps({
            "extra_message_policy": {
                "enabled": True,
                "defaultPolicy": {"respond": True, "requireMention": True, "ingestMode": "responseCandidates"},
                "policies": [{
                    "channelId": "parent1",
                    "respond": True,
                    "requireMention": False,
                    "ingestMode": "responseCandidates",
                }],
            }
        }))
        assert mod.pre_gateway_dispatch(Event()) is None


def test_policy_dashboard_shows_parent_inherited_thread_policy():
    with hermes_home() as h:
        os.environ["HERMES_SESSION_CHAT_ID"] = "parent1"
        os.environ["HERMES_SESSION_THREAD_ID"] = "t1"
        (h / "settings.json").write_text(json.dumps({
            "extra_message_policy": {
                "enabled": True,
                "defaultPolicy": {"respond": True, "requireMention": True, "ingestMode": "responseCandidates"},
                "policies": [{
                    "channelId": "parent1",
                    "respond": True,
                    "requireMention": False,
                    "ingestMode": "responseCandidates",
                }],
            }
        }))
        view = mod._build_policy_dashboard_view(mod._load_config(), scope=mod._current_scope([]))
        assert "- Bot replies: `Always reply`" in view["text"]
        assert "Inherited from parent channel `parent1`" in view["text"]


def test_thread_policy_overrides_parent_channel_policy_even_when_parent_is_last():
    with hermes_home() as h:
        (h / "settings.json").write_text(json.dumps({
            "extra_message_policy": {
                "enabled": True,
                "defaultPolicy": {"respond": True, "requireMention": False, "ingestMode": "responseCandidates"},
                "policies": [
                    {
                        "threadId": "t1",
                        "respond": True,
                        "requireMention": True,
                        "ingestMode": "responseCandidates",
                    },
                    {
                        "channelId": "parent1",
                        "respond": True,
                        "requireMention": False,
                        "ingestMode": "responseCandidates",
                    },
                ],
            }
        }))
        assert mod.pre_gateway_dispatch(Event())["action"] == "skip"
        assert mod.pre_gateway_dispatch(MentionEvent()) is None


def test_exact_thread_policy_ignores_stale_parent_metadata():
    with hermes_home() as h:
        (h / "settings.json").write_text(json.dumps({
            "extra_message_policy": {
                "enabled": True,
                "defaultPolicy": {"respond": True, "requireMention": True, "ingestMode": "responseCandidates"},
                "policies": [{
                    "threadId": "t1",
                    "parentChatId": "stale-parent",
                    "respond": True,
                    "requireMention": False,
                    "ingestMode": "responseCandidates",
                }],
            }
        }))
        assert mod.pre_gateway_dispatch(ThreadAsChannelEvent()) is None


def test_policy_response_and_ingest_commands_persist_runtime_override():
    with hermes_home() as h:
        reply = mod._policy_command("response off")
        assert "Reply policy set to Off" in reply
        settings = read_settings(h)
        policies = settings["extra_message_policy"]["policies"]
        assert len(policies) == 1
        assert policies[0]["runtimeOverride"] is True
        assert policies[0]["threadId"] == "t1"
        assert policies[0]["respond"] is False
        assert policies[0]["runtimeResponseMode"] == "off"
        assert mod.pre_gateway_dispatch(Event())["action"] == "skip"

        reply = mod._policy_command("ingest all")
        assert "Read policy set to All messages" in reply
        policy = read_settings(h)["extra_message_policy"]["policies"][0]
        assert policy["ingestMode"] == "all"
        assert policy["runtimeIngestMode"] == "all"

        reply = mod._policy_command("response always")
        assert "Reply policy set to Always reply" in reply
        assert mod.pre_gateway_dispatch(Event()) is None

        reply = mod._policy_command("reset")
        assert "Runtime policy reset" in reply
        assert read_settings(h)["extra_message_policy"]["policies"] == []


def test_mention_mode_requires_bot_mention_before_replying():
    with hermes_home():
        mod._policy_command("response mention")
        assert mod.pre_gateway_dispatch(Event())["action"] == "skip"
        assert mod.pre_gateway_dispatch(MentionEvent()) is None


def test_policy_dashboard_exposes_openclaw_compatible_button_labels():
    with hermes_home():
        view = mod._build_policy_dashboard_view(mod._load_config(), scope=mod._current_scope([]))
        labels = [
            button["label"]
            for row in view["componentSpec"]["blocks"]
            for button in row["buttons"]
        ]
        for label in [
            "Replies off",
            "Mention only",
            "First tag",
            "Reply always",
            "Read off",
            "Passive",
            "Candidates",
            "All messages",
            "Native gate on",
            "Native gate off",
            "Reset panel",
            "Refresh",
            "Details",
            "Dismiss",
        ]:
            assert label in labels, label
        callbacks = [
            button["callbackData"]
            for row in view["componentSpec"]["blocks"]
            for button in row["buttons"]
        ]
        assert "policy:response:off:_" in callbacks
        assert "policy:ingest:all:_" in callbacks
        assert "policy:native:on:_" in callbacks


def test_policy_callback_payloads_are_accepted_as_fallback_commands():
    with hermes_home() as h:
        reply = mod._policy_command("policy:response:always:_")
        assert "Reply policy set to Always reply" in reply
        policy = read_settings(h)["extra_message_policy"]["policies"][0]
        assert policy["runtimeResponseMode"] == "always"


def test_policy_help_is_manual_alias():
    with hermes_home():
        reply = mod._policy_command("help")
        assert "/policy details" in reply
        assert "/policy response off|mention|firstTag|always" in reply


def test_native_gate_updates_hermes_config_and_live_env():
    with hermes_home() as h:
        (h / "config.yaml").write_text(yaml.safe_dump({
            "discord": {
                "require_mention": True,
                "free_response_channels": ["other", "t1"],
            }
        }, sort_keys=False))

        reply = mod._policy_command("native on")
        assert "Native Hermes gate enabled" in reply
        cfg = yaml.safe_load((h / "config.yaml").read_text())
        assert cfg["discord"]["require_mention"] is True
        assert "t1" not in cfg["discord"]["free_response_channels"]
        assert os.environ["DISCORD_REQUIRE_MENTION"] == "true"
        assert "t1" not in os.environ["DISCORD_FREE_RESPONSE_CHANNELS"].split(",")

        reply = mod._policy_command("native off")
        assert "Native Hermes gate disabled" in reply
        cfg = yaml.safe_load((h / "config.yaml").read_text())
        assert "t1" in cfg["discord"]["free_response_channels"]
        assert "t1" in os.environ["DISCORD_FREE_RESPONSE_CHANNELS"].split(",")


if __name__ == "__main__":
    test_passive_skip_jsonl_and_recall()
    test_default_policy_is_mention_only_when_plugin_manages_gate()
    test_commands_bypass_policy_gate()
    test_platform_enum_matches_scoped_thread_policy()
    test_thread_policy_matches_channel_only_thread_events()
    test_thread_inherits_parent_channel_policy()
    test_policy_dashboard_shows_parent_inherited_thread_policy()
    test_thread_policy_overrides_parent_channel_policy_even_when_parent_is_last()
    test_exact_thread_policy_ignores_stale_parent_metadata()
    test_policy_response_and_ingest_commands_persist_runtime_override()
    test_mention_mode_requires_bot_mention_before_replying()
    test_policy_dashboard_exposes_openclaw_compatible_button_labels()
    test_policy_callback_payloads_are_accepted_as_fallback_commands()
    test_policy_help_is_manual_alias()
    test_native_gate_updates_hermes_config_and_live_env()
    print("HERMES_PLUGIN_TEST_OK")

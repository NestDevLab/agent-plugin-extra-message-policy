# openclaw-plugin-extra-message-policy

Neutral OpenClaw plugin for cross-platform message policy.

It exists to keep message access, ingest, and response behavior deterministic across Discord, Telegram, and other chat providers **without changing OpenClaw core**.

## What it does

The plugin adds an extra policy layer after the normal platform/OpenClaw access checks:

```ts
canRead = allowList && platformCanRead

responseCandidate = canRead && nativeRoutingWouldDispatch

shouldIngest =
  canRead &&
  (
    ingestMode === "all" ||
    (ingestMode === "responseCandidates" && responseCandidate)
  )

shouldRespond = responseCandidate && respond

actualRespond = shouldRespond && platformCanSend
```

Important points:

- `allowList` always remains active.
- Platform permissions still matter: Discord/Telegram/etc. decide what the bot can physically read/send.
- For `ingestMode: "all"`, native channel routing must let messages reach plugin hooks. In practice this may mean `requireMention: false` on the allowed chat, then `respond: false` here to keep the bot silent.
- `ingestMode` controls whether the plugin captures all readable messages or only messages that reached the response pipeline.
- `respond: false` suppresses replies even when normal routing, mentions, or allow-list rules would otherwise allow a response.
- On platforms with granular send permissions, e.g. Discord, the platform may block sending before this policy visibly “fires”. The plugin policy is still the same everywhere.
- On platforms with native reply metadata, the plugin can attach replies to the inbound source message so agent answers stay threaded and readable.

## Use cases

- Memory ingest for channels where the bot should learn context but stay silent.
- Context accumulation for operational/project knowledge.
- Passive monitoring/auditing of visible chat traffic.
- Telegram safety, where per-topic/per-channel outbound permissions are less granular than Discord.

## What it does not do

- It does not bypass platform permissions.
- It does not bypass OpenClaw allow-lists.
- It does not modify OpenClaw core.
- It does not call an LLM for every message.
- It does not send messages from the ingest path.

## Config model

### `respond`

Boolean. Default: `true`.

When `false`, inbound messages can still be ingested, but the plugin marks the dispatch as handled without reply.

### `ingestMode`

One of:

- `none` — do not ingest.
- `passive` — ingest only passive `message_received` events.
- `responseCandidates` — ingest only messages that reached `before_dispatch`, i.e. messages native routing would consider for response.
- `all` — ingest messages observed by `message_received`, i.e. all messages OpenClaw exposes to plugin hooks after allow-list/platform read checks.

## Runtime Policy Command

The plugin exposes one central command, `/policy`, for runtime response and ingest controls. On Discord, `/policy` and `/policy status` open an interactive panel with buttons for the current channel/thread scope:

```text
/policy status
/policy response off|mention|always|toggle
/policy ingest off|passive|responseCandidates|all|toggle
/policy native on|off
/policy reset
```

The text subcommands remain available as a fallback, but the normal Discord workflow is button-driven: change runtime response, runtime ingest, permanent native mention config, refresh the panel, reset runtime overrides, or dismiss the panel without typing command arguments.

Runtime `response` and `ingest` subcommands write plugin state, not OpenClaw config. They should not force a gateway config reload or Discord reconnect.

`/policy native on|off` is the explicit replacement for the old `/require_mention on|off` command. It writes permanent OpenClaw Discord `requireMention` config for the current channel/thread, so it may require reload/restart or trigger provider reconnect.

When `response mention` is active, the plugin first uses provider mention metadata. If the runtime hook does not expose that metadata, `mentionDetection` can provide fallback Discord bot IDs, names, or regex patterns per account.

This command shape follows the preferred custom-plugin convention: one top-level command per plugin, with subcommands for related behavior.

## Example

```jsonc
{
  "plugins": {
    "extra-message-policy": {
      "enabled": true,
      "defaultPolicy": {
        "respond": true,
        "ingestMode": "responseCandidates"
      },
      "policies": [
        {
          "channelId": "YOUR_RESPONSE_CHANNEL_ID",
          "respond": true,
          "ingestMode": "all"
        },
        {
          "guildId": "YOUR_SILENT_GUILD_ID",
          "respond": false,
          "ingestMode": "all"
        },
        {
          "sessionKeyIncludes": "discord:channel:",
          "respond": false,
          "ingestMode": "all"
        },
        {
          "isGroup": false,
          "senderId": "YOUR_OPERATOR_USER_ID",
          "respond": true,
          "ingestMode": "all"
        },
        {
          "sessionKeyIncludes": "telegram:",
          "respond": false,
          "ingestMode": "all"
        }
      ],
      "jsonlSink": {
        "enabled": true,
        "path": "runtime/extra-message-policy/messages.jsonl"
      },
      "mentionDetection": {
        "accounts": {
          "default": {
            "botIds": ["YOUR_DISCORD_BOT_USER_ID"],
            "names": ["Your Bot Name"]
          }
        }
      },
      "nativeReplyHandling": {
        "enabled": true,
        "platforms": ["discord"]
      }
    }
  }
}
```

## Native reply handling

`nativeReplyHandling` makes outbound responses use platform-native reply
metadata when the runtime exposes the inbound source message id.

Default:

```jsonc
{
  "nativeReplyHandling": {
    "enabled": true,
    "platforms": ["discord"]
  }
}
```

The plugin does not replace routing or mentions. For Discord mesh traffic, agents
should still send hydrated `cc-mesh:` mentions; native replies only attach the
message to the specific source turn for readability. Existing explicit
`replyTo` values are preserved.

## Raw recall

The plugin can also explain the raw archive to the agent, inject small relevant excerpts at request time, and expose an on-demand `search_raw_context` tool.

This keeps ingest zero-token: no embedding, no summarization, no LLM call is made when messages arrive. Recall only happens during an actual agent request.

```jsonc
{
  "rawRecall": {
    "enabled": true,
    "appendGuidance": true,
    "searchOnTriggerOnly": true,
    "maxDays": 30,
    "maxMatches": 12,
    "maxContextChars": 6000,
    "tool": {
      "enabled": true,
      "maxMatches": 20,
      "maxContextChars": 12000,
      "maxFiles": 5000
    }
  }
}
```

The automatic preflight recall uses `maxDays` as a lookback window, then injects only a bounded result block. It does not inject the whole archive.

For deeper recall, the agent can call `search_raw_context` on demand. By default the tool searches all available JSONL shards under `rawRecall.rootPath`; callers can pass `daysBack`, `conversationId`, `channelId`, or `senderId` to narrow the search.

Example trigger: “Where are we on project X?”

The plugin searches local JSONL shards for relevant terms and injects a short `Relevant passive raw-recall excerpts` block.

## Sinks

### JSONL sink

Writes one JSON object per ingested message. Useful as a durable raw transcript spool.

For long-running passive ingest, use sharding to avoid a single huge file:

```jsonc
{
  "jsonlSink": {
    "enabled": true,
    "path": "memory/discord/raw",
    "shardBy": "dayConversation"
  }
}
```

This writes files like:

```text
memory/discord/raw/2026/05/08/channel_YOUR_SECOND_RESPONSE_CHANNEL_ID.jsonl
```

### HTTP sink

Optional generic HTTP POST sink for forwarding records to another memory/monitoring service.

```jsonc
{
  "httpSink": {
    "enabled": true,
    "url": "http://127.0.0.1:8000/ingest",
    "accessToken": "..."
  }
}
```

The plugin posts the normalized ingest record as JSON.

## Hook strategy

- `message_received` handles `ingestMode: "all"`.
- `before_dispatch` handles `ingestMode: "responseCandidates"` and suppresses replies when `respond: false`.
- `message_sending` is a defensive outbound guard for any reply associated with a suppressed dispatch, and applies native reply metadata when enabled.

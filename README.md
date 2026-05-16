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

## Companion X/Twitter tools

This plugin governs chat ingest and chat replies. It does not replace OpenClaw
tool allow-lists or review controls for plugins that call outside services.

For example, an OpenClaw workspace can install
[TweetClaw](https://github.com/Xquik-dev/tweetclaw) for public X/Twitter
automation while this plugin keeps Discord, Telegram, or other chat channels
silent or recall-only:

```sh
openclaw plugins install @xquik/tweetclaw
openclaw config set tools.alsoAllow '["explore", "tweetclaw"]'
```

Keep the responsibilities separate:

- Use Extra Message Policy for channel ingest, raw recall, and reply
  suppression.
- Use OpenClaw tool allow-lists and TweetClaw review controls for live
  `tweetclaw` calls.
- Store only concise decisions, source URLs, tweet IDs, or follow-up notes in
  raw recall. Do not write API keys, cookies, raw direct-message bodies, or raw
  follower exports to JSONL or HTTP sinks.

`explore` lets the agent inspect TweetClaw's endpoint catalog without a live API
call. `tweetclaw` performs Xquik-backed actions such as search tweets, search
tweet replies, follower export, user lookup, media upload, media download,
direct messages, monitor tweets, webhooks, giveaway draws, post tweets, and
post tweet replies.

References: [npm package](https://www.npmjs.com/package/@xquik/tweetclaw) and
[ClawHub listing](https://clawhub.ai/plugins/@xquik/tweetclaw).

## Config model

### `respond`

Boolean. Default: `true`.

When `false`, inbound messages can still be ingested, but the plugin marks the dispatch as handled without reply.

### `ingestMode`

One of:

- `none` — do not ingest.
- `responseCandidates` — ingest only messages that reached `before_dispatch`, i.e. messages native routing would consider for response.
- `all` — ingest messages observed by `message_received`, i.e. all messages OpenClaw exposes to plugin hooks after allow-list/platform read checks.

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
      }
    }
  }
}
```

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
- `message_sending` is a defensive outbound guard for any reply associated with a suppressed dispatch.

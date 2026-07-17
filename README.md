# agent-plugin-extra-message-policy

OpenPack/AgentWheel package for the same extra message policy concept across agent runtimes.

- **OpenClaw**: installs the existing `extra-message-policy` OpenClaw plugin.
- **Hermes**: installs a Hermes Python plugin that hooks `pre_gateway_dispatch` for listen-only / allow / silent-ingest policy and `pre_llm_call` for bounded raw recall context.

## AgentWheel

Built-in OpenClaw adapter supports `plugins` directly:

```bash
agentwheel install . --adapter openclaw --dry-run
```

AgentWheel 0.9.0's built-in Hermes adapter does **not** expose `plugins`; use the included adapter config until upstream adds it:

```bash
agentwheel install . --adapter-config adapters/hermes-with-plugins.jsonc --dry-run
```

OpenPack runtime selection is declared in `openpack.json` through `runtimes`.

## Hermes config

Defaults are installed as `settings/hermes-extra-message-policy.json` into `.hermes/settings.json` by AgentWheel. The plugin also reads `~/.hermes/settings.json` directly under `extra_message_policy`.

Default policy is conservative: enabled, respond allowed, no passive ingest sink unless configured.

Both runtime implementations accept `mentionRecall` beside `requireMention` in
the default policy and scoped rules. It defaults to `true` for compatibility.
Set it to `false` when only mention evidence on the current message may satisfy
`requireMention`; this does not change message ingest. Hermes currently has no
internal cross-event mention cache, but honors recalled provenance supplied by
an adapter (`mention_source: recalled` or equivalent evidence metadata).

## Companion X/Twitter tools

This package governs chat ingest and chat replies. It does not replace OpenClaw tool allow-lists or review controls for plugins that call outside services.

For example, an OpenClaw workspace can install [TweetClaw](https://github.com/Xquik-dev/tweetclaw) for public X/Twitter automation while this package keeps Discord, Telegram, or other chat channels silent or recall-only:

```sh
openclaw plugins install @xquik/tweetclaw
openclaw config set tools.alsoAllow '["explore", "tweetclaw"]'
```

Keep the responsibilities separate:

- Use Extra Message Policy for channel ingest, raw recall, and reply suppression.
- Use OpenClaw tool allow-lists and TweetClaw review controls for live `tweetclaw` calls.
- Store only concise decisions, source URLs, tweet IDs, or follow-up notes in raw recall. Do not write API keys, cookies, raw direct-message bodies, or raw follower exports to JSONL or HTTP sinks.

`explore` lets the agent inspect TweetClaw's endpoint catalog without a live API call. `tweetclaw` performs Xquik-backed actions such as search tweets, search tweet replies, follower export, user lookup, media upload, media download, direct messages, monitor tweets, webhooks, giveaway draws, post tweets, and post tweet replies.

References: [npm package](https://www.npmjs.com/package/@xquik/tweetclaw) and [ClawHub listing](https://clawhub.ai/plugins/@xquik/tweetclaw).

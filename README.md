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

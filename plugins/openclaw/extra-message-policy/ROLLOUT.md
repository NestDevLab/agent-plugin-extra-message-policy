# Rollout plan

This plugin is an extra policy layer. It does **not** replace the platform/OpenClaw read allow-list.

## 1. Native access first

Configure the underlying channel so OpenClaw can see the messages you want the plugin to evaluate:

- keep allow-lists / group policies scoped to the chats the bot is allowed to access;
- for `ingestMode: "all"`, native routing must not drop non-mentions before plugin hooks see them;
- where needed, set native `requireMention: false` for the allowed chat, then use this plugin's `respond: false` to keep the bot silent.

Mental model:

```ts
canRead = nativeAllowList && platformCanRead
```

If `canRead` is false, the plugin should not see the message and cannot ingest it.

## 2. Plugin policy second

Use plugin rules to decide:

```ts
ingestMode = "none" | "all" | "responseCandidates"
respond = true | false
```

Recommended default:

```jsonc
{
  "defaultPolicy": {
    "respond": false,
    "ingestMode": "all"
  }
}
```

Then add narrow allow-rules above broad silent rules for channels where the bot may reply.

## 3. Discord

Discord can provide an extra safety net by denying `Send Messages` in channels where the bot should be silent.

Still configure `respond: false` in this plugin. The policy should be the same across platforms; Discord permissions may simply block outbound before the plugin guard is observable.

## 4. Telegram

Telegram usually lacks Discord-like per-topic outbound permission granularity.

For Telegram, `respond: false` is the primary safety control once the bot can read the group/topic.

Also verify Telegram privacy mode / bot visibility, because `ingestMode: "all"` only works if Telegram actually delivers all relevant messages to the bot.

## 5. Initial test matrix

| Case | Native access | Plugin policy | Expected |
| --- | --- | --- | --- |
| Allowed chat, silent memory | canRead true | `respond:false`, `ingestMode:all` | ingest, no reply |
| Allowed chat, normal bot | canRead true | `respond:true`, `ingestMode:responseCandidates` | reply only to native candidates |
| Allowed chat, learning responder | canRead true | `respond:true`, `ingestMode:all` | ingest all, reply to candidates |
| Disallowed chat | canRead false | any | no ingest, no reply |
| Discord send denied | canRead true, platformCanSend false | `respond:true` | policy allows, platform blocks actual send |

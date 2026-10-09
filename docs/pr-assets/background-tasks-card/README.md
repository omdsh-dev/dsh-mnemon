# Background tasks on the status page

[简体中文](./README.zh-CN.md)

Tested implementation: `7229e348`. Windows 11, Node 22.22.0, Git 2.55.0.windows.5, pnpm 11.7.0, a real `dsh web` instance served from `scripts/serve-e2e.mjs` with a disposable profile and a loopback model stub. The storage root shown is that fixture's own throwaway directory; no personal memory or credentials were used.

## The route the current conversation will use

The status page carries a **Background tasks** card. It states the route background work takes and, underneath, the Provider and Model that route resolves to right now. The header names the fallback for a caller that holds no session.

![Background tasks card: the route follows the conversation, and the line below names the Provider and Model it resolves to](./status-background-tasks-zh.png)

## Choosing a route without leaving the page

The route control opens a menu with the two routes: follow the conversation, or pin a Provider and Model. Choosing the second one expands the Provider and Model rows in place, so a reader never has to open the plugin configuration to change this.

![The route menu open, with both routes and their descriptions](./status-background-tasks-fixed-model-zh.png)

The Provider row lists the Providers this Host can actually reach; the Model row lists that Provider's models, and marks the ones that take image input.

![The Provider menu open on DeepSeek](./status-background-tasks-provider-zh.png)

## What the page wrote

Choosing a route is a profile write, not a page-local preference. After picking the fixed route, the profile's patch file held:

```yaml
taskAgentModel:
  mode: fixed
  provider: deepseek-official
  model: deepseek-flash
```

Switching back to the inherited route removed the two fields and left `mode: inherit`, so the choice can be taken back.

The same control stays read-only when the Host reports settings are not writable, and the card reports a model directory it could not read instead of silently falling back.

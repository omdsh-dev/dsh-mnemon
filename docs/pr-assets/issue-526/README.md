# Issue 526: hidden memory reads

These screenshots come from a disposable DSH 0.2.1-rc.2 WebUI running this branch in Chromium 156 on macOS. The model endpoint is a loopback stub; all conversation and memory content is synthetic.

- `chat-after-aba.png`: after opening Memory System, returning to chat, and switching A/B/A three times. No Mnemon RPC was dispatched during those switches.
- `runtime-refreshed.png`: Runtime Memory after a real Source mutation while its page was hidden, followed by reopening the page. The new synthetic entry is visible.

The same browser run observed one Runtime snapshot on the initial open, zero on a same-revision reopen, one after the Refresh button, and one after the hidden-page mutation changed the revision. Catalog, dashboard, and status-summary each refreshed once per open. Request counts cover the fixture scenario; these are not a reproduction of the issue's Windows latency measurements.

Headless Chromium kept the first tab's document visibility state visible when another tab was opened. Browser-hidden gating, idle scheduling, request coalescing, late writes, and retry recovery are covered by the client regressions rather than these screenshots. No bootstrap credential, personal data, or raw transport log is included.

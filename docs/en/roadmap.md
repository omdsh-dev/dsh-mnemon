# Roadmap

[简体中文](../zh-CN/roadmap.md) | **English** | [Documentation](./README.md)

This page separates shipped foundations from remaining work. Future items are directions, not release promises.

## Shipped foundations

- Independent Source, Strategy and Provider packages, a small public contribution service, Source-owned pages and one immutable View per executing turn.
- A Starter with the Layered strategy as its default, the General strategy as an alternative main strategy, and three optional enhancements that work with either.
- Source-local Provider descriptors, connection schemas, redaction and child-Fiber registration.
- Public-contract tests, independently installed artifacts, isolated Headless/WebUI fixtures and selective package releases.

See [Architecture](./development/architecture.md), [Development](./development/README.md) and [Release process](./development/releasing.md) for the actual scope and limits.

## Next: reliability and recoverability

- Persist background-review watermarks and pending activity across restarts; add bounded backoff and explicit retry.
- Improve idempotence and cancellation under interrupted maintenance; retain evidence of partial writes and source revisions.
- Add a deterministic sensitive-content defense before memory admission. Current model guidance is not a secret scanner.
- Expand real WebUI and fault-injection coverage: scopes, concurrent edits, capacity limits, remote deployment paths, provider recovery and supported OS combinations.
- Extend the [verified compatibility matrix](./reference/compatibility.md), including explicitly authorized real-Provider tests. Adapter fixtures alone are insufficient.

## Next: gaps from the October 2026 review

A review of the code after v0.5.31 found these concrete gaps. Each one changes what users, plugin authors or the model see, so each gets a pull request of its own. Done so far: a default install's save receipt no longer reads as a failure; while DSH does not manage the embedding settings, a save without a vector ends with a neutral note.

- **Backups and Git sync keep a Native space's placement decision.** An import that includes Memory Spaces, and the sync that uses one, keeps six fields of each Memory Space entry, so a Native space loses its recorded automatic placement decision.
- **One atomic write and one lock rule for every store.** Eleven hand-written writes differ in what they leave behind after a failure and in how they name their temporary files, and only one of the four lock implementations checks that it still owns a lock before removing it.
- **One rule for a saved secret in Provider settings.** In Memory Spaces' **Memory providers** settings, deleting part of a saved secret's mask before saving stores the rest of the mask as the secret. The dialogs' rule, where an empty field keeps the saved secret and clearing it is explicit, should apply there too.
- **One timeout range for Mnemon calls.** The Host accepts 100–120,000 ms and the Memory Spaces Source 1–600,000 ms for the same value; once they agree, a stored value outside the range should be clamped, never refused.
- **The turn memory bar opens the page of the Source that served a tool.** Today a tool the bar does not know, including the generic View tools, and an item from any other Source both open Memory Spaces.
- **The named memory tools pass only what the Source accepts.** A property the model adds, a recall `limit` above 20, or a fractional `importance` sent through `mnemon_view_action` can make the Source refuse a call the tool's schema allows.
- **Providers bring their own translated text,** and a Provider without copy shows its summary instead of an empty line.
- **Memory Spaces reaches Mnemon Native through its Provider adapter** for embedding status and fill, the version check and space merges, so that other Providers can offer the same operations.
- **SDK helpers for the code every Source and Provider repeats:** page presentation, refreshing on a new revision, navigation seeds, and a packaged Provider's entry with a default status check.
- **Memory Spaces shows no error while it starts.** Right after it is switched on, its settings show "not installed" for about a second while the Source starts; they should read as loading.
- **A Provider list reload cannot undo a switch or a save.** A quiet reload already under way when the user switches or saves a Provider can answer after the change and show the list from before it until the next read.
- **A replaced runtime memory entry shows when it last changed.** The Runtime memory page shows each entry's creation time, so a corrected entry keeps the time it was first written. Found while capturing the v0.5.32 gallery.
- **At 390 px the active Memory System tab, the turn memory bar's summary and the space cards' counts stay in sight.** On a phone the active tab can sit off-screen in English, a space card's counts are cut short, and the bar's summary is cut once it outgrows the row. Found while capturing the v0.5.32 gallery.
- **Memory Spaces shows a placeholder, not zeros, while a space is checked.** Until a space's status answers, its card reads 0 memories, 0 edges and 0 B, so a slow Provider looks like an empty space. Found while reviewing the v0.5.32 gallery.
- **A turn's item opens its page without an empty moment.** Until the Memory System's Source catalog answers, a page opened from a turn shows an empty canvas and only the Status tab; it should show the page as loading. Found while reviewing the v0.5.32 gallery.
- **The graph's entity count matches the Entities page.** The Overview graph draws at most 24 entities and its footer counts only those, so it reads 24 when the Entities page counts more. Found while reviewing the v0.5.32 gallery.
- **Graph labels stay readable.** In a dense graph, node labels overlap one another and run past the right edge. Found while reviewing the v0.5.32 gallery.
- **The Git sync form and the Host agree on local repository paths.** On some platforms the settings form accepts a local path the Host refuses, or the reverse, and only the Host refuses a NUL byte.
- **Decide what to do with the Host endpoints the client no longer calls.** 28 endpoints remain for scripts and the Interfaces reference: keep them as a documented interface or deprecate them.
- **Build maintenance:** client bundles stop carrying the build machine's paths, and ByteRover's published declarations keep their types.
- **A recall keeps the same memories when several match equally.** Today the limit can keep a different set of tied memories on each call. Found while capturing the v0.5.32 gallery.

## Later: controlled maintenance and extension growth

- Reviewable long-term consolidation, conflict/decay candidates and deliberate forgetting.
- Stronger multi-component backup/restore drills and repair tools for damaged metadata or missing projections.
- Explicit data-format migration and rollback procedures when persistent formats actually need to change.
- Better background-review history and diagnostics; broader internationalization of Host errors and command output.
- A reusable DSH directory picker when the Host exposes the necessary capability; track [dsh-external/issues#603](https://github.com/dsh-external/issues/issues/603) (private repository; requires access, and unauthenticated requests return 404).
- Candidate Source/Strategy evaluation and controlled promotion for RSI: preserve inputs, artifacts, permissions and comparison results before an explicit installation decision.

## Boundaries that remain

The current UI presents memory behavior, not a generic plugin marketplace or View canvas. External plugins follow DSH installation and the public author contracts.

Cordis ownership is not a sandbox. There is no automatic execution of model-generated code, universal deletion guarantee, cross-Provider transaction, notification daemon or claim that every third-party memory plugin integrates without adaptation.

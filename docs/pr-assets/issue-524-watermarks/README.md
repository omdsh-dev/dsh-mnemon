# Idle-review watermark settings

Actual DSH WebUI screenshots captured from a disposable local fixture at a 1440 × 1000 viewport. The settings images capture the real dialog; the status image captures the workbench header and status region. All pixels are unmodified. The fixture uses synthetic data and a scripted local model, with no external model requests or personal Desktop profile changes.

- [Default off](settings-default-off.png): the optional persistence switch starts disabled.
- [Enabled](settings-enabled.png): the same switch after user interaction; it remained enabled after a browser reload.
- [Session status](status-session-attempts.png): the actual workbench shows 0 / 1 attempts and 0 restored attempts after a synthetic parent turn with persistence enabled. This capture includes the workbench header and status cards and excludes storage paths.
- [UI verification](ui-verification.json): redacted capture checks.

The model name displayed by DSH is fixture configuration text; the fixture replaces its execution with a local scripted response. These captures establish settings/status appearance and configuration retention. Restarted-session admission, failure counting, corruption handling, and competing-process admission are verified separately by the automated Host, lifecycle, and store tests.

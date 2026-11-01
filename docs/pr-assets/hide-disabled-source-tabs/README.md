# Hide disabled Source tabs

[简体中文](./README.zh-CN.md)

Actual DSH 0.2.1-rc.2 WebUI with this branch built locally and the isolated `scripts/serve-e2e.mjs --docs-demo=zh-CN` fixture. All displayed Lumen documents and memories are synthetic. The disabled screenshot is cropped above the temporary storage paths.

1. [Enabled](./enabled.png): Project Documents is selected, with five active and one archived document.
2. [Disabled](./disabled.png): the fixture profile disables `mnemon-source-documents` and restarts. Its tab is absent; Status still explains that the component is off and configuration remains reachable.
3. [Restored](./restored.png): re-enable the same component and restart. Its tab returns, and all five active / one archived documents remain.

The screenshots verify the persisted component switch in a real browser. Vitest additionally verifies changing the selected layer without a restart, ignoring disabled anchors, restoring tab order, descriptor-driven and focused pages, all eight built-in switch combinations, and an unmanaged replacement of a disabled shipped Source. Enabled Sources that fail to run keep their diagnostic tab. No personal data, live model requests, or user profile changes were used.

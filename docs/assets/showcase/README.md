# Current WebUI showcase / 当前界面展示

Captured on **2026-09-06 (Asia/Shanghai)** from a real, isolated local DSH Web server. This is product documentation, not an LLM benchmark.

## Environment and scope

| Item | Capture environment |
|---|---|
| Production source | `d94dfecddc0976b9d0620d1e0e387a5340bd6526` (main after PR #190); documentation edits do not change it |
| Starter and official plugins | `0.5.2`, locally built and linked by `pnpm e2e:serve` |
| DSH | Published `0.1.2-rc.1` packages; no DSH source modification |
| Browser | Chrome `152.0.7977.76`, Playwright-controlled real WebUI |
| Desktop | `1440 × 960`, device scale 1; English and Chinese |
| Narrow layout | `390 × 844` browser viewport; clipping observed, not a passing mobile test |
| Mnemon CLI | Existing local `0.2.7`; SHA-256 `1b977a07772f512905d957a0309b0e2f184c70286d38fc56c9994e9cc224bcd1` |
| Data | Synthetic Atlas workspace; 4 Runtime entries, 2 Documents, 2 Native spaces containing 4 evidence items |
| Models | Loopback fixture endpoint; no paid model, semantic distillation or cloud Provider used |

The CLI checksum identifies the installed binary; it is not an independent upstream signature verification. This capture does not expand the full compatibility matrix to every 0.2.7 feature.

## Media

[Watch the 22.72-second recording](./demo.mp4). It is a continuous real browser recording transcoded to H.264 / yuv420p with fast-start metadata: no constructed interface, label replacement, generated answer or composited frame. The video has no audio. A single MP4 replaces the old duplicated GIF/video presentation on the project landing page.

| Surface | English | 简体中文 |
|---|---|---|
| Status | [Screenshot](./en/status.png) | [截图](./zh-CN/status.png) |
| Runtime | [Screenshot](./en/runtime.png) | [截图](./zh-CN/runtime.png) |
| Documents | [Screenshot](./en/documents.png) | [截图](./zh-CN/documents.png) |
| Memory Spaces | [Screenshot](./en/spaces.png) | [截图](./zh-CN/spaces.png) |
| Evidence content | [Screenshot](./en/content.png) | [截图](./zh-CN/content.png) |
| Enhancements | [Screenshot](./en/enhancements.png) | [截图](./zh-CN/enhancements.png) |

## Reproduce and interpret

1. Build the Starter and official packages, then run `pnpm e2e:serve` as described in [Development](../../en/development/README.md). Keep its temporary credentials and paths out of shared logs.
2. Choose an isolated Atlas workspace through DSH. Create Runtime entries, Documents and Native spaces through the real UI. The four long-term demonstration facts were seeded with the real CLI into the fixture's explicit storage root, without embeddings or an LLM. Do not point these operations at personal memory.
3. Activate both spaces and synchronize. Verify that each reports two memories; browse the actual evidence in Content. Filter Runtime to Working Memory, open a Document, then visit Settings → Memory System.
4. Capture with DSH's actual language setting. Enable all three enhancement switches, reopen Settings to verify persistence, then return all three to Off. Both desktop language runs passed with no page-level JavaScript exceptions. A separate 390px resize exposed clipped settings content; see [the retained failure evidence](../../pr-assets/documentation-refresh/README.md). Container bounds alone did not detect that failure.
5. Close the browser context to finalize the recording. Transcode once; keep the screenshot pixels unchanged. Stop the fixture to dispose its server and test data.

The screenshots show the default disabled enhancement state. The recording also demonstrates temporary activation. They prove visible operations and persistence in this fixture, not the quality of automatic capture, recall ranking, summarization, external services or production conversation workloads.

## 中文说明

本组素材来自真实本地 DSH、当前 0.5.2 实现与隔离的合成数据，不是设计稿或拼接界面。四条热记忆、两份档案及两个记忆体由页面创建；四条长期证据由真实 CLI 写入夹具的明确存储根，未调用嵌入或模型。页面随后完成激活、同步与浏览。

中英文桌面均验证了三个增强开关的开启、重新打开设置后的持久化，以及恢复默认关闭。390px 窄屏另发现设置裁切，失败证据单列，不计作通过。录屏为连续浏览器画面转码，保留真实按钮和内容。它不证明 LLM 效果、云 Provider 兼容性或真实手机表现。

旧版图片、GIF、视频与 PR 证据保留原路径和版本身份，见[历史证据索引](../../pr-assets/README.md)。不覆盖历史结果，也不因主文档停止引用就删除被旧 PR 使用的素材。

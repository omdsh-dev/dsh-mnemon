# Documentation refresh verification / 文档整理验证

Current documentation media: [capture provenance](../../assets/showcase/README.md).

## Verification

Production code, loader patch, lockfile and package versions are unchanged from main `d94dfec`. The new executable work is limited to the documentation guard and its tests. Verification used Node `24.19.0` and pnpm `10.13.1` on macOS.

| Check | Result |
|---|---|
| `MNEMON_NATIVE_TEST_CLI=/absolute/path/to/mnemon pnpm verify` | Passed: 122 test files / 1,058 tests, including 8 documentation regressions and the real Native create/write/recall/forget case; 1 Windows-only file/test skipped |
| Deterministic build | 39 generated files matched |
| Headless | 38 tools / 7 representative Mnemon tools; legacy entry spelling and complete Starter disabling verified |
| Package verification | 46 Starter files; 11 public runtime imports / 26 public type dependencies; strict publint and attw passed |
| `pnpm verify:plugins` | 16 independent plugin repositories and 17 packed artifacts passed installation, public-consumer checks, typecheck, tests and builds; real DSH activated the packed Starter and all three optional enhancements |
| `pnpm release:check` / `pnpm release:intent` | Existing exact composition valid; changeset covers all 17 packages whose published README/metadata changed; no publication or version bump performed |
| Documentation | Local file/anchor links, English/Chinese counterpart paths and the full official plugin catalog checked; external network availability is not a CI prerequisite |
| README/media | Both languages rendered through GitHub's Markdown API and inspected at desktop/390px widths; overview and Runtime image URLs returned HTTP 200; 1440×960 H.264 video loaded and played for 22.72 seconds |
| Real desktop WebUI | Runtime and Document creation; Native space creation/activation/synchronization/content; three enhancement switches persisted after reopening Settings and returned to Off in both languages; no page-level JS exceptions |
| Narrow product WebUI | **Failed visual inspection**, described below; not conflated with the narrow README rendering check |

The first verification was stopped by the existing absolute-README-image gate, which caught the interim relative media links. The links now use an immutable media revision. An overlapping standalone package check also ran during a rebuild and saw missing generated declarations; final verification was rerun serially and passed. Upstream packages emit missing-sourcemap warnings; no runtime fix or suppression is included here.

No paid-model evaluation, cloud-Provider account test, physical-device test or new release-upgrade scenario was run. The Native binary used was the installed 0.2.7 executable identified in the media provenance, not a newly downloaded checksum-verified release. Historical evidence and benchmark scores are retained, not replaced by these checks.

本次只改变文档与文档检查，不改变生产代码、配置、数据格式或版本。完整验证共 1,058 项通过，真实 Native 用例已运行，仅跳过 Windows 专用测试；16 个独立插件仓库和 17 个产物验证通过。中英文桌面与 README 展示检查通过，产品 390px 窄屏失败单独保留。未执行付费模型、真实云账号或物理手机测试，也未发布新版本。

## Narrow-screen finding

The unmodified production implementation at `d94dfecddc0976b9d0620d1e0e387a5340bd6526`, running on published DSH `0.1.2-rc.1`, showed clipping after resizing an open Memory System settings dialog from 1440×960 to 390×844. The dialog container remained inside the viewport, but the controls and workbench stacking were not visually usable. This is **not a passing responsive-layout result**. It was found during documentation capture; this documentation PR does not change runtime or DSH UI code.

[Original 390px resize screenshot](./narrow-resize-390.png)

A fresh 390×844 touch-enabled browser context was checked separately: open the Sidebar, then Settings → Memory System. The resize-specific overlapping workbench was absent, but the fixed-width settings navigation left the content column approximately 106px wide, producing excessively wrapped text. [Fresh narrow-context screenshot](./narrow-fresh-390.png). This is browser emulation, not a physical mobile-device test, and is also not accepted as a usable layout.

真实当前实现缩到 390px 后，虽然弹窗外框仍在视口内，设置内容和工作台层叠却出现裁切。因此不能仅凭 bounding-box 断言就宣布窄屏通过。本次保留原始失败截图，不修改业务界面，也不将其作为主展示素材。桌面中英文操作结果与这一失败分别记录。

另用新的 390px 触控浏览器上下文复核：没有同样的工作台层叠，但固定导航让内容列只剩约 106px，正文过度换行；仍不作为可用的窄屏布局通过。

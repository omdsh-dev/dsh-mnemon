# Documentation refresh verification / 文档整理验证

Current documentation media: [capture provenance](../../assets/showcase/README.md).

## Narrow-screen finding

The unmodified production implementation at `d94dfecddc0976b9d0620d1e0e387a5340bd6526`, running on published DSH `0.1.2-rc.1`, showed clipping after resizing an open Memory System settings dialog from 1440×960 to 390×844. The dialog container remained inside the viewport, but the controls and workbench stacking were not visually usable. This is **not a passing responsive-layout result**. It was found during documentation capture; this documentation PR does not change runtime or DSH UI code.

[Original 390px resize screenshot](./narrow-resize-390.png)

A fresh 390×844 touch-enabled browser context was checked separately: open the Sidebar, then Settings → Memory System. The resize-specific overlapping workbench was absent, but the fixed-width settings navigation left the content column approximately 106px wide, producing excessively wrapped text. [Fresh narrow-context screenshot](./narrow-fresh-390.png). This is browser emulation, not a physical mobile-device test, and is also not accepted as a usable layout.

真实当前实现缩到 390px 后，虽然弹窗外框仍在视口内，设置内容和工作台层叠却出现裁切。因此不能仅凭 bounding-box 断言就宣布窄屏通过。本次保留原始失败截图，不修改业务界面，也不将其作为主展示素材。桌面中英文操作结果与这一失败分别记录。

另用新的 390px 触控浏览器上下文复核：没有同样的工作台层叠，但固定导航让内容列只剩约 106px，正文过度换行；仍不作为可用的窄屏布局通过。

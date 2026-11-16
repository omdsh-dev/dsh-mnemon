# Source locale fallback / Source 语言回退

The screenshots run the real Source React components from this branch in a disposable browser fixture with synthetic, read-only responses. The fixture header and locale selector identify the tested configuration. This checks rendering and language switches, not a full DSH installation or a third-party language pack distribution.

截图运行本分支的真实 Source React 组件，使用独立浏览器夹具和只读合成数据。页首及语言选择器标明测试配置；验证范围为渲染及语言切换，不代表完整 DSH 安装或某个第三方语言包发行版的验收。

- Italian without a pack falls back to English: [Runtime](it-runtime.png), [Documents](it-documents.png), [Memory Spaces](it-spaces.png), [Skills](it-skills.png). / 无语言包的意大利语回退为英文。
- A partial Italian pack supplies the Skills heading while untranslated copy stays English: [partial pack](it-partial-pack.png). / 部分意大利语包透传标题，其余文案回退英文。
- Switching the same page to Chinese retains Chinese copy and read-only controls: [Chinese](zh-skills.png). / 同一页面切换中文，文案及只读限制保持正确。

Regression command / 回归命令：`pnpm exec vitest run tests/client-locale-fallback.spec.tsx`.

Before the fix: 5 failed, 6 passed. After: all 11 passed, covering all four Source translators, shared copy, regional locales, partial packs, parameter interpolation, plural forms, unknown keys, live language changes and settings fallback.

修复前 5 项失败、6 项通过；修复后 11 项全部通过。覆盖四类 Source、共享文案、地区语言、部分语言包、参数插值、复数、未知键、动态切换及设置回退。

`pnpm run verify`: 3,743 passed, 14 existing optional tests skipped; type checks, builds, independent Source tests, docs, Headless and package checks passed. Existing authorized and read-only UI tests remain green. No storage, RPC, permissions, configuration or new required Core client export is introduced.

全仓验证通过：3,743 项通过、14 项已有可选测试跳过，包括类型、构建、独立 Source、文档、Headless 及打包检查。原有可写及只读 UI 测试保持通过；未变更存储、RPC、权限、配置，也未增加 Source 必须依赖的新 Core 客户端导出。

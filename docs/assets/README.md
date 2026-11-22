# Documentation media / 文档素材

Product screenshots, recordings, and architecture diagrams referenced by `README.md`, `README.zh-CN.md`, and `docs/{en,zh-CN}/` live here under semantic, version-agnostic directories.

`README.md`、`README.zh-CN.md` 以及 `docs/{en,zh-CN}/` 引用的产品截图、录制和架构图按语义目录保存在此处，不再按版本号或 PR/Issue 编号堆叠目录。

| Directory / 目录 | Purpose / 用途 |
|---|---|
| [diagrams](./diagrams/README.md) | Editable bilingual SVG architecture diagrams and 2x PNG fallbacks / 双语可编辑 SVG 架构图及 2 倍 PNG 兼容图 |
| [install](./install/README.md) | First-time installation and onboarding walkthroughs / 首次安装与上手引导图集 |
| [webui](./webui/README.md) | Memory System, conversation flows, and Plugins page walkthroughs / 记忆系统、对话交互与插件配置图集 |
| [skills](./skills/README.md) | Skills library, evolution, evals, and market walkthroughs / 技能管理、进化、评测与市场图集 |

## Media policy / 素材存放规范

- **Active documentation only / 仅存放活跃文档素材**：Keep only media files actively referenced by `README*.md` or `docs/{en,zh-CN}/`. `pnpm run verify:docs` rejects unreferenced orphan files under `docs/assets/`.
- **No PR or Issue binaries in Git / 不向仓库提交 PR 或 Issue 评审附件**：Attach before/after review screenshots directly to GitHub Pull Requests via GitHub attachments; for automated/CLI uploads, push to a dedicated orphan branch or separate asset repository referenced by commit SHA, and attach release acceptance bundles to GitHub Releases or CI artifacts instead of committing them to `main`.
- **Synthetic data only / 仅使用合成数据**：Never include personal paths, private memories, API keys, or unredacted logs in screenshots or recordings.

# Playbooks

Reusable skills and prompts, reviewed before activation.

This independently installed Source owns its records, scope, review state and management page. Its public routes return View-pinned evidence. Model suggestions remain pending; explicit management edits are revision-fenced. Archives and edits retain history. Disabling the plugin retains its data.

Install alongside `dsh-mnemon-strategy-workspace` in an explicit DSH profile. Configure `dataDir` to choose a storage root. Run `pnpm verify` for this package.

## 简体中文

经审核后启用的可复用技能和提示词。 每个 Source 独立拥有数据、作用域、审核状态与管理页面。模型建议进入待审核队列，人工采纳后才生效；修改检查版本并保留历史。关闭插件不会删除数据。

## Session schedules and native skills

Enabled, approved skills are registered through DSH's public skill-provider interface and remain workspace-filtered. A distinct `providerName` is required when installing multiple instances. Catalogs invalidate after writes; disabled and pending skills cannot be loaded.

Use `{{name}}` variables in prompts; `date`, `time`, `workspace` and `session` are supplied by the Source. Preview resolves required variables before use. Immediate use creates an attributed session message, with an explicit optional wake. Schedules freeze the approved text and variables for this session, accept a start round, interval and use count (`0` means continuous), persist usage and can be stopped. Disabling their playbook stops future scheduled use. Each admitted human round may inject at most eight prompts and 40000 characters; a reservation is persisted before entering the DSH step and is not replayed after a crash.

已采纳并启用的技能接入 DSH 原生技能目录，按项目过滤；多个实例需配置不同的提供方名称。提示词支持变量预览、立即使用、下一轮或指定间隔/次数的会话调度，次数为 0 表示持续。调度固定已确认内容，记录使用次数，支持停止；停用原提示词会停止后续调用。每轮最多注入 8 条、共 40000 字符，带明确插件来源，不覆盖用户当前指令。

## Configured skill directories

`skillDirectories` adds explicit directories to the native DSH skill provider. Its public filesystem provider parses SKILL.md metadata; the Source also offers bounded Markdown browsing and editing in those directories. Reads resolve real paths, reject escaping symlinks and cap files at 256 KiB. Saving checks the observed digest, serializes cooperating writers across processes, writes atomically and preserves file permissions. Pending record suggestions remain separate from enabled skills. File edits invalidate the catalog; directory listings remain fresh even when initially empty.

`skillDirectories` 可配置额外的原生技能目录，复用 DSH 公开文件系统技能提供方解析元数据。页面支持目录检索和 Markdown 文件编辑，限制真实路径和 256 KiB 文件大小。保存检查已读取的内容摘要，协调并发写入，以原子替换保留权限；过期编辑会提示重新读取。目录技能与待审核的技能建议分别遵循自己的启用流程。

The page can create a named skill folder and its `SKILL.md` inside a registered directory. Existing folders are never overwritten, and the complete file is published atomically. Removing a file checks its digest and renames it to a hidden `.archived` sibling, which is excluded from discovery; the recovery path is shown after removal. Restore it on the service host only after checking that the original filename is still free. The shared Core editor provides native Markdown preview, unsaved-change status and ⌘/Ctrl+S. Failed saves keep the draft; changing workspaces drops old responses and drafts.

页面支持在已配置目录中创建技能文件夹及 `SKILL.md`，拒绝覆盖已有目录，完整文件以原子方式发布。移除先校验内容摘要，再改名为同目录下隐藏的 `.archived` 副本，使其退出技能发现；完成后显示恢复路径。恢复时应先在服务主机确认原文件名空闲。Core 编辑器统一提供原生 Markdown 预览、未保存提示和 ⌘/Ctrl+S；保存失败保留草稿，切换工作区时清除旧响应与草稿。

## Reviewed model operations

Model prompt creation and editing require `instruction-update` authority. Invoking, scheduling or stopping a prompt requires `session-instructions` authority and the exact record version. Skills retain their separate proposal/approval path. An immediate invocation always uses once; explicit wake steers a running conversation at its next step or wakes an idle one. An interval of zero also means one use, regardless of count. Duplicate active schedules for the same prompt and session are rejected. Failed variable expansion retains a failed record and does not block other schedules.

Prompt summaries and tags aid discovery. Built-in `date` and `time` use UTC and expand at each admitted invocation; the approved template and user variables remain frozen. Completed one-shot schedules show zero remaining uses.

模型创建和编辑提示词需要 `instruction-update` 授权；立即使用、安排和停止需要 `session-instructions` 授权及精确条目版本。技能仍经过独立的建议审核。立即使用固定一次，显式唤醒会在运行中会话的下一步生效，或启动空闲会话。间隔为 0 也只使用一次；同一提示词在同一会话中不能重复创建活跃调度。变量展开失败保留失败记录，不阻塞其他调度。

提示词支持简介与标签。内置 `date` 和 `time` 使用 UTC，在每次实际调用时展开；已确认模板和用户变量保持固定。一次调用完成后，剩余次数显示为 0。

Name, exact category, tag and summary filters combine in the model route and human page. Categories come from saved records; creating with a new category adds it. Reviewed rename/removal affects only the selected category in its own scope and preserves text/history. Partial model metadata edits preserve unrelated fields.

模型路由和人类页面支持名称、精确分类、标签与简介共同筛选。分类来自已存条目；新建条目可引入新分类。审核后的分类重命名或移除仅影响其自身作用域，保留正文和历史。模型局部修改元信息时保留其他字段。

## Native skill versions

The **Skills** page extends this Source with complete native bundles: `SKILL.md`, scripts, references and tests. **Generate from experience** reads an exact reusable procedure from this Source or, when installed, the Learning Source's scoped public event. Generation uses the selected session's DSH model. Existing native user/custom skills can also be inspected and refined; their original files stay available during review. The independent `dsh-mnemon-strategy-skill-refinement` extension can suggest candidates after enough evidence or new negative feedback. It remains off by default.

A candidate does not enter the native registry. Review its resources and declared commands, then run checks through the current session's native DSH tools and permission policy. Results retain command output, exit status and the candidate digest; any edit invalidates them. Executable bundles require passing checks; advisory skills need no artificial script. Publishing atomically materializes the exact version and replaces only the inspected active predecessor. Both model and human revisions retain evidence and version history. Restoring a historical version creates another candidate that must be checked and reviewed.

Native loading, associated shell commands, model-reported use and explicit human feedback are separate events. Command outcomes belong to the complete native shell command; a wrapper that masks a script's exit code cannot establish that script's success. Use native `workdir` and preserve script exit codes. Negative observations remain unresolved until a reviewed replacement addresses the exact inspected feedback. New feedback arriving during generation stays outstanding. When Learning is installed, publication, validation, execution and human feedback also become attributed observations there.

The native catalog follows the active session's preset and workspace. It supports additional directory discovery, text resource editing with digest checks, and native enable/disable metadata. Project and bundled skills remain protected; published managed bundles use version review. The shared Core `MemoryFileEditor` supplies resource navigation, Markdown preview, comparisons, immutable published views, and semantic light/dark theme colors.

Limits: 24 text resources per bundle, 64 KiB per resource, 90,000 serialized file characters and six declared checks. At most two model/check runs execute per Source owner, with a three-minute total deadline and the native tool's per-command timeout. Runs survive Strategy recomposition and retain durable interrupted/cancelled states. Multiple Source instances must use distinct native Provider names and their own data directories.

### 技能版本管理

「技能」页面将经验整理为完整原生资源包：`SKILL.md`、脚本、参考资料和测试。可从精确经验依据生成，也可读取现有原生技能的全部资源后提出修订。生成使用当前会话选定的 DSH 模型；独立「技能改进」策略按证据门槛或新增负面反馈提醒模型处理，默认关闭。

候选先保持未启用。审核资源和命令后，由当前会话的 DSH 原生工具执行检查并保留输出、退出码与内容摘要。编辑后原验证失效；含脚本的技能须通过检查，纯说明技能无需人为添加脚本。发布才进入原生目录，并原子替换已检查的旧版本。历史恢复也生成待审核候选。

原生加载、关联命令执行、模型报告和人工反馈分别计数。命令结果表示整个 shell 命令的退出状态；尾随命令吞掉错误时，不能据此证明内部脚本成功。负面反馈只有在审核发布对应修订后才标记已处理；生成期间新增反馈继续保留。启用经验整理 Source 后，真实结果与明确人工反馈还会回流为带来源的观察记录。

原生目录遵循当前预设与项目，支持附加目录接入、资源编辑及启停；项目内和随系统提供的技能保持只读。托管版本统一经过资源对比、验证和发布流程，Core 共享编辑器提供明暗主题及窄屏布局。

# Git 同步提交者身份：issue #539

[English](./README.md) | [Issue #539](https://github.com/omdsh-dev/dsh-mnemon/issues/539)

于 2026-11-02 使用 Node 22.22.0、pnpm 10.13.1 与 Apple Git 2.39.5 验证。基线为 `a4ad2d6955172b936ff9328f39cc5873c3ec9c55`（v0.5.38）。候选源码 `src/host/git-sync.ts` 的 SHA-256 为 `4ac6b4ee6e438733fa33b9075e70ae2428279eff7f7007f7032901a99e065f30`；回归文件 `tests/git-sync.spec.ts` 的 SHA-256 为 `511e248ee0d16085769e8a2b865a09ec030097d94f35921af56fee1ca2e1bf0a`。

可重复运行的[真实 Git 回归测试](../../../tests/git-sync.spec.ts)建立临时裸仓库、Source 存储和全局 Git 配置文件。可执行的 `pre-receive` hook 只接受合成身份 `Corporate User <employee@company.example>`，并检查每个新增提交。没有使用个人 Git 配置、同步目录、账号或网络远端。

```sh
pnpm exec vitest run tests/git-sync.spec.ts -t '#539'
pnpm exec vitest run tests/git-sync.spec.ts tests/sync-config.spec.ts tests/client-memory-enhancements.spec.tsx tests/client-sync.spec.tsx
pnpm run verify
```

| 检查 | 修复前 | 修复后 |
|---|---|---|
| 新设置，已配置全局身份 | hook 拒绝占位身份 | 正确的 author 与 committer，推送成功 |
| v0.5.38 保存的默认组合，已配置身份 | hook 拒绝占位身份 | 正确的 author 与 committer，推送成功 |
| 镜像本地、相对 include、条件 include、worktree 配置 | 四种情况均使用占位身份 | 四种情况均使用 `Mirror User <mirror@example.com>` |
| 显式身份优先于 Git 配置和继承的作者环境变量 | 环境变量覆盖显式选择 | 保留显式的 `dsh-mnemon sync <approved@example.com>` |
| 此前拒绝的提交，远端为空 | 重试仍被拒绝 | 一个正确身份的根提交，本机记忆保留 |
| 此前拒绝的提交，远端已有历史 | 重试仍被拒绝 | 正确身份的新提交，父提交哈希与原发布提交完全一致，本机记忆保留 |

新增的九项回归在未修改的基线实现上全部失败，修复后全部通过。相关四个测试文件共 140 项通过；已有的无身份回退、空作者字段、远端竞争和只读配置路径也通过。高级设置渲染测试先在旧的“始终使用占位身份”说明上失败，更新为 Git 优先说明后通过。

完整 `pnpm run verify` 通过：根测试 2,396 项通过、7 项按需测试跳过；组件测试 745 项通过、3 项按需测试跳过；类型检查、确定性构建、隔离 Headless 激活和包校验通过。首次完整运行在双语文案指纹处停止；仅恢复那两条旧说明，即能重现原指纹。更新这两个指纹后（每种语言仍为 1,399 个键），完整命令重新执行并以 0 退出，未省略任何测试套件。

基线上实际观察到的最小错误，已移除临时远端路径：

```text
committed: true
pushed: false
the commit stays local because no token is available:
remote: Commit author rejected by policy: dsh-mnemon sync <mnemon@localhost>
error: failed to push some refs to '<temporary bare remote>'
```

修复后，远端策略拒绝保留 hook 详情，提示 `Sync > Advanced`，不再归因于缺少 token。配置可接受的 Git 身份后，普通同步返回 `committed: true, pushed: true`。已有历史的用例中，`git rev-list --count mnemon-sync` 为 `2`，`git rev-parse mnemon-sync^` 等于原先已发布的提交。没有新增强制推送或修改历史操作。

旧占位姓名/邮箱的完整组合对应既有的“默认”选项，现在跟随 Git；其他显式组合仍保留，包括仅一个字段与占位值相同的情况。解析身份不写入同步设置或 Git 配置。重试从远端和当前 Source 存储重建可丢弃的镜像，不保留仅在镜像内手工修改的内容。[操作指南](../../zh-CN/guides/operations.md#git-仓库同步)包含恢复与回滚步骤。

此验证覆盖本地 Git 策略 hook 和身份优先级，不代表真实企业 GitLab 账号、HTTPS 凭据、所有服务器策略或 Windows 执行已经验证。定向运行中仍可见上游 source-map 警告和 Node SQLite 实验性警告。

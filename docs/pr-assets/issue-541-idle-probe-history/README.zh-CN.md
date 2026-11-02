# Issue 541：空闲 PTC 历史完整性

[English](./README.md)

2026-11-02 合成验证，基于 v0.5.38（`a4ad2d6955172b936ff9328f39cc5873c3ec9c55`）。未读取或修改用户会话或 Desktop profile；本地确定性模型不调用外部模型服务。

## 复现与结果

`tests/idle-review-tool-access-host.spec.ts` 中的真实 DSH Agent 在 PTC 模式运行两个合格父回合。未修改 main 在 `turn/end` 后追加探测，正式 v4 校验器报错：

```text
SessionFormatError: tool/ptc-dispatch-start is outside an open turn
```

修复分支在 `agent/turn-stopping` 中等待探测，也覆盖超时后故意延迟的 PTC 审计事件。空闲计时器启动获准的审查子代理，不再新增父会话工具事件。v4 校验器和新建 JSONL 持久化读取器均可加载完整历史。守卫、审批抑制、包装器及后置策略拒绝、取消、持久化次数与后续恢复继续受测试覆盖。

`tests/fixtures/issue-541-idle-probe-v4.jsonl` 来自上述真实 rc.5 复现，仅将临时文件系统路径替换为 `/synthetic/issue-541`，对话、模型及数据均为合成内容。恢复将两个探测审计事件转换为带命名空间的可忽略记录，保留原类型、数据及位置；所有对话消息与其他原始行保持不变。正式读取器拒绝原件、接受恢复副本，覆盖 JSONL 和带校验和的 Zstandard。再次恢复保持字节不变；歧义、不完整及非探测调用拒绝输出。

## 复验

```bash
pnpm exec vitest run tests/idle-review-tool-access-host.spec.ts tests/lifecycle.spec.ts tests/legacy-session-repair.spec.ts
DSH_HOST_ROOT=/path/to/installed/node_modules/@deepseek-ai/dsh pnpm run test:installed-dsh tests/idle-review-tool-access-host.spec.ts tests/legacy-session-repair.spec.ts
node bin/repair-legacy-session.mjs --input tests/fixtures/issue-541-idle-probe-v4.jsonl
pnpm run verify
```

完整 `pnpm run verify` 通过：根测试 2,400 项通过、7 项既有可选跳过，所有组件套件、类型、确定性构建、Headless 和包检查通过。随后增加六个守卫/恢复场景，最终全部根测试 2,406 项通过、7 项跳过。已安装 rc.5 针对性测试：287 项通过；已安装 0.2.0-rc.2：158 项通过。[CLI 预览](./recovery-preview.json)仅包含合成夹具摘要与计数。

## 限制

五秒截止时间会请求取消探测，但无法强制结束同进程扩展中间件：停止钩子必须等待其收尾，才能结束回合。准入只是检查点，不保证未来子代理或写操作的权限。恢复为显式选择、仅生成副本；不会自动修改用户存储、删除审计数据，也不保证无关损坏可恢复。继承/子会话、孤立或其他歧义审计记录会被拒绝。未修改上游 DSH 代码。

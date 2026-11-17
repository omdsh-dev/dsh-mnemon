# 读取旧 Hindsight Bank，只写入专用新 Bank

**简体中文** | [English](../../en/guides/hindsight-bank-isolation.md) | [Provider](./memory-providers.md)

现有 Source 隔离与后端限制的凭据，可以支持 [#434](https://github.com/omdsh-dev/dsh-mnemon/issues/434) 的双连接替代方案。这套可选部署配置不在 Mnemon 中新增按 Bank 划分的 ACL，也不改变已有配置。

| 连接 | Source 配置 | 后端权限 |
| --- | --- | --- |
| 旧 Bank | 独立目录；`writeEnabled: false` | 读取、浏览旧 Bank |
| DSH 专用新 Bank | 独立目录；`writeEnabled: true` | 凭据只允许访问专用 Bank |

第一层在调用 Provider 前拒绝模型和管理界面的修改；第二层防止可写连接通过别名、重新发现或修改本地 Bank ID 获得旧 Bank 权限。这类别名请求由后端拒绝并报错，不是 Host 在 Provider 调用前按命名空间拒绝。激活状态、默认 `bankId`、提示词和策略选择均不能替代这些边界。

## 后端前提

通过后端管理界面创建专用 Bank。支持 Bank 范围 API key 的 Hindsight Cloud/Enterprise 部署，应把新凭据限定到该 Bank；[Hindsight 文档说明其他 Bank 请求会返回 403](https://docs.hindsight.vectorize.io/enterprise/api-keys/)。可写 Source 不应持有不受限的管理员 key。先确认自己的部署允许受限凭据执行发现，并且只列出授权 Bank。

开源版[共享 API key 鉴权](https://hindsight.vectorize.io/developer/configuration#authentication)用于识别请求，本身不提供 Bank 隔离。没有 Bank 范围凭据时，使用独立受限的后端端点或租户。两个权限相同且不受限的 key 不能实现隔离。本方案不代为配置代理，也不认证外部授权服务。

## 配置 Source

1. 配置期间停止对话和后台任务，保留原数据目录与远端记忆。
2. 添加两个显式 Memory Spaces Entry，分别使用不同 ID 和绝对 `dataDir` 路径，各自只挂载 Hindsight Provider。在各自 Source 的 Provider 设置中单独配置端点、凭据并发现目标 Bank。首次连接设置需要 `writeEnabled: true`，应在接受 Agent 工作之前完成，然后将旧库 Source 改为 `false` 并重启。只读状态也会阻止之后的连接或激活编辑；调整这些配置时另开停止服务的维护窗口。
3. 在现有“分层策略”下开启“范围组合”，选择两个 Source，并保留需要的 Runtime/Documents Source。持久记忆的可写 Source 只选新的 DSH Source；保留 Runtime/Documents 原权限。使用 Source 目录中的准确实例键，包含可能存在的 profile 前缀。没有范围选择时，默认分层策略会把两个持久证据 Source 判为歧义。
4. 从部署中移除其他可写的旧 Bank 连接；不受限的 Source 仍拥有自己的权限。不要在 DSH Bank 不可用时配置自动回退到其他持久记忆 Provider。

最终 Entry 片段如下；请按系统替换路径，通过 Provider 设置填写凭据：

```yaml
- id: legacy-memory
  name: dsh-mnemon-source-memory-spaces
  config:
    dataDir: /absolute/path/to/legacy-source
    writeEnabled: false
    providers:
      - use: dsh-mnemon-provider-hindsight
        instanceId: hindsight
- id: dsh-memory
  name: dsh-mnemon-source-memory-spaces
  config:
    dataDir: /absolute/path/to/dsh-source
    writeEnabled: true
    providers:
      - use: dsh-mnemon-provider-hindsight
        instanceId: hindsight
```

只组合这两个 Entry 时，范围组合使用 `sourceKeys: [source:dsh-memory, source:legacy-memory]` 和 `writableSourceKeys: [source:dsh-memory]`。把已有 Runtime/Documents 的实例键补入相应列表，以保留其参与和权限。Source 顺序只表达偏好，不提供授权。涉及多个 Source/空间时，使用准确的 Route/Action 和 `memoryBodyId`，不依赖有歧义的默认目标。

## 使用前验证

- Recall 和 Related 能读取旧库证据；旧库 Source 不提供写入 Action，管理界面的 Remember/Forget 在 Provider 修改调用前被拒绝。
- 可写连接只发现专用 Bank；Hindsight 的 `queued` 回执表示已接受提取任务，不表示事实已经持久化并可查询。
- 禁用新连接后，旧库仍可读取，持久写入 Action 则消失。空目标集合保持为空，不回退到旧 Bank。
- 使用隔离测试命名空间或账号验证后端拒绝，包括连接别名和修改本地 Bank ID。不要向生产旧库发送破坏性请求来测试未知权限。
- 权限调整在停止服务的维护窗口进行，重启后再使用。设置不能撤回已经发送的远端操作；仅收窄策略选择也不等于立即撤销旧 View 的权限。

[隔离回归](../../../tests/hindsight-source-isolation.spec.ts)将真实 Source、分层/范围策略与 Hindsight 适配器连接到本机授权夹具，覆盖两个旧 Bank、Recall/Related、Host 拒绝、排队回执、后端拒绝别名越权以及空写入目标。测试不访问或认证真实 Hindsight 部署。不改变存储/凭据格式及 Provider 行为；移除此可选组合时可以保留数据目录。

# Skill refinement

An optional enhancement for the Workspace context Strategy. It uses the Playbooks Source's native skill lifecycle and can consume reusable procedures from the Learning Source when installed. The default three-tier composition is unchanged.

The policy asks the agent to inspect existing skills and exact evidence before proposing one complete candidate. Revisions require reading every resource of the current version. Duplicate or insufficient evidence can be deferred with a recorded explanation.

The Source owns files, review, native publication and attributed feedback. This Strategy owns guidance and the evidence threshold; it does not execute scripts or activate candidates. Script checks run only when explicitly requested through the DSH tool pipeline. A candidate stays inactive until reviewed and published.

Configuration:

| Field | Default | Meaning |
| --- | --- | --- |
| `minimumSignals` | `2` | Independent signals before suggesting a new skill |
| `reviewFeedback` | `true` | Prompt follow-up on unresolved skill feedback |
| `instruction` | Built-in guidance | Refinement rules applied by the Workspace Strategy |

## 简体中文

工作区主策略的可选增强，依赖工作方法 Source 的原生技能生命周期。经验整理 Source 可选安装，通过带作用域的公开事件提供证据。默认三层记忆组合保持不变。

新技能默认需要两条独立证据；已有技能收到负面反馈时，可单独触发改进提示。模型必须读取本轮实际提供的依据，并在修订前逐一读取所有资源。每轮最多处理一个机会，重复或不足的证据可记录暂不处理的原因。候选始终先等待人工审核；验证和发布由 Source 管理，策略不执行脚本、不持有技能文件。

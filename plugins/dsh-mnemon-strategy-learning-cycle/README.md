# Learning cycle

A pure optional enhancement for `dsh-mnemon-strategy-workspace`. It requires an enabled learning Source and reads only its public facts. `interval` defaults to five real human turns. `feedbackReview` defaults to true; new explicit feedback can trigger a review independently of the human-turn interval. `outcomeInterval` defaults to zero, meaning outcomes are collected for the ordinary review; a positive value enables a separate outcome threshold. `instruction` supplies bounded review guidance.

The enhancement never calls a model, writes a store or adopts a candidate. Those operations belong to Sources and use their public routes and actions. Failed reviews stay outstanding. It contributes nothing when the required learning routes/actions are absent.

## 简体中文

工作区策略的可选纯策略增强，需要启用经验整理 Source，仅消费其公共状态。`interval` 默认五个真实用户轮次；`feedbackReview` 默认开启，新增人工反馈可独立触发整理；`outcomeInterval` 默认为零，结果随常规周期整理，设为正数可另设结果数量阈值；`instruction` 提供受限整理规则。

增强不调用模型、不写存储、不采纳建议。操作由 Source 的公共路由和动作承接，失败时保留未完成状态。学习能力未安装或未提供必要操作时不注入整理指令。

# Issue #551 UI evidence / 界面验收

Captured in an isolated DSH 0.2.2-rc.1 Web profile with this branch linked. Its home, agents directory and Mnemon data are temporary; no user memories or model credentials were loaded.

- `settings-default-off.jpg`: automatic adoption defaults off while evolution and backtests are on.
- `settings-enabled.jpg`: the switch was enabled through the real UI, and `skills.autoAdopt: true` was read back from the profile patch. It was then switched off again.
- `review-retained.jpg`: a synthetic three-attempt regression stays in review, shows baseline 75 / draft 50, and retains the manual actions.
- `review-history.jpg`: the activity expands to show both rewrite attempts and the terminal reason.

The review and scores are synthetic UI fixtures, not evidence of real-model quality. The original synthetic skill file was checked unchanged. Host/Source integration tests separately exercise actual automatic orchestration, model selection, the two-rewrite bound, complete-case/check comparison, settings cancellation, file/draft/case conflicts and Source adoption under its write lock.

截图来自独立的 DSH 0.2.2-rc.1 Web 测试配置；home、agents 和记忆目录均隔离。开关在真实界面开启后已核对持久化配置，再恢复关闭。草案、活动与分数是合成验收数据，没有调用真实模型；原合成技能文件保持不变。自动编排及写入边界由 Host + Source 集成测试验证。

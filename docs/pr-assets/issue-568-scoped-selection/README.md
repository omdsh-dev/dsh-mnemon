# Scoped source selection evidence / 范围组合证据

`default-selection.png` renders this branch's actual `ComponentOptions` with synthetic sources in a minimal Vite browser fixture. It demonstrates checked inherited source selections and no saved changes; the fixture omits the full DSH theme, so it is not a layout-fidelity claim. No user account, memory content, private path or credential appears.

截图使用本分支实际组件与合成来源，展示默认勾选且尚未保存。夹具未加载完整 DSH 主题，不用于宣称整页布局一致；不包含用户账号、记忆、私人路径或凭据。

A downstream equivalent patch was also exercised in the real DSH rc.5 desktop after restart: three inherited selections were checked, clearing them and applying opened the warning, Cancel did not save, and Discard restored defaults. The full desktop screenshot was not uploaded because it includes private sidebar data.

等价补丁已在真实 DSH rc.5 桌面重启后点击验收：默认三项选中，清空并应用出现确认，取消不保存，放弃修改恢复默认。完整桌面截图含私人侧栏信息，未上传。

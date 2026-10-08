<h1 align="center">dsh-mnemon</h1>

<p align="center"><a href="README.md">English</a> · <strong>简体中文</strong></p>

<p align="center"><strong>dsh-mnemon 现在在 <a href="https://github.com/mnemon-dev/mnemon">mnemon-dev/mnemon</a> 的 <a href="https://github.com/mnemon-dev/mnemon/tree/master/dsh"><code>dsh/</code></a> 目录中开发。</strong></p>

DeepSeek Harness 插件和 Mnemon 记忆系统现在在同一个仓库里。代码、文档、Issue 和新版本都在那里。

## 安装方式不变

npm 包名仍然是 `dsh-mnemon`。在 DeepSeek Harness 中打开 **插件 → 添加插件** 安装 `dsh-mnemon`，或者运行：

```sh
dsh plugin --profile web add dsh-mnemon
```

已有安装照常从 npm 更新。

## 现在去哪里

- 文档：[https://github.com/mnemon-dev/mnemon/tree/master/dsh](https://github.com/mnemon-dev/mnemon/tree/master/dsh#readme)
- Issue 和 PR：[https://github.com/mnemon-dev/mnemon/issues](https://github.com/mnemon-dev/mnemon/issues)
- 发布：以前的版本和 tag 继续保留在本仓库；新版本从 mnemon-dev/mnemon 发布。

## 本仓库保留的内容

- 发布历史和 tag。
- `docs/assets/` 和 `docs/pr-assets/`：以前的 README、发布说明和 PR 引用的图片、录屏和验证证据。
- 以前的每一个文档页面，改成指向新位置的简短说明。
- 一个可安装的入口，`dsh plugin --profile web add github:omdsh-dev/dsh-mnemon` 仍然安装 npm 上的最新版本。

## 许可证

[MIT](LICENSE)

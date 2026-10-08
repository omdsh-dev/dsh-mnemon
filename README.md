<h1 align="center">dsh-mnemon</h1>

<p align="center"><strong>English</strong> · <a href="README.zh-CN.md">简体中文</a></p>

<p align="center"><strong>dsh-mnemon is now developed in <a href="https://github.com/mnemon-dev/mnemon">mnemon-dev/mnemon</a>, in its <a href="https://github.com/mnemon-dev/mnemon/tree/master/dsh"><code>dsh/</code></a> directory.</strong></p>

The DeepSeek Harness plugin and the Mnemon memory system now live in one repository. Code, documentation, issues and new releases are there.

## Nothing changes for installations

The npm package is still `dsh-mnemon`. In DeepSeek Harness, open **Plugins → Add plugin** and install `dsh-mnemon`, or run:

```sh
dsh plugin --profile web add dsh-mnemon
```

Existing installations keep updating from npm as before.

## Where things are now

- Documentation: [https://github.com/mnemon-dev/mnemon/tree/master/dsh](https://github.com/mnemon-dev/mnemon/tree/master/dsh#readme)
- Issues and pull requests: [https://github.com/mnemon-dev/mnemon/issues](https://github.com/mnemon-dev/mnemon/issues)
- Releases: earlier releases and tags stay listed in this repository; new releases are published from mnemon-dev/mnemon.

## What stays here

- The release history and its tags.
- `docs/assets/` and `docs/pr-assets/`: images, recordings and evidence that earlier READMEs, releases and pull requests link to.
- Every earlier documentation page, as a short pointer to its new location.
- A small installable entry, so `dsh plugin --profile web add github:omdsh-dev/dsh-mnemon` keeps installing the latest npm release.

## License

[MIT](LICENSE)

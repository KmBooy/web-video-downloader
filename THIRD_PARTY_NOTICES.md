# 第三方依赖

安装包中的 `licenses/` 目录包含随包分发的第三方许可文本。构建过程中生成的 `*.LEGAL.txt` 保留了打包工具收集的源码声明。依赖版本与 npm 包的完整性校验记录见 [package-lock.json](https://github.com/KmBooy/web-video-downloader/blob/v0.2.13/package-lock.json)。

- Mediabunny 使用 MPL 2.0。本版本包含未经修改的 Mediabunny 1.65.2，通过构建工具与扩展一起打包。其对应源码可从 [Mediabunny 1.65.2 npm 包](https://registry.npmjs.org/mediabunny/-/mediabunny-1.65.2.tgz) 获取，位于包的 `src/` 目录。
- m3u8-parser 与 mpd-parser 使用 Apache 2.0。googlevideo 使用 MIT。
- protobuf-es 的项目许可来自 [v2.17.0 上游许可文件](https://github.com/bufbuild/protobuf-es/blob/v2.17.0/LICENSE)。随包也附上其运行时中 varint 模块的 BSD 声明。

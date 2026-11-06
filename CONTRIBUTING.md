# 贡献指南

欢迎在 [Issues](https://github.com/KmBooy/web-video-downloader/issues/new/choose) 报告问题、建议改进或提出想支持的网站。

- 报告问题时请写明浏览器和扩展版本、复现步骤、预期与实际结果。标明问题发生在识别、下载、合并或保存的哪个阶段。
- 测试样本应当能公开分享，优先用自有或明确允许下载的短视频。日志请去掉 Cookie、认证头、签名媒体地址和本机路径。
- 提议代码改动前，可以先开 Issue 说明场景。各站适配器位于 `src/platforms/`，页面识别入口在 `src/scan-page.js`。改一个站点时，请核对其他站点所用的通用识别和下载流程。

## 运行检查

```sh
npm ci
npm test
npm run build
```

浏览器回归测试需要 Playwright Chromium、FFmpeg 和 ffprobe。在 macOS 或 Linux 上可按下面的方式运行：

```sh
npx playwright install chromium
WEB_VIDEO_TEST_DIR=/path/to/writable/test-folder node scripts/browser-check.mjs
```

`WEB_VIDEO_TEST_DIR` 应指向可写的现有目录。脚本在其中创建并清理自己的媒体测试目录。也可用 `WEB_VIDEO_CHROME` 指定 Chrome for Testing 的可执行文件。

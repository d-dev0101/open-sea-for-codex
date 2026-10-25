# 🌊 公开演示素材 / Public demo media

这里的海洋由项目的 **真实 WebGPU 渲染器**生成，界面使用固定的 **Codex 布局演示 / Mock preview**。动图不是用户的 Codex 录屏，也不代表 OpenAI 官方界面逐像素还原。

| 素材 | 内容 | 规格 |
| --- | --- | --- |
| `hero-dark.gif` | 深色玻璃界面与持续流动的真实海洋 | 960 × 600，6 秒，10 fps，7.24 MB |
| `controls-demo.gif` | 波浪 → 夕阳 → 玻璃不透明度，最后回到初始设置 | 960 × 600，8 秒，10 fps，7.78 MB |
| `hero-dark.mp4` / `controls-demo.mp4` | 同一次录制的高清版本，无音轨 | 1120 × 700，H.264 |
| `hero-dark-poster.png` / `controls-demo-poster.png` | 对应动图的首帧 | 1120 × 700 |
| `preview-controller.png` | 实际控制端在独立浏览器预览模式中的截图 | 1120 × 1050，无客户端连接 |

GIF 为了控制 GitHub README 的下载量，采用 64 色量化和有损压缩，天空渐变会有可见色阶。MP4 保留更完整的色彩与海面细节，适合下载查看或作为网站视频。两段 GIF 均循环播放。

## 🔒 隐私与来源

- 所有标题、项目、任务和输入框文字均为脚本内固定示例。画面持续显示 **Mock preview** 标记。
- 不打开或读取官方 Codex，不连接其调试端口，不读取任何真实会话。
- 不扫描个人目录，不使用用户截图、账号信息、Apple 壁纸或个人视频。
- 控制端截图使用全新的浏览器上下文，`window.openSea` 原生桥接不存在；不会枚举本机壁纸。
- 渲染代码为 `runtime/ocean.js`，皮肤适配为 `runtime/skin.js`；图标沿用现有 `assets/icon.svg`。
- 录制只允许访问临时回环服务器的固定资源清单，禁止外网请求。

`capture-manifest.json` 记录源码摘要、素材 SHA-256、尺寸、设置、渲染后端和海洋时间推进。实际检查结果：**WebGPU 成功渲染，0 次清单外请求，0 个页面运行错误**。

## 🎬 重新生成

需要 Node.js、项目依赖、Playwright Chromium、FFmpeg 和 Gifsicle。使用仓库根目录运行：

```bash
npm ci
npx playwright install chromium
node scripts/record-public-demos.mjs
```

FFmpeg / Gifsicle 需可从 `PATH` 调用；也可设置 `FFMPEG`、`GIFSICLE` 环境变量。已有独立测试浏览器时，可用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定其可执行文件。

脚本会覆盖本目录中的演示素材，在系统临时目录中存放中间帧，结束后自动清理。它不会改动生产源码，也不会安装或启动 Codex。海洋按真实时间运行，因此重录的波纹和文件摘要可能不同；布局、调节顺序和编码参数可复现。

初始参数：波浪 **56**、日光 **55**、玻璃不透明度 **40%**。调节演示将波浪升至 **88**、日光降至 **12**、不透明度升至 **70%**，最后恢复初始参数。

---

**English:** These are privacy-safe mock-layout recordings powered by the real production ocean renderer and skin adapter. No user sessions, official Codex window, personal files or Apple media are captured. The actual controller screenshot runs without a native bridge. GIFs use a compact 64-color palette; the matching MP4s preserve higher image quality. Run `node scripts/record-public-demos.mjs` with project dependencies, Chromium, FFmpeg and Gifsicle installed. The capture manifest documents hashes, settings, graphics backend and rendering progress.

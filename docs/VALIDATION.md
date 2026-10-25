# 验证记录 / Validation record

更新于 2026-10-26。首个公开版本定位为 **Beta**。构建成功、布局演示与真实客户端测试是不同的证据；本页不承诺所有平台或未来 Codex 版本兼容。

## ✅ 已有证据

| 范围 | 已完成 | 限制 |
| --- | --- | --- |
| Mac 官方客户端 | 开发阶段在 Apple 芯片 Mac 上核对了官方 Codex `26.1021.31345`（build `21828`）身份；用户手动确认动态海洋和顶部透明导航正常显示 | 部分实机验证；尚未完整核验当前 Beta 的安装、全部输入场景、视频与恢复流程 |
| Windows | 实现 Microsoft Store 客户端发现、身份校验与启动；CI 在 Windows 运行单元测试和 PowerShell fixtures，并构建 x64 安装包 | **实验性，未完成 Windows 原生 GUI 验证** |
| Mac Intel | CI 构建 x64 安装包并校验签名 | 未做 Intel 实机 GUI 验证 |
| 海洋与玻璃样式 | Chromium 布局 fixtures 覆盖真实海洋渲染、深浅主题、顶部导航、1px 分栏、输入框圆角、外框边缘、叠层与完整恢复 | 模拟布局回归，不是全部官方 DOM 的兼容证明 |
| 控制面板 | 隔离 Electron 实际运行主进程、preload 与 UI，测试海洋、生成的视频、托盘、隐藏/最小化/恢复、暂停及失败提示 | 不连接用户真实 Codex，不读取真实聊天 |
| 视频预览 | 缓冲时保留已解码画面；同源状态更新不会重新加载；过期播放失败不会覆盖较新的播放结果 | 解码仍取决于格式、系统与设备 |
| 本机视频传输 | 独立 Electron 宿主使用生产 CDP 和媒体代码，验证分段读取、播放、暂停、跳转、恢复后清理 | 不是官方 Codex 的完整视频集成验证 |
| Mac 系统壁纸 | 开发机成功识别已下载的系统壁纸，并在隔离面板导入、转换、播放与复用缓存 | 可发现内容取决于 macOS 版本与下载情况；不分发 Apple 素材 |
| 首次视频准备 | 同一台 Mac、同一个约 300 秒 4K/240fps HEVC 源：110.485 秒 → 36.044 秒，约减少 67% 等待 | 单设备单素材测量，不是普遍速度保证；依赖/时间线校验不通过时走兼容路径 |
| 输出检查 | H.264、最高 1080p/30fps、无音轨、保留完整时间线；测试首帧、连续播放、中途跳转、结尾、取消及缓存 | 原始系统文件不修改、不上传 |

## 🧪 如何复查源码

```sh
npm ci
npm test
npm run build
npx --no-install playwright install chromium
npm run test:browser
```

macOS 的隔离 Electron 检查：

```sh
npx --no-install install-electron
npm run test:electron
```

发布前的开发基线通过 93 项本机单元/原生/传输测试（Mac 跳过 1 项 Windows 专属测试）、20 项 Chromium 检查和 5 项 Electron 套件检查。公开源码的实际结果请查看 [CI](https://github.com/d-dev0101/open-sea-for-codex/actions/workflows/ci.yml)；源码版本不同，不能沿用旧结果。

工作流锁定 Action 提交和 npm 依赖。打包工作流接收完整源码 SHA，重新验证后构建 Mac arm64、Mac x64、Windows x64，输出安装包、SHA-256 与构建元数据。它本身不创建 Release。

## 📦 签名与下载

- Mac 包采用 **ad-hoc 本地签名**，构建时以 `codesign --verify --deep --strict` 检查完整应用及 ZIP 解压后的应用。没有 Apple Developer ID 签名或公证。
- Windows 包没有发布者签名。SHA-256 只能确认文件字节，不等于发布者认证或兼容性证明。
- 请保留操作系统安全保护；本项目不要求关闭 Gatekeeper 或 Windows 防护。
- 只使用 [Releases](https://github.com/d-dev0101/open-sea-for-codex/releases) 中实际提供的文件；实验性版本使用预发布标记。

## 🎬 公开演示与隐私

`docs/media/` 中的演示使用真实海洋渲染器与**模拟 Codex 布局**。它们展示动态背景及透明度，不是完整官方客户端实录，也不作为实机兼容性证明。

演示内容不连接用户账号，不读取会话或工作区，不使用个人截图或 Apple 壁纸。公开前检查画面、元数据和文件名。私人验证记录和本机媒体不包含在源码或安装包中。

## 📝 稳定版前仍需完成

在各目标平台记录系统版本、架构、Codex 完整版本、安装包哈希与源码 SHA；验证安装/更新、真实主界面、所有控制项、视频切换、睡眠恢复、输入框与菜单、恢复/退出、卸载。Windows 和 Intel Mac 需要各自的原生实机记录。

如报告问题，请提供版本、系统、复现步骤和脱敏画面；不要公开账号、聊天、个人路径、令牌或调试连接地址。

---

**English:** This is a beta, with partial user-assisted testing of the dynamic ocean and upper navigation in one Apple-silicon Mac version of Codex (`26.1021.31345`). Windows and Intel Mac installer construction does **not** establish native GUI compatibility. Browser fixtures and isolated Electron checks use generated/mock data. Public media shows the real ocean in a mock Codex layout, not a recording of the official application. Mac packages are ad-hoc signed, not Developer ID signed or notarized; Windows packages are unsigned. See each release's commit, checksums, CI and stated limitations.

# 隐私与安全 / Privacy and security

[中文首页](../README.md) · [English README](../README.en.md)

## 中文

### 连接与权限

Open Sea 是独立社区工具，通过 Chrome DevTools Protocol（CDP）为正在运行的官方 Codex 主界面添加背景和样式。它不修改官方应用包，不要求重新签名官方客户端，也不替代官方聊天或设置页面。

控制器在连接前检查官方应用身份、本机调试监听地址与进程归属；它只接受本机回环端点和识别到的 Codex 主界面目标。检测失败时应报告错误并停止应用皮肤。控制器不会为了连接而关闭无关应用或结束其他 Codex 进程。

CDP 本身拥有操作客户端页面的能力。仅监听本机回环地址可以限制网络可达范围，但不是对同一电脑上其他进程的身份验证。请只运行你信任的本机软件，使用结束后退出受管理的 Codex 实例来关闭调试端口。不要转发该端口或把它暴露给其他电脑。

### 数据与隔离范围

- 皮肤控制器不抓取聊天文字或输入内容；主界面适配依据结构锚点。深色半透明控制面板的 Codex 布局预览使用示例内容，不读取或展示真实聊天，不透明度变化可直接在预览中查看。皮肤资源与渲染依赖随应用提供，图片和视频只在本机处理。控制面板与 Codex 皮肤共用原版实时海洋渲染器。
- 皮肤设置保存在应用自己的用户数据目录中，`skin-settings.json` 可能包含转码后的自定义图片；导入视频另存为该目录中的本地副本。皮肤功能不会上传这些图片或视频。官方 Codex 自身的联网行为仍按其产品设置运行。
- 管理窗口使用独立的浏览器配置目录 `codex-profile/`，因此可能需要首次登录。**普通启动默认沿用现有 `CODEX_HOME` 环境值；未设置时由 Codex 使用默认目录。浏览器配置隔离不等于聊天数据隔离。**
- 公开截图、动图和实际验证应另外指定独立的演示 `CODEX_HOME` 与浏览器配置，只使用无个人信息的演示数据。控制面板预览和模拟接口测试不能替代真实客户端兼容性验证。

图片导入只接受 PNG、JPEG、WebP，输入上限为 10 MiB；文件内容还会经过格式识别与图片解码。SVG、HTML 和远程图片地址不作为用户导入内容接受。超大像素图片会被拒绝，宽图可能在本地缩小并转为 JPEG。

### 本地视频与系统素材

视频导入接受 MOV、MP4、M4V、WebM，单文件不超过 2 GiB，复制到本机用户数据目录后静音循环播放。文件扩展名和容器校验不保证解码成功，尤其是 HEVC；解码和播放失败会显示为错误，不会伪报就绪。暂停设置与页面隐藏均会暂停视频，切换背景、恢复和退出会卸载播放器资源。

通过 Mac 系统壁纸列表导入时，首次使用会由随安装包提供的本机 AVFoundation 转换工具生成 H.264 播放副本，最高 1080p、30 fps，且不保留音轨。转换进度显示在面板中；系统原文件不被覆盖。临时输出和播放缓存存放在本机私有目录，原文件未变化且缓存有效时可直接复用。这个过程不上传视频、不下载转换器，也不要求安装 ffmpeg 或 Swift；手动导入的其他视频仍取决于播放器支持的编码。

视频按范围读取，每次最多 2 MiB。Codex 中仅接受固定的 HTTPS 回环地址 `https://127.0.0.1/open-sea-media/<token>/<id>`：令牌和视频 ID 均为 32 位十六进制，不允许显式端口、查询参数、片段或其他主机。CDP 在请求阶段、实际网络访问前合成本机媒体响应，不运行媒体服务器，也不进行 DNS 查询；这不是远程上传。控制面板预览仍使用应用自己的 `open-sea-media://<token>/<id>` 协议。运行时地址不写入持久化偏好，不接受任意远程或文件 URL。

该 HTTPS 媒体路径使用已检查官方客户端现有的 `media-src https:` 许可，不修改或放宽 Codex 的内容安全策略（CSP）。恢复时卸载视频并取消在途请求、撤销拦截，完成清理的实例不会继续请求视频。隔离 Electron fixture 的媒体播放验证不代表真实 Codex 主界面已经通过集成验证。

macOS 的系统墙纸入口扫描本机下载目录，并读取本地清单中的名称，只列出通过完整性检查的视频。**去系统下载 ↗** 只打开固定的 macOS 墙纸设置页面，由用户在系统设置中下载；返回面板或点击刷新后重新查找。Open Sea 不请求清单中的远程视频地址，不直接从 Apple CDN 下载，也不上传 Apple 文件。可发现的内容取决于 macOS 版本和本机下载情况。仓库和安装包不包含这些系统视频，本项目的许可也不覆盖这些素材。Apple 系统内容仍受其[软件许可协议](https://www.apple.com/legal/sla/docs/macOSTahoe.pdf)约束。三张随应用提供的静态预设为原创图形。

### 恢复、验证与反馈

“恢复原界面”移除 Open Sea 添加的样式、背景与后续注入注册；它不会关闭客户端的调试监听。关闭设置窗口只会隐藏到 macOS 菜单栏或 Windows 托盘；选择“退出 Open Sea”才会退出控制器，并在限定等待时间内尝试异步移除皮肤、断开连接。异常或超时可能使清理不完整，也不会退出 Codex 或关闭调试端口。完整退出方式是：恢复皮肤 → 退出受管理的 Codex → 正常启动 Codex。切换背景或暂停不会隐式启动 Codex。

当前 macOS Codex `26.1021.31345` 的主界面实机集成验证尚未完成。Windows 为候选／实验性路径，尚无原生实机验证结论。源码检查、单元测试、独立控制面板或浏览器 fixture 中的真实渲染／视频播放，以及构建成功，都不等于目标平台完整兼容。本文描述当前源码；安装包的功能与验证状态以具体 Release 为准。

签名、公证和安装包校验信息以具体 Release 的明确记录为准。文档不会要求关闭 Gatekeeper、移除隔离属性、停用 Windows 防护或降低系统安全设置。遇到安全提示请先核实来源；参见 [Apple 的说明](https://support.apple.com/en-us/102445)及 [Microsoft 的 SmartScreen 说明](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)。

反馈普通故障可使用 [Issues](https://github.com/d-dev0101/open-sea-for-codex/issues)，请去除聊天、账号、凭据、个人路径和完整调试地址。如果发现涉及敏感数据的安全问题，不要把这些数据贴到公开 Issue；先检查仓库是否提供私密安全报告渠道。

## English

### Connection and capabilities

Open Sea is an independent community companion. It adds backgrounds and styles to the running official Codex main interface through Chrome DevTools Protocol (CDP). It does not edit or re-sign the official application package, or replace its conversations and settings.

Before attaching, the controller checks the official application identity, the loopback listener, and ownership by the expected process tree. Only recognized Codex main-interface targets are accepted. Failed verification should stop skin application with a readable error. The controller does not terminate unrelated processes to obtain a connection.

CDP has the ability to operate the client page. Binding to loopback limits network exposure; it does not authenticate other processes on the same computer. Run only trusted local software, and quit the managed Codex instance when finished to close its debugging listener. Do not forward or publicly expose this port.

### Data and isolation

- The skin controller does not scrape conversation text or input contents. The adapter identifies structural interface anchors. The dark translucent panel's Codex layout preview uses example content, does not read or display real conversations, and shows opacity changes immediately. Skin resources and rendering dependencies are local; images and videos are processed locally. The panel and Codex skin share the original real-time ocean renderer.
- Preferences are stored in the companion's own user-data directory. `skin-settings.json` can contain a converted copy of an imported image; imported videos are separate local copies in that directory. The skin does not upload these images or videos. The official Codex application retains its own normal network behavior.
- A separate browser profile, `codex-profile/`, can require a fresh sign-in. **Normal launches inherit the existing `CODEX_HOME` environment value; when unset, Codex uses its own default. A separate browser profile does not isolate conversation storage.**
- Public screenshots, recordings, and real-client verification should use a separate demo `CODEX_HOME` and browser profile with non-personal demonstration data. A controller preview or mocked bridge is not proof of real-client compatibility.

Imports accept PNG, JPEG, and WebP up to 10 MiB, with content-type checks and image decoding. User-supplied SVG, HTML, and remote image URLs are not accepted. Excessive image dimensions are rejected; large images can be resized locally and converted to JPEG.

### Local videos and system assets

Video imports accept MOV, MP4, M4V, and WebM up to 2 GiB per file. They are copied into local user data and loop silently. A recognized extension and container do not guarantee codec support, especially for HEVC. Decoding and playback failures report errors, never readiness. Explicit pause and page visibility control playback; switching backgrounds, restoring, and quitting unload the player resources.

First-use imports from the Mac system wallpaper list use the bundled local AVFoundation helper to create an H.264 playback copy at up to 1080p and 30 fps, without an audio track. Progress is shown in the panel, and the system original is never overwritten. Temporary output and playback caches stay in private local directories; a valid cache is reused while the source remains unchanged. Conversion uploads no video, downloads no converter, and requires no separate ffmpeg or Swift installation. Other manually imported videos still depend on the player's codec support.

Video data is read in ranges of at most 2 MiB per response. The Codex renderer accepts only the fixed HTTPS loopback address `https://127.0.0.1/open-sea-media/<token>/<id>`. The token and video ID each contain 32 hexadecimal characters; explicit ports, queries, fragments, and other hosts are rejected. CDP supplies the local media response at the request stage, before network access. No media server or DNS lookup is used, and no video is uploaded. The companion preview still uses its own `open-sea-media://<token>/<id>` protocol. Runtime URLs are not persisted in preferences. Arbitrary remote and file URLs are not accepted.

The HTTPS media path uses the inspected official client's existing `media-src https:` allowance. Codex's Content Security Policy (CSP) is not changed or relaxed. Restore unloads the video, cancels in-flight requests, and removes interception; a cleaned-up instance makes no further video requests. Media playback in an isolated Electron fixture does not establish real Codex main-interface compatibility.

The macOS system picker scans local download folders, reads names from local manifests, and lists videos that pass completeness checks. **Download in Settings ↗** opens a fixed macOS Wallpaper settings destination; users download through System Settings and return to the panel or click Refresh to scan again. Open Sea does not request remote video URLs from the manifests, download directly from Apple's CDN, or upload Apple files. Discovery depends on the macOS version and local downloads. These system videos are excluded from the repository and installers, and the project's license does not cover them. Apple system content remains subject to Apple's [software license](https://www.apple.com/legal/sla/docs/macOSTahoe.pdf). The three bundled still-image presets are original artwork.

### Restore and verification

Restore removes Open Sea's styles, background, and future injection registrations. It does not stop the debugging listener. Closing settings only hides the window in the macOS menu bar or Windows tray. Choosing **Quit Open Sea** exits the controller and attempts asynchronous skin removal within a bounded timeout before disconnecting; errors or a timeout can leave cleanup incomplete. This does not quit Codex or close its debugging port. For full teardown, restore the skin, quit the managed Codex instance, and launch Codex normally. Switching backgrounds or pausing never launches Codex implicitly.

Real main-interface integration verification for macOS Codex `26.1021.31345` is still pending. Windows remains a candidate/experimental path without native Windows validation. Source inspection, unit tests, real rendering or video playback in the standalone panel or browser fixtures, and successful builds do not establish complete platform compatibility. This document describes the current source. Package features and validation status must be stated by each specific Release.

Signing, notarization, and checksum information must be stated by each specific Release. These instructions do not require disabling system protections or removing quarantine attributes. Review the source before proceeding through a security prompt; see [Apple's guidance](https://support.apple.com/en-us/102445) and [Microsoft's SmartScreen guidance](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation).

Use [Issues](https://github.com/d-dev0101/open-sea-for-codex/issues) for ordinary bugs after removing conversations, account details, credentials, personal paths, and full debugging URLs. For a sensitive security report, check whether the repository offers a private reporting channel before sharing details publicly.

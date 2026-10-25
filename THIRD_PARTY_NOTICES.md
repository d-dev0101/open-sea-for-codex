# 第三方许可与来源 / Third-party notices

根目录 [LICENSE](LICENSE) 的 PolyForm Noncommercial 条款仅适用于本项目有权授权的原创部分。下列材料保持原有许可，**不受本项目新增的非商业限制约束**。已授予的 MIT 权利不会被追溯撤回。

## 🌊 Open Sea Skin — MIT

来源：[d-dev0101/open-sea-skin](https://github.com/d-dev0101/open-sea-skin)。该项目已公开采用 MIT，包含多位贡献者的工作。

以下文件整体保留 MIT，含适配后的海洋渲染器：

- `runtime/ocean.js`：海洋与 Shader 模型，适配自 Open Sea Skin。
- `runtime/ocean-preview.jpg`：来自上游 `website/ocean-preview.jpg` 的纯海洋静态回退图。
- `assets/icon.svg`、`assets/icon.png`、`assets/icon.ico`、`assets/icon.icns`：沿用上游海浪品牌图形及派生图标。
- `src/tray-icon.ico`、`src/tray-iconTemplate.png`、`src/tray-iconTemplate@2x.png`：同一海浪图形的菜单栏/托盘版本。

许可全文：[licenses/open-sea-MIT.txt](licenses/open-sea-MIT.txt)。这些组件可按 MIT 独立使用，包括商用；本项目整体的原创控制端与集成代码另按根许可授权。

## 🧊 Three.js r178 — MIT

`runtime/vendor/**` 内的 `three.core.js`、`three.webgpu.js`、`three.tsl.js`、`OrbitControls.js` 与 `BloomNode.js` 为随包本地提供的 Three.js 文件，来自 Open Sea Skin 的 vendor 副本。

[Three.js](https://github.com/mrdoob/three.js) · [许可全文](licenses/three-MIT.txt)

## 📏 image-size — MIT

图片尺寸检查使用 `image-size`，版本由 `package-lock.json` 锁定。

[image-size](https://github.com/image-size/image-size) · [许可全文](licenses/image-size-MIT.txt)

## 🧭 Codex Dream Skin — 设计参考 / MIT reference

官方客户端识别、生命周期和语义适配设计参考 [Codex Dream Skin](https://github.com/Fei-Away/Codex-Dream-Skin)。本项目为独立实现，相关注释位于 `src/platform.mjs`、`src/platform-windows.ps1` 与 `runtime/skin.js`。

原项目 [MIT 声明](licenses/reference-MIT.txt)保留。这里的说明不改变原项目代码或任何复用部分的 MIT 权利。

## 🪟 其他运行与构建组件

Electron 及 Chromium 等依赖保留各自的许可。安装包保留 Electron 的 `LICENSE.electron.txt` 和 `LICENSES.chromium.html`；构建工具及依赖按自身许可使用，完整版本见锁文件。

按钮玻璃质感在视觉上参考 [solid-glass](https://github.com/deeplethe/solid-glass)，未复制其 CSS 或代码。

Apple 系统壁纸仅由用户在本机下载和导入，**不随仓库或安装包分发**；本项目不为这些素材提供再分发许可。官方 Codex 客户端及 OpenAI/Apple 标识也不包含在本项目许可中。

---

**English:** The root noncommercial license applies only to the author's original contributions. The ocean renderer, ocean fallback image, wave icons and Three.js vendor files listed above retain MIT terms, including commercial rights. `image-size`, Electron/Chromium and other dependencies retain their own licenses. Prior grants are not revoked. References do not relicense their original projects. Apple wallpapers are local user assets and are not distributed here; no rights in the official Codex app or third-party trademarks are granted.

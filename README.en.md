<div align="center">

<img src="assets/icon.png" width="72" height="72" alt="Open Sea" />

# 🌊 Open Sea for Codex

**A living ocean behind your workspace.**

Real-time ocean · Adjustable glass · Local wallpapers · Menu bar & system tray

[简体中文](README.md) · **English**

[📦 Get the beta](https://github.com/d-dev0101/open-sea-for-codex/releases) · [📖 Installation](docs/INSTALL.en.md) · [💬 Feedback](https://github.com/d-dev0101/open-sea-for-codex/issues)

<p>
  <a href="https://github.com/d-dev0101/open-sea-for-codex/releases"><img src="https://img.shields.io/badge/release-v0.1.0--beta.1-3b8b8c" alt="Beta release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-PolyForm_Noncommercial-617b82" alt="PolyForm Noncommercial" /></a>
  <a href="https://github.com/d-dev0101/open-sea-for-codex/actions/workflows/ci.yml"><img src="https://github.com/d-dev0101/open-sea-for-codex/actions/workflows/ci.yml/badge.svg" alt="Automated checks" /></a>
</p>

Noncommercial use is free · Commercial use requires a separate license. [Scope and terms](docs/COMMERCIAL-LICENSE.md).

</div>

![Real Open Sea ocean rendering behind an illustrative Codex layout](docs/media/hero-dark.gif)

[▶ High-quality video](docs/media/hero-dark.mp4) · [How this demo was made](docs/media/README.md)

> 🎬 **About these demos:** the GIFs record the actual ocean renderer with an illustrative Codex layout. They show the ocean and companion controls, **not a full recording of the official client**. No real private conversations appear.

Open Sea is an independent local companion for the **official Codex desktop app**. Choose a background, tune the light and glass opacity, then apply the skin to Codex's main interface.

**Install the desktop application. No npm login or terminal commands are required.** This documentation targets beta `v0.1.0-beta.1`; available downloads and validation scope are defined by each release's attached files and notes.

## 🚀 Start in three steps

**First:** install and open the [official Codex desktop app](https://openai.com/codex/).

### 1️⃣ Choose your download

Open **[Releases →](https://github.com/d-dev0101/open-sea-for-codex/releases)** and select the package for your computer:

| Computer | Package to choose | Current validation |
| --- | --- | --- |
| 🍎 Mac · Apple silicon | `mac-arm64` `.dmg` or `.zip` | User-confirmed ocean and translucent upper navigation in real Codex; other checks are detailed in the validation record |
| 🍎 Mac · Intel | `mac-x64` `.dmg` or `.zip` | Architecture builds and signature checks; no completed manual Intel Mac test |
| 🪟 Windows · x64 | `win-x64` `.exe` | **Experimental:** builds and automated checks, without native Windows manual validation |

On Mac, check **Apple menu → About This Mac** if unsure. Choose only files attached to that release. GitHub's **Source code** downloads are not application installers.

### 2️⃣ Install and open Open Sea

- **Mac:** open the `.dmg` and drag **Open Sea for Codex** into Applications. For `.zip`, extract it first.
- **Windows:** run the `.exe` installer, then open **Open Sea for Codex** from the Start menu.

The panel defaults to Chinese; click **EN** for English. See the [installation guide](docs/INSTALL.en.md) for opening prompts. Mac packages use ad-hoc signatures without Developer ID signing or notarization; Windows packages have no publisher signature.

### 3️⃣ Click “Launch Codex with skin”

Keep the default Ocean, or choose a background in the preview first. If the new Codex window shows a sign-in page, sign in and wait for its main interface.

💡 Reopen the panel through the **macOS menu bar / Windows system tray**. Closing its window only hides it.

## ✨ Your workspace, your view

| Feature | What you can do |
| --- | --- |
| 🌊 **Real-time ocean** | Adjust wave motion, daylight and sunset; pause the animation |
| 🫧 **Adjustable glass** | Set opacity from 15–90%, default 40%; lower values reveal more background |
| 🎛️ **Live layout preview** | See an illustrative 16:10 sidebar, workspace and rounded composer respond to changes |
| 🖼️ **Your own scenery** | Import local images or videos, or choose the Aurora, Dunes and Coast still-image presets |
| 🍎 **Downloaded Mac wallpapers** | Find local system videos; open Wallpaper settings to download more, then return to choose one |
| 📍 **Quick access** | Switch backgrounds, pause and restore from the menu bar or tray; Chinese and English controls |

![Adjusting the real ocean renderer and glass opacity in the Open Sea controller](docs/media/controls-demo.gif)

[▶ High-quality controls video](docs/media/controls-demo.mp4)

<details>
<summary>🎛️ View the controller / 查看控制面板</summary>

![Open Sea controller with example content](docs/media/preview-controller.png)

</details>

Images: PNG, JPEG and WebP, up to 10 MiB. Videos: MOV, MP4, M4V and WebM, up to 2 GiB, looping silently. Manually imported video playback depends on system codec support.

### 🍎 Use a Mac system wallpaper

**Download in Settings ↗ → download through macOS Wallpaper settings → return to Open Sea → choose the wallpaper.**

First use creates a local, silent H.264 playback copy at up to 1080p / 30 fps and shows conversion progress. The original stays unchanged; subsequent selections can reuse the cache. The Mac app includes its converter, with no separate ffmpeg or Swift installation.

On one Mac, preparing a roughly five-minute 4K/240fps wallpaper improved from **110.5 s to 36.0 s**. This is a measured result for that device and source, not a universal speed guarantee. [Test scope →](docs/VALIDATION.md)

Media stays local and is not uploaded by the skin. Apple wallpapers are downloaded by users through System Settings and **are not distributed with this project or its installers**.

## 🔄 Updating and restoring

<details>
<summary><strong>How do I update an existing installation?</strong></summary>

Choose **Quit Open Sea** from the menu bar / tray and wait for the icon to disappear → install and open the new version → click **Launch Codex with skin**.

Closing the panel leaves the old controller running. Keep the application data folder to retain settings and imported local media. [Update steps](docs/INSTALL.en.md#update-an-existing-installation)

</details>

<details>
<summary><strong>Why might Codex ask me to sign in again?</strong></summary>

Open Sea starts a managed official Codex instance with a separate browser profile. First sign-in may be required. Normal launches inherit `CODEX_HOME`, or use Codex's default when unset; **a separate browser profile does not isolate conversation storage**.

“Controller ready” means the panel is available. A working preview does not establish a Codex connection. Check the actual main window and panel status. [Status guide](docs/INSTALL.en.md#read-the-status)

</details>

<details>
<summary><strong>How do I restore Codex? Does Open Sea modify the official app?</strong></summary>

Click **Restore original** to remove the background and styles. Open Sea applies the skin through a verified local loopback CDP connection, without modifying the official application package or Content Security Policy (CSP).

**Quit Open Sea** exits the controller and attempts bounded cleanup; it does not quit Codex. To close the debugging port, quit **the Codex instance launched by Open Sea**, then open Codex normally. CDP can operate the page; loopback binding is not authentication against other local processes. [Privacy and security](docs/SECURITY.md)

</details>

## 🧪 Compatibility and feedback

This independent community beta is not affiliated with OpenAI or Apple. Recorded macOS native evidence covers Codex `26.1021.31345`; official updates may require adaptation. Companion tests, illustrative layouts and successful builds do not establish complete native compatibility on every platform.

Please report issues with your OS, processor architecture, Codex / Open Sea versions and error message in **[Issues](https://github.com/d-dev0101/open-sea-for-codex/issues)**. Remove account details, private conversations and personal paths from screenshots.

📚 [Install and use](docs/INSTALL.en.md) · [Validation record](docs/VALIDATION.md) · [Privacy and security](docs/SECURITY.md)

<details>
<summary><strong>🛠️ Run from source</strong></summary>

Use Node.js 22+. Mac source builds also require Xcode Command Line Tools with Swift and the macOS SDK. Packaged applications do not require these developer tools.

Inside the cloned repository:

```sh
npm ci
npm start
```

Run tests with `npm test`; build packages supported by your environment with `npm run package`. A successful build is not native platform validation.

</details>

## 🙏 Credits

Included notices retain the third-party MIT licenses for [Open Sea Skin](licenses/open-sea-MIT.txt) and [Three.js](licenses/three-MIT.txt). [Codex Dream Skin](https://github.com/Fei-Away/Codex-Dream-Skin) informed client detection and lifecycle design; this companion implements its own approach and preserves the [reference notice](licenses/reference-MIT.txt). Buttons take visual inspiration from [solid-glass](https://github.com/deeplethe/solid-glass); no CSS or code was copied from it.

## 📄 License

This project is **source available and free for noncommercial use** under [PolyForm Noncommercial 1.0.0](LICENSE). It is not OSI-defined open source.

**Except for purposes expressly permitted by LICENSE and statutory rights, commercial use requires a separate prior written license**, including internal commercial business use, paid derivatives, resale and commercial bundling. Read the [commercial licensing guide](docs/COMMERCIAL-LICENSE.md). You can express interest through a [commercial license request](https://github.com/d-dev0101/open-sea-for-codex/issues/new?template=commercial_license.yml); do not put private contact details, contracts or other sensitive information in public issues.

Third-party MIT components keep their original licenses. See [Third-party notices](THIRD_PARTY_NOTICES.md) for their scope.

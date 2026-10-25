# 📦 Install and use

[← README](../README.en.md) · [简体中文](INSTALL.zh.md) · [Downloads](https://github.com/d-dev0101/open-sea-for-codex/releases)

Open Sea is a separate local companion for the **official Codex desktop app**. Install and open official Codex first. Packaged Open Sea installations need **no npm login, Node.js or terminal commands**. The panel defaults to Chinese; click **EN** to switch to English.

This guide targets beta `v0.1.0-beta.1`. Available packages, signatures and validation scope are defined by the [actual release files and notes](https://github.com/d-dev0101/open-sea-for-codex/releases). GitHub's `Source code.zip` and `Source code.tar.gz` downloads are not installers.

**Jump to:** [Mac](#install-on-mac) · [Windows](#install-on-windows-experimental) · [Controls](#everyday-use) · [Mac wallpapers](#use-mac-dynamic-wallpapers) · [Update](#update-an-existing-installation) · [Restore](#restore-and-leave)

## Install on Mac

### 1️⃣ Choose your architecture

Open **Apple menu → About This Mac**, then choose the matching file from [Releases](https://github.com/d-dev0101/open-sea-for-codex/releases):

| Your Mac | Download |
| --- | --- |
| Apple silicon / M-series chip | `mac-arm64` `.dmg` or `.zip` |
| Intel processor | `mac-x64` `.dmg` or `.zip` |

Choose only architecture files attached to that release. Ocean and translucent upper navigation have been user-confirmed in real Codex on Apple silicon. Manual Intel Mac validation has not been completed.

### 2️⃣ Install Open Sea

Open the `.dmg` and drag **Open Sea for Codex** into Applications, then open it. For a `.zip` download, extract it first and move the application into Applications.

Current Mac packages pass ad-hoc signature checks but do not have Apple Developer ID signing or notarization. macOS may display an opening prompt.

<details>
<summary><strong>If macOS prevents opening</strong></summary>

First confirm that the file came from this repository's matching release and review its notes. For a file you trust and have verified has not been altered, macOS may offer **System Settings → Privacy & Security → Open Anyway** after an opening attempt. Follow the system's confirmation flow; wording varies by macOS version.

If macOS reports damage or malicious content, stop and report it. Do not disable Gatekeeper, remove quarantine attributes or change global security settings. [Apple's opening guidance](https://support.apple.com/en-us/102445)

</details>

### 3️⃣ Apply the skin

Keep **Ocean** selected and click **Launch Codex with skin**. If the new official Codex window shows a sign-in page, complete sign-in and wait for its main interface. Repeated launch clicks are unnecessary.

You can adjust waves, daylight and opacity in the preview first. Once connected, edits also apply to the managed Codex window.

## Install on Windows (experimental)

The Windows integration targets the official `OpenAI.Codex` Microsoft Store installation. Install and open that official client first.

1. **Download:** choose an attached `win-x64` `.exe` from [Releases](https://github.com/d-dev0101/open-sea-for-codex/releases).
2. **Install:** run the installer, then open **Open Sea for Codex** from the Start menu.
3. **Apply:** click **Launch Codex with skin**. Sign in in the new window if prompted, then wait for the main interface.

**Validation limit:** Windows has builds and automated checks, but no completed native Windows manual validation. Producing an installer does not establish complete client integration.

Windows packages have no publisher signature and may trigger SmartScreen. Check the source, release notes and file information before proceeding. Organizational policies may prevent installation or independent launch of the Store client. Keep any error message and report it; do not disable protections or force a launch through administrator commands. [Microsoft's SmartScreen explanation](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)

## Everyday use

**Find Open Sea in the menu bar / system tray.** Open settings, change backgrounds, import video, pause or restore from that icon. Closing the panel only hides it; **Quit Open Sea** exits the controller.

| Goal | Control |
| --- | --- |
| 🌊 Use the live ocean | Choose Ocean; defaults are wave motion 56 and daylight 55 |
| 🫧 Adjust glass | Set Glass opacity to 15–90%, default 40%; lower values are more transparent |
| 🖼️ Change still scenery | Choose Aurora, Dunes or Coast, or import an image |
| 🎞️ Use local video | Choose Import a video; videos loop silently |
| ⏸️ Pause motion | Click Pause animated background; click again to resume |
| 🌐 Change language | Use 中 / EN at the top right |

**Formats:** PNG, JPEG and WebP images up to 10 MiB; MOV, MP4, M4V and WebM videos up to 2 GiB. Excessive image dimensions may be rejected. Large images can be resized locally and converted to JPEG, so transparency is not guaranteed to survive import. A supported container does not guarantee codec support, especially HEVC. Playback errors appear in the panel; try another video or switch to Ocean.

### Preview versus the real client

The controller uses the **actual ocean renderer with an illustrative 16:10 Codex layout**: sidebar, workspace and rounded composer. It contains example content and does not read real conversations. Wave motion, daylight and opacity update the preview immediately.

A working preview is not a Codex connection or proof of compatibility across all client screens. Check the actual managed window and connection status.

Brief video buffering keeps the current picture visible. Hiding or minimizing the panel pauses only its preview; reopening resumes it without changing Codex background playback. Your explicit pause preference is preserved.

## Use Mac dynamic wallpapers

1. **Open System Settings:** click **Download in Settings ↗** under Mac dynamic wallpapers.
2. **Download a wallpaper:** choose one in macOS Wallpaper settings and wait for the download to finish.
3. **Return to Open Sea:** the panel scans again when it regains focus; you can also click **Refresh**.
4. **Apply it:** click a listed wallpaper. An existing Codex connection receives it; otherwise click **Launch Codex with skin** when ready.

The list contains local videos that pass completeness checks. Results depend on macOS version and completed downloads. The shortcut opens system Wallpaper settings; macOS handles downloading. Open Sea does not download video directly from Apple's CDN.

### Why does first use prepare the wallpaper?

Some system videos use high-frame-rate HEVC that the player cannot reliably use directly. The bundled Mac converter creates a **silent H.264 playback copy at up to 1080p / 30 fps**. It preserves the full timeline and leaves the system original unchanged. The panel shows conversion progress.

For high-frame-rate media with verified dependency information and timing, preparation avoids unnecessary decoding. Other videos use the compatibility path. On one Mac, preparing a roughly five-minute 4K/240fps wallpaper improved from 110.5 s to 36.0 s; your result depends on the device and source. [Validation record](VALIDATION.md)

The copy stays in private local storage and is reused while the original is unchanged and the cache is available. Updating the controller does not force existing videos to be converted again. Packaged Mac apps require no separate ffmpeg, Swift or developer tools.

Apple videos are not uploaded by the skin or distributed with the repository or installer. On Windows, use **Import a video** for your own local media; the macOS settings shortcut is unavailable. [Asset and privacy details](SECURITY.md)

## Update an existing installation

1. **Quit the old controller:** choose **Quit Open Sea** from the menu bar / tray and wait for its icon to disappear. Closing the window alone leaves it running.
2. **Install the update:** install in the same location and reopen Open Sea. Keep the application data folder to preserve settings and imported media.
3. **Apply again:** click **Launch Codex with skin**. The controller checks and attempts to reconnect to its previously managed Codex window before applying the updated skin.

If the old appearance remains, use **Restore original**, wait for success and apply again. If the connection expired, save your work, quit **the Codex instance launched by Open Sea** and launch through the new controller. Leave unrelated Codex windows running.

## Read the status

| Status | Meaning and next step |
| --- | --- |
| Controller ready | The panel is available; this does not establish a Codex connection |
| Waiting for the main interface | Wait for the client; sign in only if it shows a sign-in page |
| Ocean graphics are initializing / A static ocean background is visible | Connected; animation is preparing or temporarily unavailable. No extra sign-in is needed |
| Preparing wallpaper locally …% | First-use conversion; wait for completion, then later selections can reuse the cache |
| Loading local video | Preparing the first frame; no relaunch or sign-in is needed |
| Your skin is visible in Codex | The main interface has been recognized and the skin applied |
| Video background could not play / Skin rendering failed | Read the error, change the background or adjust and retry. This is not a sign-in request |
| UI preview · not connected to a client | Standalone preview only; use the Open Sea application for launch and restore |

With multiple windows, failures or static fallback take priority. For connection or launch errors, follow the specific message and check that the official client is installed and the managed window is still running.

## First sign-in and connection

Open Sea starts a managed official Codex instance with a separate browser profile, so first sign-in may be required. Normal launches inherit an existing `CODEX_HOME`; when unset, Codex uses its default. **A separate browser profile does not isolate conversation storage.**

The skin uses a verified local loopback Chrome DevTools Protocol (CDP) connection. It does not modify the official app package or its Content Security Policy (CSP). CDP can operate the page; loopback binding limits network exposure but does not authenticate other processes on the same computer. Do not forward or expose the debugging port to other computers. [Connection and security boundaries](SECURITY.md)

## Restore and leave

- **Restore appearance:** click **Restore original** to remove Open Sea's background and styles.
- **Quit the controller:** choose **Quit Open Sea** from the menu bar / tray. It attempts bounded skin cleanup and disconnects, but does not quit Codex.
- **Fully end the managed launch:** restore the skin → quit the Codex instance launched by Open Sea → reopen Codex normally. Quitting that instance closes its debugging port.

A lost connection or timeout can leave cleanup incomplete. If Restore is temporarily unavailable, let the current operation finish. If disconnected, save your work, quit the managed instance and reopen normally. Do not terminate unrelated processes.

## 💬 Report a problem

Check the release's platform, architecture and validation notes first. Recorded macOS native evidence covers Codex `26.1021.31345`; official app updates may need skin adjustments. See the [validation record](VALIDATION.md) for the complete scope.

In [Issues](https://github.com/d-dev0101/open-sea-for-codex/issues), include **OS and processor architecture, Codex version, Open Sea version, reproduction steps and the error text**. Remove account details, conversation titles and text, personal paths, debugging URLs and credentials from attachments.

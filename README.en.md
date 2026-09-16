# dsh-android-pane

![banner](assets/banner.svg)

A **live Android device pane** next to your DeepSeek Harness (DSH) conversation: emulators and USB real phones alike. The agent drives the device and verifies its own changes with screenshots plus a structured UI tree — and you can jump in and co-operate at any time.

[中文](README.md) · [Releases](https://github.com/hoyyang/dsh-android-pane/releases) · [Changelog](CHANGELOG.md)

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg"></a>
  <img alt="Release" src="https://img.shields.io/github/v/release/hoyyang/dsh-android-pane">
  <img alt="Platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-blue">
</p>

## Install

```sh
dsh plugin add github:hoyyang/dsh-android-pane
```

Zero configuration: no API keys, no DSH config edits. Requires `adb` on PATH (Android SDK), a device with USB debugging (or any emulator); macOS/Linux and the DSH web profile.

## Why it's useful

- **Live stream**: scrcpy-server H.264 straight into the DSH web UI, decoded via WebCodecs (30–60 fps on loopback); automatic fallback to screenshot polling when scrcpy can't run (old devices, hardened security builds).
- **The agent verifies itself**: 10 context-economical tools — tap/swipe/text/key/scroll/rotate (auto-screenshot after every action), uiautomator element tree with tap coordinates, mp4 recording, host-managed debug sessions (recording + logcat + action timeline).
- **FLAG_SECURE self-recovery**: banking/password apps are detected automatically; a banner plus a mitigation chain (`adb root` → root-framework guidance → final SECURE-flag re-check), degrading to a tappable text view of the element tree when pixels stay system-blocked — every step reported, never silent.
- **Human + agent on one screen**: tap = tap, drag = swipe in the pane; a red badge shows when the agent is driving (panel gestures are temporarily rejected).
- **Session isolation**: one device belongs to one session at a time; idle sessions release devices after 10 minutes (emulators shut down, phones detach).
- **Local-only**: all streams accept 127.0.0.1 peers only (everything else gets 403); panel mutations are same-origin checked.

## 30-second start

1. Connect a phone with USB debugging (or start any emulator);
2. Tell the agent "connect my Android device";
3. The live device pane appears in the DSH web UI;
4. Say "tap the Settings icon" — watch it act, screenshot returned each step;
5. Tap and drag the pane yourself anytime — human and agent share the screen.

## Advanced

- **Chinese input**: `android_pane_install_ime` (one-time ADBKeyboard IME setup; Chinese text goes through clipboard paste).
- **Element-level ops**: `android_pane_ui` find/click/setText — fuzzy text matching instead of blind coordinates.
- **Secure-page detection switch**: config `flagSecureCheck` (default true).
- **MIUI/HyperOS**: input injection requires "USB debugging (Security settings)"; otherwise the pane degrades to view-only.

## How it works

On attach, scrcpy-server is pushed to the device and runs H.264 encoding via app_process; the stream reaches the local loopback through adb port forwarding and is rendered in the browser with WebCodecs. Injection commands go over adb; the element tree comes from uiautomator dump. Debug mode is host-managed: segmented mp4 recording + full logcat + a structured action timeline for per-action replay.

## Reliability

Delivered through the dsh-plugin-build pipeline: isolated staging verification, uninstall/reinstall idempotence, cold-boot triple-fault static checks, and a ten-gate review; tested on emulators and multiple real phones (H.264 streaming, injection, Chinese input, FLAG_SECURE degradation chain, multi-device concurrency).

## FAQ

- **Black screen?** Usually a FLAG_SECURE page (banking/password managers) — the pane shows a banner with a mitigation chain; on normal pages, check `adb devices` first.
- **Taps do nothing?** MIUI/HyperOS needs "USB debugging (Security settings)".
- **Low fps?** Concurrent devices share the bandwidth; detach the ones you don't need.

## Build from source

```sh
git clone https://github.com/hoyyang/dsh-android-pane && cd dsh-android-pane
npm install && npm run build && npm run build:client
```

## Uninstall

```sh
dsh plugin remove dsh-android-pane
```

Removal stops all streams and reclaims adb child processes; state lives under `<DSH_HOME>/dsh-android-pane/` (screenshots, state.json) and can be deleted freely.

## Privacy

Screenshots the agent takes of the device are sent to the configured model. Don't sign in to real accounts on a device under agent control.

## License

MIT — see [LICENSE](./LICENSE). Bundled `scrcpy-server` (Apache-2.0) and `ADBKeyboard.apk` (Apache-2.0) are covered in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

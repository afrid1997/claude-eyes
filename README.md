# Claude Eyes 👁️

**Give Claude a physical eye — not just a screen eye.**

claude-eyes is a tiny MCP server that gives Claude four senses on a Mac: the screen, the webcam, **your phone as a roaming camera**, and hands to act on what it sees. Point your phone at a breadboard, a printer error, a whiteboard, or the device you're debugging — Claude sees it, acts on the Mac, then looks again. Autonomous feedback loops that reach into the real world.

## What it does

| Tool | What Claude can do |
|------|-------------------|
| `take_screenshot` | See the Mac screen — any app, any window. Returns the pixel→point mapping so Claude can click what it sees. |
| `capture_webcam` | See what's in front of your Mac |
| `get_phone_frame` | See what your **phone camera** is pointed at — no app install, just a web page |
| `phone_screenshot` | See a **phone's screen**: Android via adb, iOS Simulator, or a physical iPhone over USB (iOS 17+ supported, no root) — made for app testing feedback loops |
| `phone_control` | Act on the phone: tap, swipe, type, launch/kill apps, open deep links — full input on Android and (with one-time WebDriverAgent setup) on physical iPhones |
| `get_camera_frame` | See through **any network camera** — security cams, IP cams, NVR channels — via RTSP, HTTP snapshot, or MJPEG |
| `mac_control` | Act on the Mac: click buttons or coordinates, type, send keystrokes, drive menus, run AppleScript or shell |

The phone camera is the part you won't find elsewhere: open one URL in your phone's browser (iPhone or Android — nothing to install), allow camera, and Claude has a camera it can ask you to point at anything.

## How is this different from X?

Fair question — parts of this exist elsewhere, and some of those tools are excellent:

- **[Peekaboo](https://github.com/steipete/Peekaboo)** is a more powerful *screen* automation tool (accessibility-tree clicking, agent runtime). If you only want desktop GUI automation, use it.
- **[mcp-webcam](https://github.com/evalstate/mcp-webcam)** covers the webcam piece.
- **Phone-camera MCPs** (Phone MCP, ScreenMCP) exist, but they're installed Android apps that run the server *on the phone*.

What claude-eyes does differently: **all four senses in one ~500-line server**, and the phone is a zero-install roaming eye — a web page that streams frames to the Mac, so it works on iPhone too. They see the screen; this sees the room.

## Setup

### 1. Install and build

```bash
git clone https://github.com/afrid1997/claude-eyes && cd claude-eyes
npm install
npm run build
```

### 2. Install imagesnap (for webcam)

```bash
brew install imagesnap
```

> If you already have `ffmpeg`, webcam capture uses that instead.

### 3. Register with Claude Code

```bash
claude mcp add claude-eyes node /absolute/path/to/claude-eyes/dist/index.js
```

Restart Claude Code after saving.

### 4. Grant permissions (first use will prompt)

- **Screen Recording** — for `take_screenshot`
- **Accessibility** — for `mac_control`

Both in System Settings → Privacy & Security, granted to whatever runs Claude Code (Terminal, iTerm, VS Code…).

### 5. Phone camera (optional)

The server runs a local web server on port **3456**.

1. Phone and Mac on the same Wi-Fi
2. Open `http://<your-mac-ip>:3456` on the phone (the exact URL is printed on startup)
3. Allow camera, point it at anything
4. Ask Claude: *"What do you see through my phone camera?"*

The page auto-sends a frame every 10 seconds, or tap **Send Frame to Claude**.

### Phone screen capture (optional)

For `phone_screenshot`:

- **Android**: `brew install android-platform-tools`, enable USB debugging on the phone
- **iOS Simulator**: nothing — works with any booted simulator
- **Physical iPhone**: `brew install libimobiledevice` (iOS 16 and older), or for iOS 17+:
  ```bash
  python3 -m venv ~/.claude-eyes/pmd3 && ~/.claude-eyes/pmd3/bin/pip install pymobiledevice3
  ```
  Plug in via USB, tap Trust, enable Developer Mode (Settings → Privacy & Security). The phone screen must be awake — a locked phone captures black.

### Phone control (optional)

`phone_control` works out of the box on **Android** (tap/swipe/type/keys/app control via adb) and for **app lifecycle on iOS** (launch/kill apps through the USB tunnel — no extra setup beyond pymobiledevice3 above).

For **touch input on a physical iPhone** (tap/swipe/type), run the one-time setup:

```bash
bash scripts/setup-ios-control.sh
```

This installs [WebDriverAgent](https://github.com/appium/WebDriverAgent) — the same Appium-maintained runner app used by virtually every iOS testing stack — onto your phone, **signed with your own Apple ID** (a free account works; find your Team ID in Xcode → Settings → Accounts). Nothing is sideloaded from third parties: the script clones the source and Xcode builds it locally. It then keeps the agent reachable on `localhost:8100` (override with `CLAUDE_EYES_WDA_URL`).

Tap coordinates: just use pixel coordinates from `phone_screenshot` — iOS taps are auto-scaled from pixels to points.

### Network / security cameras (optional)

For `get_camera_frame`, list your cameras in `~/.claude-eyes/cameras.json`:

```json
{
  "front-door": "rtsp://user:password@192.168.1.50:554/stream1",
  "garage": "http://192.168.1.51/snapshot.jpg"
}
```

```bash
chmod 600 ~/.claude-eyes/cameras.json   # the URLs contain credentials
```

Works with anything ffmpeg can open: **RTSP** (virtually every IP camera and NVR — Hikvision, Dahua, CP Plus, Reolink, Amcrest, Tapo, Ubiquiti…), HTTP snapshot endpoints, and MJPEG streams. RTSP is often disabled by default on consumer cameras — enable it once in the camera's settings. Cloud-only cameras (Ring, Nest) are not supported; they don't expose local streams.

## Usage examples

```
"Check the front-door camera — has the delivery arrived?"
"Open my app on the phone, tap through the onboarding flow, and screenshot each step"
"Take a phone screenshot — does the new onboarding screen render right on the real device?"
"Use my phone camera to read the error on the printer's display"
"Look at the breadboard through my phone — is the LED on pin 13 lit?"
"Open OpenSCAD, render the model, screenshot it, and keep iterating until the shape looks right"
"Take a screenshot — why does my app's layout look broken?"
"Look through my webcam — am I in frame for this call?"
```

## mac_control actions

| Action | Notes |
|--------|-------|
| `click` | Click a named button in an app via accessibility — preferred when the button has a name |
| `click_at` | Click at screen-point coordinates. Take a screenshot first; its result includes the pixel→point formula. Uses a compiled CGEvent helper (auto-built via Xcode CLT, or `brew install cliclick`) |
| `type_text` / `keystroke` | Target a named `app`, or omit it to hit the frontmost app. Named keys supported: `return`, `escape`, `tab`, arrows, `f1`–`f12`, … |
| `menu_click` | Click a menu-bar item by name |
| `focus_app` / `open_app` | Bring an app forward / launch it |
| `run_applescript` / `shell` | Escape hatches, with `timeout_ms` for long-running work (default 30s, max 5min) |

## Reliability notes

- All actions run async — a long shell command or AppleScript can't stall the MCP connection.
- Multiple Claude Code sessions can run claude-eyes at once: the phone-camera port is only bound by the first instance, and the frame file is shared, so `get_phone_frame` works everywhere.
- Screenshots are downscaled to 1920px wide by default (pass `max_width: 0` for full Retina resolution).
- Errors come back as messages with the fix in them (missing permission → which setting to open; missing field → an example call).

## How it works

- **Screenshot**: macOS `screencapture`, downscaled with `sips`
- **Webcam**: `imagesnap` or `ffmpeg`
- **Phone camera**: an Express server receives JPEG frames POSTed by the phone's browser — no app, just `getUserMedia` and a form post
- **Clicks**: CGEvent via a tiny Swift helper compiled on first use (falls back to `cliclick`)
- **Everything else**: AppleScript through `osascript`

Images are passed to Claude as base64 MCP image content. Nothing leaves your machine.

## Requirements

- macOS (Apple Silicon or Intel)
- Node.js 18+
- `imagesnap` or `ffmpeg` for webcam
- Xcode Command Line Tools *or* `cliclick` for coordinate clicks

## License

MIT

import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const execFileAsync = promisify(execFile);

export type PhoneControlTarget = "auto" | "android" | "ios" | "ios-simulator";

export type PhoneControlAction =
  | { type: "tap"; x: number; y: number }
  | { type: "swipe"; x1: number; y1: number; x2: number; y2: number; duration_ms?: number }
  | { type: "type_text"; text: string }
  | { type: "key"; key: string }
  | { type: "launch_app"; app_id: string }
  | { type: "terminate_app"; app_id: string }
  | { type: "open_url"; url: string };

const WDA_URL = process.env.CLAUDE_EYES_WDA_URL || "http://127.0.0.1:8100";

const WDA_SETUP_HINT =
  "iPhone touch control needs WebDriverAgent running on the phone. One-time setup: bash <claude-eyes>/scripts/setup-ios-control.sh " +
  "(builds Appium's WebDriverAgent onto your phone with your Apple ID, then keeps it reachable on port 8100).";

// ---------------------------------------------------------------------------
// Android via adb
// ---------------------------------------------------------------------------

const ANDROID_KEYCODES: Record<string, number> = {
  home: 3,
  back: 4,
  enter: 66,
  delete: 67,
  backspace: 67,
  tab: 61,
  space: 62,
  power: 26,
  volume_up: 24,
  volume_down: 25,
  app_switch: 187,
  menu: 82,
  up: 19,
  down: 20,
  left: 21,
  right: 22,
};

async function adbSerial(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("adb", ["devices"], { timeout: 10_000 });
    const line = stdout.split("\n").slice(1).find((l) => l.trim().endsWith("device"));
    return line ? line.split("\t")[0].trim() : null;
  } catch {
    return null;
  }
}

async function adbShell(serial: string, args: string[], timeout = 20_000): Promise<string> {
  const { stdout } = await execFileAsync("adb", ["-s", serial, "shell", ...args], {
    timeout,
    maxBuffer: 5 * 1024 * 1024,
  });
  return stdout.trim();
}

async function androidControl(serial: string, action: PhoneControlAction): Promise<string> {
  switch (action.type) {
    case "tap":
      await adbShell(serial, ["input", "tap", String(action.x), String(action.y)]);
      return `Tapped (${action.x}, ${action.y}) on Android`;
    case "swipe": {
      const ms = String(action.duration_ms ?? 300);
      await adbShell(serial, ["input", "swipe", String(action.x1), String(action.y1), String(action.x2), String(action.y2), ms]);
      return `Swiped (${action.x1},${action.y1}) → (${action.x2},${action.y2}) on Android`;
    }
    case "type_text": {
      // `input text` treats spaces as separators; %s is its space escape.
      const escaped = action.text.replace(/ /g, "%s");
      await adbShell(serial, ["input", "text", escaped]);
      return `Typed text on Android`;
    }
    case "key": {
      const code = ANDROID_KEYCODES[action.key.toLowerCase()];
      if (code === undefined) {
        throw new Error(`Unknown Android key "${action.key}". Supported: ${Object.keys(ANDROID_KEYCODES).join(", ")}`);
      }
      await adbShell(serial, ["input", "keyevent", String(code)]);
      return `Pressed ${action.key} on Android`;
    }
    case "launch_app":
      await adbShell(serial, ["monkey", "-p", action.app_id, "-c", "android.intent.category.LAUNCHER", "1"]);
      return `Launched ${action.app_id} on Android`;
    case "terminate_app":
      await adbShell(serial, ["am", "force-stop", action.app_id]);
      return `Terminated ${action.app_id} on Android`;
    case "open_url":
      await adbShell(serial, ["am", "start", "-a", "android.intent.action.VIEW", "-d", action.url]);
      return `Opened ${action.url} on Android`;
  }
}

// ---------------------------------------------------------------------------
// iOS Simulator via simctl (app lifecycle; touches go through WDA if present)
// ---------------------------------------------------------------------------

async function bootedSimulatorUdid(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("xcrun", ["simctl", "list", "devices", "booted"], { timeout: 10_000 });
    const match = stdout.match(/\(([0-9A-F-]{36})\) \(Booted\)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

async function simulatorControl(udid: string, action: PhoneControlAction): Promise<string> {
  switch (action.type) {
    case "launch_app":
      await execFileAsync("xcrun", ["simctl", "launch", udid, action.app_id], { timeout: 30_000 });
      return `Launched ${action.app_id} in the Simulator`;
    case "terminate_app":
      await execFileAsync("xcrun", ["simctl", "terminate", udid, action.app_id], { timeout: 30_000 });
      return `Terminated ${action.app_id} in the Simulator`;
    case "open_url":
      await execFileAsync("xcrun", ["simctl", "openurl", udid, action.url], { timeout: 30_000 });
      return `Opened ${action.url} in the Simulator`;
    default:
      if (await wdaReachable()) return wdaControl(action, "iOS Simulator (WebDriverAgent)");
      throw new Error(
        `Simulator ${action.type} needs either WebDriverAgent (run scripts/setup-ios-control.sh) ` +
          `or use mac_control click_at on the Simulator window (take_screenshot to find it).`
      );
  }
}

// ---------------------------------------------------------------------------
// Physical iPhone: WebDriverAgent for input, pymobiledevice3 for app lifecycle
// ---------------------------------------------------------------------------

async function wdaFetch(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetch(`${WDA_URL}${path}`, {
    ...init,
    signal: AbortSignal.timeout(30_000),
    headers: { "Content-Type": "application/json" },
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(`WebDriverAgent ${path} failed: ${JSON.stringify(body.value ?? body).slice(0, 300)}`);
  }
  return body;
}

async function wdaReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${WDA_URL}/status`, { signal: AbortSignal.timeout(3_000) });
    return res.ok;
  } catch {
    return false;
  }
}

let wdaSessionId: string | null = null;
let wdaWindowSize: { width: number; height: number } | null = null;

async function wdaSession(): Promise<string> {
  if (wdaSessionId) {
    try {
      await wdaFetch(`/session/${wdaSessionId}/window/size`);
      return wdaSessionId;
    } catch {
      wdaSessionId = null; // stale — recreate
    }
  }
  const status = await wdaFetch("/status");
  const existing = (status as { sessionId?: string }).sessionId;
  if (existing) {
    wdaSessionId = existing;
    return existing;
  }
  const created = await wdaFetch("/session", {
    method: "POST",
    body: JSON.stringify({ capabilities: {} }),
  });
  wdaSessionId = (created as { sessionId?: string }).sessionId ?? null;
  if (!wdaSessionId) throw new Error("Could not create a WebDriverAgent session.");
  return wdaSessionId;
}

// WDA coordinates are in points; screenshots are in pixels. If a coordinate
// lands outside the point-sized window, assume it's pixels and scale it down.
async function toPoints(sid: string, x: number, y: number): Promise<{ x: number; y: number }> {
  if (!wdaWindowSize) {
    const res = await wdaFetch(`/session/${sid}/window/size`);
    wdaWindowSize = res.value as { width: number; height: number };
  }
  const { width, height } = wdaWindowSize;
  if (x <= width && y <= height) return { x, y };
  const scale = Math.max(Math.round(Math.max(x / width, y / height)), 1);
  return { x: Math.round(x / scale), y: Math.round(y / scale) };
}

async function wdaPointerActions(
  sid: string,
  moves: { x: number; y: number; pauseMs?: number }[]
): Promise<void> {
  const seq: Record<string, unknown>[] = [
    { type: "pointerMove", duration: 0, x: moves[0].x, y: moves[0].y },
    { type: "pointerDown", button: 0 },
  ];
  for (let i = 0; i < moves.length; i++) {
    if (i > 0) seq.push({ type: "pointerMove", duration: moves[i].pauseMs ?? 300, x: moves[i].x, y: moves[i].y });
    if (moves[i].pauseMs && i === 0) seq.push({ type: "pause", duration: moves[i].pauseMs });
  }
  seq.push({ type: "pointerUp", button: 0 });
  await wdaFetch(`/session/${sid}/actions`, {
    method: "POST",
    body: JSON.stringify({
      actions: [{ type: "pointer", id: "finger1", parameters: { pointerType: "touch" }, actions: seq }],
    }),
  });
}

async function wdaControl(action: PhoneControlAction, deviceLabel: string): Promise<string> {
  const sid = await wdaSession();
  switch (action.type) {
    case "tap": {
      const p = await toPoints(sid, action.x, action.y);
      await wdaPointerActions(sid, [{ ...p, pauseMs: 80 }]);
      return `Tapped (${p.x}, ${p.y}) on ${deviceLabel}`;
    }
    case "swipe": {
      const from = await toPoints(sid, action.x1, action.y1);
      const to = await toPoints(sid, action.x2, action.y2);
      await wdaPointerActions(sid, [from, { ...to, pauseMs: action.duration_ms ?? 300 }]);
      return `Swiped (${from.x},${from.y}) → (${to.x},${to.y}) on ${deviceLabel}`;
    }
    case "type_text":
      await wdaFetch(`/session/${sid}/wda/keys`, {
        method: "POST",
        body: JSON.stringify({ value: [action.text] }),
      });
      return `Typed text on ${deviceLabel}`;
    case "key": {
      if (action.key.toLowerCase() === "home") {
        await wdaFetch("/wda/homescreen", { method: "POST", body: "{}" });
        return `Pressed home on ${deviceLabel}`;
      }
      if (action.key.toLowerCase() === "enter" || action.key.toLowerCase() === "return") {
        await wdaFetch(`/session/${sid}/wda/keys`, { method: "POST", body: JSON.stringify({ value: ["\n"] }) });
        return `Pressed enter on ${deviceLabel}`;
      }
      throw new Error(`iOS key "${action.key}" not supported. Supported: home, enter.`);
    }
    case "open_url":
      await wdaFetch(`/session/${sid}/url`, { method: "POST", body: JSON.stringify({ url: action.url }) });
      return `Opened ${action.url} on ${deviceLabel}`;
    case "launch_app":
      await wdaFetch(`/session/${sid}/wda/apps/launch`, {
        method: "POST",
        body: JSON.stringify({ bundleId: action.app_id }),
      });
      return `Launched ${action.app_id} on ${deviceLabel}`;
    case "terminate_app":
      await wdaFetch(`/session/${sid}/wda/apps/terminate`, {
        method: "POST",
        body: JSON.stringify({ bundleId: action.app_id }),
      });
      return `Terminated ${action.app_id} on ${deviceLabel}`;
  }
}

async function iosDeviceConnected(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("idevice_id", ["-l"], { timeout: 10_000 });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

function pmd3Path(): string | null {
  const venvPath = join(homedir(), ".claude-eyes", "pmd3", "bin", "pymobiledevice3");
  return existsSync(venvPath) ? venvPath : null;
}

async function iosDeviceControl(action: PhoneControlAction): Promise<string> {
  // Touchless actions work through the pymobiledevice3 tunnel — no WDA needed.
  const pmd3 = pmd3Path();
  if (pmd3 && (action.type === "launch_app" || action.type === "terminate_app")) {
    try {
      if (action.type === "launch_app") {
        await execFileAsync(pmd3, ["developer", "dvt", "launch", action.app_id, "--userspace"], { timeout: 120_000 });
        return `Launched ${action.app_id} on iPhone`;
      }
      await execFileAsync(pmd3, ["developer", "dvt", "pkill", action.app_id, "--userspace"], { timeout: 120_000 });
      return `Terminated ${action.app_id} on iPhone`;
    } catch {
      // fall through to WDA
    }
  }

  if (!(await wdaReachable())) {
    throw new Error(WDA_SETUP_HINT);
  }
  return wdaControl(action, "iPhone (WebDriverAgent)");
}

// ---------------------------------------------------------------------------

export async function phoneControl(
  action: PhoneControlAction,
  target: PhoneControlTarget = "auto"
): Promise<string> {
  if (target === "android" || target === "auto") {
    const serial = await adbSerial();
    if (serial) return androidControl(serial, action);
    if (target === "android") {
      throw new Error("No Android device connected. Plug in via USB with USB debugging enabled.");
    }
  }

  if (target === "ios-simulator" || target === "auto") {
    const udid = await bootedSimulatorUdid();
    if (udid) return simulatorControl(udid, action);
    if (target === "ios-simulator") {
      throw new Error("No booted iOS Simulator found.");
    }
  }

  if (target === "ios" || target === "auto") {
    if (await iosDeviceConnected()) return iosDeviceControl(action);
    if (target === "ios") {
      throw new Error("No iPhone detected over USB. Plug it in, unlock it, and tap Trust if prompted.");
    }
  }

  throw new Error(
    "No phone found to control. Checked: Android via adb, booted iOS Simulator, iPhone via USB."
  );
}

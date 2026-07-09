import { exec, execFile } from "child_process";
import { promisify } from "util";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export type MacControlAction =
  | { type: "run_applescript"; script: string; timeout_ms?: number }
  | { type: "click"; app: string; target: string }
  | { type: "click_at"; x: number; y: number; double?: boolean }
  | { type: "type_text"; app?: string; text: string }
  | { type: "keystroke"; app?: string; key: string; modifiers?: string[] }
  | { type: "focus_app"; app: string }
  | { type: "menu_click"; app: string; menu: string; item: string }
  | { type: "open_app"; app: string }
  | { type: "shell"; command: string; timeout_ms?: number };

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;

// AppleScript `keystroke` types characters literally, so named keys like
// "return" must be sent as `key code` instead.
const KEY_CODES: Record<string, number> = {
  return: 36,
  enter: 76,
  tab: 48,
  space: 49,
  delete: 51,
  backspace: 51,
  "forward-delete": 117,
  escape: 53,
  esc: 53,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
  home: 115,
  end: 119,
  pageup: 116,
  pagedown: 121,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97,
  f7: 98,
  f8: 100,
  f9: 101,
  f10: 109,
  f11: 103,
  f12: 111,
};

function clampTimeout(ms: number | undefined): number {
  if (!ms || ms <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(ms, MAX_TIMEOUT_MS);
}

async function runAppleScript(script: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
  try {
    const { stdout } = await execFileAsync("osascript", ["-e", script], {
      encoding: "utf8",
      timeout: timeoutMs,
    });
    return stdout.trim();
  } catch (err: unknown) {
    const error = err as { stderr?: string; message?: string; killed?: boolean };
    if (error.killed) {
      throw new Error(
        `AppleScript timed out after ${timeoutMs}ms. For long-running scripts pass timeout_ms (max ${MAX_TIMEOUT_MS}).`
      );
    }
    const detail = (error.stderr || error.message || String(err)).trim();
    if (detail.includes("not allowed assistive access") || detail.includes("-25211")) {
      throw new Error(
        "macOS Accessibility permission missing. Grant it in System Settings > Privacy & Security > Accessibility to the app running Claude Code (e.g. Terminal), then retry."
      );
    }
    throw new Error(detail);
  }
}

function need(action: Record<string, unknown>, field: string, example: string): void {
  const value = action[field];
  if (value === undefined || value === null || value === "") {
    throw new Error(
      `mac_control "${action.type}" requires "${field}". Example: ${example}`
    );
  }
}

function escapeAppleScriptString(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// `activate` first when an app is named; otherwise act on the frontmost app.
function activatePrefix(app: string | undefined): string {
  if (!app) return "";
  return `tell application "${escapeAppleScriptString(app)}" to activate\ndelay 0.3\n`;
}

// ---------------------------------------------------------------------------
// click_at: synthetic mouse click at screen-point coordinates via CGEvent.
// Prefers a compiled helper (fast), falls back to cliclick, then to
// interpreting the Swift source directly.
// ---------------------------------------------------------------------------

const CLICK_SWIFT_SOURCE = `import CoreGraphics
import Foundation

let x = Double(CommandLine.arguments[1])!
let y = Double(CommandLine.arguments[2])!
let clicks = CommandLine.arguments.count > 3 ? Int(CommandLine.arguments[3])! : 1
let pt = CGPoint(x: x, y: y)

CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: pt, mouseButton: .left)?.post(tap: .cghidEventTap)
usleep(120_000)
for i in 1...max(clicks, 1) {
    let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: pt, mouseButton: .left)
    down?.setIntegerValueField(.mouseEventClickState, value: Int64(i))
    down?.post(tap: .cghidEventTap)
    usleep(60_000)
    let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: pt, mouseButton: .left)
    up?.setIntegerValueField(.mouseEventClickState, value: Int64(i))
    up?.post(tap: .cghidEventTap)
    usleep(60_000)
}
`;

const HELPER_DIR = join(tmpdir(), "claude-eyes-bin");
const CLICK_BINARY = join(HELPER_DIR, "click");
const CLICK_SOURCE_PATH = join(HELPER_DIR, "click.swift");

async function commandExists(cmd: string): Promise<boolean> {
  try {
    await execFileAsync("which", [cmd], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

function ensureClickSource(): void {
  if (!existsSync(HELPER_DIR)) mkdirSync(HELPER_DIR, { recursive: true });
  if (!existsSync(CLICK_SOURCE_PATH)) writeFileSync(CLICK_SOURCE_PATH, CLICK_SWIFT_SOURCE);
}

async function performClickAt(x: number, y: number, double: boolean): Promise<string> {
  const clicks = double ? "2" : "1";

  if (existsSync(CLICK_BINARY)) {
    await execFileAsync(CLICK_BINARY, [String(x), String(y), clicks], { timeout: 10_000 });
    return `Clicked at (${x}, ${y})${double ? " (double)" : ""}`;
  }

  if (await commandExists("cliclick")) {
    const op = double ? `dc:${x},${y}` : `c:${x},${y}`;
    await execFileAsync("cliclick", [op], { timeout: 10_000 });
    return `Clicked at (${x}, ${y})${double ? " (double)" : ""} via cliclick`;
  }

  ensureClickSource();

  if (await commandExists("swiftc")) {
    try {
      await execFileAsync("swiftc", ["-O", CLICK_SOURCE_PATH, "-o", CLICK_BINARY], {
        timeout: 120_000,
      });
      await execFileAsync(CLICK_BINARY, [String(x), String(y), clicks], { timeout: 10_000 });
      return `Clicked at (${x}, ${y})${double ? " (double)" : ""}`;
    } catch {
      // fall through to the interpreter
    }
  }

  if (await commandExists("swift")) {
    await execFileAsync("swift", [CLICK_SOURCE_PATH, String(x), String(y), clicks], {
      timeout: 30_000,
    });
    return `Clicked at (${x}, ${y})${double ? " (double)" : ""} via swift`;
  }

  throw new Error(
    "click_at needs either cliclick (brew install cliclick) or the Xcode Command Line Tools (xcode-select --install)."
  );
}

// ---------------------------------------------------------------------------

export async function macControl(action: MacControlAction): Promise<string> {
  switch (action.type) {
    case "run_applescript": {
      need(action, "script", `{"type": "run_applescript", "script": "display dialog \\"hi\\""}`);
      return runAppleScript(action.script, clampTimeout(action.timeout_ms));
    }

    case "focus_app": {
      need(action, "app", `{"type": "focus_app", "app": "Safari"}`);
      await runAppleScript(`tell application "${escapeAppleScriptString(action.app)}" to activate`);
      return `Focused ${action.app}`;
    }

    case "open_app": {
      need(action, "app", `{"type": "open_app", "app": "Calculator"}`);
      await execFileAsync("open", ["-a", action.app], { timeout: 10_000 });
      return `Opened ${action.app}`;
    }

    case "click": {
      need(action, "app", `{"type": "click", "app": "OpenSCAD", "target": "Render"}`);
      need(action, "target", `{"type": "click", "app": "OpenSCAD", "target": "Render"}`);
      const app = escapeAppleScriptString(action.app);
      const script = `${activatePrefix(action.app)}tell application "System Events"
  tell process "${app}"
    click button "${escapeAppleScriptString(action.target)}" of front window
  end tell
end tell`;
      await runAppleScript(script);
      return `Clicked "${action.target}" in ${action.app}`;
    }

    case "click_at": {
      if (typeof action.x !== "number" || typeof action.y !== "number") {
        throw new Error(
          `mac_control "click_at" requires numeric "x" and "y" in screen points. ` +
            `Take a screenshot first — its result includes the pixel-to-point mapping.`
        );
      }
      return performClickAt(action.x, action.y, action.double === true);
    }

    case "type_text": {
      need(action, "text", `{"type": "type_text", "text": "hello"}`);
      const script = `${activatePrefix(action.app)}tell application "System Events"
  keystroke "${escapeAppleScriptString(action.text)}"
end tell`;
      await runAppleScript(script);
      return `Typed text into ${action.app ?? "the frontmost app"}`;
    }

    case "keystroke": {
      need(action, "key", `{"type": "keystroke", "key": "s", "modifiers": ["command"]}`);
      const mods = action.modifiers ?? [];
      const modString =
        mods.length > 0 ? ` using {${mods.map((m) => `${m} down`).join(", ")}}` : "";

      const keyLower = action.key.toLowerCase();
      let press: string;
      if (action.key.length === 1) {
        press = `keystroke "${escapeAppleScriptString(action.key)}"${modString}`;
      } else if (keyLower in KEY_CODES) {
        press = `key code ${KEY_CODES[keyLower]}${modString}`;
      } else {
        throw new Error(
          `Unknown key "${action.key}". Use a single character or one of: ${Object.keys(KEY_CODES).join(", ")}`
        );
      }

      const script = `${activatePrefix(action.app)}tell application "System Events"
  ${press}
end tell`;
      await runAppleScript(script);
      return `Sent ${action.key}${mods.length ? ` with ${mods.join("+")}` : ""} to ${action.app ?? "the frontmost app"}`;
    }

    case "menu_click": {
      need(action, "app", `{"type": "menu_click", "app": "OpenSCAD", "menu": "Design", "item": "Render"}`);
      need(action, "menu", `{"type": "menu_click", "app": "OpenSCAD", "menu": "Design", "item": "Render"}`);
      need(action, "item", `{"type": "menu_click", "app": "OpenSCAD", "menu": "Design", "item": "Render"}`);
      const app = escapeAppleScriptString(action.app);
      const script = `${activatePrefix(action.app)}tell application "System Events"
  tell process "${app}"
    click menu item "${escapeAppleScriptString(action.item)}" of menu "${escapeAppleScriptString(action.menu)}" of menu bar 1
  end tell
end tell`;
      await runAppleScript(script);
      return `Clicked menu ${action.menu} > ${action.item} in ${action.app}`;
    }

    case "shell": {
      need(action, "command", `{"type": "shell", "command": "ls ~"}`);
      const timeoutMs = clampTimeout(action.timeout_ms);
      try {
        const { stdout } = await execAsync(action.command, {
          encoding: "utf8",
          timeout: timeoutMs,
          maxBuffer: 10 * 1024 * 1024,
        });
        return stdout.trim() || "(no output)";
      } catch (err: unknown) {
        const error = err as { stderr?: string; message?: string; killed?: boolean };
        if (error.killed) {
          throw new Error(
            `Shell command timed out after ${timeoutMs}ms. Pass timeout_ms for long commands (max ${MAX_TIMEOUT_MS}).`
          );
        }
        throw new Error((error.stderr || error.message || String(err)).trim());
      }
    }

    default: {
      const t = (action as { type?: string }).type;
      throw new Error(
        `Unknown mac_control action "${t}". Valid types: run_applescript, click, click_at, type_text, keystroke, focus_app, menu_click, open_app, shell.`
      );
    }
  }
}

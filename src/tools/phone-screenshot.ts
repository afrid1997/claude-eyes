import { execFile } from "child_process";
import { promisify } from "util";
import { readFileSync, unlinkSync, existsSync } from "fs";
import { tmpdir, homedir } from "os";
import { join } from "path";

const execFileAsync = promisify(execFile);

export type PhoneScreenshotTarget = "auto" | "android" | "ios" | "ios-simulator";

export interface PhoneScreenshotResult {
  base64: string;
  mimeType: string;
  device: string;
}

async function has(cmd: string): Promise<boolean> {
  try {
    await execFileAsync("which", [cmd], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Android: adb exec-out screencap
// ---------------------------------------------------------------------------

async function androidDevices(): Promise<string[]> {
  if (!(await has("adb"))) return [];
  try {
    const { stdout } = await execFileAsync("adb", ["devices"], { timeout: 10_000 });
    return stdout
      .split("\n")
      .slice(1)
      .filter((l) => l.trim().endsWith("device"))
      .map((l) => l.split("\t")[0].trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function captureAndroid(serial: string): Promise<PhoneScreenshotResult> {
  const { stdout } = await execFileAsync(
    "adb",
    ["-s", serial, "exec-out", "screencap", "-p"],
    { timeout: 20_000, encoding: "buffer", maxBuffer: 50 * 1024 * 1024 }
  );
  return {
    base64: Buffer.from(stdout).toString("base64"),
    mimeType: "image/png",
    device: `Android device ${serial}`,
  };
}

// ---------------------------------------------------------------------------
// iOS Simulator: xcrun simctl io booted screenshot
// ---------------------------------------------------------------------------

async function bootedSimulator(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "xcrun",
      ["simctl", "list", "devices", "booted"],
      { timeout: 10_000 }
    );
    const match = stdout.match(/^\s+(.+?) \(([0-9A-F-]+)\) \(Booted\)/m);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

async function captureSimulator(): Promise<PhoneScreenshotResult> {
  const path = join(tmpdir(), `claude-eyes-sim-${Date.now()}.png`);
  try {
    await execFileAsync("xcrun", ["simctl", "io", "booted", "screenshot", path], {
      timeout: 20_000,
    });
    const name = (await bootedSimulator()) ?? "iOS Simulator";
    const data = readFileSync(path);
    return { base64: data.toString("base64"), mimeType: "image/png", device: name };
  } finally {
    try { unlinkSync(path); } catch { /* already gone */ }
  }
}

// ---------------------------------------------------------------------------
// Physical iPhone/iPad: idevicescreenshot (libimobiledevice)
// ---------------------------------------------------------------------------

async function iosDeviceConnected(): Promise<boolean> {
  if (!(await has("idevice_id"))) return false;
  try {
    const { stdout } = await execFileAsync("idevice_id", ["-l"], { timeout: 10_000 });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

const PMD3_INSTALL_HINT =
  "python3 -m venv ~/.claude-eyes/pmd3 && ~/.claude-eyes/pmd3/bin/pip install pymobiledevice3";

async function findPymobiledevice3(): Promise<string | null> {
  const venvPath = join(homedir(), ".claude-eyes", "pmd3", "bin", "pymobiledevice3");
  if (existsSync(venvPath)) return venvPath;
  if (await has("pymobiledevice3")) return "pymobiledevice3";
  return null;
}

async function captureIosDevice(): Promise<PhoneScreenshotResult> {
  const path = join(tmpdir(), `claude-eyes-ios-${Date.now()}.png`);
  try {
    // iOS <17: the classic screenshotr service via libimobiledevice.
    if (await has("idevicescreenshot")) {
      try {
        await execFileAsync("idevicescreenshot", [path], { timeout: 20_000 });
        if (existsSync(path)) {
          const data = readFileSync(path);
          return { base64: data.toString("base64"), mimeType: "image/png", device: "iPhone (USB)" };
        }
      } catch {
        // iOS 17+ removed screenshotr — fall through to pymobiledevice3.
      }
    }

    // iOS 17+: DVT screenshot over an in-process userspace tunnel (no root).
    const pmd3 = await findPymobiledevice3();
    if (!pmd3) {
      throw new Error(
        `iPhone found, but no working screenshot tool for this iOS version. Install pymobiledevice3:\n${PMD3_INSTALL_HINT}`
      );
    }
    try {
      await execFileAsync(pmd3, ["developer", "dvt", "screenshot", path, "--userspace"], {
        timeout: 120_000,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("DeveloperMode") || msg.includes("developer mode")) {
        throw new Error(
          "iPhone found, but Developer Mode is off. Enable it: Settings > Privacy & Security > Developer Mode, reboot the phone, then retry."
        );
      }
      if (msg.includes("PasswordRequired") || msg.includes("Trust")) {
        throw new Error("iPhone is locked or not trusted. Unlock it and tap Trust, then retry.");
      }
      throw new Error(`iPhone screenshot failed: ${msg}`);
    }
    if (!existsSync(path)) {
      throw new Error("iPhone screenshot produced no file.");
    }
    const data = readFileSync(path);
    return {
      base64: data.toString("base64"),
      mimeType: "image/png",
      device: "iPhone (USB, iOS 17+ tunnel)",
    };
  } finally {
    try { unlinkSync(path); } catch { /* already gone */ }
  }
}

// ---------------------------------------------------------------------------

export async function phoneScreenshot(
  target: PhoneScreenshotTarget = "auto"
): Promise<PhoneScreenshotResult> {
  if (target === "android" || target === "auto") {
    const devices = await androidDevices();
    if (devices.length > 0) return captureAndroid(devices[0]);
    if (target === "android") {
      throw new Error(
        (await has("adb"))
          ? "No Android device connected. Plug in via USB with USB debugging enabled (adb devices should list it)."
          : "adb not found. Install it: brew install android-platform-tools"
      );
    }
  }

  if (target === "ios-simulator" || target === "auto") {
    if (await bootedSimulator()) return captureSimulator();
    if (target === "ios-simulator") {
      throw new Error("No booted iOS Simulator found. Boot one first (e.g. npm run ios, or open Simulator.app).");
    }
  }

  if (target === "ios" || target === "auto") {
    if (await iosDeviceConnected()) return captureIosDevice();
    if (target === "ios") {
      throw new Error(
        (await has("idevicescreenshot"))
          ? "No iPhone detected over USB. Plug it in, unlock it, and tap Trust if prompted."
          : "idevicescreenshot not found. Install it: brew install libimobiledevice"
      );
    }
  }

  throw new Error(
    "No phone found. Checked: Android via adb, booted iOS Simulator, iPhone via USB. " +
      "Connect a device (USB debugging for Android, Trust + Developer Mode for iPhone) or boot a simulator, then retry."
  );
}

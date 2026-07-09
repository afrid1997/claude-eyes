import { execFile } from "child_process";
import { promisify } from "util";
import { readFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const execFileAsync = promisify(execFile);

export interface ScreenshotResult {
  base64: string;
  mimeType: string;
  width: number;
  height: number;
  screenPointsWidth: number;
  screenPointsHeight: number;
}

let cachedScreenPoints: { width: number; height: number } | null = null;

// Screen size in points (what CGEvent/click_at coordinates use). On Retina
// displays this is half the screenshot's pixel size.
async function getScreenPoints(): Promise<{ width: number; height: number }> {
  if (cachedScreenPoints) return cachedScreenPoints;
  try {
    const { stdout } = await execFileAsync(
      "osascript",
      ["-e", "tell application \"Finder\" to get bounds of window of desktop"],
      { timeout: 10_000 }
    );
    const parts = stdout.trim().split(",").map((p) => parseInt(p.trim(), 10));
    if (parts.length === 4 && parts.every((n) => !isNaN(n))) {
      cachedScreenPoints = { width: parts[2] - parts[0], height: parts[3] - parts[1] };
      return cachedScreenPoints;
    }
  } catch {
    // fall through
  }
  return { width: 0, height: 0 };
}

async function getImageSize(path: string): Promise<{ width: number; height: number }> {
  const { stdout } = await execFileAsync(
    "sips",
    ["-g", "pixelWidth", "-g", "pixelHeight", path],
    { timeout: 10_000 }
  );
  const width = parseInt(stdout.match(/pixelWidth: (\d+)/)?.[1] ?? "0", 10);
  const height = parseInt(stdout.match(/pixelHeight: (\d+)/)?.[1] ?? "0", 10);
  return { width, height };
}

export async function takeScreenshot(maxWidth = 1920): Promise<ScreenshotResult> {
  const path = join(tmpdir(), `claude-eyes-screenshot-${Date.now()}.png`);
  try {
    await execFileAsync("screencapture", ["-x", "-t", "png", path], { timeout: 15_000 });

    let { width, height } = await getImageSize(path);

    if (maxWidth > 0 && width > maxWidth) {
      await execFileAsync("sips", ["--resampleWidth", String(maxWidth), path], {
        timeout: 15_000,
      });
      ({ width, height } = await getImageSize(path));
    }

    const screen = await getScreenPoints();
    const data = readFileSync(path);
    return {
      base64: data.toString("base64"),
      mimeType: "image/png",
      width,
      height,
      screenPointsWidth: screen.width,
      screenPointsHeight: screen.height,
    };
  } finally {
    try {
      unlinkSync(path);
    } catch {
      // already gone
    }
  }
}

import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync, readFileSync, unlinkSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";

const execFileAsync = promisify(execFile);

const CONFIG_PATH = join(homedir(), ".claude-eyes", "cameras.json");

const SAMPLE_CONFIG = `{
  "front-door": "rtsp://user:password@192.168.1.50:554/stream1",
  "garage": "http://192.168.1.51/snapshot.jpg"
}`;

const SETUP_HINT =
  `No cameras configured. Create ${CONFIG_PATH} mapping camera names to stream URLs (RTSP, HTTP snapshot, or MJPEG):\n` +
  `${SAMPLE_CONFIG}\n` +
  `Most IP cameras and NVRs expose RTSP (check the camera's settings — it's often disabled by default). ` +
  `Then: chmod 600 ${CONFIG_PATH} since URLs contain credentials.`;

export interface CameraFrameResult {
  base64: string;
  mimeType: string;
  camera: string;
}

function loadCameras(): Record<string, string> {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(SETUP_HINT);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch (e) {
    throw new Error(`${CONFIG_PATH} is not valid JSON: ${e instanceof Error ? e.message : e}`);
  }
  const cameras = parsed as Record<string, string>;
  if (typeof cameras !== "object" || cameras === null || Object.keys(cameras).length === 0) {
    throw new Error(SETUP_HINT);
  }
  return cameras;
}

export async function getCameraFrame(name?: string): Promise<CameraFrameResult> {
  const cameras = loadCameras();
  const names = Object.keys(cameras);

  let selected = name;
  if (!selected) {
    if (names.length === 1) {
      selected = names[0];
    } else {
      throw new Error(`Multiple cameras configured — pass "camera". Available: ${names.join(", ")}`);
    }
  }

  const url = cameras[selected];
  if (!url) {
    throw new Error(`Unknown camera "${selected}". Available: ${names.join(", ")}`);
  }

  try {
    await execFileAsync("which", ["ffmpeg"], { timeout: 5_000 });
  } catch {
    throw new Error("ffmpeg is required for camera capture. Install it: brew install ffmpeg");
  }

  const path = join(tmpdir(), `claude-eyes-camera-${Date.now()}.jpg`);
  const args = ["-y", "-loglevel", "error"];
  if (url.startsWith("rtsp://")) {
    // TCP transport avoids UDP packet loss artifacts on most cameras.
    args.push("-rtsp_transport", "tcp");
  }
  args.push("-i", url, "-vframes", "1", "-q:v", "2", path);

  try {
    await execFileAsync("ffmpeg", args, { timeout: 25_000, maxBuffer: 5 * 1024 * 1024 });
    if (!existsSync(path)) {
      throw new Error("ffmpeg produced no frame");
    }
    const data = readFileSync(path);
    return { base64: data.toString("base64"), mimeType: "image/jpeg", camera: selected };
  } catch (err: unknown) {
    const error = err as { stderr?: string; message?: string; killed?: boolean };
    if (error.killed) {
      throw new Error(
        `Camera "${selected}" timed out after 25s. Check that the URL is reachable from this Mac ` +
          `and that RTSP is enabled on the camera.`
      );
    }
    const detail = (error.stderr || error.message || String(err)).trim().split("\n").slice(-3).join(" ");
    throw new Error(
      `Could not grab a frame from "${selected}": ${detail}. ` +
        `Common causes: wrong credentials in the URL, RTSP disabled on the camera, or wrong stream path.`
    );
  } finally {
    try { unlinkSync(path); } catch { /* already gone */ }
  }
}

export function listCameras(): string[] {
  return Object.keys(loadCameras());
}

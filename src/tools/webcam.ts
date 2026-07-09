import { execSync, execFileSync } from "child_process";
import { readFileSync, unlinkSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

function hasImagesnap(): boolean {
  try {
    execSync("which imagesnap", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function hasFfmpeg(): boolean {
  try {
    execSync("which ffmpeg", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export async function captureWebcam(): Promise<{ base64: string; mimeType: string }> {
  const path = join(tmpdir(), `claude-eyes-webcam-${Date.now()}.jpg`);

  if (hasImagesnap()) {
    execFileSync("imagesnap", ["-w", "1", path]);
  } else if (hasFfmpeg()) {
    execFileSync("ffmpeg", [
      "-f", "avfoundation",
      "-i", "0",
      "-vframes", "1",
      "-q:v", "2",
      path,
    ], { stdio: "ignore" });
  } else {
    throw new Error(
      "No webcam capture tool found. Install imagesnap: brew install imagesnap"
    );
  }

  if (!existsSync(path)) {
    throw new Error("Webcam capture failed — no output file produced.");
  }

  const data = readFileSync(path);
  unlinkSync(path);
  return { base64: data.toString("base64"), mimeType: "image/jpeg" };
}

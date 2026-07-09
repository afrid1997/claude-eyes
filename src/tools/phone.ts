import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

export const PHONE_FRAME_PATH = join(tmpdir(), "claude-eyes-phone-frame.jpg");

export async function getPhoneFrame(): Promise<{ base64: string; mimeType: string }> {
  if (!existsSync(PHONE_FRAME_PATH)) {
    throw new Error(
      "No phone frame received yet. Open the camera page on your phone: https://<your-mac-ip>:3456 (the exact URL is printed in the server log; accept the one-time certificate warning)"
    );
  }
  const data = readFileSync(PHONE_FRAME_PATH);
  return { base64: data.toString("base64"), mimeType: "image/jpeg" };
}

import express from "express";
import multer from "multer";
import { join, dirname } from "path";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { networkInterfaces, homedir, tmpdir } from "os";
import { execFileSync } from "child_process";
import { createServer as createHttpsServer } from "https";
import { createServer as createHttpServer } from "http";
import { PHONE_FRAME_PATH } from "../tools/phone.js";

export const PHONE_PORT = 3456;
const HTTP_REDIRECT_PORT = 3457;

const upload = multer({ dest: tmpdir() });

// getUserMedia only works in secure contexts, so the phone page must be
// served over HTTPS. A self-signed cert is fine: the phone shows one
// warning, the user accepts it once, and the cert persists across restarts.
function ensureTlsCert(): { key: Buffer; cert: Buffer } | null {
  const dir = join(homedir(), ".claude-eyes");
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");

  if (!existsSync(keyPath) || !existsSync(certPath)) {
    try {
      mkdirSync(dir, { recursive: true });
      execFileSync(
        "openssl",
        [
          "req", "-x509", "-newkey", "rsa:2048",
          "-keyout", keyPath, "-out", certPath,
          "-days", "3650", "-nodes",
          "-subj", "/CN=claude-eyes.local",
        ],
        { stdio: "ignore", timeout: 30_000 }
      );
    } catch {
      return null;
    }
  }

  try {
    return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
  } catch {
    return null;
  }
}

export function startPhoneServer(): void {
  const app = express();

  app.use(express.static(join(dirname(dirname(dirname(__filename))), "src", "phone-server", "public")));

  app.post("/frame", upload.single("frame"), (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: "No frame received" });
      return;
    }
    copyFileSync(req.file.path, PHONE_FRAME_PATH);
    res.json({ ok: true });
  });

  const ip = getLocalIP();
  const tls = ensureTlsCert();

  // A second claude-eyes instance (e.g. another Claude Code session) will hit
  // EADDRINUSE here. That must not kill the MCP server — the frame file in
  // tmpdir is shared, so get_phone_frame still works via the first instance.
  const onError = (label: string) => (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      process.stderr.write(
        `[claude-eyes] ${label}: port already in use — not started in this instance. ` +
        `Another claude-eyes is probably serving it; get_phone_frame will still work.\n`
      );
    } else {
      process.stderr.write(`[claude-eyes] ${label} error: ${err.message}\n`);
    }
  };

  if (tls) {
    const httpsServer = createHttpsServer(tls, app);
    httpsServer.on("error", onError("Phone camera server (https)"));
    httpsServer.listen(PHONE_PORT, "0.0.0.0", () => {
      process.stderr.write(
        `[claude-eyes] Phone camera server running.\n` +
        `Open on your phone: https://${ip}:${PHONE_PORT}\n` +
        `(Accept the one-time certificate warning — it's a local self-signed cert; nothing leaves your network.)\n`
      );
    });

    // Convenience: anyone who types the old http:// URL gets redirected.
    const redirect = createHttpServer((req, res) => {
      const host = (req.headers.host ?? ip).split(":")[0];
      res.statusCode = 302;
      res.setHeader("Location", `https://${host}:${PHONE_PORT}${req.url ?? "/"}`);
      res.end();
    });
    redirect.on("error", () => { /* best-effort helper — ignore */ });
    redirect.listen(HTTP_REDIRECT_PORT, "0.0.0.0");
  } else {
    // No openssl available: serve plain HTTP. Live camera preview won't work
    // (browsers require a secure context), but the page's "take photo"
    // fallback still does.
    const httpServer = createHttpServer(app);
    httpServer.on("error", onError("Phone camera server"));
    httpServer.listen(PHONE_PORT, "0.0.0.0", () => {
      process.stderr.write(
        `[claude-eyes] Phone camera server running (HTTP only — openssl not found).\n` +
        `Open on your phone: http://${ip}:${PHONE_PORT}\n` +
        `Live preview needs HTTPS; the page will offer a take-photo button instead.\n`
      );
    });
  }
}

function getLocalIP(): string {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === "IPv4" && !net.internal) {
        return net.address;
      }
    }
  }
  return "localhost";
}

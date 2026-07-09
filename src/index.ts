#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { takeScreenshot } from "./tools/screenshot.js";
import { captureWebcam } from "./tools/webcam.js";
import { getPhoneFrame } from "./tools/phone.js";
import { phoneScreenshot, PhoneScreenshotTarget } from "./tools/phone-screenshot.js";
import { phoneControl, PhoneControlAction, PhoneControlTarget } from "./tools/phone-control.js";
import { getCameraFrame } from "./tools/cameras.js";
import { macControl, MacControlAction } from "./tools/mac-control.js";
import { startPhoneServer } from "./phone-server/server.js";

// A stray async error (e.g. from the phone server or a child process) must
// never take down the stdio transport — that surfaces to the client as an
// opaque "Connection closed".
process.on("uncaughtException", (err) => {
  process.stderr.write(`[claude-eyes] Uncaught exception (recovered): ${err.stack ?? err}\n`);
});
process.on("unhandledRejection", (reason) => {
  process.stderr.write(`[claude-eyes] Unhandled rejection (recovered): ${reason}\n`);
});

startPhoneServer();

const server = new Server(
  { name: "claude-eyes", version: "1.3.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "take_screenshot",
      description:
        "Take a screenshot of the current Mac screen and return it as an image, plus a text block with the pixel-to-screen-point mapping (use it to compute click_at coordinates). Use this to see what is on screen, including any native app like OpenSCAD, Xcode, Figma, etc.",
      inputSchema: {
        type: "object",
        properties: {
          max_width: {
            type: "number",
            description:
              "Downscale the image to at most this many pixels wide (default 1920, keeps payloads small). Pass 0 for full Retina resolution.",
          },
        },
        required: [],
      },
    },
    {
      name: "capture_webcam",
      description:
        "Capture a single frame from the Mac webcam and return it as an image. Use this to see what is in front of the computer.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "get_phone_frame",
      description:
        "Get the latest frame captured from the phone camera. The user must have the phone camera page open at https://<mac-ip>:3456. Use this to see what the user is pointing their phone at.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "phone_screenshot",
      description:
        "Take a screenshot of a connected phone's SCREEN (not its camera) — an Android device via adb, a booted iOS Simulator, or an iPhone via USB. Use this to see the app being tested on the device, e.g. after a build installs or to verify a UI change on the real phone.",
      inputSchema: {
        type: "object",
        properties: {
          target: {
            type: "string",
            enum: ["auto", "android", "ios", "ios-simulator"],
            description:
              "Which device to capture. Default 'auto' tries: Android device, then booted iOS Simulator, then iPhone over USB.",
          },
        },
        required: [],
      },
    },
    {
      name: "get_camera_frame",
      description:
        "Grab a single frame from a network camera (security camera, IP camera, NVR channel) configured in ~/.claude-eyes/cameras.json. Supports RTSP, HTTP snapshot, and MJPEG URLs. Use this to see what a security or IP camera sees right now.",
      inputSchema: {
        type: "object",
        properties: {
          camera: {
            type: "string",
            description:
              "Camera name from cameras.json. Optional if only one camera is configured; errors list the available names.",
          },
        },
        required: [],
      },
    },
    {
      name: "phone_control",
      description:
        "Control a connected phone: tap, swipe, type, press keys, launch/terminate apps, open URLs. Android needs only adb; iOS Simulator supports app lifecycle via simctl (touches need WebDriverAgent); physical iPhone supports launch/terminate via USB tunnel, and touch input once WebDriverAgent is set up (scripts/setup-ios-control.sh). Combine with phone_screenshot for see-act-see loops. Coordinates: use pixel coordinates from phone_screenshot — iOS taps are auto-scaled from pixels to points.",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "object",
            description: "The action to perform on the phone",
            properties: {
              type: {
                type: "string",
                enum: ["tap", "swipe", "type_text", "key", "launch_app", "terminate_app", "open_url"],
                description:
                  "tap: tap at coordinates. swipe: drag between two points. type_text: type into the focused field. key: press a named key (Android: home, back, enter, delete, tab, volume_up/down, app_switch…; iOS: home, enter). launch_app/terminate_app: by package name (Android) or bundle id (iOS). open_url: open a URL or deep link.",
              },
              x: { type: "number", description: "X coordinate (for tap)" },
              y: { type: "number", description: "Y coordinate (for tap)" },
              x1: { type: "number", description: "Swipe start X" },
              y1: { type: "number", description: "Swipe start Y" },
              x2: { type: "number", description: "Swipe end X" },
              y2: { type: "number", description: "Swipe end Y" },
              duration_ms: { type: "number", description: "Swipe duration in ms (default 300)" },
              text: { type: "string", description: "Text to type (for type_text)" },
              key: { type: "string", description: "Key name (for key)" },
              app_id: { type: "string", description: "Android package name or iOS bundle id" },
              url: { type: "string", description: "URL or deep link (for open_url)" },
            },
            required: ["type"],
          },
          target: {
            type: "string",
            enum: ["auto", "android", "ios", "ios-simulator"],
            description: "Which device to control. Default 'auto': Android, then booted Simulator, then iPhone.",
          },
        },
        required: ["action"],
      },
    },
    {
      name: "mac_control",
      description:
        "Control any Mac application using AppleScript and shell commands. Can focus apps, click UI elements or coordinates, type text, send keystrokes, click menu items, open apps, and run shell commands. Combine with take_screenshot to create feedback loops: act, screenshot, observe, act again. Caution: keystrokes and clicks go to the real screen — if the user may be actively using the Mac, prefer app-targeted actions (pass \"app\") over blind coordinate clicks.",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "object",
            description: "The action to perform",
            properties: {
              type: {
                type: "string",
                enum: [
                  "run_applescript",
                  "click",
                  "click_at",
                  "type_text",
                  "keystroke",
                  "focus_app",
                  "menu_click",
                  "open_app",
                  "shell",
                ],
                description:
                  "run_applescript: run raw AppleScript. click: click a named button in an app (accessibility-based, preferred). click_at: click at screen-point coordinates (take_screenshot first to get the pixel-to-point mapping). type_text: type text (into `app` if given, else the frontmost app). keystroke: send a key with optional modifiers — single characters or named keys like return, escape, tab, arrows. focus_app: bring app to foreground. menu_click: click a menu bar item. open_app: open a Mac app by name. shell: run a shell command.",
              },
              script: { type: "string", description: "AppleScript to run (for run_applescript)" },
              app: {
                type: "string",
                description:
                  "App name, e.g. 'OpenSCAD', 'Xcode', 'Safari'. Required for click, focus_app, menu_click, open_app. Optional for type_text and keystroke — omit to target the frontmost app.",
              },
              target: { type: "string", description: "Button or element name (for click)" },
              x: { type: "number", description: "X in screen points (for click_at)" },
              y: { type: "number", description: "Y in screen points (for click_at)" },
              double: { type: "boolean", description: "Double-click instead of single (for click_at)" },
              text: { type: "string", description: "Text to type (for type_text)" },
              key: {
                type: "string",
                description:
                  "Key to press (for keystroke): a single character, or a named key — return, enter, tab, space, delete, escape, left, right, up, down, home, end, pageup, pagedown, f1-f12",
              },
              modifiers: {
                type: "array",
                items: { type: "string" },
                description: "Modifier keys: 'command', 'option', 'shift', 'control' (for keystroke)",
              },
              menu: { type: "string", description: "Menu bar name, e.g. 'Design', 'File', 'Edit' (for menu_click)" },
              item: { type: "string", description: "Menu item name, e.g. 'Render', 'Save', 'Undo' (for menu_click)" },
              command: { type: "string", description: "Shell command to run (for shell)" },
              timeout_ms: {
                type: "number",
                description:
                  "Timeout in ms for run_applescript and shell (default 30000, max 300000). Use for long-running scripts and commands.",
              },
            },
            required: ["type"],
          },
        },
        required: ["action"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "take_screenshot") {
      const maxWidth = (args as { max_width?: number })?.max_width;
      const result = await takeScreenshot(maxWidth ?? 1920);
      const mapping =
        result.screenPointsWidth > 0
          ? `Image is ${result.width}x${result.height} px; the screen is ${result.screenPointsWidth}x${result.screenPointsHeight} points. ` +
            `To click a pixel (px, py) in this image with click_at, use x = px * ${result.screenPointsWidth}/${result.width}, y = py * ${result.screenPointsHeight}/${result.height}.`
          : `Image is ${result.width}x${result.height} px.`;
      return {
        content: [
          { type: "image", data: result.base64, mimeType: result.mimeType },
          { type: "text", text: mapping },
        ],
      };
    }

    if (name === "capture_webcam") {
      const result = await captureWebcam();
      return {
        content: [{ type: "image", data: result.base64, mimeType: result.mimeType }],
      };
    }

    if (name === "get_phone_frame") {
      const result = await getPhoneFrame();
      return {
        content: [{ type: "image", data: result.base64, mimeType: result.mimeType }],
      };
    }

    if (name === "phone_screenshot") {
      const target = (args as { target?: PhoneScreenshotTarget })?.target ?? "auto";
      const result = await phoneScreenshot(target);
      return {
        content: [
          { type: "image", data: result.base64, mimeType: result.mimeType },
          { type: "text", text: `Captured from: ${result.device}` },
        ],
      };
    }

    if (name === "get_camera_frame") {
      const cam = (args as { camera?: string })?.camera;
      const result = await getCameraFrame(cam);
      return {
        content: [
          { type: "image", data: result.base64, mimeType: result.mimeType },
          { type: "text", text: `Camera: ${result.camera}` },
        ],
      };
    }

    if (name === "phone_control") {
      const a = args as { action: PhoneControlAction; target?: PhoneControlTarget };
      const result = await phoneControl(a.action, a.target ?? "auto");
      return {
        content: [{ type: "text", text: result }],
      };
    }

    if (name === "mac_control") {
      const action = (args as { action: MacControlAction }).action;
      const result = await macControl(action);
      return {
        content: [{ type: "text", text: result }],
      };
    }

    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: error instanceof Error ? error.message : String(error),
        },
      ],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[claude-eyes] MCP server running\n");
}

main().catch((e) => {
  process.stderr.write(`[claude-eyes] Fatal: ${e}\n`);
  process.exit(1);
});

#!/bin/bash
# One-time setup for iPhone touch control (WebDriverAgent).
#
# What this does:
#   1. Clones Appium's WebDriverAgent (the de-facto standard iOS automation app)
#   2. Builds + installs it onto your connected iPhone, signed with YOUR Apple ID
#   3. Starts it and forwards port 8100 so claude-eyes can reach it
#
# Requirements: Xcode, an Apple ID added to Xcode (free account works),
# iPhone connected via USB with Developer Mode enabled.
#
# Usage:
#   bash setup-ios-control.sh                # interactive
#   bash setup-ios-control.sh TEAM_ID        # non-interactive with your team id
set -euo pipefail

WDA_DIR="$HOME/.claude-eyes/WebDriverAgent"
TEAM_ID="${1:-}"

echo "==> claude-eyes iOS control setup"

if ! xcode-select -p >/dev/null 2>&1; then
  echo "ERROR: Xcode is required. Install it from the App Store, then run: xcode-select --install"
  exit 1
fi

UDID="$(idevice_id -l 2>/dev/null | head -1 || true)"
if [ -z "$UDID" ]; then
  echo "ERROR: No iPhone detected over USB. Plug it in, unlock it, tap Trust, and retry."
  exit 1
fi
echo "==> Found iPhone: $UDID"

if [ ! -d "$WDA_DIR" ]; then
  echo "==> Cloning WebDriverAgent to $WDA_DIR"
  git clone --depth 1 https://github.com/appium/WebDriverAgent "$WDA_DIR"
else
  echo "==> WebDriverAgent already cloned at $WDA_DIR"
fi

if [ -z "$TEAM_ID" ]; then
  echo ""
  echo "Your Apple Development Team ID is needed to sign the app."
  echo "Find it: Xcode > Settings > Accounts > (your Apple ID) > Team — the 10-character id."
  echo "A free personal Apple ID works (apps expire after 7 days; re-run this script to refresh)."
  read -r -p "Team ID: " TEAM_ID
fi

echo "==> Building and installing WebDriverAgent on the phone (first build takes a few minutes)..."
echo "    If the phone shows 'Untrusted Developer': Settings > General > VPN & Device Management > trust your cert, then re-run."

xcodebuild -project "$WDA_DIR/WebDriverAgent.xcodeproj" \
  -scheme WebDriverAgentRunner \
  -destination "id=$UDID" \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  CODE_SIGNING_ALLOWED=YES \
  build-for-testing

echo "==> Starting WebDriverAgent on the phone..."
nohup xcodebuild -project "$WDA_DIR/WebDriverAgent.xcodeproj" \
  -scheme WebDriverAgentRunner \
  -destination "id=$UDID" \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  test-without-building > "$HOME/.claude-eyes/wda.log" 2>&1 &

echo "==> Forwarding port 8100 (USB)..."
pkill -f "iproxy 8100" 2>/dev/null || true
nohup iproxy 8100 8100 > /dev/null 2>&1 &

echo "==> Waiting for WebDriverAgent to come up..."
for i in $(seq 1 60); do
  if curl -s -m 2 http://127.0.0.1:8100/status >/dev/null 2>&1; then
    echo ""
    echo "✅ WebDriverAgent is running. Claude can now tap, swipe, and type on your iPhone."
    echo "   It stays up until the phone reboots or the xcodebuild process is killed."
    echo "   To restart later, just re-run this script (it skips the build if unchanged)."
    exit 0
  fi
  sleep 2
done

echo "⚠️  WebDriverAgent didn't respond on port 8100 after 2 minutes."
echo "    Check the log: tail -50 ~/.claude-eyes/wda.log"
echo "    Common fixes: trust the developer cert on the phone; unlock the phone; re-run this script."
exit 1

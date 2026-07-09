#!/bin/bash
# One-time setup for iPhone touch control (WebDriverAgent).
#
# What this does:
#   1. Clones Appium's WebDriverAgent (the de-facto standard iOS automation app)
#   2. Builds + installs it onto your connected iPhone, signed with YOUR Apple ID
#   3. Starts it and forwards port 8100 so claude-eyes can reach it
#
# Requirements: Xcode, iPhone connected via USB with Developer Mode enabled,
# and either (a) an Apple ID signed into Xcode, or (b) an existing Apple
# Development certificate in your keychain (you have one if you've ever run
# any app of yours on this phone from this Mac).
#
# Usage:
#   bash setup-ios-control.sh                # auto-detects your Team ID
#   bash setup-ios-control.sh TEAM_ID        # explicit 10-character team id
set -uo pipefail

WDA_DIR="$HOME/.claude-eyes/WebDriverAgent"
LOG_DIR="$HOME/.claude-eyes"
TEAM_ID="${1:-}"

echo "==> claude-eyes iOS control setup"

if ! xcode-select -p >/dev/null 2>&1; then
  echo "ERROR: Xcode is required. Install it from the App Store, then run: xcode-select --install"
  exit 1
fi

UDID="$(idevice_id -l 2>/dev/null | head -1 || true)"
if [ -z "$UDID" ]; then
  echo "ERROR: No iPhone detected over USB. Plug it in, unlock it, tap Trust, and retry."
  echo "       (idevice_id comes from libimobiledevice: brew install libimobiledevice)"
  exit 1
fi
echo "==> Found iPhone: $UDID"

# --- Team ID auto-detection -------------------------------------------------
# The team id is the OU field of your Apple Development certificate — NOT the
# 10-character code shown in parentheses in the certificate name.
detect_teams() {
  security find-certificate -c "Apple Development" -p -a 2>/dev/null | python3 -c '
import re, subprocess, sys
pem = sys.stdin.read()
teams = []
for cert in re.findall(r"-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----", pem, re.S):
    p = subprocess.run(["openssl", "x509", "-noout", "-subject"], input=cert, capture_output=True, text=True)
    m = re.search(r"OU\s*=\s*([A-Z0-9]{10})", p.stdout)
    if m and m.group(1) not in teams:
        teams.append(m.group(1))
print("\n".join(teams))
'
}

if [ -z "$TEAM_ID" ]; then
  TEAMS="$(detect_teams)"
  COUNT=$(echo "$TEAMS" | grep -c . || true)
  if [ "$COUNT" -eq 1 ]; then
    TEAM_ID="$TEAMS"
    echo "==> Auto-detected Team ID from keychain: $TEAM_ID"
  elif [ "$COUNT" -gt 1 ]; then
    echo "Multiple development teams found in your keychain:"
    echo "$TEAMS" | sed 's/^/  - /'
    echo "Your personal team is usually the one Xcode shows as '(Individual)'."
    read -r -p "Team ID to use: " TEAM_ID
  else
    echo ""
    echo "No Apple Development certificate found in the keychain."
    echo "Sign into Xcode (Settings > Accounts) with any Apple ID — a free account works —"
    echo "then find your Team ID under that account and pass it to this script."
    read -r -p "Team ID: " TEAM_ID
  fi
fi

if [ ! -d "$WDA_DIR" ]; then
  echo "==> Cloning WebDriverAgent to $WDA_DIR"
  git clone --depth 1 https://github.com/appium/WebDriverAgent "$WDA_DIR"
else
  echo "==> WebDriverAgent already cloned at $WDA_DIR"
fi

# --- Build ------------------------------------------------------------------
# Two attempts:
#   1. Without -allowProvisioningUpdates — works offline using existing local
#      profiles/certs, and is the only mode that works when no Apple ID is
#      signed into Xcode.
#   2. With -allowProvisioningUpdates — lets Xcode create the profile, but
#      requires an Apple ID session ("No Accounts" error otherwise).
build_wda() {
  xcodebuild -project "$WDA_DIR/WebDriverAgent.xcodeproj" \
    -scheme WebDriverAgentRunner \
    -destination "id=$UDID" \
    CODE_SIGN_STYLE=Automatic \
    DEVELOPMENT_TEAM="$TEAM_ID" \
    "$@" \
    build-for-testing > "$LOG_DIR/wda-build.log" 2>&1
}

echo "==> Building WebDriverAgent (first build takes a few minutes)..."
if build_wda; then
  echo "==> Built using local signing assets."
elif build_wda -allowProvisioningUpdates; then
  echo "==> Built with Xcode-managed provisioning."
else
  echo "ERROR: Build failed. Last errors:"
  grep -iE "error:" "$LOG_DIR/wda-build.log" | head -5
  echo ""
  echo "Common fixes:"
  echo "  - Sign into Xcode: Settings > Accounts > add your Apple ID (free works)"
  echo "  - Wrong team id? Re-run with: bash $0 YOUR_TEAM_ID"
  echo "  - Full log: $LOG_DIR/wda-build.log"
  exit 1
fi

echo "==> Starting WebDriverAgent on the phone..."
echo "    If the phone shows 'Untrusted Developer': Settings > General > VPN & Device Management > trust, then re-run."
nohup xcodebuild -project "$WDA_DIR/WebDriverAgent.xcodeproj" \
  -scheme WebDriverAgentRunner \
  -destination "id=$UDID" \
  CODE_SIGN_STYLE=Automatic \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  test-without-building > "$LOG_DIR/wda.log" 2>&1 &

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
echo "    Check the log: tail -50 $LOG_DIR/wda.log"
echo "    Common fixes: trust the developer cert on the phone; unlock the phone; re-run this script."
exit 1

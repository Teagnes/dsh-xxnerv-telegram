#!/usr/bin/env bash
# Render the Telegram configuration page in headless Chrome and screenshot it.
#
# Boots a sandbox web instance that mirrors the desktop profile (base + web-app
# + this plugin + the desktop UI patch rows), drives the real client over the
# DevTools Protocol, and writes a PNG.
set -euo pipefail

HERE="$(cd -- "$(dirname -- "$0")" && pwd)"
PLUGIN_DIR="$(cd -- "$HERE/../.." && pwd)"
APP="${DSH_APP:-/Applications/DeepSeek Harness.app}"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
ELECTRON="$APP/Contents/MacOS/DeepSeek Harness"
CLI="$APP/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"
NODE="${DSH_NODE:-$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node}"
# The desktop profile whose UI rows the sandbox mirrors; override for a profile
# installed somewhere else (or for CI, where there is no desktop profile at all).
DESKTOP_PATCH="${DSH_DESKTOP_PATCH:-$HOME/.dsh/profiles/desktop/cordis.patch.yml}"
WORK="$PLUGIN_DIR/.scratch/ui-verify"
HOME_DIR="$WORK/home"
PROFILE_DIR="$HOME_DIR/profiles/tgui"
PORT="$("$NODE" -e 'const net=require("node:net");const s=net.createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
DEBUG_PORT="$("$NODE" -e 'const net=require("node:net");const s=net.createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
SHOTS="$WORK/shots"

for required in "$ELECTRON" "$NODE" "$CHROME" "$DESKTOP_PATCH"; do
  [ -e "$required" ] || { echo "missing: $required (set DSH_APP / DSH_NODE / CHROME / DSH_DESKTOP_PATCH)" >&2; exit 2; }
done

echo "== preparing profile (base + web-app + plugin, desktop UI patch rows)"
rm -rf "$HOME_DIR" "$WORK/chrome-profile" "$WORK/crash" "$SHOTS"
mkdir -p "$WORK/crash" "$SHOTS"
mkdir -p "$PROFILE_DIR/node_modules"
ln -sfn "$PLUGIN_DIR" "$PROFILE_DIR/node_modules/dsh-xxnerv-telegram"
cat > "$PROFILE_DIR/package.json" <<EOF
{
  "name": "dsh-profile-tgui",
  "private": true,
  "dependencies": { "dsh-xxnerv-telegram": "link:$PLUGIN_DIR" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-xxnerv-telegram"] } }
}
EOF
printf '[]\n' > "$PROFILE_DIR/cordis.yml"
printf 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n' > "$PROFILE_DIR/pnpm-workspace.yaml"
# The desktop profile's UI rows (onboarding finished, chat/settings configured)
# plus this plugin's own row, so the shell looks like the real desktop app.
python3 - "$HOME_DIR" "$PROFILE_DIR" "$DESKTOP_PATCH" <<'PY'
import pathlib, re, sys
home, profile = sys.argv[1], sys.argv[2]
source = pathlib.Path(sys.argv[3])
text = source.read_text()
# Drop this plugin's own row; the runner writes its own with a test token.
rows = text.split('\n- ')
kept = [rows[0]] + [row for row in rows[1:] if 'dsh-xxnerv-telegram' not in row]
patch = '\n- '.join(kept).rstrip() + '\n' + '''# dsh-xxnerv-telegram (sandbox verification row)
- id: xxnerv-telegram
  name: "dsh-xxnerv-telegram"
  config:
    botToken: "TEST-TOKEN"
    defaultChatId: "@your_channel"
    notifyChatId: "@your_channel"
    proxyUrl: "http://127.0.0.1:7897"
    notifyOnTurnEnd: false
'''
pathlib.Path(profile, 'cordis.patch.yml').write_text(patch)
print('patch rows:', [line.strip() for line in patch.splitlines() if line.startswith('- id:')])
PY

echo "== booting sandbox web instance on $PORT"
DSH_HOME="$HOME_DIR" PORT="$PORT" ELECTRON_RUN_AS_NODE=1 "$ELECTRON" "$CLI" --profile tgui --port "$PORT" --no-open > "$WORK/boot.log" 2>&1 &
BOOT_PID=$!
TOKEN=""
for _ in $(seq 1 60); do
  TOKEN="$(grep -o 'token=[A-Za-z0-9_-]*' "$WORK/boot.log" 2>/dev/null | head -1 | cut -d= -f2 || true)"
  [ -n "$TOKEN" ] && break
  sleep 0.5
done
[ -n "$TOKEN" ] || { echo "web instance did not start:" >&2; cat "$WORK/boot.log" >&2; kill "$BOOT_PID" 2>/dev/null || true; exit 2; }
echo "   token acquired, pid $BOOT_PID"

echo "== launching headless Chrome (debug port $DEBUG_PORT)"
# The workspace-only file sandbox denies Chrome's default crash database under
# ~/Library, so crash reporting is disabled and every writable path stays here.
"$CHROME" --headless=new --no-sandbox --disable-gpu --disable-breakpad \
  --disable-crash-reporter --crash-dumps-dir="$WORK/crash" --no-first-run \
  --no-default-browser-check --disable-background-networking \
  --user-data-dir="$WORK/chrome-profile" --remote-debugging-port="$DEBUG_PORT" \
  --window-size=1440,900 about:blank > "$WORK/chrome.log" 2>&1 &
CHROME_PID=$!
cleanup() {
  kill "$CHROME_PID" 2>/dev/null || true
  kill "$BOOT_PID" 2>/dev/null || true
}
trap cleanup EXIT

echo "== driving the UI"
export UI_SAVE_VALUE="${UI_SAVE_VALUE:-}"
export UI_SAVE_TOKEN="${UI_SAVE_TOKEN:-}"
set +e
"$NODE" "$HERE/ui-verify.mjs" "http://127.0.0.1:$PORT/?token=$TOKEN" "$SHOTS" "$DEBUG_PORT" > "$WORK/ui.log" 2>&1
UI_STATUS=$?
set -e
sed -n '1,60p' "$WORK/ui.log"

if [ "$UI_STATUS" -ne 0 ]; then
  echo "== UI verification failed (status $UI_STATUS); screenshots/log above" >&2
  exit "$UI_STATUS"
fi
ls -la "$SHOTS"
if [ -n "${UI_SAVE_VALUE:-}${UI_SAVE_TOKEN:-}" ]; then
  echo "== profile patch after GUI save"
  grep -nE "botToken|defaultChatId" "$PROFILE_DIR/cordis.patch.yml"
fi
if [ -n "${UI_SAVE_TOKEN:-}" ]; then
  grep -qF "botToken: $UI_SAVE_TOKEN" "$PROFILE_DIR/cordis.patch.yml" \
    || { echo "FAIL: the token typed in the GUI did not reach the profile" >&2; exit 1; }
  if grep -q '\*' "$PROFILE_DIR/cordis.patch.yml"; then
    echo "FAIL: the display mask leaked into the profile" >&2; exit 1
  fi
  echo "== token saved through the GUI, mask never written"
fi
echo "== screenshots in $SHOTS"

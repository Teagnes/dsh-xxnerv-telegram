#!/usr/bin/env bash
# Integration check: boot a real dsh runtime with this plugin installed as a
# profile bundle, and drive both contributions through their real seams.
#
# It proves: the bundle layer applies, the plugin module loads, `xxnerv_telegram_send`
# registers on the model-facing surface, the tool pipeline validates and executes
# arguments, the response reaches the caller, and a session's `turn/end` pushes a
# notification.
#
# Two modes:
#   default        a local stand-in for the Telegram Bot API (no network, no credentials)
#   LIVE=1         the real api.telegram.org, using DSH_XXNERV_TELEGRAM_BOT_TOKEN,
#                  DSH_XXNERV_TELEGRAM_CHAT_ID and DSH_XXNERV_TELEGRAM_PROXY (sends real messages)
#
# Usage: test/integration/run.sh [profile-name]
# Env:   DSH_APP (default /Applications/DeepSeek Harness.app), DSH_NODE
set -euo pipefail

HERE="$(cd -- "$(dirname -- "$0")" && pwd)"
PLUGIN_DIR="$(cd -- "$HERE/../.." && pwd)"
APP="${DSH_APP:-/Applications/DeepSeek Harness.app}"
ELECTRON="$APP/Contents/MacOS/DeepSeek Harness"
CLI="$APP/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"
NODE="${DSH_NODE:-$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node}"
PROFILE="${1:-tgtest}"
WORK="$PLUGIN_DIR/.scratch/integration"
HOME_DIR="$WORK/dsh-home"
PROFILE_DIR="$HOME_DIR/profiles/$PROFILE"
LOG="$WORK/fake-telegram.jsonl"
BOOT_LOG="$WORK/boot.log"
LIVE="${LIVE:-0}"
# Tool-only mode (`NOTIFY_ON_TURN_END=false`) must send nothing on turn end.
NOTIFY="${NOTIFY_ON_TURN_END:-true}"
# The value the probe writes through xxnerv_telegram_config; live runs reuse the real
# chat so the follow-up send is a genuine message rather than an unknown chat.
NEW_CHAT="${PROBE_NEW_CHAT:-}"

# The CLI lives inside app.asar, which shell file tests cannot see; only the app
# bundle and the interpreter are checked here.
for required in "$ELECTRON" "$NODE"; do
  [ -e "$required" ] || { echo "missing: $required" >&2; exit 2; }
done

if [ "$LIVE" = "1" ]; then
  TOKEN="${DSH_XXNERV_TELEGRAM_BOT_TOKEN:?LIVE=1 needs DSH_XXNERV_TELEGRAM_BOT_TOKEN}"
  CHAT_ID="${DSH_XXNERV_TELEGRAM_CHAT_ID:?LIVE=1 needs DSH_XXNERV_TELEGRAM_CHAT_ID}"
  PROXY="${DSH_XXNERV_TELEGRAM_PROXY:-}"
  API_LINE=""
  PROXY_LINE=""
  [ -n "$PROXY" ] && PROXY_LINE="    proxyUrl: '$PROXY'"
  [ -z "$NEW_CHAT" ] && NEW_CHAT="$CHAT_ID"
else
  TOKEN="TEST-TOKEN"
  CHAT_ID="4242"
  if [ -n "${FAKE_TELEGRAM_PORT:-}" ]; then
    PORT="$FAKE_TELEGRAM_PORT"
  else
    # Pick a free ephemeral port; the profile config written below names it.
    PORT="$("$NODE" -e 'const net = require("node:net"); const server = net.createServer(); server.listen(0, "127.0.0.1", () => { console.log(server.address().port); server.close() })')"
  fi
  API_LINE="    apiBase: 'http://127.0.0.1:$PORT'"
  PROXY_LINE=""
  [ -z "$NEW_CHAT" ] && NEW_CHAT="9999"
fi

echo "== preparing profile $PROFILE (mode: $([ "$LIVE" = 1 ] && echo live || echo fake)) in $PROFILE_DIR"
rm -rf "$WORK"
mkdir -p "$PROFILE_DIR/node_modules"
ln -sfn "$PLUGIN_DIR" "$PROFILE_DIR/node_modules/dsh-xxnerv-telegram"
cat > "$PROFILE_DIR/package.json" <<EOF
{
  "name": "dsh-profile-$PROFILE",
  "private": true,
  "dependencies": {
    "dsh-xxnerv-telegram": "link:$PLUGIN_DIR"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "dsh-xxnerv-telegram"
      ]
    }
  }
}
EOF
printf '[]\n' > "$PROFILE_DIR/cordis.yml"
cat > "$PROFILE_DIR/pnpm-workspace.yaml" <<'EOF'
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
EOF
{
  echo '- id: xxnerv-telegram'
  echo "  name: 'dsh-xxnerv-telegram'"
  echo '  config:'
  echo "    botToken: '$TOKEN'"
  echo "    defaultChatId: '$CHAT_ID'"
  echo "    notifyChatId: '$CHAT_ID'"
  echo "    notifyOnTurnEnd: $NOTIFY"
  [ -n "$API_LINE" ] && echo "$API_LINE"
  [ -n "$PROXY_LINE" ] && echo "$PROXY_LINE"
} > "$PROFILE_DIR/cordis.patch.yml"

# The probe overlay is generated here rather than committed, so it carries this
# checkout's own path and keeps working from any clone location.
cat > "$WORK/probe.patch.yml" <<EOF
# Overlay applied on top of the "$PROFILE" profile by the integration runner.
# It mounts the probe that drives xxnerv_telegram_send through the real tool pipeline.
- insert:
    - id: xxnerv-telegram-probe
      name: '$HERE/probe.mjs'
EOF

if [ "$LIVE" != "1" ]; then
  echo "== starting fake Telegram API on port $PORT"
  : > "$LOG"
  "$NODE" "$HERE/fake-telegram.mjs" "$PORT" "$LOG" > "$WORK/fake.log" 2>&1 &
  FAKE_PID=$!
  trap 'kill "$FAKE_PID" 2>/dev/null || true' EXIT
  for _ in $(seq 1 50); do
    grep -q listening "$WORK/fake.log" 2>/dev/null && break
    sleep 0.1
  done
  grep -q listening "$WORK/fake.log" || { echo "fake Telegram API did not start:" >&2; cat "$WORK/fake.log" >&2; exit 2; }
fi

echo "== booting dsh with the plugin and the probe"
set +e
DSH_HOME="$HOME_DIR" ELECTRON_RUN_AS_NODE=1 PROBE_INITIAL_CHAT="$CHAT_ID" PROBE_NEW_CHAT="$NEW_CHAT" \
  "$ELECTRON" "$CLI" --profile "$PROFILE" --patch "$WORK/probe.patch.yml" > "$BOOT_LOG" 2>&1
BOOT_STATUS=$?
set -e
sed -n '1,40p' "$BOOT_LOG"

echo "== asserting"
fail=0
grep -q 'PROBE tool-registered=true' "$BOOT_LOG" || { echo "FAIL: xxnerv_telegram_send was not registered" >&2; fail=1; }
grep -q 'PROBE result=Sent Telegram message' "$BOOT_LOG" || { echo "FAIL: the tool did not report a sent message" >&2; fail=1; }
grep -q 'PROBE notification-events-appended=true' "$BOOT_LOG" || { echo "FAIL: could not append turn/end events to a real session" >&2; fail=1; }
grep -q "PROBE config-status-default-chat=$CHAT_ID" "$BOOT_LOG" || { echo "FAIL: xxnerv_telegram_config status did not report the configured chat" >&2; fail=1; }
grep -q 'PROBE config-set-ok=true' "$BOOT_LOG" || { echo "FAIL: xxnerv_telegram_config could not write the profile config" >&2; fail=1; }
grep -q "PROBE config-applied-default-chat=$NEW_CHAT" "$BOOT_LOG" || { echo "FAIL: the written chat id did not take effect live" >&2; fail=1; }
grep -Eq "defaultChatId: ['\"]?$NEW_CHAT['\"]?" "$PROFILE_DIR/cordis.patch.yml" || { echo "FAIL: the profile patch was not updated" >&2; fail=1; }
grep -q 'botToken: ' "$PROFILE_DIR/cordis.patch.yml" || { echo "FAIL: the write dropped an unrelated field" >&2; fail=1; }
[ "$BOOT_STATUS" -eq 0 ] || { echo "FAIL: dsh exited with $BOOT_STATUS" >&2; fail=1; }

if [ "$LIVE" != "1" ]; then
  if [ ! -s "$LOG" ]; then
    echo "FAIL: the fake Telegram API received no request" >&2
    fail=1
  else
    echo "received:"; cat "$LOG"
    grep -q "bot$TOKEN/sendMessage" "$LOG" || { echo "FAIL: wrong method URL" >&2; fail=1; }
    grep -q "\"chat_id\":\"$CHAT_ID\"" "$LOG" || { echo "FAIL: wrong chat id" >&2; fail=1; }
    grep -q 'integration hello' "$LOG" || { echo "FAIL: tool message text not delivered" >&2; fail=1; }
    grep -q '"chat_id":"9999"' "$LOG" || { echo "FAIL: the rewritten chat id never reached the API" >&2; fail=1; }
    # Expected requests: the first tool call, the config-driven call, and — when
    # enabled — the turn-end notification.
    if [ "$NOTIFY" = "true" ]; then
      grep -q 'DSH 任务完成' "$LOG" || { echo "FAIL: turn-end notification was not sent" >&2; fail=1; }
      grep -q 'Probe session' "$LOG" || { echo "FAIL: notification did not carry the session title" >&2; fail=1; }
      EXPECTED=3
    else
      grep -q 'DSH 任务完成' "$LOG" && { echo "FAIL: notifyOnTurnEnd=false still pushed a notification" >&2; fail=1; }
      EXPECTED=2
    fi
    REQUESTS="$(wc -l < "$LOG" | tr -d ' ')"
    [ "$REQUESTS" = "$EXPECTED" ] || { echo "FAIL: saw $REQUESTS requests, expected $EXPECTED" >&2; fail=1; }
    echo "notifyOnTurnEnd=$NOTIFY: $REQUESTS request(s), as expected"
  fi
fi

[ "$fail" -eq 0 ] && echo "== integration OK" || { echo "== integration FAILED" >&2; exit 1; }

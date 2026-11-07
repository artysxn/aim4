#!/bin/sh
# Runs the bot 24/7 on macOS: starts at login, restarts if it stops, and keeps
# the Mac awake while it is on the charger (caffeinate -s).
#   sh install-service.sh           install and start
#   sh install-service.sh --remove  stop and remove
set -e
LABEL=io.aim4.insights-bot
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$HOME/Library/Logs/aim4-insights-bot.log"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
if [ "$1" = "--remove" ]; then
  rm -f "$PLIST"
  echo "Removed. The bot no longer runs."
  exit 0
fi

NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "Node not found. Install Node 22+ first (brew install node)."; exit 1; }
[ -d "$DIR/node_modules/@polymarket/client" ] || { echo "Run npm install in $DIR first."; exit 1; }
[ -f "$HOME/.aim4/insights-executor.json" ] || { echo "Run npm run setup first."; exit 1; }

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string><string>-s</string>
    <string>$NODE</string><string>$DIR/bot.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Running. Log: tail -f \"$LOG\""

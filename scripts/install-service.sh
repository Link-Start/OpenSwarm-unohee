#!/bin/bash
# OpenSwarm macOS launchd service installer

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PLIST_SOURCE="$PROJECT_DIR/scripts/com.intrect.openswarm.plist"
PLIST_TARGET="$HOME/Library/LaunchAgents/com.intrect.openswarm.plist"
LOG_DIR="$HOME/.openswarm/logs"

echo "Installing OpenSwarm service..."

# 1. Build check
cd "$PROJECT_DIR"
if [ ! -d "dist" ]; then
    echo "Building TypeScript..."
    npm run build
fi

# 2. Log directory
mkdir -p "$LOG_DIR"

# 3. Config check
if [ ! -f "$PROJECT_DIR/.env" ]; then
    echo "Error: .env file not found."
    echo "  cp .env.example .env"
    exit 1
fi

if [ ! -f "$PROJECT_DIR/config.yaml" ]; then
    echo "Error: config.yaml not found."
    echo "  cp config.example.yaml config.yaml"
    exit 1
fi

# 4. Resolve node path and substitute placeholders
NODE_PATH=$(which node)
echo "Node.js: $NODE_PATH"

sed -e "s|__NODE_PATH__|$NODE_PATH|g" \
    -e "s|__PROJECT_DIR__|$PROJECT_DIR|g" \
    -e "s|__HOME_DIR__|$HOME|g" \
    "$PLIST_SOURCE" > /tmp/openswarm.plist.tmp

# 5. Install plist
mkdir -p "$HOME/Library/LaunchAgents"
cp /tmp/openswarm.plist.tmp "$PLIST_TARGET"
rm /tmp/openswarm.plist.tmp

# 6. Unload existing (if any)
if launchctl list | grep -q "com.intrect.openswarm"; then
    echo "Stopping existing service..."
    launchctl unload "$PLIST_TARGET" 2>/dev/null || true
fi

# 7. Load and start
echo "Loading service..."
launchctl load "$PLIST_TARGET"
launchctl start com.intrect.openswarm

# 8. Verify
sleep 2
if launchctl list | grep -q "com.intrect.openswarm"; then
    echo "OpenSwarm service installed successfully."
    echo ""
    echo "Management:"
    echo "  npm run service:status"
    echo "  npm run service:start"
    echo "  npm run service:stop"
    echo "  npm run service:restart"
    echo "  npm run service:logs"
else
    echo "Service load failed. Check: tail -f $LOG_DIR/stderr.log"
    exit 1
fi

#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: setup.sh [--config <path>] [--state-dir <path>] [--no-db-check]

Configures OpenClaw iMessage to use this skill's native poller + converter runtime.
EOF
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-$STATE_DIR/openclaw.json}"
CHECK_DB_ACCESS=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config)
      CONFIG_PATH="${2:-}"
      shift 2
      ;;
    --state-dir)
      STATE_DIR="${2:-}"
      shift 2
      ;;
    --no-db-check)
      CHECK_DB_ACCESS=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This installer supports macOS only." >&2
  exit 1
fi

NATIVE_CLIENT="$SCRIPT_DIR/native-applescript.mjs"
CONVERTER="$SCRIPT_DIR/convert-heic.sh"

if [[ ! -f "$NATIVE_CLIENT" ]]; then
  echo "Missing runtime: $NATIVE_CLIENT" >&2
  exit 1
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "Missing required tool: sqlite3" >&2
  exit 1
fi

if ! command -v sips >/dev/null 2>&1; then
  echo "Missing required tool: sips (should be available on macOS)" >&2
  exit 1
fi

if ! command -v magick >/dev/null 2>&1; then
  echo "Warning: ImageMagick not found (optional fallback for HEIC conversion)." >&2
  echo "Install with: brew install imagemagick" >&2
fi

mkdir -p "$(dirname "$CONFIG_PATH")"
mkdir -p "$STATE_DIR/media/inbox" "$STATE_DIR/media/outbound"
chmod +x "$NATIVE_CLIENT" "$CONVERTER"

if [[ ! -f "$CONFIG_PATH" ]]; then
  echo "{}" > "$CONFIG_PATH"
fi

NATIVE_CLIENT="$NATIVE_CLIENT" CONFIG_PATH="$CONFIG_PATH" node <<'NODE'
const fs = require("fs");
const path = require("path");

const configPath = process.env.CONFIG_PATH;
const cliPath = process.env.NATIVE_CLIENT;

let cfg = {};
try {
  const raw = fs.readFileSync(configPath, "utf8");
  cfg = JSON.parse(raw);
} catch {
  cfg = {};
}

if (!cfg || typeof cfg !== "object") cfg = {};
if (!cfg.channels || typeof cfg.channels !== "object") cfg.channels = {};
if (!cfg.channels.imessage || typeof cfg.channels.imessage !== "object") cfg.channels.imessage = {};

cfg.channels.imessage.enabled = true;
cfg.channels.imessage.cliPath = cliPath;
if (!cfg.channels.imessage.service) cfg.channels.imessage.service = "auto";

if (!cfg.channels.imessage.accounts || typeof cfg.channels.imessage.accounts !== "object") {
  cfg.channels.imessage.accounts = {};
}
if (!cfg.channels.imessage.accounts.default || typeof cfg.channels.imessage.accounts.default !== "object") {
  cfg.channels.imessage.accounts.default = {};
}

cfg.channels.imessage.accounts.default.cliPath = cliPath;
if (!cfg.channels.imessage.accounts.default.service) cfg.channels.imessage.accounts.default.service = "auto";
if (
  typeof cfg.channels.imessage.accounts.default.dbPath !== "string" ||
  !cfg.channels.imessage.accounts.default.dbPath.trim()
) {
  cfg.channels.imessage.accounts.default.dbPath = `${process.env.HOME}/Library/Messages/chat.db`;
}

fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n");
console.log(`Updated ${configPath}`);
console.log(`iMessage cliPath -> ${cliPath}`);
NODE

"$NATIVE_CLIENT" rpc --help >/dev/null

DB_PATH="$(CONFIG_PATH="$CONFIG_PATH" node <<'NODE'
const fs = require("fs");
const p = process.env.CONFIG_PATH;
try {
  const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
  const dbPath = cfg?.channels?.imessage?.accounts?.default?.dbPath || "";
  process.stdout.write(String(dbPath));
} catch {
  process.stdout.write("");
}
NODE
)"

if [[ "$CHECK_DB_ACCESS" == "1" && -n "$DB_PATH" ]]; then
  if ! DB_CHECK_ERR="$(/usr/bin/sqlite3 "$DB_PATH" "SELECT 1;" 2>&1 >/dev/null)"; then
    echo "" >&2
    echo "WARNING: Cannot read iMessage database: $DB_PATH" >&2
    echo "sqlite3 error: $DB_CHECK_ERR" >&2
    echo "" >&2
    echo "Fix permissions in macOS Privacy & Security:" >&2
    echo "1) Full Disk Access -> your terminal app (Terminal/iTerm)" >&2
    echo "2) Accessibility -> your terminal app (Terminal/iTerm)" >&2
    echo "" >&2
    echo "If gateway runs as LaunchAgent, grant Full Disk Access to its runtime too (usually node)." >&2
    echo "Inspect with:" >&2
    echo "  launchctl print \"gui/$(id -u)/ai.openclaw.gateway\" | grep -A4 ProgramArguments" >&2
    echo "" >&2
  fi
fi

cat <<EOF
Done.

Next required macOS permissions:
1. System Settings -> Privacy & Security -> Full Disk Access -> enable your terminal app
2. System Settings -> Privacy & Security -> Accessibility -> enable your terminal app

Then restart gateway:
  openclaw gateway restart
EOF

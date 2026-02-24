---
name: imessage
description: "Two-way iMessage integration using native macOS AppleScript. Send messages, handle attachments (HEIC auto-conversion), and receive messages via SQLite polling. No CLI dependencies required."
---

# iMessage Skill (Native AppleScript)

Full two-way iMessage integration for macOS using native AppleScript and SQLite polling. No external CLI tools required (like `imsg` or `pymobiledevice3`).

## Features

- ✅ **Send messages** via AppleScript (no external tools)
- ✅ **Receive messages** via SQLite polling of Messages database
- ✅ **Image attachments** with HEIC → JPEG auto-conversion
- ✅ **Group chat support** (detect and handle group messages)
- ✅ **Duplicate prevention** (tracks message IDs to avoid re-processing)
- ✅ **No external iMessage CLI dependencies** (no `imsg`, no `pymobiledevice3`)

## When to Use

- User wants iMessage integration on macOS
- Alternative to `imsg` CLI or `pymobiledevice3`
- Need image attachment support with HEIC conversion
- Want reliable two-way messaging without external dependencies

## Requirements

### macOS Permissions

The Mac must grant these permissions to **Terminal** (or your shell app):

1. **Accessibility** → System Settings → Privacy & Security → Accessibility
   - Required for AppleScript to control Messages.app
2. **Full Disk Access** → System Settings → Privacy & Security → Full Disk Access
   - Required to read `~/Library/Messages/chat.db`
   - Add your terminal app (Terminal.app, iTerm2, etc.)

### Software

- macOS (tested on macOS 14+)
- Optional ImageMagick fallback (HEIC conversion): `brew install imagemagick`
- Messages.app must be signed in to iMessage

## Installation

### 1. Install Skill Bundle

```bash
mkdir -p ~/.openclaw/skills
curl -L -o /tmp/imessage-1.0.1.skill https://github.com/interagents-ai/openclaw-imessage-skill/releases/download/v1.0.1/imessage-1.0.1.skill
unzip -o /tmp/imessage-1.0.1.skill -d ~/.openclaw/skills
```

### 2. Configure runtime (poller + converter)

```bash
~/.openclaw/skills/imessage/setup.sh
```

This sets `cliPath` to this skill's `native-applescript.mjs`, which includes:
- SQLite poller for inbound messages
- HEIC converter (`sips`, with ImageMagick fallback)

### 3. Grant Permissions

1. Open **System Settings** → **Privacy & Security**
2. Grant **Full Disk Access** to your terminal app
3. Grant **Accessibility** to your terminal app (if prompted)
4. Restart terminal/shell

## Configuration

### openclaw.json

```json
{
  "channels": {
    "imessage": {
      "enabled": true,
      "accounts": {
        "default": {
          "cliPath": "/Users/<you>/.openclaw/skills/imessage/native-applescript.mjs",
          "dbPath": null,
          "service": "auto"
        }
      }
    }
  }
}
```

**Fields:**
- `cliPath`: Path to `native-applescript.mjs`
- `dbPath`: Optional custom path to `chat.db` (defaults to `~/Library/Messages/chat.db`)
- `service`: `"auto"`, `"iMessage"`, or `"SMS"` (auto-detects if omitted)

## How It Works

### Sending Messages

Uses **AppleScript** to send messages via Messages.app:

```applescript
tell application "Messages" 
  send "Hello!" to buddy "+1234567890"
end tell
```

### Receiving Messages

Polls `~/Library/Messages/chat.db` every 2 seconds using SQLite queries:

1. Query messages newer than `lastMessageTime`
2. Filter out reactions and system messages
3. Deduplicate using `knownMessageIds` set
4. Emit notifications to OpenClaw

### Image Attachments

**Sending:**
1. User provides `mediaUrl` (file path or URL)
2. OpenClaw downloads/loads media
3. Sends via AppleScript: `send POSIX file "/path/to/image.jpg" to buddy "..."`

**Receiving:**
1. SQLite query includes `attachment.filename` and `attachment.mime_type`
2. If attachment is HEIC, convert to JPEG using `sips` (and fallback to ImageMagick)
3. Provide converted path in notification

### HEIC Conversion

When receiving HEIC images:

```bash
# Original: ~/Library/Messages/Attachments/.../IMG_1234.heic
# Converted: ~/.openclaw/media/inbox/converted_IMG_1234.jpg

/usr/bin/sips -s format jpeg input.heic --out output.jpg
# Fallback (optional): magick convert input.heic -quality 85 output.jpg
```

## Files in This Skill

```
imessage/
├── SKILL.md                    # This file
├── setup.sh                    # Configure OpenClaw to use this runtime
├── client-native.mjs           # Native AppleScript client (reference)
├── convert-heic.sh             # HEIC → JPEG conversion script
├── native-applescript.mjs      # Poller + JSON-RPC runtime used by OpenClaw
└── examples/
    ├── send-message.mjs        # Example: Send a message
    ├── send-image.mjs          # Example: Send an image
    └── receive-messages.mjs    # Example: Monitor for messages
```

## Usage Examples

### Send a Text Message

```javascript
import { createIMessageRpcClient } from './client-native.mjs';

const client = await createIMessageRpcClient();
await client.request('send', {
  to: '+1234567890',
  text: 'Hello from OpenClaw!'
});
await client.stop();
```

### Send an Image

```javascript
import { createIMessageRpcClient } from './client-native.mjs';

const client = await createIMessageRpcClient();
await client.request('send', {
  to: '+1234567890',
  text: 'Check this out!',
  file: '/path/to/image.jpg'
});
await client.stop();
```

### Receive Messages

```javascript
import { createIMessageRpcClient } from './client-native.mjs';

const client = await createIMessageRpcClient({
  onNotification: (notification) => {
    const msg = notification.params.message;
    console.log(`From: ${msg.sender}`);
    console.log(`Text: ${msg.text}`);
    
    if (msg.attachments) {
      console.log(`Attachments: ${msg.attachments.length}`);
      msg.attachments.forEach(att => {
        console.log(`  - ${att.filename} (${att.mime_type})`);
      });
    }
  }
});

// Client polls automatically every 2 seconds
// Press Ctrl+C to stop
await client.waitForClose();
```

## Debugging

### Enable Verbose Logging

Pass `runtime` with `debug` method:

```javascript
const client = await createIMessageRpcClient({
  runtime: {
    debug: (msg) => console.log(`[DEBUG] ${msg}`),
    info: (msg) => console.log(`[INFO] ${msg}`)
  }
});
```

### Check Messages Database

```bash
# View recent messages
sqlite3 ~/Library/Messages/chat.db \
  "SELECT ROWID, text, datetime(date/1000000000 + 978307200, 'unixepoch', 'localtime') as time 
   FROM message 
   WHERE is_from_me = 0 
   ORDER BY date DESC 
   LIMIT 10"
```

### Test AppleScript

```bash
# Send test message
osascript -e 'tell application "Messages" to send "Test" to buddy "+1234567890"'
```

## Troubleshooting

### "Operation not permitted" when polling

**Cause:** Terminal doesn't have Full Disk Access

**Fix:** System Settings → Privacy & Security → Full Disk Access → Enable for Terminal.app

### "Messages got an error: Can't send message"

**Cause:** AppleScript doesn't have Accessibility permission

**Fix:** System Settings → Privacy & Security → Accessibility → Enable for Terminal.app

### HEIC images not converting

**Cause:** Converter chain unavailable (`sips` failed and ImageMagick missing)

**Fix:**
```bash
brew install imagemagick
which magick
```

### Duplicate messages on restart

**Cause:** `lastMessageTime` resets on restart

**Fix:** Default lookback is 5 minutes. Adjust in `client-native.mjs`:

```javascript
const lookbackSeconds = 60; // Only look back 1 minute
```

### Group chat messages not detected

**Fix:** Group chat detection uses `chat_identifier` containing `;`. Verify in database:

```bash
sqlite3 ~/Library/Messages/chat.db \
  "SELECT chat_identifier, display_name FROM chat WHERE chat_identifier LIKE '%;%'"
```

## Advanced: Customization

### Adjust Polling Interval

Default is 2 seconds. To change:

```javascript
// In client-native.mjs, line ~73:
this.pollInterval = setInterval(() => {
  this.pollMessagesSqlite().catch(...);
}, 5000); // 5 seconds instead of 2
```

### Change Lookback Window

Default is 5 minutes on startup. To change:

```javascript
// In client-native.mjs, line ~68:
const lookbackSeconds = 600; // 10 minutes instead of 5
```

### Filter by Specific Sender

```javascript
const client = await createIMessageRpcClient({
  onNotification: (notification) => {
    const msg = notification.params.message;
    
    // Only process messages from specific sender
    if (msg.sender === '+1234567890') {
      console.log(`Message from allowed sender: ${msg.text}`);
    }
  }
});
```

## Integration with OpenClaw

Use `setup.sh` so OpenClaw points directly to this skill runtime:

```bash
~/.openclaw/skills/imessage/setup.sh
```

This sets `channels.imessage.accounts.default.cliPath` to `~/.openclaw/skills/imessage/native-applescript.mjs`.

### Message Format

Received messages follow OpenClaw's standard format:

```javascript
{
  method: "message",
  params: {
    message: {
      id: "12345",
      guid: "native-12345",
      text: "Hello!",
      sender: "+1234567890",
      handle: "+1234567890",
      chat_id: "+1234567890",
      chat_guid: null,
      chat_identifier: "+1234567890",
      chat_name: null,
      is_group: false,
      is_from_me: false,
      service: "iMessage",
      timestamp: 1234567890000000000,
      date: 1234567890000000000,
      created_at: "2024-01-01T12:00:00.000Z",
      attachments: [
        {
          filename: "IMG_1234.heic",
          mime_type: "image/heic",
          path: "/Users/you/Library/Messages/Attachments/.../IMG_1234.heic",
          id: "456"
        }
      ]
    }
  }
}
```

## Known Limitations

1. **Reactions not supported** - Filtering them out to avoid noise
2. **Read receipts not supported** - No callback when messages are read
3. **Typing indicators not supported** - AppleScript doesn't expose this
4. **macOS only** - Requires Messages.app (no iOS/iPadOS)
5. **Messages.app must be running** - AppleScript requires the app to be active

## Security Notes

- ✅ **No remote access** - All operations local to macOS
- ✅ **No API keys required** - Uses built-in Messages.app
- ⚠️ **Full Disk Access required** - Grants read access to entire disk (required for `chat.db`)
- ⚠️ **Accessibility permission** - Allows AppleScript to control Messages.app

## Credits

- Built for OpenClaw by Molty (Parts Molty, SD Molty, TH Molty, Main Molty team effort)
- Based on macOS Messages.app and SQLite schema reverse engineering
- HEIC conversion via `sips` with ImageMagick fallback

## License

Part of OpenClaw distribution. See main OpenClaw license.

## Support

For issues or questions:
1. Check OpenClaw docs: `/opt/homebrew/lib/node_modules/openclaw/docs`
2. OpenClaw Discord: https://discord.com/invite/clawd
3. GitHub: https://github.com/openclaw/openclaw

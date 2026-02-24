# iMessage Skill

Native macOS iMessage integration using AppleScript and SQLite polling.

## Quick Start

### 1. Install ImageMagick (for HEIC conversion)

```bash
brew install imagemagick
```

### 2. Grant Permissions

**System Settings → Privacy & Security:**
- Full Disk Access → Enable for Terminal.app
- Accessibility → Enable for Terminal.app

### 3. Test Sending

```bash
cd ~/.openclaw/skills/imessage/examples
node send-message.mjs "+1234567890" "Test message"
```

### 4. Test Receiving

```bash
cd ~/.openclaw/skills/imessage/examples
node receive-messages.mjs
# Send yourself a message to see it appear
```

## Files

- **SKILL.md** - Full documentation
- **client-native.mjs** - Native AppleScript client implementation
- **convert-heic.sh** - HEIC → JPEG conversion script
- **examples/** - Working examples for send/receive

## OpenClaw Integration

This implementation is already integrated into OpenClaw core. Set `cliPath: "native-applescript"` in your `openclaw.json` to use it.

## Features

✅ Send text messages  
✅ Send images (HEIC auto-converted to JPEG)  
✅ Receive messages (SQLite polling)  
✅ Group chat detection  
✅ Duplicate prevention  
✅ No external CLI dependencies  

## Need Help?

Read **SKILL.md** for full documentation, troubleshooting, and advanced usage.

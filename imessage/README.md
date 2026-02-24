# iMessage Skill

Native macOS iMessage integration using AppleScript and SQLite polling.

## Quick Start

### 1. Install the skill bundle

```bash
mkdir -p ~/.openclaw/skills
curl -L -o /tmp/imessage-1.0.1.skill https://github.com/interagents-ai/openclaw-imessage-skill/releases/download/v1.0.1/imessage-1.0.1.skill
unzip -o /tmp/imessage-1.0.1.skill -d ~/.openclaw/skills
```

### 2. Run setup (configures poller + converter runtime)

```bash
~/.openclaw/skills/imessage/setup.sh
```

### 3. Grant Permissions

**System Settings → Privacy & Security:**
- Full Disk Access → Enable for Terminal.app
- Accessibility → Enable for Terminal.app

### 4. Restart OpenClaw

```bash
openclaw gateway restart
```

### 5. Test Sending

```bash
cd ~/.openclaw/skills/imessage/examples
node send-message.mjs "+1234567890" "Test message"
```

### 6. Test Receiving

```bash
cd ~/.openclaw/skills/imessage/examples
node receive-messages.mjs
# Send yourself a message to see it appear
```

## Files

- **SKILL.md** - Full documentation
- **setup.sh** - Installs runtime config for poller + converter
- **client-native.mjs** - Native AppleScript client implementation
- **convert-heic.sh** - HEIC → JPEG conversion script
- **examples/** - Working examples for send/receive

## OpenClaw Integration

`setup.sh` configures `openclaw.json` to use this skill's runtime directly:

- `channels.imessage.accounts.default.cliPath=~/.openclaw/skills/imessage/native-applescript.mjs`
- Enables iMessage and default account with `service=auto`

## Features

✅ Send text messages  
✅ Send images (HEIC auto-converted to JPEG)  
✅ Receive messages (SQLite polling)  
✅ Group chat detection  
✅ Duplicate prevention  
✅ No external CLI dependencies  

## Need Help?

Read **SKILL.md** for full documentation, troubleshooting, and advanced usage.

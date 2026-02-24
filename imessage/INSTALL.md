# Installation Guide

## Prerequisites

1. **macOS** (10.14 or later)
2. **Messages.app** signed in to iMessage
3. **Homebrew** installed

## Step 1: Install ImageMagick

```bash
brew install imagemagick
```

Verify installation:

```bash
magick -version
```

## Step 2: Grant Permissions

### Full Disk Access

1. Open **System Settings**
2. Go to **Privacy & Security** → **Full Disk Access**
3. Click the **+** button
4. Add your terminal app:
   - **Terminal.app**: `/Applications/Utilities/Terminal.app`
   - **iTerm2**: `/Applications/iTerm.app`
5. Toggle **ON**

### Accessibility

1. In **Privacy & Security** → **Accessibility**
2. Click the **+** button
3. Add your terminal app (same as above)
4. Toggle **ON**

### Restart Terminal

After granting permissions, **quit and reopen** your terminal app.

## Step 3: Test the Skill

### Test Sending

```bash
cd ~/.openclaw/skills/imessage/examples
node send-message.mjs "+1234567890" "Test from iMessage skill"
```

Replace `+1234567890` with your own phone number.

### Test Receiving

```bash
cd ~/.openclaw/skills/imessage/examples
node receive-messages.mjs
```

Leave this running, then send yourself a message from your iPhone. You should see it appear in the terminal.

Press **Ctrl+C** to stop.

## Step 4: Integrate with OpenClaw

The native client is already integrated into OpenClaw core. To enable it:

### Edit `~/.openclaw/openclaw.json`

```json
{
  "channels": {
    "imessage": {
      "enabled": true,
      "accounts": {
        "default": {
          "cliPath": "native-applescript",
          "service": "auto"
        }
      }
    }
  }
}
```

### Restart OpenClaw

```bash
openclaw gateway restart
```

## Troubleshooting

### "Operation not permitted" when polling

**Fix:** Grant Full Disk Access (Step 2) and restart terminal.

### "Messages got an error"

**Fix:** Grant Accessibility permission (Step 2) and restart terminal.

### HEIC images not converting

**Fix:** Install ImageMagick (Step 1).

### Messages not appearing

**Fix:** Check Messages.app is signed in and working manually first.

## Next Steps

- Read **SKILL.md** for full documentation
- Check **examples/** for code samples
- Integrate with OpenClaw for full automation

## Support

For issues:
1. Check OpenClaw docs: `/opt/homebrew/lib/node_modules/openclaw/docs`
2. Discord: https://discord.com/invite/clawd
3. GitHub: https://github.com/openclaw/openclaw

# Installation Guide

## Prerequisites

1. **macOS** (10.14 or later)
2. **Messages.app** signed in to iMessage
3. **OpenClaw** installed

## Step 1: Install Skill Bundle

```bash
mkdir -p ~/.openclaw/skills
curl -fL -o /tmp/imessage-1.0.5.skill https://github.com/interagents-ai/openclaw-imessage-skill/releases/download/v1.0.5/imessage-1.0.5.skill
unzip -o /tmp/imessage-1.0.5.skill -d ~/.openclaw/skills
```

## Step 2: Configure Runtime (Poller + Converter)

```bash
~/.openclaw/skills/imessage/setup.sh
```

What this does:
- Sets `channels.imessage.accounts.default.cliPath` to `~/.openclaw/skills/imessage/native-applescript.mjs`
- Enables iMessage channel + default account
- Sets DM policy to `open` with `allowFrom=["*"]` (no pairing prompt for customer DMs)
- Uses the built-in SQLite poller in `native-applescript.mjs`
- Enables HEIC converter flow (`sips` first, ImageMagick fallback)

If you want ImageMagick fallback converter:

```bash
brew install imagemagick
```

## Step 3: Grant Permissions

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

## Step 4: Restart OpenClaw

```bash
openclaw gateway restart
```

## Step 5: Test the Skill

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

## Troubleshooting

### "Operation not permitted" when polling

**Fix:** Grant Full Disk Access (Step 3) and restart terminal.

### "authorization denied" for `~/Library/Messages/chat.db`

**Fix:** This is macOS privacy (TCC). Grant Full Disk Access to your terminal app.  
If gateway runs as LaunchAgent, grant Full Disk Access to its runtime binary too (usually `node`), then restart gateway.

### Re-enable pairing mode (optional)

If you want owner approval flow instead of open DMs:

```bash
~/.openclaw/skills/imessage/setup.sh --dm-policy pairing
openclaw gateway restart
```

### Agent sees media placeholders but no actual images

**Fix:** Upgrade to `v1.0.4+` and rerun setup. This version restores legacy-compatible attachment fields (`path`, `id`, `filename`) expected by OpenClaw media loaders.

### "Messages got an error"

**Fix:** Grant Accessibility permission (Step 3) and restart terminal.

### HEIC images not converting

**Fix:** Install ImageMagick and rerun setup.

```bash
brew install imagemagick
~/.openclaw/skills/imessage/setup.sh
```

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

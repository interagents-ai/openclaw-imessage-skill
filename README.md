# OpenClaw iMessage Skill (Native AppleScript)

Public distribution of the OpenClaw iMessage skill used in Interagents environments.

## Contents

- `imessage/` - skill source folder (drop-in for `~/.openclaw/skills/imessage`)
- `dist/imessage-1.0.5.skill` - installable skill bundle
- `dist/imessage-1.0.5.skill.sha256` - checksum

## Install on another Mac

```bash
mkdir -p ~/.openclaw/skills
unzip -o dist/imessage-1.0.5.skill -d ~/.openclaw/skills
~/.openclaw/skills/imessage/setup.sh
openclaw skills info imessage
```

## Verify bundle integrity

```bash
shasum -a 256 dist/imessage-1.0.5.skill
cat dist/imessage-1.0.5.skill.sha256
```

## Requirements

- macOS with Messages.app signed in
- Terminal with Full Disk Access and Accessibility permissions
- Optional ImageMagick (`brew install imagemagick`) for HEIC conversion fallback

See `imessage/INSTALL.md` and `imessage/SKILL.md` for full setup details.

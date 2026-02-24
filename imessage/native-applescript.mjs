#!/usr/bin/env node
/*
 * OpenClaw iMessage channel backend: "imsg rpc" compatible JSON-RPC over stdio.
 *
 * Why this exists:
 * - OpenClaw's built-in iMessage channel is a legacy integration that spawns `imsg rpc`.
 * - We prefer a native AppleScript + SQLite implementation (no external `imsg` dependency).
 * - This script is used by setting `channels.imessage.cliPath` to this file path.
 *
 * Contract (subset of `imsg rpc`):
 * - JSON-RPC 2.0 over newline-delimited stdin/stdout
 * - Methods:
 *   - send
 *   - chats.list
 *   - watch.subscribe
 *   - watch.unsubscribe
 * - Notifications:
 *   - {"method":"message","params":{"message":{...}}}
 *
 * IMPORTANT:
 * - stdout must contain only JSON-RPC lines (except `rpc --help`).
 * - Log to stderr only.
 */

import { execFile as execFileCb } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

const APPLE_EPOCH_OFFSET_MS = 978307200000n; // 2001-01-01 - 1970-01-01
const NS_PER_MS = 1_000_000n;
const NS_PER_S = 1_000_000_000n;

function unixMsToAppleNs(unixMs) {
  return (unixMs - APPLE_EPOCH_OFFSET_MS) * NS_PER_MS;
}

function appleNsToUnixMs(appleNs) {
  return appleNs / NS_PER_MS + APPLE_EPOCH_OFFSET_MS;
}

function logErr(...args) {
  // stderr is safe; stdout is reserved for JSON-RPC framing.
  process.stderr.write(args.map(String).join(" ") + "\n");
}

function writeJsonLine(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function writeResult(id, result) {
  writeJsonLine({ jsonrpc: "2.0", id, result });
}

function writeError(id, err, code = -32000) {
  const message = err instanceof Error ? err.message : String(err);
  const data = err instanceof Error && err.stack ? err.stack : undefined;
  writeJsonLine({ jsonrpc: "2.0", id, error: { code, message, data } });
}

function escapeAppleScriptString(str) {
  if (!str) return "";
  return String(str)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

function expandTilde(p) {
  if (!p) return p;
  if (p === "~") return process.env.HOME ?? p;
  if (p.startsWith("~/")) return `${process.env.HOME ?? ""}${p.slice(1)}`;
  return p;
}

function resolveMessagesAttachmentsDir(env = process.env) {
  const home = String(env.HOME ?? "").trim() || os.homedir();
  return path.join(home, "Library", "Messages", "Attachments");
}

function normalizeAttachmentPath(p) {
  if (!p) return "";
  let out = String(p);
  if (out.startsWith("file://")) out = out.slice("file://".length);
  out = expandTilde(out);

  out = out.trim();
  if (!out) return "";

  // Some rows store attachment paths relative to ~/Library/Messages/Attachments.
  // Make them absolute so OpenClaw can actually load the media.
  if (!path.isAbsolute(out)) {
    const home = String(process.env.HOME ?? "").trim() || os.homedir();
    const trimmed = out.replace(/^[.][/\\\\]/, "");
    if (trimmed.startsWith(`Library${path.sep}`) || trimmed.startsWith("Library/") || trimmed.startsWith("Library\\")) {
      out = path.join(home, trimmed);
    } else {
      const base = resolveMessagesAttachmentsDir();
      const resolved = path.resolve(base, trimmed);
      const basePrefix = base.endsWith(path.sep) ? base : base + path.sep;
      out = resolved.startsWith(basePrefix) ? resolved : resolved;
    }
  }

  return out;
}

function decodeSqlEscapes(s) {
  // Keep this in sync with SQL REPLACE calls.
  return String(s)
    .replaceAll("<<PIPE>>", "|")
    .replaceAll("<<LF>>", "\n")
    .replaceAll("<<CR>>", "\r");
}

function sanitizeInboundText(text, attachments) {
  const raw = text == null ? "" : String(text);
  if (!raw) return "";
  if (!attachments || attachments.length === 0) return raw;

  // iMessage stores attachments in the DB separately and often inserts U+FFFC
  // (OBJECT REPLACEMENT CHARACTER) into message.text as a placeholder.
  // If we forward that through, OpenClaw treats it as normal text and won't
  // fall back to <media:image>/<media:attachment> placeholders.
  return raw.replace(/\uFFFC/g, "").trim();
}

function inferMimeTypeFromPath(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  switch (ext) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    case ".tif":
    case ".tiff":
      return "image/tiff";
    case ".heic":
      return "image/heic";
    case ".heif":
      return "image/heif";
    case ".svg":
      return "image/svg+xml";
    case ".mp4":
      return "video/mp4";
    case ".mov":
      return "video/quicktime";
    case ".m4v":
      return "video/x-m4v";
    case ".mp3":
      return "audio/mpeg";
    case ".m4a":
      return "audio/mp4";
    case ".wav":
      return "audio/wav";
    case ".aac":
      return "audio/aac";
    case ".pdf":
      return "application/pdf";
    default:
      return undefined;
  }
}

function normalizeMimeType(mimeType, filePath) {
  const trimmed = String(mimeType || "").trim();
  if (trimmed) return trimmed;
  return inferMimeTypeFromPath(filePath);
}

function hasBytesPrefix(buf, bytes) {
  if (!buf || buf.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (buf[i] !== bytes[i]) return false;
  return true;
}

function asciiSlice(buf, start, end) {
  if (!buf || buf.length < end) return "";
  return buf.subarray(start, end).toString("ascii");
}

function sniffMimeTypeFromHeader(buf) {
  if (!buf || buf.length < 4) return undefined;

  // JPEG
  if (hasBytesPrefix(buf, [0xff, 0xd8, 0xff])) return "image/jpeg";

  // PNG
  if (hasBytesPrefix(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";

  // GIF
  const gif = asciiSlice(buf, 0, 6);
  if (gif === "GIF87a" || gif === "GIF89a") return "image/gif";

  // WebP (RIFF....WEBP)
  if (asciiSlice(buf, 0, 4) === "RIFF" && asciiSlice(buf, 8, 12) === "WEBP") return "image/webp";

  // PDF
  if (asciiSlice(buf, 0, 4) === "%PDF") return "application/pdf";

  // ISO BMFF (HEIC/HEIF/MP4/QuickTime)
  if (asciiSlice(buf, 4, 8) === "ftyp") {
    const brand = asciiSlice(buf, 8, 12);
    const lower = brand.toLowerCase();
    if (["heic", "heix", "hevc", "hevx"].includes(lower)) return "image/heic";
    if (["mif1", "msf1", "heif"].includes(lower)) return "image/heif";
    if (lower === "qt  ") return "video/quicktime";
    if (["isom", "iso2", "mp41", "mp42", "avc1", "dash"].includes(lower)) return "video/mp4";
  }

  // ZIP (sometimes used as a container)
  if (hasBytesPrefix(buf, [0x50, 0x4b, 0x03, 0x04])) return "application/zip";

  return undefined;
}

async function sniffMimeTypeFromFilePath(filePath) {
  const p = String(filePath || "").trim();
  if (!p) return undefined;
  try {
    const fh = await fs.open(p, "r");
    try {
      const buf = Buffer.alloc(64);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      return sniffMimeTypeFromHeader(buf.subarray(0, bytesRead));
    } finally {
      await fh.close();
    }
  } catch {
    return undefined;
  }
}

function safeFileNameFragment(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function resolveLocalSkillPath(fileName) {
  try {
    const thisFile = decodeURIComponent(new URL(import.meta.url).pathname);
    return path.join(path.dirname(thisFile), fileName);
  } catch {
    return "";
  }
}

async function maybeConvertHeicToJpeg(inputPath, attachmentId) {
  const p = String(inputPath || "").trim();
  if (!p) return null;

  // Use OpenClaw state dir so the path is stable across restarts and can be safely shared with the agent.
  const inboxDir = path.join(resolveOpenclawStateDir(), "media", "inbox");
  const base = attachmentId ? `converted-${safeFileNameFragment(attachmentId)}` : `converted-${safeFileNameFragment(path.basename(p))}`;
  const outPath = path.join(inboxDir, `${base}.jpg`);

  try {
    const st = await fs.stat(outPath);
    if (st.isFile() && st.size > 0) return outPath;
  } catch {
    // Not present; fall through to convert.
  }

  try {
    await fs.mkdir(inboxDir, { recursive: true });
  } catch {
    // ignore
  }

  try {
    await execFile("/usr/bin/sips", ["-s", "format", "jpeg", p, "--out", outPath], { timeout: 30_000 });
    const st = await fs.stat(outPath);
    if (st.isFile() && st.size > 0) return outPath;
  } catch {
    // Fall through to alternate converters.
  }

  // Fallback 1: skill-bundled converter script (ImageMagick-based)
  const converterScript = resolveLocalSkillPath("convert-heic.sh");
  if (converterScript) {
    try {
      await execFile("/bin/bash", [converterScript, p, outPath, "85"], { timeout: 30_000 });
      const st = await fs.stat(outPath);
      if (st.isFile() && st.size > 0) return outPath;
    } catch {
      // Fall through to direct magick call.
    }
  }

  // Fallback 2: direct ImageMagick invocation if available in PATH.
  try {
    await execFile("/usr/bin/env", ["magick", "convert", p, "-quality", "85", outPath], { timeout: 30_000 });
    const st = await fs.stat(outPath);
    if (st.isFile() && st.size > 0) return outPath;
  } catch {
    // No converter available.
  }

  return null;
}

function isTruthyEnv(value) {
  const v = String(value ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "y" || v === "on";
}

function resolveOpenclawStateDir(env = process.env) {
  const override = String(env.OPENCLAW_STATE_DIR ?? env.CLAWDBOT_STATE_DIR ?? "").trim();
  if (override) return path.resolve(expandTilde(override));
  const home = String(env.HOME ?? "").trim() || os.homedir();
  return path.join(home, ".openclaw");
}

async function assertSafeOutboundFilePath(filePath) {
  if (!filePath) return;

  // Security hardening:
  // By default, only allow sending attachments that OpenClaw staged into its outbound media dir.
  // This prevents exfiltration of arbitrary local files if an attacker can trigger iMessage sends.
  // Escape hatch for trusted environments:
  //   OPENCLAW_IMESSAGE_ALLOW_ARBITRARY_FILES=1
  if (isTruthyEnv(process.env.OPENCLAW_IMESSAGE_ALLOW_ARBITRARY_FILES)) return;

  const stateDir = resolveOpenclawStateDir();
  const outboundDir = path.resolve(path.join(stateDir, "media", "outbound"));
  const resolvedFile = path.resolve(filePath);
  const outboundPrefix = outboundDir.endsWith(path.sep) ? outboundDir : outboundDir + path.sep;

  if (!resolvedFile.startsWith(outboundPrefix)) {
    throw new Error(
      `Refusing to send attachment outside OpenClaw outbound dir. file=${resolvedFile} outboundDir=${outboundDir} (set OPENCLAW_IMESSAGE_ALLOW_ARBITRARY_FILES=1 to override)`,
    );
  }

  // Realpath containment blocks symlink-based escapes via parent directories (not just the final file).
  let realOutboundDir;
  try {
    realOutboundDir = await fs.realpath(outboundDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Outbound dir not accessible: ${outboundDir} (${msg})`);
  }

  let realFile;
  try {
    realFile = await fs.realpath(resolvedFile);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Attachment not accessible: ${resolvedFile} (${msg})`);
  }

  const realOutboundPrefix = realOutboundDir.endsWith(path.sep) ? realOutboundDir : realOutboundDir + path.sep;
  if (!realFile.startsWith(realOutboundPrefix)) {
    throw new Error(
      `Refusing to send attachment outside OpenClaw outbound dir (realpath). file=${realFile} outboundDir=${realOutboundDir} (set OPENCLAW_IMESSAGE_ALLOW_ARBITRARY_FILES=1 to override)`,
    );
  }

  const lst = await fs.lstat(resolvedFile).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Attachment not accessible: ${resolvedFile} (${msg})`);
  });
  if (lst.isSymbolicLink()) throw new Error(`Refusing to send symlink attachment: ${resolvedFile}`);

  const st = await fs.stat(realFile).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Attachment not accessible: ${realFile} (${msg})`);
  });
  if (!st.isFile()) throw new Error(`Refusing to send non-file attachment: ${realFile}`);

  const maxBytesRaw = String(process.env.OPENCLAW_IMESSAGE_MAX_ATTACHMENT_BYTES ?? "").trim();
  if (maxBytesRaw) {
    const maxBytes = Number.parseInt(maxBytesRaw, 10);
    if (Number.isFinite(maxBytes) && maxBytes > 0 && st.size > maxBytes) {
      throw new Error(`Refusing to send attachment larger than ${maxBytes} bytes: ${realFile} (${st.size} bytes)`);
    }
  }
}

async function stageAttachmentForMessages(filePath) {
  // iMessage sending is handled by `imagent`, which is sandboxed and cannot read arbitrary paths
  // like ~/.openclaw/media/outbound. In practice, `imagent` can read user media folders like ~/Pictures,
  // and Messages will then copy the file into ~/Library/Messages/Attachments as part of the send.
  const p = String(filePath || "").trim();
  if (!p) return "";

  const resolved = path.resolve(p);
  const home = String(process.env.HOME ?? "").trim() || os.homedir();
  const stageDir = path.join(home, "Pictures", "OpenClawOutbound");
  const extRaw = path.extname(resolved) || "";
  const ext = extRaw && extRaw.length <= 12 ? extRaw : "";
  const rand = Math.random().toString(16).slice(2);
  const outName = `openclaw-${Date.now()}-${rand}${ext}`;
  const outPath = path.join(stageDir, outName);

  await fs.mkdir(stageDir, { recursive: true });
  await fs.copyFile(resolved, outPath);
  await fs.chmod(outPath, 0o600).catch(() => {});

  // Best-effort cleanup to avoid accumulating lots of staged copies.
  // Default: delete staged files older than 24 hours.
  try {
    const ttlHoursRaw = String(process.env.OPENCLAW_IMESSAGE_STAGE_TTL_HOURS ?? "").trim();
    const ttlHours = ttlHoursRaw ? Number.parseInt(ttlHoursRaw, 10) : 24;
    const ttlMs = Number.isFinite(ttlHours) && ttlHours > 0 ? ttlHours * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    const now = Date.now();
    const entries = await fs.readdir(stageDir, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      if (!ent.name.startsWith("openclaw-")) continue;
      const full = path.join(stageDir, ent.name);
      const st = await fs.stat(full).catch(() => null);
      if (!st || !st.isFile()) continue;
      if (now - st.mtimeMs > ttlMs) {
        await fs.unlink(full).catch(() => {});
      }
    }
  } catch {
    // ignore
  }

  return outPath;
}

function printRpcHelp() {
  process.stdout.write(`native-applescript (imsg rpc compatible)\n\n`);
  process.stdout.write(`Usage:\n  native-applescript.mjs rpc [--db <path>] [--help]\n\n`);
  process.stdout.write(`RPC methods:\n  send, chats.list, watch.subscribe, watch.unsubscribe\n`);
}

function parseRpcArgs(argv) {
  let dbPath;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db" && argv[i + 1]) {
      dbPath = argv[i + 1];
      i++;
      continue;
    }
    // Accept legacy-ish flag name variants just in case.
    if ((a === "--db-path" || a === "--dbPath") && argv[i + 1]) {
      dbPath = argv[i + 1];
      i++;
      continue;
    }
  }
  dbPath = expandTilde(dbPath?.trim()) || `${process.env.HOME}/Library/Messages/chat.db`;
  return { dbPath };
}

async function sendViaAppleScript({ target, targetKind, service, text, filePath, dbPath }) {
  const escapedText = escapeAppleScriptString(text ?? "");
  const escapedTarget = escapeAppleScriptString(target);
  const escapedFile = filePath ? escapeAppleScriptString(filePath) : "";

  if (isTruthyEnv(process.env.OPENCLAW_IMESSAGE_DEBUG)) {
    const fileLabel = filePath ? path.basename(String(filePath)) : "";
    logErr(`[imessage-native] sendViaAppleScript targetKind=${targetKind} service=${String(service || "auto")} target=${target} file=${fileLabel}`);
  }

  const servicePref =
    String(service || "auto").toLowerCase() === "imessage"
      ? ["iMessage"]
      : String(service || "auto").toLowerCase() === "sms"
        ? ["SMS"]
        : ["iMessage", "SMS"];

  // For group targets, we can't reliably select service; try direct chat addressing.
  if (targetKind !== "handle") {
    const scriptParts = [];
    scriptParts.push(`tell application "Messages"`);
    scriptParts.push(`set theChat to chat id "${escapedTarget}"`);
    if (escapedText) scriptParts.push(`send "${escapedText}" to theChat`);
    if (escapedFile) {
      // AppleScript is noticeably more reliable with explicit alias coercion for attachments.
      scriptParts.push(`set theAttachment to POSIX file "${escapedFile}" as alias`);
      scriptParts.push(`send theAttachment to theChat`);
    }
    scriptParts.push(`end tell`);
    const script = scriptParts.join("\n");
    await execFile("/usr/bin/osascript", ["-e", script], { timeout: 15_000 });
    return;
  }

  // For handles, prefer iMessage then SMS (or forced).
  let lastErr = null;
  for (const serviceType of servicePref) {
    // Creating a text chat and sending to that chat is more reliable for attachments than
    // sending a file directly to a buddy (which can silently fail for some accounts).
    const scriptParts = [];
    scriptParts.push(`tell application "Messages"`);
    scriptParts.push(`set targetService to 1st service whose service type is ${serviceType}`);
    scriptParts.push(`set targetBuddy to buddy "${escapedTarget}" of targetService`);
    scriptParts.push(`set theChat to make new text chat with properties {participants:{targetBuddy}}`);
    scriptParts.push(`delay 0.1`);
    if (escapedText) scriptParts.push(`send "${escapedText}" to theChat`);
    if (escapedFile) {
      scriptParts.push(`delay 0.1`);
      scriptParts.push(`set theAttachment to POSIX file "${escapedFile}" as alias`);
      scriptParts.push(`send theAttachment to theChat`);
    }
    scriptParts.push(`end tell`);
    const script = scriptParts.join("\n");
    try {
      await execFile("/usr/bin/osascript", ["-e", script], { timeout: 30_000 });
      return;
    } catch (err) {
      lastErr = err;
    }
  }

  // Fallback: attempt buddy sends (text/file) without creating a chat.
  for (const serviceType of servicePref) {
    const scriptParts = [];
    scriptParts.push(`tell application "Messages"`);
    scriptParts.push(`set targetService to 1st service whose service type is ${serviceType}`);
    scriptParts.push(`set targetBuddy to buddy "${escapedTarget}" of targetService`);
    if (escapedText) scriptParts.push(`send "${escapedText}" to targetBuddy`);
    if (escapedFile) {
      scriptParts.push(`set theAttachment to POSIX file "${escapedFile}" as alias`);
      scriptParts.push(`send theAttachment to targetBuddy`);
    }
    scriptParts.push(`end tell`);
    const script = scriptParts.join("\n");
    try {
      await execFile("/usr/bin/osascript", ["-e", script], { timeout: 30_000 });
      return;
    } catch (err) {
      lastErr = err;
    }
  }

  // Fallback: try generic buddy send without picking a service.
  try {
    const scriptParts = [];
    scriptParts.push(`tell application "Messages"`);
    if (escapedText) scriptParts.push(`send "${escapedText}" to buddy "${escapedTarget}"`);
    if (escapedFile) {
      scriptParts.push(`set theAttachment to POSIX file "${escapedFile}" as alias`);
      scriptParts.push(`send theAttachment to buddy "${escapedTarget}"`);
    }
    scriptParts.push(`end tell`);
    const script = scriptParts.join("\n");
    await execFile("/usr/bin/osascript", ["-e", script], { timeout: 15_000 });
    return;
  } catch (err) {
    throw lastErr ?? err;
  }
}

function looksLikeChatId(value) {
  const v = String(value ?? "").trim();
  if (!v) return false;
  if (v.includes(";")) return true; // e.g. iMessage;+;chat123...
  if (v.startsWith("chat")) return true; // group chats often start with chat*
  return false;
}

function looksLikeHandle(value) {
  const v = String(value ?? "").trim();
  if (!v) return false;
  if (v.includes("@")) return true;
  // E.164 and other phone number-ish forms.
  return /^[+0-9][0-9 ()-]*$/.test(v);
}

function isOpenclawMediaPlaceholderText(text) {
  const t = String(text ?? "").trim().toLowerCase();
  return (
    t === "<media:image>" ||
    t === "<media:video>" ||
    t === "<media:audio>" ||
    t === "<media:attachment>" ||
    t === "<media:document>"
  );
}

function parseSendTarget(params) {
  if (params?.chat_id != null) return { kind: "chat_id", value: String(params.chat_id) };
  if (params?.chat_guid != null) return { kind: "chat_guid", value: String(params.chat_guid) };
  if (params?.chat_identifier != null) return { kind: "chat_identifier", value: String(params.chat_identifier) };
  if (params?.to != null) return { kind: "handle", value: String(params.to) };
  return null;
}

async function lookupChatTargetsFromRowId(dbPath, rowId) {
  const clean = String(rowId).replace(/[^0-9]/g, "");
  if (!clean) return null;
  const query = `SELECT guid, chat_identifier FROM chat WHERE ROWID = ${clean} LIMIT 1;`;
  const { stdout } = await execFile("/usr/bin/sqlite3", ["-separator", "|", dbPath, query], {
    timeout: 2_000,
    maxBuffer: 1024 * 1024,
  });
  const line = stdout.trim();
  if (!line) return null;
  const [guidRaw, identRaw] = line.split("|");
  const guid = String(guidRaw ?? "").trim() || null;
  const chatIdentifier = String(identRaw ?? "").trim() || null;
  return { guid, chat_identifier: chatIdentifier };
}

function buildPollQuery({ lastMessageTime, includeAttachments }) {
  const baseSelect = [
    "message.ROWID as message_id",
    "REPLACE(REPLACE(REPLACE(COALESCE(message.text, ''), CHAR(13), '<<CR>>'), CHAR(10), '<<LF>>'), '|', '<<PIPE>>') as text",
    "message.date",
    "message.is_from_me",
    "handle.id as sender",
    "chat.ROWID as chat_id",
    "REPLACE(chat.chat_identifier, '|', '<<PIPE>>') as chat_identifier",
    "REPLACE(COALESCE(chat.display_name, ''), '|', '<<PIPE>>') as display_name",
    "message.associated_message_type",
  ];

  const joins = [
    "FROM message",
    "LEFT JOIN handle ON message.handle_id = handle.ROWID",
    "LEFT JOIN chat_message_join ON message.ROWID = chat_message_join.message_id",
    "LEFT JOIN chat ON chat_message_join.chat_id = chat.ROWID",
  ];

  if (includeAttachments) {
    baseSelect.push("REPLACE(COALESCE(attachment.filename, ''), '|', '<<PIPE>>') as filename");
    baseSelect.push("COALESCE(attachment.mime_type, '') as mime_type");
    baseSelect.push("COALESCE(attachment.ROWID, '') as attachment_id");
    joins.push("LEFT JOIN message_attachment_join ON message.ROWID = message_attachment_join.message_id");
    joins.push("LEFT JOIN attachment ON message_attachment_join.attachment_id = attachment.ROWID");
  }

  const where = [
    `WHERE message.date > ${lastMessageTime.toString()}`,
    "AND message.is_from_me = 0",
    "AND message.cache_roomnames IS NULL",
  ];

  const orderBy = includeAttachments
    ? "ORDER BY message.date ASC, attachment.ROWID ASC"
    : "ORDER BY message.date ASC";

  const query = [
    `SELECT ${baseSelect.join(", ")}`,
    joins.join(" "),
    where.join(" "),
    orderBy,
    "LIMIT 500",
  ]
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  return query;
}

function isProbablyGroup({ chatIdentifier, displayName }) {
  const ident = (chatIdentifier ?? "").trim();
  const name = (displayName ?? "").trim();
  if (name) return true;
  if (!ident) return false;
  if (ident.startsWith("chat")) return true;
  return false;
}

function buildMessageObject(row, includeAttachments) {
  const messageId = row.message_id;
  const text = sanitizeInboundText(row.text, row.attachments);
  const dateNs = row.date_ns;
  const createdAtIso = row.created_at;

  const sender = row.sender;
  const chatId = row.chat_id;
  const chatIdentifier = row.chat_identifier;
  const displayName = row.display_name;

  const group = isProbablyGroup({ chatIdentifier, displayName });

  const msg = {
    id: messageId ? Number(messageId) : undefined,
    text,
    sender,
    chat_id: chatId ? Number(chatId) : undefined,
    chat_identifier: chatIdentifier,
    chat_name: displayName || undefined,
    is_group: group,
    is_from_me: false,
    created_at: createdAtIso,
    date: dateNs, // keep raw Apple epoch ns for debugging
  };

  if (includeAttachments) {
    msg.attachments = row.attachments;
  }

  return msg;
}

async function runRpcServer({ dbPath }) {
  let subscribed = false;
  let includeAttachments = false;
  let subscriptionId = null;
  let pollTimer = null;

  // Track date in Apple epoch ns (BigInt).
  // Persist lastMessageTime to disk so restarts don't miss messages.
  const STATE_FILE = path.join(os.homedir(), ".openclaw", "imessage-poll-state.json");
  const nowAppleNs = unixMsToAppleNs(BigInt(Date.now()));
  let lastMessageTime = nowAppleNs - 1800n * NS_PER_S; // 30 min lookback default
  try {
    const stateRaw = await fs.readFile(STATE_FILE, "utf8");
    const state = JSON.parse(stateRaw);
    if (state.lastMessageTime) {
      const saved = BigInt(state.lastMessageTime);
      // Use saved time if it's within last 24 hours, otherwise use 30 min lookback
      if (saved > nowAppleNs - 86400n * NS_PER_S && saved < nowAppleNs) {
        lastMessageTime = saved;
        logErr(`[poll] restored lastMessageTime from state file: ${saved.toString()}`);
      }
    }
  } catch { /* no state file yet, use default */ }
  if (lastMessageTime < 0n) lastMessageTime = 0n;
  const knownMessageIds = new Set();

  async function saveState() {
    try {
      await fs.writeFile(STATE_FILE, JSON.stringify({ lastMessageTime: lastMessageTime.toString(), updatedAt: new Date().toISOString() }));
    } catch (e) { logErr(`[poll] failed to save state: ${e}`); }
  }

  async function pollOnce() {
    if (!subscribed) { logErr("[poll] not subscribed, skipping"); return; }
    logErr(`[poll] polling (lastMessageTime=${lastMessageTime.toString()})`);

    const query = buildPollQuery({ lastMessageTime, includeAttachments });
    let stdout = "";
    try {
      const res = await execFile(
        "/usr/bin/sqlite3",
        ["-separator", "|", dbPath, query],
        { timeout: 3_000, maxBuffer: 10 * 1024 * 1024 },
      );
      stdout = res.stdout ?? "";
    } catch (err) {
      // Report watch errors as notifications (matching imsg rpc convention).
      writeJsonLine({ jsonrpc: "2.0", method: "error", params: { error: String(err) } });
      return;
    }

    const trimmed = stdout.trim();
    if (!trimmed) return;

    const lines = trimmed.split("\n").filter(Boolean);
    const byId = new Map();

    for (const line of lines) {
      const parts = line.split("|");
      const baseCount = includeAttachments ? 12 : 9;
      if (parts.length < baseCount) continue;

      const messageId = parts[0];
      const text = decodeSqlEscapes(parts[1] ?? "");
      const dateStr = parts[2] ?? "";
      const sender = parts[4] ?? "";
      const chatId = parts[5] ?? "";
      const chatIdentifier = decodeSqlEscapes(parts[6] ?? "");
      const displayName = decodeSqlEscapes(parts[7] ?? "");
      const assocType = parts[8] ?? "0";

      if (!messageId || !dateStr) continue;
      if (assocType && assocType !== "0") continue; // skip reactions/system associated messages
      if (!sender.trim()) continue; // OpenClaw drops messages without sender

      let dateNs;
      try {
        dateNs = BigInt(dateStr);
      } catch {
        continue;
      }

      const existing = byId.get(messageId);
      if (!existing) {
        const unixMs = appleNsToUnixMs(dateNs);
        const createdAt = new Date(Number(unixMs)).toISOString();
        byId.set(messageId, {
          message_id: messageId,
          text,
          date_ns: dateStr,
          date_ns_big: dateNs,
          created_at: createdAt,
          sender: sender.trim(),
          chat_id: chatId ? String(chatId) : undefined,
          chat_identifier: chatIdentifier,
          display_name: displayName,
          attachments: [],
        });
      } else if (!existing.text && text) {
        existing.text = text;
      }

      if (includeAttachments) {
        const filename = decodeSqlEscapes(parts[9] ?? "");
        const mimeType = parts[10] ?? "";
        const attachmentId = parts[11] ?? "";
        const attachmentPath = normalizeAttachmentPath(filename);
        if (attachmentPath) {
          let missing = false;
          try {
            await fs.access(attachmentPath);
          } catch (err) {
            if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") missing = true;
          }

          let normalizedMime = normalizeMimeType(mimeType, attachmentPath);
          if (!normalizedMime) normalizedMime = await sniffMimeTypeFromFilePath(attachmentPath);

          let finalPath = attachmentPath;
          let finalMime = normalizedMime;
          if (finalMime === "image/heic" || finalMime === "image/heif") {
            const converted = await maybeConvertHeicToJpeg(attachmentPath, attachmentId);
            if (converted) {
              finalPath = converted;
              finalMime = "image/jpeg";
            }
          }

          byId.get(messageId).attachments.push({
            attachment_id: attachmentId || undefined,
            original_path: finalPath,
            mime_type: finalMime || undefined,
            missing,
          });
        }
      }
    }

    const records = Array.from(byId.values()).sort((a, b) =>
      a.date_ns_big < b.date_ns_big ? -1 : a.date_ns_big > b.date_ns_big ? 1 : 0,
    );

    for (const rec of records) {
      // Update lastMessageTime for all parsed rows to prevent re-query loops even if we skip emissions.
      if (rec.date_ns_big > lastMessageTime) { lastMessageTime = rec.date_ns_big; saveState(); }

      if (knownMessageIds.has(rec.message_id)) continue;
      knownMessageIds.add(rec.message_id);

      // Keep memory bounded.
      if (knownMessageIds.size > 2000) {
        // Evict oldest-ish by recreating set from the tail. Order in Set is insertion order.
        const keep = Array.from(knownMessageIds).slice(-1500);
        knownMessageIds.clear();
        for (const id of keep) knownMessageIds.add(id);
      }

      const msg = buildMessageObject(rec, includeAttachments);
      writeJsonLine({ jsonrpc: "2.0", method: "message", params: { message: msg } });
    }
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      pollOnce().catch((err) => {
        writeJsonLine({ jsonrpc: "2.0", method: "error", params: { error: String(err) } });
      });
    }, 2000);
    pollOnce().catch((err) => {
      writeJsonLine({ jsonrpc: "2.0", method: "error", params: { error: String(err) } });
    });
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  async function handleRpcRequest(req) {
    const id = req?.id;
    const method = req?.method;
    const params = req?.params ?? {};

    if (id === undefined || id === null) return;

    try {
      switch (method) {
        case "chats.list": {
          writeResult(id, { chats: [], count: 0 });
          return;
        }

        case "watch.subscribe": {
          logErr("[rpc] watch.subscribe called, attachments=" + Boolean(params.attachments));
          includeAttachments = Boolean(params.attachments);
          subscribed = true;
          subscriptionId = subscriptionId ?? `sub-${Date.now()}`;
          startPolling();
          writeResult(id, { subscription: subscriptionId });
          return;
        }

        case "watch.unsubscribe": {
          subscribed = false;
          stopPolling();
          writeResult(id, { ok: true });
          return;
        }

        case "send": {
          const target = parseSendTarget(params);
          let text = String(params.text ?? "");
          const filePath = params.file ? normalizeAttachmentPath(params.file) : "";

          if (!target) {
            throw new Error("Missing required parameter: to|chat_id|chat_guid|chat_identifier");
          }
          if (!text.trim() && !filePath) {
            throw new Error("Missing required parameter: text or file");
          }

          // OpenClaw uses placeholder text (e.g. "<media:image>") when sending attachments without a user-supplied
          // caption. Humans don't need (or want) that string.
          if (filePath && isOpenclawMediaPlaceholderText(text)) {
            text = "";
          }

          if (filePath) await assertSafeOutboundFilePath(filePath);

          let sendTargetKind = target.kind;
          let sendTargetValue = target.value;

          // Some OpenClaw code passes chat_identifier even for DMs, where chat_identifier is just the handle.
          // Normalize those to "handle" so AppleScript buddy/chat creation can resolve them.
          if (sendTargetKind === "chat_identifier" && looksLikeHandle(sendTargetValue) && !looksLikeChatId(sendTargetValue)) {
            sendTargetKind = "handle";
          }

          // Best-effort: when OpenClaw sends to chat_id (SQLite ROWID), map it to a stable identifier.
          if (sendTargetKind === "chat_id" && /^\d+$/.test(sendTargetValue)) {
            const mapped = await lookupChatTargetsFromRowId(dbPath, sendTargetValue).catch(() => null);
            if (mapped?.guid && looksLikeChatId(mapped.guid)) {
              sendTargetKind = "chat_guid";
              sendTargetValue = mapped.guid;
            } else if (mapped?.chat_identifier) {
              sendTargetValue = mapped.chat_identifier;
              sendTargetKind =
                looksLikeHandle(sendTargetValue) && !looksLikeChatId(sendTargetValue) ? "handle" : "chat_identifier";
            }
          }

          const stagedFilePath = filePath
            ? await stageAttachmentForMessages(filePath).catch((err) => {
                logErr(`[imessage-native] staging failed; sending original path. err=${String(err)}`);
                return filePath;
              })
            : undefined;

          await sendViaAppleScript({
            target: sendTargetValue,
            targetKind: sendTargetKind === "handle" ? "handle" : "chat",
            service: params.service,
            text,
            filePath: stagedFilePath,
            dbPath,
          });

          writeResult(id, { ok: true, messageId: `sent-${Date.now()}` });
          return;
        }

        default: {
          writeError(id, new Error(`Method not found: ${String(method)}`), -32601);
        }
      }
    } catch (err) {
      writeError(id, err);
    }
  }

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const trimmed = String(line).trim();
    if (!trimmed) return;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      // Can't respond without a request id. Surface on stderr.
      logErr(`rpc parse error: ${String(err)}`);
      return;
    }
    handleRpcRequest(parsed).catch((err) => {
      logErr(`rpc handler error: ${String(err)}`);
    });
  });
  rl.on("close", () => {
    subscribed = false;
    stopPolling();
    process.exit(0);
  });

  // If OpenClaw kills us, shut down cleanly.
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => {
      subscribed = false;
      stopPolling();
      process.exit(0);
    });
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "--help" || cmd === "-h") {
    printRpcHelp();
    process.exit(0);
  }

  if (cmd !== "rpc") {
    // Keep this non-fatal for probes; we only support rpc mode.
    logErr(`Unknown command: ${cmd}`);
    process.exit(1);
  }

  if (rest.includes("--help") || rest.includes("-h")) {
    printRpcHelp();
    process.exit(0);
  }

  const { dbPath } = parseRpcArgs(rest);
  await runRpcServer({ dbPath });
}

main().catch((err) => {
  logErr(String(err?.stack ?? err));
  process.exit(1);
});

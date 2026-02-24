/**
 * Drop-in replacement for OpenClaw's iMessage client using native AppleScript
 * Compatible with the original IMessageRpcClient interface
 */

import { promisify } from "node:util";
import { exec as execCallback } from "node:child_process";

const exec = promisify(execCallback);

export class IMessageRpcClient {
  cliPath;
  dbPath;
  runtime;
  onNotification;
  pending = new Map();
  closed;
  closedResolve = null;
  child = null;
  reader = null;
  nextId = 1;
  
  // AppleScript-specific
  polling = false;
  pollInterval = null;
  lastMessageTime = 0;
  knownMessageIds = new Set();

  constructor(opts = {}) {
    this.cliPath = "native-applescript"; // Marker for native mode
    this.dbPath = opts.dbPath?.trim();
    this.runtime = opts.runtime;
    this.onNotification = opts.onNotification;
    this.closed = new Promise((resolve) => {
      this.closedResolve = resolve;
    });
  }

  async start() {
    if (this.polling) {
      return;
    }
    this.polling = true;
    
    // Initialize timestamp - look back 5 minutes to catch recent messages
    const now = Date.now() / 1000;
    const lookbackSeconds = 300; // 5 minutes
    const appleTime = ((now - lookbackSeconds) - 978307200) * 1000000000;
    this.lastMessageTime = appleTime;
    
    if (this.runtime?.debug) {
      this.runtime.debug(`iMessage polling started, lookback timestamp: ${appleTime}`);
    }
    
    // Start polling for new messages
    this.pollInterval = setInterval(() => {
      this.pollMessagesSqlite().catch((err) => {
        if (this.runtime?.debug) {
          this.runtime.debug(`Poll error: ${err.message}`);
        }
      });
    }, 2000);
    
    // Do an immediate poll
    this.pollMessagesSqlite().catch((err) => {
      if (this.runtime?.debug) {
        this.runtime.debug(`Initial poll error: ${err.message}`);
      }
    });
    
    this.runtime?.info?.("iMessage native client started");
  }

  async stop() {
    this.polling = false;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.closedResolve?.();
  }

  async waitForClose() {
    await this.closed;
  }

  async request(method, params, opts) {
    const timeoutMs = opts?.timeoutMs ?? 10_000;

    try {
      switch (method) {
        case "send":
          return await this.sendMessage(params, timeoutMs);
        
        case "chats.list":
          return await this.listChats(params, timeoutMs);
        
        case "watch.subscribe":
          // No-op for native (polling handles this)
          return { ok: true };
        
        default:
          throw new Error(`Unknown method: ${method}`);
      }
    } catch (err) {
      throw new Error(`iMessage ${method}: ${err.message}`);
    }
  }

  async sendMessage(params, timeoutMs) {
    const { text, to, chat_id, file } = params;
    
    if (!text && !file) {
      throw new Error("Missing required parameter: text or file");
    }
    
    if (!to && !chat_id) {
      throw new Error("Missing required parameter: to or chat_id");
    }

    const target = to || chat_id;
    const message = text || "";
    
    // Handle file attachments
    if (file) {
      return await this.sendFile(target, message, file, timeoutMs);
    }
    
    const escapedText = this.escapeAppleScriptString(message);
    const escapedTarget = this.escapeAppleScriptString(target);

    const script = `tell application "Messages" to send "${escapedText}" to buddy "${escapedTarget}"`;
    
    try {
      await exec(`osascript -e '${script}'`, { timeout: timeoutMs });
      return { ok: true, messageId: `sent-${Date.now()}` };
    } catch (err) {
      throw new Error(`Failed to send: ${err.message}`);
    }
  }

  async sendFile(target, caption, filePath, timeoutMs) {
    const escapedPath = this.escapeAppleScriptString(filePath);
    const escapedTarget = this.escapeAppleScriptString(target);
    const escapedCaption = caption ? this.escapeAppleScriptString(caption) : "";

    // Send file with optional caption
    const script = caption
      ? `tell application "Messages"
          set targetBuddy to buddy "${escapedTarget}"
          send "${escapedCaption}" to targetBuddy
          send POSIX file "${escapedPath}" to targetBuddy
        end tell`
      : `tell application "Messages" to send POSIX file "${escapedPath}" to buddy "${escapedTarget}"`;

    try {
      await exec(`osascript -e '${script.replace(/\n/g, " ")}'`, { timeout: timeoutMs });
      return { ok: true, messageId: `sent-${Date.now()}` };
    } catch (err) {
      throw new Error(`Failed to send file: ${err.message}`);
    }
  }

  async listChats(params, timeoutMs) {
    // Simple probe - just return success
    return { chats: [], count: 0 };
  }

  async pollMessagesSqlite() {
    const pollStartedAt = new Date();
    this._pollCounter = (this._pollCounter ?? 0) + 1;
    const pollSeq = this._pollCounter;

    console.log(`[imessage-native][pollMessagesSqlite][${pollSeq}] CALLED`, {
      pollSeq,
      startedAtIso: pollStartedAt.toISOString(),
      polling: this.polling,
      lastMessageTime: this.lastMessageTime,
      knownMessageIdsSize: this.knownMessageIds?.size ?? null,
      pid: process.pid,
      node: process.version,
    });

    if (!this.polling) {
      console.log(
        `[imessage-native][pollMessagesSqlite][${pollSeq}] EARLY_RETURN polling=false`
      );
      return;
    }

    const dbPath = `${process.env.HOME}/Library/Messages/chat.db`;
    
    const query = `
      SELECT 
        message.ROWID,
        message.text,
        message.date,
        message.is_from_me,
        handle.id,
        chat.chat_identifier,
        chat.display_name,
        message.associated_message_type,
        attachment.filename,
        attachment.mime_type,
        attachment.ROWID as attachment_id
      FROM message
      LEFT JOIN handle ON message.handle_id = handle.ROWID
      LEFT JOIN chat_message_join ON message.ROWID = chat_message_join.message_id
      LEFT JOIN chat ON chat_message_join.chat_id = chat.ROWID
      LEFT JOIN message_attachment_join ON message.ROWID = message_attachment_join.message_id
      LEFT JOIN attachment ON message_attachment_join.attachment_id = attachment.ROWID
      WHERE message.date > ${this.lastMessageTime}
        AND message.is_from_me = 0
        AND message.cache_roomnames IS NULL
      ORDER BY message.date ASC, attachment.ROWID ASC
      LIMIT 500
    `.replace(/\n/g, " ").replace(/\s+/g, " ");

    try {
      const sqliteCmd = `sqlite3 -separator '|' "${dbPath}" "${query}"`;

      console.log(`[imessage-native][pollMessagesSqlite][${pollSeq}] SQL_QUERY`, {
        dbPath,
        lastMessageTime: this.lastMessageTime,
        query,
        sqliteCmd,
      });

      const { stdout } = await exec(
        sqliteCmd,
        { timeout: 3000 }
      );

      console.log(`[imessage-native][pollMessagesSqlite][${pollSeq}] SQLITE_STDOUT_META`, {
        stdoutType: typeof stdout,
        stdoutLength: stdout?.length ?? null,
        stdoutTrimmedLength: stdout?.trim?.().length ?? null,
      });

      console.log(
        `[imessage-native][pollMessagesSqlite][${pollSeq}] SQLITE_STDOUT_RAW_BEGIN\n${stdout}\n[imessage-native][pollMessagesSqlite][${pollSeq}] SQLITE_STDOUT_RAW_END`
      );

      if (!stdout.trim()) {
        if (this.runtime?.debug) {
          this.runtime.debug(`Poll: no new messages (lastTime: ${this.lastMessageTime})`);
        }
        console.log(
          `[imessage-native][pollMessagesSqlite][${pollSeq}] NO_RESULTS stdout was empty/whitespace-only`
        );
        return;
      }

      const rawLines = stdout.split("\n");
      const lines = stdout.trim().split("\n");
      console.log(`[imessage-native][pollMessagesSqlite][${pollSeq}] PARSE_LINES`, {
        rawLineCount: rawLines.length,
        trimmedLineCount: lines.length,
        sampleFirstLine: lines[0] ?? null,
      });

      if (this.runtime?.debug) {
        this.runtime.debug(`Poll: found ${lines.length} potential message rows`);
      }
      console.log(
        `[imessage-native][pollMessagesSqlite][${pollSeq}] FOUND_ROWS count=${lines.length} (pre-filter)`
      );
      
      // Group rows by message ID to handle multiple rows per message (due to attachments)
      const messageMap = new Map();
      let latestDate = this.lastMessageTime;
      let skippedCount = 0;
      
      for (const line of lines) {
        if (!line) {
          skippedCount++;
          console.log(
            `[imessage-native][pollMessagesSqlite][${pollSeq}] SKIP empty line encountered`
          );
          continue;
        }
        
        const parts = line.split("|");
        if (parts.length < 8) {
          skippedCount++;
          console.log(`[imessage-native][pollMessagesSqlite][${pollSeq}] SKIP malformed row`, {
            line,
            partsLength: parts.length,
            parts,
          });
          continue;
        }
        
        const [id, text, date, isFromMe, sender, chatId, displayName, associatedType, filename, mimeType, attachmentId] = parts;

        console.log(`[imessage-native][pollMessagesSqlite][${pollSeq}] ROW_PARSED`, {
          id,
          date,
          isFromMe,
          sender,
          chatId,
          displayName,
          associatedType,
          filename,
          mimeType,
          attachmentId,
          textLength: (text ?? "").length,
          textPreview: (text ?? "").slice(0, 120),
        });
        
        // Skip reactions and other associated messages
        if (associatedType && associatedType !== "0") {
          skippedCount++;
          console.log(
            `[imessage-native][pollMessagesSqlite][${pollSeq}] SKIP associated_message_type=${associatedType}`
          );
          continue;
        }
        
        if (!id || (!text && text !== "")) {
          skippedCount++;
          console.log(`[imessage-native][pollMessagesSqlite][${pollSeq}] SKIP due to guard`, {
            idMissing: !id,
            textIsNullish: text == null,
          });
          continue;
        }

        const msgDate = parseFloat(date);
        if (msgDate > latestDate) {
          latestDate = msgDate;
        }

        // Add or update message in map
        if (!messageMap.has(id)) {
          messageMap.set(id, {
            id,
            text,
            date: msgDate,
            isFromMe,
            sender,
            chatId,
            displayName,
            attachments: [],
          });
        }

        // Collect attachment if present
        if (filename && attachmentId) {
          const attachmentPath = this.resolveAttachmentPath(filename);
          messageMap.get(id).attachments.push({
            filename,
            mime_type: mimeType || "application/octet-stream",
            path: attachmentPath,
            id: attachmentId,
          });
          console.log(`[imessage-native][pollMessagesSqlite][${pollSeq}] ATTACHMENT_COLLECTED`, {
            id,
            filename,
            mimeType,
            attachmentPath,
          });
        }
      }

      // Now emit messages that haven't been seen before
      let emittedCount = 0;
      for (const [id, msgData] of messageMap) {
        if (this.knownMessageIds.has(id)) {
          skippedCount++;
          console.log(`[imessage-native][pollMessagesSqlite][${pollSeq}] SKIP already known`, {
            id,
            knownMessageIdsSize: this.knownMessageIds.size,
          });
          continue;
        }

        this.knownMessageIds.add(id);
        console.log(`[imessage-native][pollMessagesSqlite][${pollSeq}] MARK_SEEN`, {
          id,
          knownMessageIdsSize: this.knownMessageIds.size,
        });
        
        if (this.knownMessageIds.size > 1000) {
          const toDelete = Array.from(this.knownMessageIds).slice(0, 500);
          toDelete.forEach(id => this.knownMessageIds.delete(id));
          console.log(
            `[imessage-native][pollMessagesSqlite][${pollSeq}] PRUNE_KNOWN_IDS`,
            {
              deleted: toDelete.length,
              knownMessageIdsSizeAfter: this.knownMessageIds.size,
            }
          );
        }

        // Determine if group chat
        const isGroup = (msgData.chatId && msgData.chatId.includes(";")) || false;
        
        // Format notification to match OpenClaw monitor expectations:
        // monitor-provider passes msg.params into a handler that expects params.message.
        const message = {
          id: msgData.id,
          guid: `native-${msgData.id}`,
          text: msgData.text || "",
          sender: msgData.sender || "unknown",
          handle: msgData.sender || "unknown",
          chat_id: msgData.chatId || msgData.sender,
          chat_guid: msgData.chatId || null,
          chat_identifier: msgData.chatId || msgData.sender,
          chat_name: msgData.displayName || null,
          is_group: isGroup,
          is_from_me: false,
          service: "iMessage",
          // Best-effort timestamps (monitor uses created_at if present)
          timestamp: msgData.date,
          date: msgData.date,
          created_at: new Date().toISOString(),
          // Add attachments array
          attachments: msgData.attachments && msgData.attachments.length > 0 ? msgData.attachments : undefined,
        };

        const notification = {
          method: "message",
          params: { message },
        };
        
        if (this.runtime?.debug) {
          const attachmentInfo = msgData.attachments?.length ? ` (${msgData.attachments.length} attachment(s))` : "";
          this.runtime.debug(`Notifying: ${msgData.text.substring(0, 50)} from ${msgData.sender}${attachmentInfo}`);
        }

        console.log(
          `[imessage-native][pollMessagesSqlite][${pollSeq}] BEFORE_onNotification`,
          {
            id: msgData.id,
            sender: msgData.sender,
            chatId: msgData.chatId,
            displayName: msgData.displayName,
            isGroup,
            msgDate: msgData.date,
            attachmentCount: msgData.attachments?.length ?? 0,
            textPreview: (msgData.text ?? "").slice(0, 200),
            notification,
          }
        );
        
        this.onNotification?.(notification);
        emittedCount++;
      }

      if (latestDate > this.lastMessageTime) {
        console.log(`[imessage-native][pollMessagesSqlite][${pollSeq}] UPDATE_lastMessageTime`, {
          prev: this.lastMessageTime,
          next: latestDate,
        });
        this.lastMessageTime = latestDate;
      } else {
        console.log(
          `[imessage-native][pollMessagesSqlite][${pollSeq}] KEEP_lastMessageTime`,
          {
            current: this.lastMessageTime,
            latestDate,
          }
        );
      }

      console.log(`[imessage-native][pollMessagesSqlite][${pollSeq}] POLL_SUMMARY`, {
        emittedCount,
        skippedCount,
        knownMessageIdsSize: this.knownMessageIds.size,
        finalLastMessageTime: this.lastMessageTime,
        durationMs: Date.now() - pollStartedAt.getTime(),
      });
    } catch (err) {
      // Silently handle errors during polling
      console.log(`[imessage-native][pollMessagesSqlite][${pollSeq}] ERROR`, {
        message: err?.message,
        stack: err?.stack,
        name: err?.name,
      });
    }
  }

  resolveAttachmentPath(filename) {
    if (!filename) return null;

    // If filename is absolute path, use as-is
    if (filename.startsWith("/")) {
      return filename;
    }

    // Otherwise, assume it's in ~/Library/Messages/Attachments/
    const attachmentPath = `${process.env.HOME}/Library/Messages/Attachments/${filename}`;
    return attachmentPath;
  }

  escapeAppleScriptString(str) {
    if (!str) return "";
    return str
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t");
  }

  // Compatibility methods (no-ops for native)
  handleLine(line) {}
  failAll(err) {}
}

export async function createIMessageRpcClient(opts = {}) {
  const client = new IMessageRpcClient(opts);
  await client.start();
  return client;
}

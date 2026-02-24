#!/usr/bin/env node
/**
 * Example: Monitor for incoming iMessages
 * Usage: node receive-messages.mjs
 * Press Ctrl+C to stop
 */

import { createIMessageRpcClient } from '../client-native.mjs';

console.log('🔍 Monitoring for iMessages... (Ctrl+C to stop)\n');

const client = await createIMessageRpcClient({
  runtime: {
    debug: (msg) => console.log(`[DEBUG] ${msg}`),
    info: (msg) => console.log(`[INFO] ${msg}`)
  },
  onNotification: (notification) => {
    const msg = notification.params.message;
    
    const timestamp = new Date().toISOString();
    const from = msg.sender || 'unknown';
    const text = msg.text || '<no text>';
    const isGroup = msg.is_group ? ' (group)' : '';
    
    console.log(`\n📨 [${timestamp}] From: ${from}${isGroup}`);
    console.log(`   ${text}`);
    
    if (msg.attachments && msg.attachments.length > 0) {
      console.log(`   📎 Attachments: ${msg.attachments.length}`);
      msg.attachments.forEach((att, i) => {
        console.log(`      ${i + 1}. ${att.filename} (${att.mime_type})`);
        console.log(`         ${att.path}`);
      });
    }
  }
});

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n\n👋 Stopping...');
  await client.stop();
  process.exit(0);
});

// Keep running
await client.waitForClose();

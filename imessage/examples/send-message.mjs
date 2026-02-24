#!/usr/bin/env node
/**
 * Example: Send a text message via iMessage
 * Usage: node send-message.mjs "+1234567890" "Hello!"
 */

import { createIMessageRpcClient } from '../client-native.mjs';

const [to, text] = process.argv.slice(2);

if (!to || !text) {
  console.error('Usage: node send-message.mjs <phone> <message>');
  console.error('Example: node send-message.mjs "+1234567890" "Hello!"');
  process.exit(1);
}

const client = await createIMessageRpcClient({
  runtime: {
    debug: (msg) => console.log(`[DEBUG] ${msg}`),
    info: (msg) => console.log(`[INFO] ${msg}`)
  }
});

try {
  const result = await client.request('send', { to, text });
  console.log('✅ Message sent:', result);
} catch (err) {
  console.error('❌ Error sending message:', err.message);
  process.exit(1);
} finally {
  await client.stop();
}

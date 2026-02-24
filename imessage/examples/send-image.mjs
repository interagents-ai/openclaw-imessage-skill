#!/usr/bin/env node
/**
 * Example: Send an image via iMessage
 * Usage: node send-image.mjs "+1234567890" "/path/to/image.jpg" "Optional caption"
 */

import { createIMessageRpcClient } from '../client-native.mjs';

const [to, imagePath, caption] = process.argv.slice(2);

if (!to || !imagePath) {
  console.error('Usage: node send-image.mjs <phone> <image-path> [caption]');
  console.error('Example: node send-image.mjs "+1234567890" "/tmp/photo.jpg" "Check this out!"');
  process.exit(1);
}

const client = await createIMessageRpcClient({
  runtime: {
    debug: (msg) => console.log(`[DEBUG] ${msg}`),
    info: (msg) => console.log(`[INFO] ${msg}`)
  }
});

try {
  const params = {
    to,
    file: imagePath,
  };
  
  if (caption) {
    params.text = caption;
  }
  
  const result = await client.request('send', params);
  console.log('✅ Image sent:', result);
} catch (err) {
  console.error('❌ Error sending image:', err.message);
  process.exit(1);
} finally {
  await client.stop();
}

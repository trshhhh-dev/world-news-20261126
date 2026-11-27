import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const html = join(here, 'render.html');
const output = join(here, 'entry.png');
const MAX_BYTES = 1048576;
const MAX_SIDE = 1024;

const chrome = spawnSync(
  '/usr/bin/google-chrome',
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1024,1024',
    `--screenshot=${output}`,
    `file://${html}`,
  ],
  { cwd: here, stdio: 'inherit' },
);
if (chrome.error) throw chrome.error;
if (chrome.status !== 0) throw new Error(`google-chrome exited with status ${chrome.status}`);
if (!existsSync(output)) throw new Error('google-chrome did not write entry.png');

const bytes = readFileSync(output);
const isPng = bytes.length >= 24 &&
  bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
  bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
const isJpeg = bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
if (!isPng && !isJpeg) throw new Error('entry.png is neither a PNG nor a JPEG');
if (bytes.length > MAX_BYTES) throw new Error(`entry.png is ${bytes.length} bytes (max ${MAX_BYTES})`);

function pngDimensions(buf) {
  if (buf.toString('ascii', 12, 16) !== 'IHDR') throw new Error('PNG has no IHDR chunk');
  if (buf.toString('ascii', buf.length - 8, buf.length - 4) !== 'IEND') {
    throw new Error('PNG is truncated (no IEND chunk)');
  }
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

function jpegDimensions(buf) {
  let at = 2;
  while (at + 9 < buf.length) {
    if (buf[at] !== 0xff) { at += 1; continue; }
    const marker = buf[at + 1];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return [buf.readUInt16BE(at + 7), buf.readUInt16BE(at + 5)];
    }
    const len = buf.readUInt16BE(at + 2);
    if (len < 2) break;
    at += 2 + len;
  }
  throw new Error('JPEG has no readable SOF dimensions');
}

const [width, height] = isPng ? pngDimensions(bytes) : jpegDimensions(bytes);
if (width > MAX_SIDE || height > MAX_SIDE) {
  throw new Error(`entry.png is ${width}x${height} (max ${MAX_SIDE}x${MAX_SIDE})`);
}

console.log(`entry.png: ${isPng ? 'PNG' : 'JPEG'} ${width}x${height}, ${bytes.length} bytes`);

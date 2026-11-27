import { readFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_BYTES = 1048576;
const MAX_SIDE = 1024;
const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(HERE, 'entry.png');

function fail(message: string): never {
  console.error(`entry.png: ${message}`);
  process.exit(1);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngInfo(bytes: Buffer): { kind: string; width: number; height: number } {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(signature)) {
    fail('not a PNG (bad 8-byte signature)');
  }

  let at = 8;
  let width = 0;
  let height = 0;
  let sawIHDR = false;
  let sawIDAT = false;
  let sawIEND = false;

  while (at + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(at);
    if (length > bytes.length - at - 12) fail(`PNG chunk at ${at} is truncated`);
    const type = bytes.toString('ascii', at + 4, at + 8);
    const dataStart = at + 8;
    const dataEnd = dataStart + length;
    const storedCRC = bytes.readUInt32BE(dataEnd);
    const computedCRC = crc32(bytes, at + 4, dataEnd);
    if (storedCRC !== computedCRC) fail(`PNG CRC mismatch in ${type} chunk at ${at}`);

    if (!sawIHDR) {
      if (type !== 'IHDR') fail('PNG first chunk is not IHDR');
      if (length !== 13) fail('PNG IHDR chunk has the wrong length');
      width = bytes.readUInt32BE(dataStart);
      height = bytes.readUInt32BE(dataStart + 4);
      sawIHDR = true;
    } else if (type === 'IEND') {
      if (length !== 0) fail('PNG IEND chunk is not empty');
      sawIEND = true;
      at = dataEnd + 4;
      if (at !== bytes.length) fail('PNG has bytes after IEND');
      break;
    } else if (type === 'IDAT') {
      sawIDAT = true;
    }

    at = dataEnd + 4;
  }

  if (!sawIHDR) fail('PNG has no IHDR chunk');
  if (!sawIDAT) fail('PNG has no IDAT image data');
  if (!sawIEND) fail('PNG has no IEND chunk');
  return { kind: 'PNG', width, height };
}

function jpegInfo(bytes: Buffer): { kind: string; width: number; height: number } {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    fail('not a JPEG (bad signature)');
  }

  let at = 2;
  let width = 0;
  let height = 0;

  while (at + 1 < bytes.length) {
    if (bytes[at] !== 0xff) fail(`JPEG marker expected at ${at}`);
    while (at < bytes.length && bytes[at] === 0xff) at++;
    if (at >= bytes.length) break;
    const marker = bytes[at++];

    if (marker === 0xd9) {
      if (at !== bytes.length) fail('JPEG has bytes after EOI');
      if (!width || !height) fail('JPEG has no readable SOF dimensions');
      return { kind: 'JPEG', width, height };
    }
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }

    if (at + 2 > bytes.length) fail('JPEG segment header is truncated');
    const length = bytes.readUInt16BE(at);
    if (length < 2 || at + length > bytes.length) fail(`JPEG segment at ${at} has an invalid length`);

    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (length < 8) fail('JPEG SOF segment is too short');
      height = bytes.readUInt16BE(at + 3);
      width = bytes.readUInt16BE(at + 5);
    }

    at += length;

    if (marker === 0xda) {
      while (at + 1 < bytes.length) {
        if (bytes[at] === 0xff) {
          const next = bytes[at + 1];
          if (next !== 0x00 && !(next >= 0xd0 && next <= 0xd7)) break;
          at += 2;
        } else {
          at++;
        }
      }
    }
  }

  fail('JPEG has no EOI marker');
}

function main(): void {
  const bytes = readFileSync(SOURCE);
  if (bytes.length > MAX_BYTES) fail(`${bytes.length} bytes exceeds the ${MAX_BYTES}-byte limit`);

  const isPng = bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
  const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (!isPng && !isJpeg) fail('file is neither a PNG nor a JPEG');

  const info = isPng ? pngInfo(bytes) : jpegInfo(bytes);
  if (info.width < 1 || info.height < 1) fail(`invalid dimensions ${info.width}x${info.height}`);
  if (info.width > MAX_SIDE || info.height > MAX_SIDE) {
    fail(`${info.width}x${info.height} exceeds the ${MAX_SIDE}x${MAX_SIDE} limit`);
  }

  const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  mkdirSync(outputDir, { recursive: true });
  copyFileSync(SOURCE, join(outputDir, 'entry.png'));
  console.log(`entry.png: ${info.kind} ${info.width}x${info.height}, ${bytes.length} bytes`);
}

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

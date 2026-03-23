import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const SVG_PATH = new URL('../packages/extension/assets/remotestorage-logo.svg', import.meta.url);
const OUT_DIR = new URL('../packages/extension/assets', import.meta.url);
const SIZES = [16, 32, 48, 128];
const FILL = { r: 255, g: 75, b: 3, a: 255 };

function parsePolygonPoints(svgText) {
  const match = svgText.match(/<polygon[^>]*points="([^"]+)"/i);
  if (!match) {
    throw new Error('Could not find polygon points in logo SVG.');
  }

  return match[1]
    .trim()
    .split(/\s+/)
    .map((point) => {
      const [x, y] = point.split(',').map(Number);
      return { x, y };
    });
}

function pointInPolygon(x, y, polygon) {
  let inside = false;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;

    const intersects = ((yi > y) !== (yj > y))
      && (x < ((xj - xi) * (y - yi)) / ((yj - yi) || Number.EPSILON) + xi);

    if (intersects) {
      inside = !inside;
    }
  }

  return inside;
}

function crc32(buffer) {
  let crc = 0xffffffff;

  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);

  return Buffer.concat([length, typeBuffer, data, crc]);
}

function renderPng(size, polygon) {
  const width = size;
  const height = size;
  const scaleX = width / 739;
  const scaleY = height / 853;
  const scaledPolygon = polygon.map((point) => ({
    x: point.x * scaleX,
    y: point.y * scaleY,
  }));

  const rowLength = width * 4 + 1;
  const raw = Buffer.alloc(rowLength * height, 0);

  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowLength;
    raw[rowOffset] = 0;

    for (let x = 0; x < width; x++) {
      const sampleX = x + 0.5;
      const sampleY = y + 0.5;

      if (!pointInPolygon(sampleX, sampleY, scaledPolygon)) {
        continue;
      }

      const pixelOffset = rowOffset + 1 + x * 4;
      raw[pixelOffset] = FILL.r;
      raw[pixelOffset + 1] = FILL.g;
      raw[pixelOffset + 2] = FILL.b;
      raw[pixelOffset + 3] = FILL.a;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const svgText = fs.readFileSync(SVG_PATH, 'utf8');
const polygon = parsePolygonPoints(svgText);

for (const size of SIZES) {
  const png = renderPng(size, polygon);
  const outputPath = path.join(OUT_DIR.pathname, `icon-${size}.png`);
  fs.writeFileSync(outputPath, png);
  console.log(`Wrote ${outputPath}`);
}

import fs from 'fs';
import zlib from 'zlib';
import path from 'path';

// Standard PNG encoder with CRC32
function createPng(width, height, isMaskable) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c;
  }
  function crc32(buf) {
    let c = -1;
    for (let i = 0; i < buf.length; i++) {
      c = (c >>> 8) ^ crcTable[(c ^ buf[i]) & 0xff];
    }
    return (c ^ -1) >>> 0;
  }
  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crc]);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8-bit depth
  ihdr[9] = 6; // RGBA color

  const raw = Buffer.alloc(height * (1 + width * 4));

  // Normalized geometry coordinates on a 512x512 canvas:
  // Maskable scales down by 0.78 to guarantee that all elements reside well within the 80% circle (safe zone).
  const scale = isMaskable ? 0.75 : 0.88;

  // Shapes definition: [xNormCenter, yNormCenter, widthNorm, heightNorm, radiusNorm, [r,g,b]]
  const rects = [
    // Left sage bar
    { cx: 167 / 512, cy: 256 / 512, w: 22 / 512, h: 80 / 512, r: 11 / 512, col: [63, 97, 82] },
    // Center charcoal voice pillar
    { cx: 225 / 512, cy: 256 / 512, w: 30 / 512, h: 216 / 512, r: 15 / 512, col: [28, 25, 23] },
    // Interstitial terracotta pause pillar
    { cx: 287 / 512, cy: 272 / 512, w: 30 / 512, h: 184 / 512, r: 15 / 512, col: [184, 93, 59] },
    // Right sage bar
    { cx: 345 / 512, cy: 260 / 512, w: 22 / 512, h: 68 / 512, r: 11 / 512, col: [63, 97, 82] },
  ];

  const dot = { cx: 256 / 512, cy: 392 / 512, r: 8 / 512, col: [184, 93, 59] };

  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0; // Filter byte 0 (None)
    const ny = (y / height - 0.5) / scale + 0.5;

    for (let x = 0; x < width; x++) {
      const p = rowStart + 1 + x * 4;
      const nx = (x / width - 0.5) / scale + 0.5;

      // Default canvas: warm ivory #FBF9F5
      let r = 251, g = 249, b = 245, a = 255;

      // Draw subtle rounded outer card on non-maskable large icons
      if (!isMaskable && width >= 180) {
        const borderInset = 16 / 512;
        const cornerR = 96 / 512;
        // Subtle outline check
        const dx = Math.max(Math.abs(nx - 0.5) - (0.5 - borderInset - cornerR), 0);
        const dy = Math.max(Math.abs(ny - 0.5) - (0.5 - borderInset - cornerR), 0);
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (Math.abs(dist - cornerR) < 3 / 512) {
          r = 234; g = 228; b = 214; // #EAE4D6 stroke
        }
      }

      // Check rects with anti-aliased edge calculation
      for (const shape of rects) {
        const dx = Math.abs(nx - shape.cx);
        const dy = Math.abs(ny - shape.cy);
        const halfW = shape.w / 2;
        const halfH = shape.h / 2;
        const cornerDistX = Math.max(dx - (halfW - shape.r), 0);
        const cornerDistY = Math.max(dy - (halfH - shape.r), 0);
        const cornerDist = Math.sqrt(cornerDistX * cornerDistX + cornerDistY * cornerDistY);

        if (dx <= halfW && dy <= halfH && cornerDist <= shape.r) {
          r = shape.col[0];
          g = shape.col[1];
          b = shape.col[2];
        }
      }

      // Check dot
      const dotDist = Math.hypot(nx - dot.cx, ny - dot.cy);
      if (dotDist <= dot.r) {
        r = dot.col[0];
        g = dot.col[1];
        b = dot.col[2];
      }

      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
      raw[p + 3] = a;
    }
  }

  const idat = zlib.deflateSync(raw);
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// Generate valid .ico container embedding 32x32 PNG
function createIco(png32Buffer) {
  // ICO header: 6 bytes
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // Reserved
  header.writeUInt16LE(1, 2); // Type 1 = ICO
  header.writeUInt16LE(1, 4); // 1 image

  // Directory entry: 16 bytes
  const entry = Buffer.alloc(16);
  entry.writeUInt8(32, 0); // Width 32
  entry.writeUInt8(32, 1); // Height 32
  entry.writeUInt8(0, 2);  // Color count
  entry.writeUInt8(0, 3);  // Reserved
  entry.writeUInt16LE(1, 4); // Color planes
  entry.writeUInt16LE(32, 6); // Bits per pixel
  entry.writeUInt32LE(png32Buffer.length, 8); // Size of image data
  entry.writeUInt32LE(22, 12); // Offset to image data (6 + 16 = 22)

  return Buffer.concat([header, entry, png32Buffer]);
}

const publicDir = path.resolve('public');
fs.mkdirSync(publicDir, { recursive: true });

console.log('Generating production icon assets for Interstitial...');

const icon192 = createPng(192, 192, false);
const icon512 = createPng(512, 512, false);
const iconMaskable512 = createPng(512, 512, true);
const appleIcon = createPng(180, 180, false);
const icon32 = createPng(32, 32, false);
const faviconIco = createIco(icon32);

// Standard named files per user specifications
fs.writeFileSync(path.join(publicDir, 'icon-192.png'), icon192);
fs.writeFileSync(path.join(publicDir, 'icon-512.png'), icon512);
fs.writeFileSync(path.join(publicDir, 'icon-maskable-512.png'), iconMaskable512);
fs.writeFileSync(path.join(publicDir, 'apple-touch-icon.png'), appleIcon);
fs.writeFileSync(path.join(publicDir, 'favicon.ico'), faviconIco);

// Backward-compatible mirrors matching previous pwa-* filenames
fs.writeFileSync(path.join(publicDir, 'pwa-192x192.png'), icon192);
fs.writeFileSync(path.join(publicDir, 'pwa-512x512.png'), icon512);
fs.writeFileSync(path.join(publicDir, 'pwa-maskable-512x512.png'), iconMaskable512);

console.log('Successfully generated all icon assets in /public:');
console.log('- favicon.svg');
console.log('- favicon.ico (32x32 ICO)');
console.log('- icon-192.png (192x192 PNG)');
console.log('- icon-512.png (512x512 PNG)');
console.log('- icon-maskable-512.png (512x512 Maskable PNG)');
console.log('- apple-touch-icon.png (180x180 PNG)');

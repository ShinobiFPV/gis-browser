/**
 * Generates build/icon.ico and build/icon.png.
 *
 *   node scripts/make-icon.mjs
 *
 * Pure Node: a small supersampled rasteriser, node:zlib for the PNG, and the ICO
 * container assembled by hand. No image library and no system binary, which is the same
 * constraint the app itself ships under.
 *
 * Rendering through Electron was tried first and abandoned -- capturePage against an
 * offscreen window did not reliably settle, and hung the build. Drawing eight shapes
 * directly is less code than the workaround would have been, and it is deterministic.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Windows wants 256 at most; macOS wants 1024 for a Retina Dock. Rendered once per size
 * rather than downscaled from one master, because the outline is a stroke of fixed width
 * in design space and looks better resampled by the rasteriser than by a box filter.
 */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const ICNS_SIZES = [32, 64, 128, 256, 512, 1024];
const SS = 4; // supersampling factor, for antialiasing

// The app's own palette, so the icon matches the window it opens.
const BG = [0x11, 0x16, 0x1d];
const BORDER = [0x23, 0x2c, 0x38];
const FILL = [0x16, 0x28, 0x3d];
const LINE = [0x4d, 0x9f, 0xff];

/** A closed boundary outline: what the app is for, at the only scale that survives 16px. */
const POLYGON = [
  [54, 176], [44, 96], [96, 58], [152, 74],
  [204, 52], [212, 128], [176, 200], [110, 210],
];

const dist2 = (ax, ay, bx, by) => (ax - bx) ** 2 + (ay - by) ** 2;

/** Distance from a point to a line segment, used for both the stroke and the vertex dots. */
function distToSegment(px, py, ax, ay, bx, by) {
  const l2 = dist2(ax, ay, bx, by);
  if (l2 === 0) return Math.sqrt(dist2(px, py, ax, ay));
  let t = ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.sqrt(dist2(px, py, ax + t * (bx - ax), ay + t * (by - ay)));
}

function insidePolygon(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Rounded rectangle in a 256-space, as a signed test. */
function insideRoundRect(px, py, x, y, w, h, r) {
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  return dist2(px, py, cx, cy) <= r * r;
}

/** Colour at a point in the 256x256 design space. Returns [r,g,b,a]. */
function shadeCore(x, y) {
  if (!insideRoundRect(x, y, 0, 0, 256, 256, 42)) return [0, 0, 0, 0];

  // Vertex dots sit on top of everything.
  for (const [vx, vy] of POLYGON) {
    if (dist2(x, y, vx, vy) <= 13 * 13) return [...LINE, 255];
  }

  // The outline itself.
  let minDist = Infinity;
  for (let i = 0; i < POLYGON.length; i++) {
    const a = POLYGON[i];
    const b = POLYGON[(i + 1) % POLYGON.length];
    minDist = Math.min(minDist, distToSegment(x, y, a[0], a[1], b[0], b[1]));
  }
  if (minDist <= 5.5) return [...LINE, 255];

  if (insidePolygon(x, y, POLYGON)) return [...FILL, 255];

  // A hairline border keeps the icon legible on a light taskbar.
  if (!insideRoundRect(x, y, 5, 5, 246, 246, 38)) return [...BORDER, 255];

  return [...BG, 255];
}

/**
 * The Android/PWA "maskable" variant.
 *
 * A launcher crops a maskable icon to whatever shape it likes -- circle, squircle, teardrop
 * -- and only guarantees the middle 80%. So the rounded square is dropped in favour of full
 * bleed, and the artwork is shrunk to sit inside the safe zone. Handing the same rounded
 * square to a circular mask would clip its own corners off and look like a mistake.
 */
const MASKABLE_SCALE = 0.72;

function shade(x, y, maskable) {
  if (!maskable) return shadeCore(x, y);

  const mx = (x - 128) / MASKABLE_SCALE + 128;
  const my = (y - 128) / MASKABLE_SCALE + 128;
  const colour = shadeCore(mx, my);
  // Outside the design square the icon is background, never transparent: a maskable icon
  // with holes shows the launcher's wallpaper through them.
  return colour[3] === 0 ? [...BG, 255] : colour;
}

/** Renders RGBA at `size`, supersampled and box-filtered. */
function render(size, maskable = false) {
  const out = Buffer.alloc(size * size * 4);
  const scale = 256 / (size * SS);

  const samples = SS * SS;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, opaque = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [cr, cg, cb, ca] = shade(
            (px * SS + sx + 0.5) * scale,
            (py * SS + sy + 0.5) * scale,
            maskable,
          );
          if (ca === 0) continue;
          r += cr; g += cg; b += cb; opaque++;
        }
      }

      const i = (py * size + px) * 4;
      if (opaque === 0) continue; // leaves RGBA all zero: fully transparent

      // Colour is the mean of the covering samples; alpha is how many of them covered.
      // Averaging colour over ALL samples instead would drag edge pixels toward black.
      out[i] = Math.round(r / opaque);
      out[i + 1] = Math.round(g / opaque);
      out[i + 2] = Math.round(b / opaque);
      out[i + 3] = Math.round((opaque / samples) * 255);
    }
  }
  return out;
}

// --- PNG ------------------------------------------------------------------------

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(6, 9); // colour type 6 = RGBA
  // compression, filter and interlace are all 0 and already zeroed.

  // One filter byte (0 = none) per scanline.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- ICO ------------------------------------------------------------------------

/** A modern ICO can carry PNG payloads directly: header, directory, then the PNGs. */
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(entries.length, 4);

  let offset = 6 + entries.length * 16;
  const dir = [];
  for (const { size, data } of entries) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // 256 is encoded as 0
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    dir.push(e);
    offset += data.length;
  }

  return Buffer.concat([header, ...dir, ...entries.map((e) => e.data)]);
}

// --- ICNS -----------------------------------------------------------------------

/**
 * Apple icon suite. Like ICO, a modern .icns can carry PNG payloads directly: a header,
 * then one typed entry per image.
 *
 * Each OSType names an exact pixel size. The 256 and 512 images appear twice on purpose
 * -- ic08/ic13 and ic09/ic14 are the 1x and 2x slots for different logical sizes, and
 * macOS picks between them by display scale.
 */
const ICNS_TYPES = [
  ['ic11', 32], // 16pt @2x
  ['ic12', 64], // 32pt @2x
  ['ic07', 128],
  ['ic13', 256], // 128pt @2x
  ['ic08', 256],
  ['ic14', 512], // 256pt @2x
  ['ic09', 512],
  ['ic10', 1024], // 512pt @2x
];

function buildIcns(pngBySize) {
  const entries = ICNS_TYPES.map(([osType, size]) => {
    const png = pngBySize.get(size);
    if (!png) throw new Error(`no rendering at ${size}px for ${osType}`);
    const header = Buffer.alloc(8);
    header.write(osType, 0, 'ascii');
    header.writeUInt32BE(png.length + 8, 4); // length INCLUDES this header
    return Buffer.concat([header, png]);
  });

  const body = Buffer.concat(entries);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'ascii');
  header.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([header, body]);
}

// --- run ------------------------------------------------------------------------

const everySize = [...new Set([...ICO_SIZES, ...ICNS_SIZES])].sort((a, b) => a - b);
const pngBySize = new Map();

for (const size of everySize) {
  const data = encodePng(render(size), size);
  pngBySize.set(size, data);
  console.log(`  ${String(size).padStart(4)}x${size}: ${data.length} bytes`);
}

mkdirSync(join(root, 'build'), { recursive: true });

const ico = buildIco(ICO_SIZES.map((size) => ({ size, data: pngBySize.get(size) })));
writeFileSync(join(root, 'build', 'icon.ico'), ico);
console.log(`wrote build/icon.ico  (${ico.length} bytes, ${ICO_SIZES.length} sizes)`);

const icns = buildIcns(pngBySize);
writeFileSync(join(root, 'build', 'icon.icns'), icns);
console.log(`wrote build/icon.icns (${icns.length} bytes, ${ICNS_TYPES.length} entries)`);

// electron-builder falls back to this for any target with no platform-specific icon,
// and it must be at least 512x512.
writeFileSync(join(root, 'build', 'icon.png'), pngBySize.get(1024));
console.log('wrote build/icon.png  (1024x1024)');

// --- PWA ------------------------------------------------------------------------

/**
 * The same eight shapes again, for the phone.
 *
 * Generated from this file rather than exported by hand so the installed PWA, the Windows
 * taskbar and the macOS Dock cannot drift apart. 180 is Apple's touch icon; 192 and 512 are
 * what the Web App Manifest spec's installability checks look for.
 */
const PWA_DIR = join(root, 'src', 'mobile', 'public');
mkdirSync(PWA_DIR, { recursive: true });

for (const size of [180, 192, 512]) {
  const data = encodePng(render(size), size);
  writeFileSync(join(PWA_DIR, `icon-${size}.png`), data);
  console.log(`wrote src/mobile/public/icon-${size}.png (${data.length} bytes)`);
}

for (const size of [192, 512]) {
  const data = encodePng(render(size, true), size);
  writeFileSync(join(PWA_DIR, `icon-maskable-${size}.png`), data);
  console.log(`wrote src/mobile/public/icon-maskable-${size}.png (${data.length} bytes)`);
}

/**
 * A vector copy for the browser tab, where a 16px raster is a smudge.
 *
 * Written straight from the same polygon and palette, so it is the icon rather than a
 * lookalike of it.
 */
const svg =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">\n` +
  `  <rect width="256" height="256" rx="42" fill="${hex(BG)}"/>\n` +
  `  <rect x="5" y="5" width="246" height="246" rx="38" fill="none" stroke="${hex(BORDER)}" stroke-width="1"/>\n` +
  `  <path d="${POLYGON.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x},${y}`).join('')}Z" ` +
  `fill="${hex(FILL)}" stroke="${hex(LINE)}" stroke-width="11" stroke-linejoin="round"/>\n` +
  POLYGON.map(([x, y]) => `  <circle cx="${x}" cy="${y}" r="13" fill="${hex(LINE)}"/>`).join('\n') +
  `\n</svg>\n`;

writeFileSync(join(PWA_DIR, 'icon.svg'), svg);
console.log(`wrote src/mobile/public/icon.svg (${svg.length} bytes)`);

function hex([r, g, b]) {
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

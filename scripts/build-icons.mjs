/**
 * build-icons.mjs
 *
 * Dựng toàn bộ ảnh biểu tượng trong `resources/icons/` từ file gốc duy nhất
 * `icon.svg`. Biến thể `icon_dot.*` là cùng hình đó với lớp `.unread-badge`
 * được bật lên, nên hai biến thể không thể lệch nhau.
 *
 *   node scripts/build-icons.mjs
 *
 * Chỉ chạy lại khi sửa file SVG. Không có phụ thuộc npm nào: dùng Chrome
 * (đã có sẵn trên máy dựng) để rasterize, và `zlib` của Node để giải mã PNG.
 *
 * Đặt biến môi trường CHROME_BIN nếu Chrome không nằm ở vị trí mặc định.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const ICONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../resources/icons');

/** Các cỡ nhúng vào từng file .ico - theo đúng bộ cỡ bản gốc đã dùng. */
const ICO_SIZES = [16, 32, 48, 64, 128, 256];
const ICO_SIZES_SMALL = [16, 32, 48, 128];
const LINUX_SIZES = [16, 24, 32, 48, 64, 128, 256, 512];
/** Cỡ ICNS -> mã loại của Apple (mục chứa PNG, macOS 10.7 trở lên). */
const ICNS_TYPES = { 16: 'icp4', 32: 'icp5', 128: 'ic07', 256: 'ic08', 512: 'ic09', 1024: 'ic10' };

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  '/opt/google/chrome/chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

function findChrome() {
  const found = CHROME_CANDIDATES.find(p => existsSync(p));
  if (!found) {
    throw new Error(
      `Không tìm thấy Chrome. Đã thử: ${CHROME_CANDIDATES.join(', ')}\n` +
      'Đặt CHROME_BIN trỏ tới file thực thi Chrome/Chromium rồi chạy lại.',
    );
  }
  return found;
}

// ─── Rasterize SVG bằng Chrome ──────────────────────────────────────────────

/**
 * Chụp `svgPath` ra PNG kích thước size×size, nền trong suốt.
 * `showBadge` bật lớp `.unread-badge` vốn ẩn trong file gốc.
 */
function rasterize(chrome, workDir, svgPath, size, showBadge) {
  const svg = readFileSync(svgPath, 'utf-8');
  // Nhúng thẳng SVG vào trang để không phát sinh request phụ, và ép đúng cỡ.
  const html =
    '<!doctype html><meta charset="utf-8">' +
    `<style>html,body{margin:0;padding:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}` +
    (showBadge ? 'svg .unread-badge{display:block}' : '') +
    '</style>' +
    svg;
  const tag = showBadge ? `dot-${size}` : `plain-${size}`;
  const htmlPath = path.join(workDir, `page-${tag}.html`);
  const outPath = path.join(workDir, `out-${tag}.png`);
  writeFileSync(htmlPath, html);

  execFileSync(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--default-background-color=00000000',
    `--screenshot=${outPath}`,
    `--window-size=${size},${size}`,
    `file://${htmlPath}`,
  ], { stdio: 'pipe' });

  if (!existsSync(outPath)) throw new Error(`Chrome không xuất được ảnh cỡ ${size}`);
  return readFileSync(outPath);
}

// ─── Giải mã PNG (chỉ loại 8-bit RGBA, đúng thứ Chrome xuất ra) ─────────────

/** Trả { width, height, rgba } với rgba là Buffer RGBA không nén. */
function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    throw new Error('Không phải file PNG');
  }
  let off = 8;
  let width = 0, height = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const [depth, colorType, , , interlace] = [data[8], data[9], data[10], data[11], data[12]];
      if (depth !== 8 || colorType !== 6 || interlace !== 0) {
        throw new Error(`PNG ngoài dự kiến: depth=${depth} colorType=${colorType} interlace=${interlace}`);
      }
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const rgba = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const out = rgba.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? rgba.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? out[x - 4] : 0;          // trái
      const b = prev ? prev[x] : 0;                // trên
      const c = prev && x >= 4 ? prev[x - 4] : 0;  // trên-trái
      let v = line[x];
      switch (filter) {
        case 0: break;
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`Bộ lọc PNG lạ: ${filter}`);
      }
      out[x] = v & 0xff;
    }
  }
  return { width, height, rgba };
}

// ─── Đóng gói ICO (mục kiểu BMP/DIB, giống hệt bản gốc) ─────────────────────

/** Một mục DIB 32bpp bottom-up kèm mặt nạ AND rỗng. */
function dibEntry({ width, height, rgba }) {
  const maskStride = (((width + 31) >> 5) << 2);
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(width, 4);
  header.writeInt32LE(height * 2, 8);   // gấp đôi: ảnh + mặt nạ
  header.writeUInt16LE(1, 12);          // planes
  header.writeUInt16LE(32, 14);         // bpp
  header.writeUInt32LE(0, 16);          // BI_RGB
  header.writeUInt32LE(width * height * 4 + maskStride * height, 20);

  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * width * 4; // DIB lưu từ dưới lên
    const dst = y * width * 4;
    for (let x = 0; x < width; x++) {
      pixels[dst + x * 4 + 0] = rgba[src + x * 4 + 2]; // B
      pixels[dst + x * 4 + 1] = rgba[src + x * 4 + 1]; // G
      pixels[dst + x * 4 + 2] = rgba[src + x * 4 + 0]; // R
      pixels[dst + x * 4 + 3] = rgba[src + x * 4 + 3]; // A
    }
  }
  return Buffer.concat([header, pixels, Buffer.alloc(maskStride * height)]);
}

function buildIco(images) {
  const entries = images.map(img => dibEntry(img));
  const dir = Buffer.alloc(6 + 16 * images.length);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);                 // 1 = ICO
  dir.writeUInt16LE(images.length, 4);
  let offset = dir.length;
  images.forEach((img, i) => {
    const at = 6 + 16 * i;
    dir[at] = img.width >= 256 ? 0 : img.width;   // 0 nghĩa là 256
    dir[at + 1] = img.height >= 256 ? 0 : img.height;
    dir[at + 2] = 0;                              // số màu bảng
    dir[at + 3] = 0;
    dir.writeUInt16LE(1, at + 4);                 // planes
    dir.writeUInt16LE(32, at + 6);                // bpp
    dir.writeUInt32LE(entries[i].length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += entries[i].length;
  });
  return Buffer.concat([dir, ...entries]);
}

// ─── Đóng gói ICNS (mục chứa thẳng PNG) ─────────────────────────────────────

function buildIcns(pngBySize) {
  const chunks = [];
  for (const [size, type] of Object.entries(ICNS_TYPES)) {
    const png = pngBySize.get(Number(size));
    if (!png) continue;
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(png.length + 8, 4);
    chunks.push(head, png);
  }
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

// ─── Chạy ───────────────────────────────────────────────────────────────────

const chrome = findChrome();
const workDir = mkdtempSync(path.join(tmpdir(), 'maihub-icons-'));
mkdirSync(ICONS_DIR, { recursive: true });

try {
  const written = [];
  const emit = (name, buf) => {
    writeFileSync(path.join(ICONS_DIR, name), buf);
    written.push([name, buf.length]);
  };

  const svgPath = path.join(ICONS_DIR, 'icon.svg');
  let plain128 = null;

  for (const variant of ['icon', 'icon_dot']) {
    const showBadge = variant === 'icon_dot';
    const sizes = [...new Set([...ICO_SIZES, ...LINUX_SIZES, ...Object.keys(ICNS_TYPES).map(Number), 1024])].sort((a, b) => a - b);

    const png = new Map();
    const decoded = new Map();
    for (const size of sizes) {
      const buf = rasterize(chrome, workDir, svgPath, size, showBadge);
      png.set(size, buf);
      decoded.set(size, decodePng(buf));
    }

    if (showBadge && png.get(128).equals(plain128)) {
      throw new Error(
        'Biến thể icon_dot dựng ra giống hệt icon thường — lớp .unread-badge ' +
        'không được bật. Kiểm tra độ ưu tiên của quy tắc CSS trong rasterize().',
      );
    }
    if (!showBadge) plain128 = png.get(128);

    emit(`${variant}.png`, png.get(1024));
    emit(`${variant}_128.png`, png.get(128));
    emit(`${variant}_128.ico`, buildIco(ICO_SIZES_SMALL.map(s => decoded.get(s))));

    if (variant === 'icon') {
      // electron-builder đọc icon.ico (Windows), icon.icns (macOS) và thư mục
      // linux/ (Linux: mỗi cỡ một file "<size>.png"; GNOME chỉ tìm icon ở các
      // cỡ chuẩn 16–512, một file 1024 duy nhất sẽ bị bỏ qua → icon mặc định).
      emit('icon.ico', buildIco(ICO_SIZES.map(s => decoded.get(s))));
      emit('icon.icns', buildIcns(png));
      mkdirSync(path.join(ICONS_DIR, 'linux'), { recursive: true });
      for (const size of LINUX_SIZES) emit(path.join('linux', `${size}x${size}.png`), png.get(size));
    } else {
      // Biến thể chấm đỏ không vào bản đóng gói, nhưng giữ cùng bộ file với
      // bản gốc để electron/main.ts không phải đổi đường dẫn.
      // (electron/main.ts chỉ nạp icon_dot_128.png cho khay hệ thống.)
      emit('icon_dot.ico', buildIco(ICO_SIZES.map(s => decoded.get(s))));
    }
  }

  console.log(`Đã dựng ${written.length} file từ icon.svg:`);
  for (const [name, size] of written) console.log(`  ${name.padEnd(20)} ${size.toLocaleString()} bytes`);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

// Minimal PNG reader/writer used by the asset pipeline (tools/build-assets.js).
// Only what the source art needs: 8-bit gray/RGB/RGBA/palette, both interlace
// modes. Everything is normalised to RGBA so the rest of the pipeline is simple.
// Kept dependency-free on purpose — the project has no bundler or npm deps for
// asset work, and `node tools/build-assets.js` should just run.

const fs = require('fs');
const zlib = require('zlib');

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
// Adam7 passes: [xStart, yStart, xStep, yStep]
const ADAM7 = [
  [0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4],
  [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2],
];

// Undo the per-scanline filters of one image (or one Adam7 pass) in place.
function unfilter(raw, width, height, bitDepth, channels) {
  const stride = Math.ceil(width * bitDepth * channels / 8);
  const bpp = Math.max(1, Math.ceil(bitDepth * channels / 8));
  const out = Buffer.alloc(height * stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const o = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[o + x - bpp] : 0;
      const b = y > 0 ? out[o - stride + x] : 0;
      const c = (x >= bpp && y > 0) ? out[o - stride + x - bpp] : 0;
      let v = raw[p + x];
      switch (filter) {
        case 0: break;
        case 1: v = (v + a) & 255; break;
        case 2: v = (v + b) & 255; break;
        case 3: v = (v + ((a + b) >> 1)) & 255; break;
        case 4: {
          const est = a + b - c;
          const pa = Math.abs(est - a), pb = Math.abs(est - b), pc = Math.abs(est - c);
          v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
          break;
        }
        default: throw new Error('bad PNG filter ' + filter);
      }
      out[o + x] = v;
    }
    p += stride;
  }
  return { data: out, stride, consumed: p };
}

// Pull one pixel out of an unfiltered scanline buffer and write it as RGBA.
function readPixel(src, stride, x, y, meta, dst, dstOff) {
  const { colorType, bitDepth, palette, trns } = meta;
  let r, g, b, a = 255;
  if (colorType === 3) {
    let idx;
    if (bitDepth === 8) idx = src[y * stride + x];
    else {
      const per = 8 / bitDepth;
      const byte = src[y * stride + Math.floor(x / per)];
      idx = (byte >> (8 - bitDepth * ((x % per) + 1))) & ((1 << bitDepth) - 1);
    }
    r = palette[idx * 3]; g = palette[idx * 3 + 1]; b = palette[idx * 3 + 2];
    if (trns && idx < trns.length) a = trns[idx];
  } else if (colorType === 6) {
    const o = y * stride + x * 4;
    r = src[o]; g = src[o + 1]; b = src[o + 2]; a = src[o + 3];
  } else if (colorType === 2) {
    const o = y * stride + x * 3;
    r = src[o]; g = src[o + 1]; b = src[o + 2];
  } else if (colorType === 4) {
    const o = y * stride + x * 2;
    r = g = b = src[o]; a = src[o + 1];
  } else {
    r = g = b = src[y * stride + x];
  }
  dst[dstOff] = r; dst[dstOff + 1] = g; dst[dstOff + 2] = b; dst[dstOff + 3] = a;
}

function decodePNG(file) {
  const buf = fs.readFileSync(file);
  let pos = 8, width, height, bitDepth, colorType, interlace = 0;
  let palette = null, trns = null;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.slice(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8 && colorType !== 3) throw new Error(`${file}: unsupported bit depth ${bitDepth}`);
  const channels = CHANNELS[colorType];
  const meta = { colorType, bitDepth, palette, trns };
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const rgba = Buffer.alloc(width * height * 4);

  if (!interlace) {
    const { data, stride } = unfilter(raw, width, height, bitDepth, channels);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        readPixel(data, stride, x, y, meta, rgba, (y * width + x) * 4);
  } else {
    let off = 0;
    for (const [xs, ys, xstep, ystep] of ADAM7) {
      const pw = Math.ceil((width - xs) / xstep), ph = Math.ceil((height - ys) / ystep);
      if (pw <= 0 || ph <= 0) continue;
      const { data, stride, consumed } = unfilter(raw.slice(off), pw, ph, bitDepth, channels);
      off += consumed;
      for (let y = 0; y < ph; y++)
        for (let x = 0; x < pw; x++)
          readPixel(data, stride, x, y, meta, rgba, ((ys + y * ystep) * width + xs + x * xstep) * 4);
    }
  }
  return { width, height, data: rgba };
}

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function encodePNG(img) {
  const { width, height, data } = img;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none — art this small compresses fine
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])];
  const chunk = (type, payload) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(payload.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), payload])), 0);
    parts.push(head, payload, crc);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  chunk('IHDR', ihdr);
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 }));
  chunk('IEND', Buffer.alloc(0));
  return Buffer.concat(parts);
}

module.exports = { decodePNG, encodePNG };

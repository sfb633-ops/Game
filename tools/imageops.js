// Small raster helpers for the asset pipeline. Images are plain
// { width, height, data: Buffer } in straight (non-premultiplied) RGBA.

function blank(width, height) {
  return { width, height, data: Buffer.alloc(width * height * 4) };
}

// Rounded. A fractional size allocates a fractional buffer and then indexes it
// with (y * w + x), which lands between pixels and writes noise — stamp() with a
// 1.7-tile crop put a white striped rectangle across a whole building and
// nothing complained. Any caller asking for half a pixel has made an arithmetic
// mistake; rounding here means it comes out a pixel off instead of as garbage.
function crop(img, sx, sy, w, h) {
  sx = Math.round(sx); sy = Math.round(sy); w = Math.round(w); h = Math.round(h);
  const out = blank(w, h);
  for (let y = 0; y < h; y++) {
    const py = sy + y;
    if (py < 0 || py >= img.height) continue;
    for (let x = 0; x < w; x++) {
      const px = sx + x;
      if (px < 0 || px >= img.width) continue;
      const s = (py * img.width + px) * 4;
      img.data.copy(out.data, (y * w + x) * 4, s, s + 4);
    }
  }
  return out;
}

// Copy src over dst at (dx, dy). Source pixels replace destination pixels —
// the pipeline only ever blits into empty regions of a sheet.
function blit(dst, src, dx, dy) {
  for (let y = 0; y < src.height; y++) {
    const py = dy + y;
    if (py < 0 || py >= dst.height) continue;
    for (let x = 0; x < src.width; x++) {
      const px = dx + x;
      if (px < 0 || px >= dst.width) continue;
      const s = (y * src.width + x) * 4;
      src.data.copy(dst.data, (py * dst.width + px) * 4, s, s + 4);
    }
  }
}

// Alpha-composite src onto dst (source-over). Used by the preview renderer;
// the pipeline itself only ever blits into empty space.
function drawOver(dst, src, dx, dy, alpha = 1) {
  for (let y = 0; y < src.height; y++) {
    const py = dy + y;
    if (py < 0 || py >= dst.height) continue;
    for (let x = 0; x < src.width; x++) {
      const px = dx + x;
      if (px < 0 || px >= dst.width) continue;
      const s = (y * src.width + x) * 4, d = (py * dst.width + px) * 4;
      const sa = (src.data[s + 3] / 255) * alpha;
      if (sa <= 0) continue;
      const da = dst.data[d + 3] / 255;
      const oa = sa + da * (1 - sa);
      for (let c = 0; c < 3; c++) {
        dst.data[d + c] = Math.round((src.data[s + c] * sa + dst.data[d + c] * da * (1 - sa)) / oa);
      }
      dst.data[d + 3] = Math.round(oa * 255);
    }
  }
}

function flipX(img) {
  const out = blank(img.width, img.height);
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++) {
      const s = (y * img.width + (img.width - 1 - x)) * 4;
      img.data.copy(out.data, (y * img.width + x) * 4, s, s + 4);
    }
  return out;
}

// Alpha-weighted box resample. Used to bring oversized source art (600px
// smoke frames, 150px houses) down onto the 32px tile grid without the halos
// a naive average around transparent pixels produces.
function resize(img, w, h) {
  const out = blank(w, h);
  const xr = img.width / w, yr = img.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * yr), y1 = Math.max(y0 + 1, Math.ceil((y + 1) * yr));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * xr), x1 = Math.max(x0 + 1, Math.ceil((x + 1) * xr));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = y0; sy < Math.min(y1, img.height); sy++)
        for (let sx = x0; sx < Math.min(x1, img.width); sx++) {
          const o = (sy * img.width + sx) * 4, al = img.data[o + 3] / 255;
          r += img.data[o] * al; g += img.data[o + 1] * al; b += img.data[o + 2] * al;
          a += img.data[o + 3]; n++;
        }
      if (!n) continue;
      const q = (y * w + x) * 4;
      const aw = a / 255;
      if (aw > 0) { out.data[q] = Math.round(r / aw); out.data[q + 1] = Math.round(g / aw); out.data[q + 2] = Math.round(b / aw); }
      out.data[q + 3] = Math.round(a / n);
    }
  }
  return out;
}

// Integer nearest-neighbour magnification. Art drawn for a 16px tile grid is
// blown up to the game's 32px one this way rather than through resize(), so
// every source pixel stays a clean square block instead of being resampled.
function scaleUp(img, n) {
  if (n === 1) return img;
  const out = blank(img.width * n, img.height * n);
  for (let y = 0; y < out.height; y++)
    for (let x = 0; x < out.width; x++) {
      const s = (Math.floor(y / n) * img.width + Math.floor(x / n)) * 4;
      img.data.copy(out.data, (y * out.width + x) * 4, s, s + 4);
    }
  return out;
}

// Quarter turn. Exact — every pixel lands on a pixel — so pixel art survives
// it untouched, which is what makes a wall drawn face-on reusable as the same
// wall running away from the viewer.
function rotate90(img, clockwise) {
  const out = blank(img.height, img.width);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const src = (y * img.width + x) * 4;
      const nx = clockwise ? img.height - 1 - y : y;
      const ny = clockwise ? x : img.width - 1 - x;
      img.data.copy(out.data, (ny * out.width + nx) * 4, src, src + 4);
    }
  }
  return out;
}

// Scale to a target width, keeping aspect ratio.
function resizeToWidth(img, w) {
  return resize(img, w, Math.max(1, Math.round(img.height * w / img.width)));
}

// Tightest rectangle containing pixels above `alphaMin`, or null if empty.
function bbox(img, alphaMin = 8) {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++)
      if (img.data[(y * img.width + x) * 4 + 3] > alphaMin) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
  return x1 < 0 ? null : { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function unionBox(a, b) {
  if (!a) return b;
  if (!b) return a;
  const x0 = Math.min(a.x0, b.x0), y0 = Math.min(a.y0, b.y0);
  const x1 = Math.max(a.x1, b.x1), y1 = Math.max(a.y1, b.y1);
  return { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// Per-pixel colour transform; fn receives (r,g,b,a) and returns [r,g,b,a].
// Fully transparent pixels are left alone.
function mapPixels(img, fn) {
  const out = { width: img.width, height: img.height, data: Buffer.from(img.data) };
  for (let i = 0; i < img.width * img.height; i++) {
    const o = i * 4;
    if (out.data[o + 3] === 0) continue;
    const [r, g, b, a] = fn(out.data[o], out.data[o + 1], out.data[o + 2], out.data[o + 3]);
    out.data[o] = r; out.data[o + 1] = g; out.data[o + 2] = b; out.data[o + 3] = a;
  }
  return out;
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h, s, l];
}

function hslToRgb(h, s, l) {
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [Math.round(hue(h + 1 / 3) * 255), Math.round(hue(h) * 255), Math.round(hue(h - 1 / 3) * 255)];
}

// Shift hue / scale saturation / nudge lightness, optionally only for pixels
// whose hue falls inside [hueFrom, hueTo] (in turns, may wrap past 1).
function recolor(img, { hueShift = 0, satMul = 1, lightAdd = 0, hueFrom = null, hueTo = null }) {
  return mapPixels(img, (r, g, b, a) => {
    let [h, s, l] = rgbToHsl(r, g, b);
    if (hueFrom !== null) {
      const inRange = hueFrom <= hueTo
        ? (h >= hueFrom && h <= hueTo)
        : (h >= hueFrom || h <= hueTo);
      if (!inRange || s < 0.08) return [r, g, b, a];
    }
    h = (h + hueShift + 1) % 1;
    s = Math.max(0, Math.min(1, s * satMul));
    l = Math.max(0, Math.min(1, l + lightAdd));
    const [nr, ng, nb] = hslToRgb(h, s, l);
    return [nr, ng, nb, a];
  });
}

module.exports = {
  blank, crop, blit, drawOver, flipX, rotate90, resize, resizeToWidth, scaleUp,
  bbox, unionBox, mapPixels, recolor, rgbToHsl, hslToRgb,
};

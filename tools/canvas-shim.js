// A tiny software Canvas2D, just large enough to run public/sprites.js outside
// a browser so tools/preview.js can render the real client draw path to a PNG.
// Not a general implementation: text is measured but not drawn, dashes are
// ignored, and curves are flattened to polylines. Good enough to check sprite
// anchors, transforms and layering; not a substitute for looking at the game.

const ops = require('./imageops');

function mul(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

function parseColor(c) {
  if (typeof c !== 'string') return [0, 0, 0, 1];
  let m = /^#([0-9a-f]{3})$/i.exec(c);
  if (m) return [parseInt(m[1][0] + m[1][0], 16), parseInt(m[1][1] + m[1][1], 16), parseInt(m[1][2] + m[1][2], 16), 1];
  m = /^#([0-9a-f]{6})$/i.exec(c);
  if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16), 1];
  m = /^rgba?\(([^)]+)\)$/i.exec(c);
  if (m) {
    const p = m[1].split(',').map(s => parseFloat(s.trim()));
    return [p[0] | 0, p[1] | 0, p[2] | 0, p.length > 3 ? p[3] : 1];
  }
  return [255, 0, 255, 1];
}

class Context {
  constructor(canvas) {
    this.canvas = canvas;
    this.img = { width: canvas.width, height: canvas.height, data: canvas._data };
    this._m = [1, 0, 0, 1, 0, 0];
    this._stack = [];
    this.globalAlpha = 1;
    this.fillStyle = '#000';
    this.strokeStyle = '#000';
    this.lineWidth = 1;
    this.font = '10px monospace';
    this.textAlign = 'left';
    this.imageSmoothingEnabled = false;
    this._path = [];
  }

  save() {
    this._stack.push({ m: this._m.slice(), a: this.globalAlpha, f: this.fillStyle, s: this.strokeStyle, lw: this.lineWidth });
  }
  restore() {
    const s = this._stack.pop();
    if (!s) return;
    this._m = s.m; this.globalAlpha = s.a; this.fillStyle = s.f; this.strokeStyle = s.s; this.lineWidth = s.lw;
  }
  setTransform(a, b, c, d, e, f) { this._m = [a, b, c, d, e, f]; }
  translate(x, y) { this._m = mul(this._m, [1, 0, 0, 1, x, y]); }
  scale(x, y) { this._m = mul(this._m, [x, 0, 0, y, 0, 0]); }
  setLineDash() {}
  measureText(t) { return { width: String(t).length * 6 }; }
  fillText() {}
  strokeText() {}

  _px(x, y, rgba, alpha) {
    const w = this.img.width, h = this.img.height;
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const a = rgba[3] * alpha * this.globalAlpha;
    if (a <= 0) return;
    const o = (y * w + x) * 4;
    const da = this.img.data[o + 3] / 255;
    const oa = a + da * (1 - a);
    for (let c = 0; c < 3; c++) {
      this.img.data[o + c] = Math.round((rgba[c] * a + this.img.data[o + c] * da * (1 - a)) / oa);
    }
    this.img.data[o + 3] = Math.round(oa * 255);
  }

  clearRect(x, y, w, h) {
    const rgba = [0, 0, 0, 0];
    for (let yy = y; yy < y + h; yy++)
      for (let xx = x; xx < x + w; xx++) {
        const [px, py] = apply(this._m, xx, yy);
        const o = ((py | 0) * this.img.width + (px | 0)) * 4;
        if (o >= 0 && o < this.img.data.length) this.img.data.fill(0, o, o + 4);
      }
    void rgba;
  }

  fillRect(x, y, w, h) {
    const c = parseColor(this.fillStyle);
    const [x0, y0] = apply(this._m, x, y);
    const [x1, y1] = apply(this._m, x + w, y + h);
    const ax = Math.round(Math.min(x0, x1)), bx = Math.round(Math.max(x0, x1));
    const ay = Math.round(Math.min(y0, y1)), by = Math.round(Math.max(y0, y1));
    for (let yy = ay; yy < by; yy++) for (let xx = ax; xx < bx; xx++) this._px(xx, yy, c, 1);
  }
  strokeRect(x, y, w, h) {
    this.beginPath();
    this.moveTo(x, y); this.lineTo(x + w, y); this.lineTo(x + w, y + h); this.lineTo(x, y + h); this.closePath();
    this.stroke();
  }

  beginPath() { this._path = []; }
  moveTo(x, y) { this._path.push([apply(this._m, x, y)]); }
  lineTo(x, y) {
    if (!this._path.length) this._path.push([]);
    this._path[this._path.length - 1].push(apply(this._m, x, y));
  }
  closePath() {
    const sub = this._path[this._path.length - 1];
    if (sub && sub.length > 1) sub.push(sub[0]);
  }
  arc(cx, cy, r, a0, a1) { this.ellipse(cx, cy, r, r, 0, a0, a1); }
  ellipse(cx, cy, rx, ry, rot, a0, a1) {
    const steps = 48;
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const a = a0 + (a1 - a0) * (i / steps);
      const x = cx + Math.cos(a) * rx * Math.cos(rot) - Math.sin(a) * ry * Math.sin(rot);
      const y = cy + Math.cos(a) * rx * Math.sin(rot) + Math.sin(a) * ry * Math.cos(rot);
      pts.push(apply(this._m, x, y));
    }
    this._path.push(pts);
  }

  stroke() {
    const c = parseColor(this.strokeStyle);
    const scale = Math.abs(this._m[0]) || 1;
    const lw = Math.max(1, Math.round(this.lineWidth * scale));
    for (const sub of this._path) {
      for (let i = 1; i < sub.length; i++) this._line(sub[i - 1], sub[i], c, lw);
    }
  }
  fill() {
    const c = parseColor(this.fillStyle);
    for (const sub of this._path) {
      if (sub.length < 3) continue;
      let minY = Infinity, maxY = -Infinity;
      for (const p of sub) { minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
      for (let y = Math.floor(minY); y <= Math.ceil(maxY); y++) {
        const xs = [];
        for (let i = 0; i < sub.length; i++) {
          const a = sub[i], b = sub[(i + 1) % sub.length];
          if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) {
            xs.push(a[0] + (y - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
          }
        }
        xs.sort((p, q) => p - q);
        for (let i = 0; i + 1 < xs.length; i += 2)
          for (let x = Math.round(xs[i]); x < Math.round(xs[i + 1]); x++) this._px(x, y, c, 1);
      }
    }
  }
  _line(a, b, c, lw) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const n = Math.max(1, Math.ceil(Math.hypot(dx, dy)));
    const half = (lw - 1) / 2;
    for (let i = 0; i <= n; i++) {
      const x = a[0] + dx * i / n, y = a[1] + dy * i / n;
      for (let oy = -half; oy <= half; oy++)
        for (let ox = -half; ox <= half; ox++) this._px(Math.round(x + ox), Math.round(y + oy), c, 1);
    }
  }

  // drawImage(src, dx, dy) | (src, sx, sy, sw, sh, dx, dy, dw, dh)
  drawImage(src, ...a) {
    const img = src._image || src;
    if (!img || !img.width) return;
    let sx = 0, sy = 0, sw = img.width, sh = img.height, dx, dy, dw, dh;
    if (a.length === 2) { [dx, dy] = a; dw = sw; dh = sh; }
    else if (a.length === 4) { [dx, dy, dw, dh] = a; }
    else { [sx, sy, sw, sh, dx, dy, dw, dh] = a; }

    // Walk destination pixels and inverse-map into the source: handles the
    // mirrored (negative scale) case the unit renderer relies on.
    const corners = [apply(this._m, dx, dy), apply(this._m, dx + dw, dy),
      apply(this._m, dx, dy + dh), apply(this._m, dx + dw, dy + dh)];
    const x0 = Math.round(Math.min(...corners.map(p => p[0])));
    const x1 = Math.round(Math.max(...corners.map(p => p[0])));
    const y0 = Math.round(Math.min(...corners.map(p => p[1])));
    const y1 = Math.round(Math.max(...corners.map(p => p[1])));
    const det = this._m[0] * this._m[3] - this._m[1] * this._m[2];
    if (!det) return;
    const inv = [this._m[3] / det, -this._m[1] / det, -this._m[2] / det, this._m[0] / det,
      (this._m[2] * this._m[5] - this._m[3] * this._m[4]) / det,
      (this._m[1] * this._m[4] - this._m[0] * this._m[5]) / det];
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        const [ux, uy] = apply(inv, px + 0.5, py + 0.5);
        const fx = (ux - dx) / dw, fy = (uy - dy) / dh;
        if (fx < 0 || fy < 0 || fx >= 1 || fy >= 1) continue;
        const ix = Math.min(sx + sw - 1, Math.floor(sx + fx * sw));
        const iy = Math.min(sy + sh - 1, Math.floor(sy + fy * sh));
        if (ix < 0 || iy < 0 || ix >= img.width || iy >= img.height) continue;
        const o = (iy * img.width + ix) * 4;
        if (o + 3 >= img.data.length) continue;
        const alpha = img.data[o + 3] / 255;
        if (!(alpha > 0)) continue;
        this._px(px, py, [img.data[o], img.data[o + 1], img.data[o + 2], alpha], 1);
      }
    }
  }
}

class Canvas {
  constructor(width, height) {
    this._w = 0; this._h = 0;
    this._data = Buffer.alloc(0);
    this._ctx = null;
    this.width = width;
    this.height = height;
  }
  // Assigning width/height reallocates and clears, as it does in a browser —
  // sprites.js creates a 0x0 element and sizes it afterwards.
  get width() { return this._w; }
  set width(v) { this._w = v | 0; this._realloc(); }
  get height() { return this._h; }
  set height(v) { this._h = v | 0; this._realloc(); }
  _realloc() {
    this._data = Buffer.alloc(Math.max(0, this._w * this._h * 4));
    this._ctx = null;
  }
  getContext() {
    if (!this._ctx) this._ctx = new Context(this);
    return this._ctx;
  }
  get data() { return this._data; }
  toImage() { return { width: this._w, height: this._h, data: this._data }; }
}

module.exports = { Canvas, Context, ops };

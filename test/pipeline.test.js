/**
 * pipeline.test.js —— 完整链路自检（Node 运行，无第三方依赖）
 *
 *   node test/pipeline.test.js          # 基本用例
 *   set BIG=1 && node test/pipeline.test.js   # 附带 810x1080 / 30 帧 的性能与体积实测
 *
 * 在 Node 里桩化 canvas 的绘图语义（save/restore/rect/clip/fillRect/drawImage/getImageData），
 * 从而完整跑通 comparer.js：合成 -> 竖带局部重绘 -> 量化 -> 帧差 -> GIF 编码，
 * 再用独立解码器把 GIF 解回来，逐像素校验：
 *   - 白条位置与颜色是否与 framePositions 计算的一致；
 *   - 白条左侧是否为图 A、右侧是否为图 B；
 *   - 是否真的使用了局部矩形帧（帧差生效）。
 */
'use strict';

const { decodeGif, compose } = require('./roundtrip.test.js');

/* --------------------------------------------------------- canvas 桩实现 */

function parseColor(v) {
  if (typeof v !== 'string') return [0, 0, 0];
  const m = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(v.trim());
  if (m) return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
  if (v === 'white') return [255, 255, 255];
  return [255, 0, 255];
}

function StubCanvas(w, h) {
  this.width = w;
  this.height = h;
  this.data = new Uint8ClampedArray(w * h * 4);
}

StubCanvas.prototype.getContext = function () {
  if (this._ctx) return this._ctx;
  const cv = this;
  let clip = { x0: 0, y0: 0, x1: cv.width, y1: cv.height };
  const stack = [];
  let path = null;
  let fill = [0, 0, 0];

  const intersect = (a, b) => ({
    x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0),
    x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1)
  });

  function put(x, y, r, g, b) {
    if (x < clip.x0 || x >= clip.x1 || y < clip.y0 || y >= clip.y1) return;
    const i = (y * cv.width + x) * 4;
    cv.data[i] = r; cv.data[i + 1] = g; cv.data[i + 2] = b; cv.data[i + 3] = 255;
  }

  const ctx = {
    imageSmoothingEnabled: false,
    imageSmoothingQuality: 'low',
    get fillStyle() { return fill; },
    set fillStyle(v) { fill = parseColor(v); },
    beginPath() { path = null; },
    rect(x, y, w, h) {
      const r = { x0: x, y0: y, x1: x + w, y1: y + h };
      path = path ? intersect(path, r) : r;
    },
    clip() { if (path) clip = intersect(clip, path); },
    save() { stack.push({ clip: { ...clip }, path: path && { ...path } }); },
    restore() { const s = stack.pop(); if (s) { clip = s.clip; path = s.path; } },
    fillRect(x, y, w, h) {
      const r = intersect(clip, { x0: x, y0: y, x1: x + w, y1: y + h });
      for (let py = Math.ceil(r.y0); py < r.y1; py++) {
        for (let px = Math.ceil(r.x0); px < r.x1; px++) put(px, py, fill[0], fill[1], fill[2]);
      }
    },
    drawImage(img, ...a) {
      let sx = 0, sy = 0, sw = img.width, sh = img.height, dx, dy, dw, dh;
      if (a.length >= 8) { sx = a[0]; sy = a[1]; sw = a[2]; sh = a[3]; dx = a[4]; dy = a[5]; dw = a[6]; dh = a[7]; }
      else { dx = a[0]; dy = a[1]; dw = a[2]; dh = a[3]; }
      if (sw !== dw || sh !== dh) throw new Error('桩不支持缩放绘制 ' + sw + 'x' + sh + ' -> ' + dw + 'x' + dh);
      const r = intersect(clip, { x0: dx, y0: dy, x1: dx + dw, y1: dy + dh });
      for (let py = Math.ceil(r.y0); py < r.y1; py++) {
        for (let px = Math.ceil(r.x0); px < r.x1; px++) {
          const si = ((sy + py - dy) * img.width + (sx + px - dx)) * 4;
          put(px, py, img.data[si], img.data[si + 1], img.data[si + 2]);
        }
      }
    },
    getImageData(x, y, w, h) {
      const out = new Uint8ClampedArray(w * h * 4);
      for (let row = 0; row < h; row++) {
        const src = ((y + row) * cv.width + x) * 4;
        out.set(cv.data.subarray(src, src + w * 4), row * w * 4);
      }
      return { data: out, width: w, height: h };
    }
  };
  this._ctx = ctx;
  return ctx;
};

globalThis.OffscreenCanvas = StubCanvas;

/* ------------------------------------------------------------- 测试素材 */

const CF = require('../public/js/comparer.js');
const W = 240, H = 180, FRAMES = 10, BAR = 8;

function makeImages() {
  const A = new StubCanvas(W, H);
  const B = new StubCanvas(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      A.data[i] = 200 + Math.round(55 * x / W);          // 暖色图
      A.data[i + 1] = 30 + Math.round(40 * y / H);
      A.data[i + 2] = 20;
      A.data[i + 3] = 255;
      B.data[i] = 10;                                     // 冷色图
      B.data[i + 1] = 60 + Math.round(60 * y / H);
      B.data[i + 2] = 190 + Math.round(65 * x / W);
      B.data[i + 3] = 255;
    }
  }
  return { A, B };
}

function makeBigImages(BW, BH) {
  const A = new StubCanvas(BW, BH), B = new StubCanvas(BW, BH);
  for (let y = 0; y < BH; y++) {
    for (let x = 0; x < BW; x++) {
      const i = (y * BW + x) * 4;
      const t = y / BH, u = x / BW;
      A.data[i] = Math.round(120 + 90 * Math.sin(t * 3.1) + 40 * u);
      A.data[i + 1] = Math.round(150 + 70 * t + 30 * Math.sin(u * 6));
      A.data[i + 2] = Math.round(200 - 60 * t);
      A.data[i + 3] = 255;
      // B 图：背景整体位移 + 中间贴纸描边，模拟"抠图前后"的效果
      const st = (y - 8) / BH, su = (x - 12) / BW;
      B.data[i] = Math.round(120 + 90 * Math.sin(st * 3.1) + 40 * su);
      B.data[i + 1] = Math.round(150 + 70 * st + 30 * Math.sin(su * 6));
      B.data[i + 2] = Math.round(200 - 60 * st);
      const cx = (x - BW / 2) / (BW * 0.34), cy = (y - BH / 2) / (BH * 0.34);
      const d = Math.sqrt(cx * cx + cy * cy);
      if (d < 0.94) { B.data[i] = 250; B.data[i + 1] = 240; B.data[i + 2] = 210; }
      else if (d < 1.0) { B.data[i] = B.data[i + 1] = B.data[i + 2] = 255; }
      B.data[i + 3] = 255;
    }
  }
  return { A, B };
}

/* ------------------------------------------------------------------ 主流程 */

let fail = 0;
function check(name, ok, extra) {
  if (ok) console.log('  \u2713 ' + name);
  else { fail++; console.log('  \u2717 ' + name + (extra ? '  -> ' + extra : '')); }
}

async function run() {
  const { A, B } = makeImages();
  console.log('\n[E2E] createJob 完整链路（桩化 canvas）');

  const job = CF.createJob({
    imageA: A, imageB: B, scale: 1, fit: 'cover',
    barWidth: BAR, barColor: '#ffffff',
    frames: FRAMES, delayMs: 40, mode: 'swing',
    colors: 128, dither: false, swap: false
  });
  const res = await job.generate();
  check('输出尺寸 = 图 A 尺寸', res.width === W && res.height === H, res.width + 'x' + res.height);
  console.log('  GIF 体积: ' + res.bytes + ' 字节, 编码帧数: ' + res.frames);

  const dec = decodeGif(Buffer.from(await res.blob.arrayBuffer()));
  check('解码帧数一致', dec.frames.length === FRAMES, dec.frames.length + '');
  check('逻辑尺寸一致', dec.width === W && dec.height === H);
  check('存在局部矩形帧（帧差生效）', dec.frames.filter(f => f.w < W || f.h < H).length > 0,
    dec.frames.map(f => f.w + 'x' + f.h).join(','));

  const positions = CF.framePositions(FRAMES, W, BAR, 'swing');
  const gct = dec.gct;
  const canvas = new Uint8Array(W * H);
  let badBar = 0, badSide = 0, sample = null;
  for (let i = 0; i < dec.frames.length; i++) {
    compose(canvas, dec.frames[i], W);
    const x = positions[i], half = BAR / 2;
    for (let y = 0; y < H; y++) {
      for (let px = 0; px < W; px++) {
        const gi = (y * W + px) * 4;
        const idx = canvas[y * W + px];
        const pr = gct[idx * 3], pg = gct[idx * 3 + 1], pb = gct[idx * 3 + 2];
        const dA = Math.abs(pr - A.data[gi]) + Math.abs(pg - A.data[gi + 1]) + Math.abs(pb - A.data[gi + 2]);
        const dB = Math.abs(pr - B.data[gi]) + Math.abs(pg - B.data[gi + 1]) + Math.abs(pb - B.data[gi + 2]);
        if (px >= x - half && px < x + half) {
          if (!(pr > 240 && pg > 240 && pb > 240)) { badBar++; sample = sample || ['bar', i, px, y, pr, pg, pb]; }
        } else if (px < x - half) {
          if (dA >= dB) { badSide++; sample = sample || ['left', i, px, y, dA, dB]; }
        } else {
          if (dB >= dA) { badSide++; sample = sample || ['right', i, px, y, dA, dB]; }
        }
      }
    }
  }
  check('白条位置与颜色正确（每帧）', badBar === 0, 'badBar=' + badBar + ' ' + JSON.stringify(sample));
  check('左 A / 右 B 归属正确（每帧）', badSide === 0, 'badSide=' + badSide + ' ' + JSON.stringify(sample));

  if (process.env.BIG) {
    const BW = 810, BH = 1080, BF = 30;
    const big = makeBigImages(BW, BH);
    const t0 = Date.now();
    const bigRes = await CF.createJob({
      imageA: big.A, imageB: big.B, scale: 1, fit: 'cover', barWidth: 8,
      barColor: '#ffffff', frames: BF, delayMs: 50, mode: 'swing',
      colors: 256, dither: !process.env.NODITHER, swap: false
    }).generate();
    console.log('\n[基准] ' + BW + 'x' + BH + ' / ' + BF + ' 帧 / 256 色 / ' +
      (process.env.NODITHER ? '无抖动' : '抖动') + ': ' +
      (bigRes.bytes / 1024).toFixed(1) + ' KB, 用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  }

  console.log('\n' + (fail === 0 ? '端到端验证通过 \u2713' : fail + ' 项失败 \u2717'));
  process.exit(fail === 0 ? 0 : 1);
}

run().catch((e) => { console.log('异常: ' + e.stack); process.exit(1); });

/**
 * roundtrip.test.js —— GIF 编码器自检（Node 运行，无第三方依赖）
 *
 *   node test/roundtrip.test.js
 *
 * 做三件事：
 *   1. 校验调色板量化：颜色数上限、"必须包含的颜色"（白条色）一定在表内；
 *   2. 按"白条滑动对比"的方式合成 8 帧，量化后得到期望的索引图；
 *   3. 用 GifWriter 写出 GIF（首帧全幅 + 后续只写变化矩形），再用本文件内
 *      独立实现的 GIF/LZW 解码器解回来，逐像素比对；
 *   4. 顺便把 GIF 落到 test/out/roundtrip.gif，方便用其它解码器（如 Pillow、
 *      浏览器）交叉验证 —— 脚本会打印每帧的 SHA1 便于比对。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Q = require('../public/js/quantizer.js');
const G = require('../public/js/gif-encoder.js');

/* ------------------------------------------------------------------ 迷你解码器 */

function lzwDecode(data, minCodeSize, pixelCount) {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let codeSize = minCodeSize + 1;
  let next = eoi + 1;
  const dict = new Array(4096);
  const reset = () => {
    for (let i = 0; i < clear; i++) dict[i] = [i];
    dict[clear] = null;
    dict[eoi] = null;
    next = eoi + 1;
    codeSize = minCodeSize + 1;
  };
  reset();

  const out = new Uint8Array(pixelCount);
  let outPos = 0;
  let bitPos = 0;
  let prev = null;

  const readCode = () => {
    if ((bitPos + codeSize) > data.length * 8) return -1;
    let code = 0;
    for (let i = 0; i < codeSize; i++) {
      const byte = data[bitPos >> 3];
      code |= ((byte >> (bitPos & 7)) & 1) << i;
      bitPos++;
    }
    return code;
  };

  for (;;) {
    const code = readCode();
    if (code === -1 || code === eoi) break;
    if (code === clear) { reset(); prev = null; continue; }
    let entry;
    if (code < next && dict[code]) entry = dict[code];
    else if (code === next && prev) entry = prev.concat(prev[0]);
    else throw new Error('LZW 码字越界: ' + code + ' (next=' + next + ')');
    for (let i = 0; i < entry.length && outPos < pixelCount; i++) out[outPos++] = entry[i];
    if (prev && next < 4096) {
      dict[next] = prev.concat(entry[0]);
      next++;
      // 表内条目数达到 2^codeSize 时，后续码字要用更宽的位读取
      if (next >= (1 << codeSize) && codeSize < 12) codeSize++;
    }
    prev = entry;
  }
  if (outPos !== pixelCount) throw new Error('像素数不足: ' + outPos + '/' + pixelCount);
  return out;
}

function decodeGif(buf) {
  let p = 0;
  const sig = String.fromCharCode(...buf.subarray(0, 6));
  if (sig !== 'GIF89a' && sig !== 'GIF87a') throw new Error('文件签名错误: ' + sig);
  p = 6;
  const width = buf[p] | (buf[p + 1] << 8); p += 2;
  const height = buf[p] | (buf[p + 1] << 8); p += 2;
  const packed = buf[p++];
  const bgIndex = buf[p++];
  p++; // 像素宽高比
  let gct = null;
  if (packed & 0x80) {
    const size = 1 << ((packed & 7) + 1);
    gct = buf.subarray(p, p + size * 3); p += size * 3;
  }
  const frames = [];
  let loopCount = null;
  let gce = { delay: 0, disposal: 0, transparent: -1 };

  while (p < buf.length) {
    const block = buf[p++];
    if (block === 0x3B) break;
    if (block === 0x21) {                       // 扩展块
      const label = buf[p++];
      if (label === 0xF9) {
        const size = buf[p++];
        if (size !== 4) throw new Error('图形控制扩展长度异常: ' + size);
        const flags = buf[p++];
        const delay = buf[p] | (buf[p + 1] << 8); p += 2;
        const tIndex = buf[p++];
        if (buf[p++] !== 0) throw new Error('图形控制扩展未正常结束');
        gce = { delay, disposal: (flags >> 2) & 7, transparent: (flags & 1) ? tIndex : -1 };
      } else if (label === 0xFF) {
        const size = buf[p++];
        const name = String.fromCharCode(...buf.subarray(p, p + size)); p += size;
        let first = true;
        for (;;) {
          const len = buf[p++];
          if (!len) break;
          if (first && name === 'NETSCAPE2.0' && buf[p] === 1) {
            loopCount = buf[p + 1] | (buf[p + 2] << 8);
          }
          first = false;
          p += len;
        }
      } else {
        for (;;) { const len = buf[p++]; if (!len) break; p += len; }
      }
      continue;
    }
    if (block === 0x2C) {                       // 图像描述符
      const x = buf[p] | (buf[p + 1] << 8); p += 2;
      const y = buf[p] | (buf[p + 1] << 8); p += 2;
      const w = buf[p] | (buf[p + 1] << 8); p += 2;
      const h = buf[p] | (buf[p + 1] << 8); p += 2;
      const ipacked = buf[p++];
      if (ipacked & 0x80) throw new Error('测试用例不期望局部色表');
      if (ipacked & 0x40) throw new Error('测试用例不期望交错');
      const minCodeSize = buf[p++];
      const chunks = [];
      for (;;) { const len = buf[p++]; if (!len) break; chunks.push(buf.subarray(p, p + len)); p += len; }
      const indices = lzwDecode(Buffer.concat(chunks), minCodeSize, w * h);
      frames.push({ x, y, w, h, indices, delay: gce.delay, disposal: gce.disposal });
      continue;
    }
    throw new Error('未知块 0x' + block.toString(16) + ' @' + (p - 1));
  }
  return { width, height, gct, bgIndex, frames, loopCount };
}

/** 按"保留上一帧"的处置方式把索引帧合成为整幅索引画布 */
function compose(indices, frame, W) {
  for (let row = 0; row < frame.h; row++) {
    for (let col = 0; col < frame.w; col++) {
      indices[(frame.y + row) * W + frame.x + col] = frame.indices[row * frame.w + col];
    }
  }
  return indices;
}

/* ------------------------------------------------------------------ 测试数据 */

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const W = 160, H = 120, FRAMES = 8, BAR = 9;

function makeSources() {
  const rnd = mulberry32(20261013);
  const a = new Uint8ClampedArray(W * H * 4);
  const b = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const n = Math.round(rnd() * 18);
      a[i] = Math.min(255, (x / W) * 255 + n);
      a[i + 1] = Math.min(255, (y / H) * 255 + n);
      a[i + 2] = 90 + Math.round(60 * Math.sin(x / 12));
      a[i + 3] = 255;
      b[i] = 255 - a[i];
      b[i + 1] = 255 - a[i + 2];
      b[i + 2] = Math.round((x + y) / (W + H) * 255);
      b[i + 3] = 255;
    }
  }
  return { a, b };
}

function positions(count, W, bar) {
  const x0 = bar / 2, L = W - bar, total = 2 * L, out = [];
  for (let i = 0; i < count; i++) {
    const s = (total * i) / count;
    out.push(x0 + (s <= L ? s : total - s));
  }
  return out;
}

/** 合成第 i 帧的 RGBA（左 A 右 B，中间白条） */
function composeRGBA(A, B, x) {
  const out = new Uint8ClampedArray(W * H * 4);
  const half = BAR / 2;
  for (let y = 0; y < H; y++) {
    for (let px = 0; px < W; px++) {
      const i = (y * W + px) * 4;
      let src;
      if (px < x - half) src = A;
      else if (px > x + half) src = B;
      else src = null;
      if (src) {
        out[i] = src[i]; out[i + 1] = src[i + 1]; out[i + 2] = src[i + 2]; out[i + 3] = 255;
      } else {
        out[i] = out[i + 1] = out[i + 2] = 255; out[i + 3] = 255;
      }
    }
  }
  return out;
}

/* ---------------------------------------------------------------------- 断言 */

let failed = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log('  \u2713 ' + name);
  } else {
    failed++;
    console.log('  \u2717 ' + name + (extra ? '  -> ' + extra : ''));
  }
}

/* ------------------------------------------------------------------------ 运行 */

function main() {
  const src = makeSources();

  console.log('\n[1] 调色板量化');
  const model = Q.createPalette(
    [{ data: src.a, stride: 2 }, { data: src.b, stride: 2 }],
    96,
    [[255, 255, 255]]
  );
  check('颜色数不超过上限', model.count <= 96, 'count=' + model.count);
  check('调色板长度 = 颜色数*3', model.palette.length === model.count * 3);
  const whiteIdx = Q.nearestIndex(model.colors, 255, 255, 255);
  check('纯白存在于调色板中', model.colors[whiteIdx][0] === 255 && model.colors[whiteIdx][1] === 255 && model.colors[whiteIdx][2] === 255);

  console.log('\n[2] 逐帧量化 + 帧差定位 + GIF 编码');
  const pos = positions(FRAMES, W, BAR);
  let dither = true;
  const expected = [];       // 期望的整幅索引图
  for (let i = 0; i < FRAMES; i++) {
    const rgba = composeRGBA(src.a, src.b, pos[i]);
    expected.push(Q.quantize(rgba, W, H, model, null, dither));
  }

  const writer = new G.GifWriter(W, H, model.palette, 0);
  let subRects = 0;
  for (let i = 0; i < FRAMES; i++) {
    let bx0 = 0, by0 = 0, bw = W, bh = H;
    if (i > 0) {
      const a = expected[i - 1], b = expected[i];
      bx0 = Infinity; let bx1 = -Infinity; by0 = Infinity; let by1 = -Infinity;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (a[y * W + x] !== b[y * W + x]) {
            if (x < bx0) bx0 = x;
            if (x > bx1) bx1 = x;
            if (y < by0) by0 = y;
            if (y > by1) by1 = y;
          }
        }
      }
      bx1++; by1++;
      bw = bx1 - bx0; bh = by1 - by0;
      if (bw < W || bh < H) subRects++;
    }
    writer.addFrame(expected[i], bx0, by0, bw, bh, 5);
  }
  const gif = writer.finish();
  check('写出的 GIF 非空', gif.length > 0, gif.length + ' 字节');
  check('使用了子矩形差分帧', subRects > 0, subRects + '/' + (FRAMES - 1));

  console.log('\n[3] 解码回读比对');
  const decoded = decodeGif(gif);
  check('逻辑屏幕尺寸一致', decoded.width === W && decoded.height === H, decoded.width + 'x' + decoded.height);
  check('帧数一致', decoded.frames.length === FRAMES, decoded.frames.length + '');
  check('NETSCAPE 无限循环标记存在', decoded.loopCount === 0, String(decoded.loopCount));
  check('全局色表存在', !!decoded.gct);

  let canvas = new Uint8Array(W * H);
  let mismatch = 0, firstBad = -1;
  for (let i = 0; i < decoded.frames.length; i++) {
    compose(canvas, decoded.frames[i], W);
    for (let k = 0; k < canvas.length; k++) {
      if (canvas[k] !== expected[i][k]) { mismatch++; if (firstBad < 0) firstBad = k; }
    }
  }
  check('逐像素索引完全一致', mismatch === 0, 'mismatch=' + mismatch + ' @' + firstBad);
  check('帧延时写入正确', decoded.frames.every(f => f.delay === 5));
  check('处置方式为"保留上一帧"', decoded.frames.every(f => f.disposal === 1));

  // 无抖动模式再跑一遍，覆盖另一条量化路径
  dither = false;
  for (let i = 0; i < FRAMES; i++) {
    expected[i] = Q.quantize(composeRGBA(src.a, src.b, pos[i]), W, H, model, null, false);
  }
  const w2 = new G.GifWriter(W, H, model.palette, 0);
  for (let i = 0; i < FRAMES; i++) w2.addFrame(expected[i], 0, 0, W, H, 4);
  const dec2 = decodeGif(w2.finish());
  let bad2 = 0;
  let canvas2 = new Uint8Array(W * H);
  for (let i = 0; i < dec2.frames.length; i++) {
    compose(canvas2, dec2.frames[i], W);
    for (let k = 0; k < canvas2.length; k++) if (canvas2[k] !== expected[i][k]) bad2++;
  }
  check('全幅帧（无抖动）逐像素一致', bad2 === 0, 'mismatch=' + bad2);

  console.log('\n[4] 输出文件（可交给浏览器/Pillow 交叉验证）');
  const outDir = path.join(__dirname, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const gifPath = path.join(outDir, 'roundtrip.gif');
  fs.writeFileSync(gifPath, gif);
  console.log('  文件: ' + gifPath + '  (' + gif.length + ' 字节)');
  const hashes = [], rgbHashes = [];
  let canvas3 = new Uint8Array(W * H);
  for (let i = 0; i < decoded.frames.length; i++) {
    compose(canvas3, decoded.frames[i], W);
    hashes.push(crypto.createHash('sha1').update(Buffer.from(canvas3)).digest('hex').slice(0, 16));
    const rgb = Buffer.alloc(W * H * 3);
    for (let k = 0; k < canvas3.length; k++) {
      rgb[k * 3] = model.palette[canvas3[k] * 3];
      rgb[k * 3 + 1] = model.palette[canvas3[k] * 3 + 1];
      rgb[k * 3 + 2] = model.palette[canvas3[k] * 3 + 2];
    }
    rgbHashes.push(crypto.createHash('sha1').update(rgb).digest('hex').slice(0, 16));
  }
  console.log('  各帧索引 SHA1(前16位): ' + hashes.join(' '));
  console.log('  各帧 RGB  SHA1(前16位): ' + rgbHashes.join(' '));

  console.log('\n' + (failed === 0 ? '全部通过 \u2713' : failed + ' 项失败 \u2717'));
  process.exit(failed === 0 ? 0 : 1);
}

if (require.main === module) {
  main();
} else {
  module.exports = { lzwDecode, decodeGif, compose };
}

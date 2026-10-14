/**
 * quantizer.js —— 调色板量化（中位切分 + K-means 微调 + 5bit 查找表）
 *
 * GIF 最多只能有 256 色，所以需要把两张图的像素颜色压缩成一张全局调色板。
 * 做法：
 *   1. 把 RGB 空间粗分为 32×32×32 个桶（每通道 5bit），统计每桶的像素数与颜色和；
 *   2. 对"桶"做中位切分（median cut），切成 <=maxColors 个盒子，每盒取加权平均色；
 *   3. 用 2 轮 K-means（Lloyd）微调调色板；
 *   4. 建立 32768 项的查找表，像素 -> rgb>>3 直接 O(1) 命中调色板索引（无抖动模式）。
 *
 * 该文件同时兼容浏览器（挂到 window.GifQuantizer）与 Node（module.exports），
 * 方便用 Node 跑自检脚本。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GifQuantizer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var LEVELS = 32;                       // 每通道 5 bit
  var BUCKETS = LEVELS * LEVELS * LEVELS; // 32768
  // 感知权重（近似人眼对 RGB 三通道的敏感度）
  var WR = 0.299, WG = 0.587, WB = 0.114;

  function bucketKey(r, g, b) {
    return ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
  }

  /* ------------------------------------------------------------------ 直方图 */

  function createHistogram() {
    return {
      count: new Float64Array(BUCKETS),
      sr: new Float64Array(BUCKETS),
      sg: new Float64Array(BUCKETS),
      sb: new Float64Array(BUCKETS),
      total: 0
    };
  }

  /** 向直方图累加一张 RGBA 像素数据；stride 为采样步长（按像素计） */
  function addPixels(hist, rgba, stride) {
    stride = Math.max(1, stride | 0);
    var step = stride * 4;
    for (var i = 0, n = rgba.length; i < n; i += step) {
      var r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      if (rgba[i + 3] === 0) continue;      // 全透明像素忽略
      var k = bucketKey(r, g, b);
      hist.count[k]++;
      hist.sr[k] += r;
      hist.sg[k] += g;
      hist.sb[k] += b;
      hist.total++;
    }
  }

  /* ------------------------------------------------------------- 中位切分 */

  function makeBox(hist, indices) {
    var rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0, weight = 0;
    for (var i = 0; i < indices.length; i++) {
      var k = indices[i];
      var r = k >> 10, g = (k >> 5) & 31, b = k & 31;
      if (r < rMin) rMin = r; if (r > rMax) rMax = r;
      if (g < gMin) gMin = g; if (g > gMax) gMax = g;
      if (b < bMin) bMin = b; if (b > bMax) bMax = b;
      weight += hist.count[k];
    }
    return {
      indices: indices,
      rMin: rMin, rMax: rMax, gMin: gMin, gMax: gMax, bMin: bMin, bMax: bMax,
      weight: weight
    };
  }

  function splitBox(hist, box) {
    var rRange = box.rMax - box.rMin, gRange = box.gMax - box.gMin, bRange = box.bMax - box.bMin;
    var axis = rRange >= gRange && rRange >= bRange ? 0 : (gRange >= bRange ? 1 : 2);
    var shift = axis === 0 ? 10 : (axis === 1 ? 5 : 0);
    var sorted = box.indices.slice().sort(function (a, b) {
      return ((a >> shift) & 31) - ((b >> shift) & 31);
    });
    var half = box.weight / 2, acc = 0, cut = 0;
    for (var i = 0; i < sorted.length - 1; i++) {
      acc += hist.count[sorted[i]];
      if (acc >= half) { cut = i + 1; break; }
    }
    if (cut <= 0) cut = 1;
    if (cut >= sorted.length) cut = sorted.length - 1;
    return [makeBox(hist, sorted.slice(0, cut)), makeBox(hist, sorted.slice(cut))];
  }

  function medianCut(hist, maxColors) {
    var all = [];
    for (var k = 0; k < BUCKETS; k++) if (hist.count[k] > 0) all.push(k);
    if (all.length === 0) {
      return [new Uint8Array([0, 0, 0])];
    }
    var boxes = [makeBox(hist, all)];
    while (boxes.length < maxColors) {
      var best = -1, bestScore = -1;
      for (var i = 0; i < boxes.length; i++) {
        var box = boxes[i];
        if (box.indices.length < 2) continue;
        var range = Math.max(box.rMax - box.rMin, box.gMax - box.gMin, box.bMax - box.bMin);
        if (range <= 0) continue;
        var score = box.weight * range;
        if (score > bestScore) { bestScore = score; best = i; }
      }
      if (best < 0) break;
      var pair = splitBox(hist, boxes[best]);
      boxes.splice(best, 1, pair[0], pair[1]);
    }
    var colors = [];
    for (var j = 0; j < boxes.length; j++) {
      var bx = boxes[j], c = hist.count, w = bx.weight || 1;
      var sr = 0, sg = 0, sb = 0;
      for (var t = 0; t < bx.indices.length; t++) {
        var kk = bx.indices[t];
        sr += c[kk] * (hist.sr[kk] / c[kk]);
        sg += c[kk] * (hist.sg[kk] / c[kk]);
        sb += c[kk] * (hist.sb[kk] / c[kk]);
      }
      colors.push([clamp255(sr / w), clamp255(sg / w), clamp255(sb / w)]);
    }
    return colors;
  }

  function clamp255(v) {
    v = Math.round(v);
    return v < 0 ? 0 : (v > 255 ? 255 : v);
  }

  /* ------------------------------------------------------- K-means 微调 */

  function buildLut(colors) {
    var lut = new Uint8Array(BUCKETS);
    var n = colors.length;
    for (var k = 0; k < BUCKETS; k++) {
      var r = ((k >> 10) & 31) * 8 + 4;
      var g = ((k >> 5) & 31) * 8 + 4;
      var b = (k & 31) * 8 + 4;
      var best = 0, bestD = Infinity;
      for (var i = 0; i < n; i++) {
        var c = colors[i];
        var dr = (r - c[0]) * WR, dg = (g - c[1]) * WG, db = (b - c[2]) * WB;
        var d = dr * dr + dg * dg + db * db;
        if (d < bestD) { bestD = d; best = i; }
      }
      lut[k] = best;
    }
    return lut;
  }

  /**
   * K-means（Lloyd）微调
   * @param {number} pinned 末尾 pinned 项为固定颜色（如白条色），不参与均值更新
   */
  function refine(hist, colors, rounds, pinned) {
    pinned = pinned || 0;
    var lut = buildLut(colors);
    var movable = colors.length - pinned;
    for (var round = 0; round < rounds; round++) {
      var n = colors.length;
      var sr = new Float64Array(n), sg = new Float64Array(n), sb = new Float64Array(n), sn = new Float64Array(n);
      for (var k = 0; k < BUCKETS; k++) {
        var cnt = hist.count[k];
        if (cnt <= 0) continue;
        var idx = lut[k];
        sr[idx] += hist.sr[k]; sg[idx] += hist.sg[k]; sb[idx] += hist.sb[k];
        sn[idx] += cnt;
      }
      for (var i = 0; i < movable; i++) {
        if (sn[i] > 0) colors[i] = [clamp255(sr[i] / sn[i]), clamp255(sg[i] / sn[i]), clamp255(sb[i] / sn[i])];
      }
      lut = buildLut(colors);
    }
    return lut;
  }

  /* --------------------------------------------------------------- 对外 API */

  /**
   * 构建调色板模型
   * @param {Array<{data: Uint8ClampedArray|Uint8Array, stride?: number}>} sources 采样源（RGBA）
   * @param {number} maxColors 目标颜色数（2~256）
   * @param {Array<number>} [mustColors] 必须包含的颜色，如 [255,255,255]
   */
  function createPalette(sources, maxColors, mustColors) {
    maxColors = Math.max(2, Math.min(256, maxColors | 0));
    var hist = createHistogram();
    for (var i = 0; i < sources.length; i++) {
      addPixels(hist, sources[i].data, sources[i].stride || 1);
    }
    // 必须包含的颜色（白条色）先预留出来，并固定在调色板末尾不参与均值更新，
    // 这样既保证它一定在表内，又不会被 K-means 拉偏
    var pins = [];
    if (mustColors) {
      for (var m = 0; m < mustColors.length && pins.length < maxColors; m++) {
        if (!containsColor(pins, mustColors[m])) pins.push(mustColors[m].slice());
      }
    }
    var colors = medianCut(hist, Math.max(1, maxColors - pins.length));
    for (var q = 0; q < pins.length; q++) colors.push(pins[q]);

    var lut = refine(hist, colors, 2, pins.length);
    var palette = new Uint8Array(colors.length * 3);
    for (var c = 0; c < colors.length; c++) {
      palette[c * 3] = colors[c][0];
      palette[c * 3 + 1] = colors[c][1];
      palette[c * 3 + 2] = colors[c][2];
    }
    return { palette: palette, colors: colors, lut: lut, count: colors.length };
  }

  function containsColor(colors, target) {
    for (var i = 0; i < colors.length; i++) {
      var c = colors[i];
      if (c[0] === target[0] && c[1] === target[1] && c[2] === target[2]) return true;
    }
    return false;
  }

  /** 最近颜色（精确搜索，用于自定义白条颜色等） */
  function nearestIndex(colors, r, g, b) {
    var best = 0, bestD = Infinity;
    for (var i = 0; i < colors.length; i++) {
      var c = colors[i];
      var dr = (r - c[0]) * WR, dg = (g - c[1]) * WG, db = (b - c[2]) * WB;
      var d = dr * dr + dg * dg + db * db;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  /**
   * 把 RGBA 像素量化为调色板索引
   * @param {Uint8ClampedArray} rgba 像素数据
   * @param {number} width
   * @param {number} height
   * @param {object} model createPalette 的返回值
   * @param {Uint8Array} out 输出（长度 width*height），可复用
   * @param {boolean} dither 是否使用 Floyd–Steinberg 误差扩散
   */
  function quantize(rgba, width, height, model, out, dither) {
    var lut = model.lut, palette = model.palette;
    var n = width * height;
    if (!out || out.length !== n) out = new Uint8Array(n);
    if (!dither) {
      for (var i = 0, p = 0; i < n; i++, p += 4) {
        out[i] = lut[bucketKey(rgba[p], rgba[p + 1], rgba[p + 2])];
      }
      return out;
    }
    // Floyd–Steinberg：误差缓冲按行滚动
    var cur = new Float32Array((width + 2) * 3);
    var next = new Float32Array((width + 2) * 3);
    for (var y = 0; y < height; y++) {
      for (var x = 0; x < width; x++) {
        var i4 = (y * width + x) * 4, e = (x + 1) * 3;
        var r = clampByte(rgba[i4] + cur[e]);
        var g = clampByte(rgba[i4 + 1] + cur[e + 1]);
        var b = clampByte(rgba[i4 + 2] + cur[e + 2]);
        var idx = lut[bucketKey(r, g, b)];
        out[y * width + x] = idx;
        var er = r - palette[idx * 3];
        var eg = g - palette[idx * 3 + 1];
        var eb = b - palette[idx * 3 + 2];
        cur[e + 3] += er * 0.4375; cur[e + 4] += eg * 0.4375; cur[e + 5] += eb * 0.4375;
        next[e - 3] += er * 0.1875; next[e - 2] += eg * 0.1875; next[e - 1] += eb * 0.1875;
        next[e] += er * 0.3125; next[e + 1] += eg * 0.3125; next[e + 2] += eb * 0.3125;
        next[e + 3] += er * 0.0625; next[e + 4] += eg * 0.0625; next[e + 5] += eb * 0.0625;
      }
      cur.set(next);
      next.fill(0);
    }
    return out;
  }

  function clampByte(v) {
    return v < 0 ? 0 : (v > 255 ? 255 : v);
  }

  return {
    LEVELS: LEVELS,
    BUCKETS: BUCKETS,
    bucketKey: bucketKey,
    createHistogram: createHistogram,
    addPixels: addPixels,
    createPalette: createPalette,
    nearestIndex: nearestIndex,
    refine: refine,
    buildLut: buildLut,
    quantize: quantize
  };
});

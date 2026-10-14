/**
 * comparer.js —— 前后对比动图的核心：画面合成 + 逐帧量化 + GIF 组装
 *
 * 动画效果：一根竖直白条左右循环滑动，白条左侧显示图 A，右侧显示图 B，
 * 于是整幅画面上呈现出"前后对比"的揭示效果。
 *
 * 性能与体积优化：
 *   - 相邻两帧只有"白条扫过的那一条竖带"会变化 => 只重绘该竖带；
 *   - 只把真正变化的像素矩形写入 GIF（帧差定位），体积可缩小一个数量级。
 *
 * 浏览器专用（依赖 canvas），兼容 window.ImgCompare。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof root !== 'undefined' && root) root.ImgCompare = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var Q = (typeof GifQuantizer !== 'undefined') ? GifQuantizer
    : (typeof require === 'function' ? require('./quantizer.js') : null);
  var E = (typeof GifEncoder !== 'undefined') ? GifEncoder
    : (typeof require === 'function' ? require('./gif-encoder.js') : null);

  /* --------------------------------------------------------------- 工具函数 */

  function createCanvas(w, h) {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  function hexToRgb(hex) {
    var m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(String(hex || '').trim());
    if (!m) return [255, 255, 255];
    return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
  }

  /** 加载用户选择的图片（自动处理 EXIF 方向） */
  async function loadImage(source) {
    if (typeof createImageBitmap === 'function') {
      try {
        return await createImageBitmap(source, { imageOrientation: 'from-image' });
      } catch (e) { /* 老浏览器不支持该参数，走下面的兜底 */ }
    }
    var url = typeof source === 'string' ? source : URL.createObjectURL(source);
    try {
      return await new Promise(function (resolve, reject) {
        var img = new Image();
        img.onload = function () { resolve(img); };
        img.onerror = function () { reject(new Error('图片解码失败')); };
        img.src = url;
      });
    } finally {
      if (typeof source !== 'string') setTimeout(function () { URL.revokeObjectURL(url); }, 0);
    }
  }

  /** 逐级降采样，避免一次性大幅缩小造成锯齿 */
  function stepDown(image, scale) {
    var cur = image, w = image.width, h = image.height;
    while (w >= 2 && h >= 2 && w / 2 >= w * scale && h / 2 >= h * scale) {
      var half = createCanvas(Math.max(1, Math.floor(w / 2)), Math.max(1, Math.floor(h / 2)));
      var ctx = half.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(cur, 0, 0, half.width, half.height);
      cur = half; w = half.width; h = half.height;
    }
    return cur;
  }

  /**
   * 把图片按目标尺寸铺到不透明画布上（与最终 GIF 的像素完全一致）
   * @param {'cover'|'contain'} fit
   */
  function prepareSource(image, W, H, fit) {
    var iw = image.width || image.naturalWidth;
    var ih = image.height || image.naturalHeight;
    var scale = fit === 'contain' ? Math.min(W / iw, H / ih) : Math.max(W / iw, H / ih);
    var src = scale < 0.5 ? stepDown(image, scale) : image;
    var canvas = createCanvas(W, H);
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    var dw = iw * scale, dh = ih * scale;
    ctx.drawImage(src, (W - dw) / 2, (H - dh) / 2, dw, dh);
    return canvas;
  }

  /**
   * 合成一帧：左半（白条左侧）取 left 图，右半取 right 图，中间覆盖白色竖条
   * @param {CanvasRenderingContext2D} ctx
   * @param {{x:number,y:number,w:number,h:number}} [region] 只绘制该区域
   */
  function composeFrame(ctx, left, right, W, H, x, barWidth, barColor, region) {
    var r = region || { x: 0, y: 0, w: W, h: H };
    var half = barWidth / 2;
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.clip();
    ctx.drawImage(left, 0, 0, W, H, 0, 0, W, H);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + half, 0, W - x - half, H);
    ctx.clip();
    ctx.drawImage(right, 0, 0, W, H, 0, 0, W, H);
    ctx.restore();
    ctx.fillStyle = barColor;
    ctx.fillRect(x - half, 0, barWidth, H);
    ctx.restore();
  }

  /**
   * 进度 t（0~1，循环）对应的白条中心位置
   * @param {'swing'|'wipe'} mode swing=左右往返（循环无缝），wipe=单向右扫后回到起点
   */
  function progressToPosition(t, W, barWidth, mode) {
    var x0 = Math.min(barWidth / 2, W / 2);
    var L = Math.max(1, W - barWidth);   // 白条中心可移动的距离
    var tt = ((t % 1) + 1) % 1;          // 归一到 [0,1)
    if (mode === 'wipe') {
      return x0 + tt * L;                  // 单向：扫到底后跳回起点
    }
    var total = 2 * L;
    var s = tt * total;                    // 往返：0 -> L -> 0，循环无缝
    return x0 + (s <= L ? s : total - s);
  }

  /** 每一帧白条中心的位置（N 个采样点，循环无缝） */
  function framePositions(count, W, barWidth, mode) {
    var out = new Array(count);
    for (var i = 0; i < count; i++) {
      out[i] = progressToPosition(i / count, W, barWidth, mode);
    }
    return out;
  }

  /* ------------------------------------------------------------ 生成任务 */

  /**
   * @param {object} opts
   *   imageA/imageB: ImageBitmap | HTMLImageElement  （A=前，B=后）
   *   scale: 输出缩放（1=与图 A 同尺寸）
   *   fit: 'cover' | 'contain'
   *   barWidth: 白条宽度（像素，基于输出尺寸）
   *   barColor: 白条颜色
   *   frames: 帧数
   *   delayMs: 每帧显示时长（毫秒，存在 GIF 里会被取整到 10ms）
   *   mode: 'swing' | 'wipe'
   *   colors: 调色板颜色数
   *   dither: 是否误差扩散抖动
   *   swap: true 表示左右两张图对调
   *   onProgress: ({frame,total,phase}) => void
   */
  function createJob(opts) {
    return {
      options: opts,
      /**
       * @returns {Promise<{blob: Blob, bytes: number, width: number, height: number, frames: number, positions: number[]}>}
       */
      generate: async function (onProgress) {
        var imageA = opts.imageA, imageB = opts.imageB;
        var aW = imageA.width || imageA.naturalWidth;
        var aH = imageA.height || imageA.naturalHeight;
        var scale = opts.scale || 1;
        var W = Math.max(2, Math.round(aW * scale));
        var H = Math.max(2, Math.round(aH * scale));

        var barWidth = Math.max(1, Math.round(opts.barWidth || 6));
        var barColor = opts.barColor || '#ffffff';
        var dither = opts.dither !== false;
        var frames = Math.max(2, Math.min(200, opts.frames || 30));
        var delayCs = Math.max(2, Math.round((opts.delayMs || 50) / 10)); // GIF 单位 1/100 秒
        var mode = opts.mode === 'wipe' ? 'wipe' : 'swing';

        // 1. 把两张图铺成与输出完全一致的像素画布
        var left = prepareSource(opts.swap ? imageB : imageA, W, H, opts.fit);
        var right = prepareSource(opts.swap ? imageA : imageB, W, H, opts.fit);

        // 2. 采样两图颜色 -> 全局调色板（保证白条颜色一定在表内）
        var leftData = left.getContext('2d').getImageData(0, 0, W, H).data;
        var rightData = right.getContext('2d').getImageData(0, 0, W, H).data;
        var stride = Math.max(1, Math.floor((W * H) / 120000));
        var model = Q.createPalette(
          [{ data: leftData, stride: stride }, { data: rightData, stride: stride }],
          opts.colors || 256,
          [hexToRgb(barColor)]
        );

        // 3. 准备逐帧合成用的画布
        var stage = createCanvas(W, H);
        var stageCtx = stage.getContext('2d', { willReadFrequently: true });
        var writer = new (E.GifWriter)(W, H, model.palette, 0);

        var total = W * H;
        var f0 = new Uint8Array(total), f1 = new Uint8Array(total);
        var prev = null, cur = f0, spare = f1;
        var pendingDelay = 0;
        var strip = null, stripW = 0;
        var positions = framePositions(frames, W, barWidth, mode);
        var encodedFrames = 0;

        // 4. 逐帧渲染 + 量化 + 写 GIF
        for (var i = 0; i < frames; i++) {
          if (prev) cur.set(prev);
          var x = positions[i];
          var px = i > 0 ? positions[i - 1] : x;
          var region;
          if (!prev) {
            region = { x: 0, y: 0, w: W, h: H };
          } else {
            var x0 = Math.max(0, Math.floor(Math.min(px, x) - barWidth / 2) - 2);
            var x1 = Math.min(W, Math.ceil(Math.max(px, x) + barWidth / 2) + 2);
            region = { x: x0, y: 0, w: x1 - x0, h: H };
          }
          if (region.w <= 0) { pendingDelay += delayCs; continue; }

          composeFrame(stageCtx, left, right, W, H, x, barWidth, barColor, region);
          var img = stageCtx.getImageData(region.x, 0, region.w, H);
          stripW = region.w;
          strip = Q.quantize(img.data, stripW, H, model, strip, dither);
          // 把竖带结果贴回整幅索引图
          for (var row = 0; row < H; row++) {
            var dst = row * W + region.x;
            var srcOff = row * stripW;
            for (var c = 0; c < stripW; c++) cur[dst + c] = strip[srcOff + c];
          }
          onProgress && onProgress({ frame: i + 1, total: frames, phase: 'render' });
          if (i % 2 === 1) await nextTick();

          // 5. 帧差定位：只写变化的最小矩形
          var bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
          if (!prev) {
            bx0 = 0; bx1 = W - 1; by0 = 0; by1 = H - 1;
          } else {
            for (var y = 0; y < H; y++) {
              var base = y * W;
              for (var xx = region.x; xx < region.x + region.w; xx++) {
                if (cur[base + xx] !== prev[base + xx]) {
                  if (xx < bx0) bx0 = xx;
                  if (xx > bx1) bx1 = xx;
                  if (y < by0) by0 = y;
                  if (y > by1) by1 = y;
                }
              }
            }
          }
          if (bx1 < bx0) { // 该帧与上一帧完全相同：直接把时长累积给下一帧
            pendingDelay += delayCs;
            continue;
          }
          writer.addFrame(cur, bx0, by0, bx1 - bx0 + 1, by1 - by0 + 1, delayCs + pendingDelay);
          pendingDelay = 0;
          encodedFrames++;

          // 交换缓冲：cur 变成上一帧，原 prev 作为下一帧的画布
          var tmp = cur; prev = cur; cur = spare; spare = tmp;
          onProgress && onProgress({ frame: i + 1, total: frames, phase: 'encode' });
          if (i % 2 === 0) await nextTick();
        }

        var bytes = writer.finish();
        var gif = new Uint8Array(bytes.length);
        gif.set(bytes);
        var blob = new Blob([gif], { type: 'image/gif' });
        return {
          blob: blob,
          bytes: gif.length,
          width: W,
          height: H,
          frames: encodedFrames,
          positions: positions
        };
      }
    };
  }

  function nextTick() {
    return new Promise(function (resolve) { setTimeout(resolve, 0); });
  }

  return {
    loadImage: loadImage,
    prepareSource: prepareSource,
    composeFrame: composeFrame,
    framePositions: framePositions,
    progressToPosition: progressToPosition,
    createJob: createJob,
    createCanvas: createCanvas,
    hexToRgb: hexToRgb
  };
});

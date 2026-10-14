/**
 * gif-encoder.js —— 极简 GIF89a 编码器（全局调色板 + LZW + 帧差定位）
 *
 * 只实现生成"对比动图"所需的最小功能：
 *   - GIF89a 文件头 + 逻辑屏幕描述符 + 全局色表
 *   - NETSCAPE2.0 无限循环扩展
 *   - 每帧图形控制扩展（延时 / 处置方式=不清除）
 *   - 每帧可指定子矩形（只写变化的区域，大幅减小体积）
 *
 * LZW 的字典/码长同步规则与主流编解码器一致（码字上限达到 2^codeSize 时位宽 +1，
 * 字典满 4096 时发 CLEAR 重置）。
 *
 * 兼容浏览器（window.GifEncoder）与 Node（module.exports）。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GifEncoder = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* --------------------------------------------------------------- 动态字节缓冲 */
  function ByteBuffer(size) {
    this.buf = new Uint8Array(size || 1 << 16);
    this.len = 0;
  }
  ByteBuffer.prototype._ensure = function (n) {
    if (this.len + n <= this.buf.length) return;
    var cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    var nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.len));
    this.buf = nb;
  };
  ByteBuffer.prototype.byte = function (v) {
    this._ensure(1);
    this.buf[this.len++] = v & 0xff;
  };
  ByteBuffer.prototype.bytes = function (arr) {
    this._ensure(arr.length);
    this.buf.set(arr, this.len);
    this.len += arr.length;
  };
  ByteBuffer.prototype.short = function (v) {
    this._ensure(2);
    this.buf[this.len++] = v & 0xff;
    this.buf[this.len++] = (v >> 8) & 0xff;
  };
  ByteBuffer.prototype.view = function () {
    return this.buf.subarray(0, this.len);
  };

  /* ------------------------------------------------------------------- LZW */
  // 复用字典（4096*256 项），避免每帧重复分配
  var DICT = null;
  var BLOCK = new Uint8Array(255);

  function lzwEncode(pixels, minCodeSize, out) {
    var clearCode = 1 << minCodeSize;
    var eoiCode = clearCode + 1;
    var codeSize = minCodeSize + 1;
    var next = eoiCode + 1;

    if (!DICT) DICT = new Int32Array(4096 * 256);
    var dict = DICT;
    dict.fill(-1);

    var blockLen = 0, bitBuf = 0, bitCount = 0;

    function pushByte(b) {
      BLOCK[blockLen++] = b;
      if (blockLen === 255) {
        out.byte(255);
        out.bytes(BLOCK);
        blockLen = 0;
      }
    }
    function emit(code) {
      bitBuf |= code << bitCount;
      bitCount += codeSize;
      while (bitCount >= 8) {
        pushByte(bitBuf & 0xff);
        bitBuf >>>= 8;
        bitCount -= 8;
      }
    }

    emit(clearCode);

    var n = pixels.length;
    if (n > 0) {
      var prefix = pixels[0];
      for (var i = 1; i < n; i++) {
        var k = pixels[i];
        var key = (prefix << 8) | k;
        var code = dict[key];
        if (code !== -1) { prefix = code; continue; }
        emit(prefix);
        if (next === 4096) {
          emit(clearCode);
          dict.fill(-1);
          next = eoiCode + 1;
          codeSize = minCodeSize + 1;
        } else {
          if (next >= (1 << codeSize)) codeSize++;
          dict[key] = next++;
        }
        prefix = k;
      }
      emit(prefix);
    }
    emit(eoiCode);
    if (bitCount > 0) pushByte(bitBuf & 0xff);
    if (blockLen > 0) {
      out.byte(blockLen);
      out.bytes(BLOCK.subarray(0, blockLen));
    }
    out.byte(0); // 图像数据终止符
  }

  /* ------------------------------------------------------------- 帧子矩形提取 */
  function extractSub(indices, stride, x, y, w, h) {
    if (x === 0 && w === stride) {
      return indices.subarray(y * stride, (y + h) * stride);
    }
    var out = new Uint8Array(w * h);
    for (var r = 0; r < h; r++) {
      var src = (y + r) * stride + x;
      out.set(indices.subarray(src, src + w), r * w);
    }
    return out;
  }

  /* ------------------------------------------------------------- GifWriter */
  /**
   * @param {number} width  画布宽（逻辑屏幕宽）
   * @param {number} height 画布高
   * @param {Uint8Array} palette RGB 三元组数组，长度 = 颜色数*3（<=768）
   * @param {number} [loopCount] 0 表示无限循环
   */
  function GifWriter(width, height, palette, loopCount) {
    this.width = width | 0;
    this.height = height | 0;
    var colorCount = Math.max(2, Math.floor(palette.length / 3));
    var bits = 1;
    while ((1 << bits) < colorCount) bits++;
    if (bits > 8) bits = 8;
    this.tableSize = 1 << bits;
    this.minCodeSize = Math.max(2, bits);

    var out = new ByteBuffer(Math.max(1 << 16, this.width * this.height >> 2));
    out.bytes([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);            // "GIF89a"
    out.short(this.width);
    out.short(this.height);
    out.byte(0x80 | ((bits - 1) << 4) | (bits - 1));              // 有全局色表 | 色深 | 色表大小
    out.byte(0);                                                  // 背景色索引
    out.byte(0);                                                  // 像素宽高比
    // 全局色表（补零到 2^bits 项）
    var table = new Uint8Array(this.tableSize * 3);
    table.set(palette.subarray(0, Math.min(palette.length, table.length)));
    out.bytes(table);
    // NETSCAPE2.0 循环扩展
    out.bytes([0x21, 0xFF, 0x0B]);
    out.bytes([0x4E, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2E, 0x30]);
    out.bytes([0x03, 0x01, (loopCount || 0) & 0xff, ((loopCount || 0) >> 8) & 0xff, 0x00]);

    this.out = out;
    this.frameCount = 0;
  }

  /**
   * 追加一帧
   * @param {Uint8Array} indices 整幅画布的调色板索引（长度 = width*height）
   * @param {number} x 变化区域左上角
   * @param {number} y
   * @param {number} w
   * @param {number} h
   * @param {number} delayCs 帧延时（1/100 秒）
   */
  GifWriter.prototype.addFrame = function (indices, x, y, w, h, delayCs) {
    var out = this.out;
    delayCs = Math.max(0, Math.round(delayCs));
    // 图形控制扩展：块长4 | 处置方式=1（保留上一帧，配合只写变化区域）
    // | 延时(2字节, 1/100秒) | 透明色索引 | 块终止符
    out.bytes([0x21, 0xF9, 0x04, 0x04, delayCs & 0xff, (delayCs >> 8) & 0xff, 0x00, 0x00]);
    out.byte(0x2C);              // 图像描述符
    out.short(x);
    out.short(y);
    out.short(w);
    out.short(h);
    out.byte(0x00);              // 无局部色表、非交错
    out.byte(this.minCodeSize);
    lzwEncode(extractSub(indices, this.width, x, y, w, h), this.minCodeSize, out);
    this.frameCount++;
    return this;
  };

  GifWriter.prototype.finish = function () {
    this.out.byte(0x3B);         // Trailer
    return this.out.view();
  };

  return {
    GifWriter: GifWriter,
    extractSub: extractSub,
    ByteBuffer: ByteBuffer
  };
});

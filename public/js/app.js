/**
 * app.js —— 页面交互：上传、参数、实时预览、生成与下载
 */
(function () {
  'use strict';

  var CF = window.ImgCompare;
  var PREVIEW_MAX = 1200;      // 预览画布最长边（避免超大图卡顿）

  // 原生 select 的展开列表无法美化，统一换成自绘下拉框（原生元素保留为数据源，
  // 仍然继续向外派发 change 事件，所以下面所有逻辑无需改动）
  if (window.Dropdown) window.Dropdown.enhanceAll('.settings select');

  function $(id) { return document.getElementById(id); }

  var state = {
    files: { a: null, b: null },
    images: { a: null, b: null },
    sources: null,             // { left, right, w, h, scale }
    previewScale: 1,
    playing: true,
    t: 0,
    lastTs: 0,
    resultUrl: null,
    generating: false,
    barTouched: false,
    rebuildTimer: 0
  };

  var preview = $('preview');
  var pctx = preview.getContext('2d');

  /* ------------------------------------------------------------- 参数读取 */

  function params() {
    return {
      barWidth: +$('barWidth').value,
      barColor: $('barColor').value,
      frames: +$('frames').value,
      delayMs: +$('delay').value,
      mode: $('mode').value,
      scale: +$('scale').value,
      fit: $('fit').value,
      colors: +$('colors').value,
      dither: $('dither').checked,
      swap: $('swap').checked
    };
  }

  function setStatus(text, kind) {
    var s = $('status');
    s.textContent = text;
    s.className = 'status' + (kind ? ' ' + kind : '');
  }

  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  function dim(img) {
    return { w: img.width || img.naturalWidth, h: img.height || img.naturalHeight };
  }

  /* --------------------------------------------------------------- 上传 */

  async function setImage(slot, file) {
    if (!file) return;
    if (!/^image\//.test(file.type) && !/\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name)) {
      setStatus('这不是图片文件：' + (file.name || ''), 'error');
      return;
    }
    try {
      var img = await CF.loadImage(file);
    } catch (e) {
      setStatus('图片解析失败：' + e.message, 'error');
      return;
    }
    var old = state.images[slot];
    if (old && typeof old.close === 'function') old.close();
    state.files[slot] = file;
    state.images[slot] = img;

    var zone = $(slot === 'a' ? 'zoneA' : 'zoneB');
    zone.classList.add('filled');
    zone.querySelector('.dz-empty').hidden = true;
    var box = zone.querySelector('.dz-preview');
    box.hidden = false;
    var size = dim(img);
    var thumbImg = box.querySelector('img');
    if (thumbImg.dataset.url) URL.revokeObjectURL(thumbImg.dataset.url);
    var thumbUrl = URL.createObjectURL(file);
    thumbImg.dataset.url = thumbUrl;
    thumbImg.src = thumbUrl;
    box.querySelector('.dz-meta').textContent =
      (file.name || 'clipboard') + ' · ' + size.w + '×' + size.h;

    if (slot === 'a' && !state.barTouched) {
      var suggested = Math.max(3, Math.min(24, Math.round(size.w * 0.01)));
      $('barWidth').value = suggested;
      $('barWidthVal').textContent = suggested + ' px';
    }
    updateHint();
    scheduleRebuild();
    updateReadyState();
  }

  function updateHint() {
    var a = state.images.a, b = state.images.b;
    var hint = $('sizeHint');
    if (!a) { hint.textContent = '输出尺寸 = 图片 A 的尺寸（可在下方缩小）。'; return; }
    var sa = dim(a);
    if (!b) {
      hint.textContent = '输出 GIF：' + sa.w + '×' + sa.h + '（与图片 A 相同）。等待图片 B…';
      return;
    }
    var sb = dim(b);
    if (Math.abs(sa.w / sa.h - sb.w / sb.h) > 0.01) {
      hint.textContent = '提示：两张图比例不同（' + sa.w + '×' + sa.h + ' / ' + sb.w + '×' + sb.h +
        '），建议选「铺满裁剪」让两者对齐。';
    } else {
      hint.textContent = '输出 GIF：' + sa.w + '×' + sa.h + '（与图片 A 相同）。';
    }
  }

  function updateReadyState() {
    var ok = !!(state.images.a && state.images.b);
    $('generateBtn').disabled = !ok || state.generating;
    $('playBtn').disabled = !ok;
    $('scrub').disabled = !ok;
    $('previewEmpty').hidden = ok;
  }

  /* --------------------------------------------------------------- 预览 */

  function rebuildPreview() {
    var a = state.images.a, b = state.images.b;
    if (!a || !b) { state.sources = null; return; }
    var p = params();
    var sa = dim(a);
    var scale = Math.min(1, PREVIEW_MAX / Math.max(sa.w, sa.h));
    var w = Math.max(2, Math.round(sa.w * scale));
    var h = Math.max(2, Math.round(sa.h * scale));
    var left = CF.prepareSource(p.swap ? b : a, w, h, p.fit);
    var right = CF.prepareSource(p.swap ? a : b, w, h, p.fit);
    state.sources = { left: left, right: right, w: w, h: h, scale: scale };
    preview.width = w;
    preview.height = h;
    $('previewInfo').textContent = w + '×' + h;
    drawPreview();
  }

  function scheduleRebuild() {
    clearTimeout(state.rebuildTimer);
    state.rebuildTimer = setTimeout(rebuildPreview, 120);
  }

  function drawPreview() {
    var s = state.sources;
    if (!s) {
      pctx.clearRect(0, 0, preview.width, preview.height);
      return;
    }
    var p = params();
    var barW = Math.max(1, p.barWidth * s.scale);
    var x = CF.progressToPosition(state.t, s.w, barW, p.mode);
    CF.composeFrame(pctx, s.left, s.right, s.w, s.h, x, barW, p.barColor, null);
  }

  function loop(ts) {
    requestAnimationFrame(loop);
    var dt = state.lastTs ? Math.min(200, ts - state.lastTs) : 0;
    state.lastTs = ts;
    if (!state.sources) return;
    var p = params();
    if (state.playing) {
      var cycle = p.frames * p.delayMs;      // 一整轮动画时长（与导出一致）
      state.t += dt / cycle;
      if (state.t >= 1) state.t -= Math.floor(state.t);
      $('scrub').value = Math.round(state.t * 1000);
    }
    drawPreview();
  }

  function setPlaying(v) {
    state.playing = v;
    $('playBtn').textContent = v ? '暂停' : '播放';
    state.lastTs = 0;
  }

  /* --------------------------------------------------------------- 生成 */

  async function generate() {
    if (state.generating || !state.images.a || !state.images.b) return;
    var p = params();
    state.generating = true;
    $('generateBtn').disabled = true;
    $('progressWrap').hidden = false;
    $('progressBar').style.width = '0%';
    $('progressText').textContent = '准备中…';
    setStatus('正在量化调色板并逐帧编码，请勿关闭页面…');

    var started = performance.now();
    try {
      var job = CF.createJob({
        imageA: state.images.a,
        imageB: state.images.b,
        scale: p.scale,
        fit: p.fit,
        barWidth: p.barWidth,
        barColor: p.barColor,
        frames: p.frames,
        delayMs: p.delayMs,
        mode: p.mode,
        colors: p.colors,
        dither: p.dither,
        swap: p.swap
      });
      var res = await job.generate(function (info) {
        var pct = Math.round((info.frame / info.total) * 100);
        $('progressBar').style.width = pct + '%';
        $('progressText').textContent = (info.phase === 'encode' ? '写入 GIF 帧 ' : '渲染第 ') +
          info.frame + ' / ' + info.total + ' 帧 · ' + pct + '%';
      });

      if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
      state.resultUrl = URL.createObjectURL(res.blob);
      $('resultImg').src = state.resultUrl;
      $('resultWrap').hidden = false;
      $('downloadBtn').href = state.resultUrl;
      $('downloadBtn').download = 'compare-' + res.width + 'x' + res.height + '-' + res.frames + 'f.gif';
      $('downloadBtn').hidden = false;
      $('resultMeta').textContent = res.width + '×' + res.height + ' · ' + res.frames +
        ' 帧 · ' + formatBytes(res.bytes) + ' · 用时 ' + ((performance.now() - started) / 1000).toFixed(1) + 's';
      $('progressBar').style.width = '100%';
      $('progressText').textContent = '完成';
      setStatus('生成成功：' + formatBytes(res.bytes) + '，可直接下载。', 'ok');
    } catch (err) {
      console.error(err);
      setStatus('生成失败：' + (err && err.message ? err.message : err), 'error');
      $('progressText').textContent = '失败';
    } finally {
      state.generating = false;
      updateReadyState();
    }
  }

  /* --------------------------------------------------------------- 事件 */

  ['a', 'b'].forEach(function (slot) {
    var zone = $(slot === 'a' ? 'zoneA' : 'zoneB');
    var input = $(slot === 'a' ? 'fileA' : 'fileB');
    input.addEventListener('change', function () {
      if (input.files && input.files[0]) setImage(slot, input.files[0]);
      input.value = '';
    });
    ['dragenter', 'dragover'].forEach(function (type) {
      zone.addEventListener(type, function (e) {
        e.preventDefault();
        zone.classList.add('dragover');
      });
    });
    ['dragleave', 'dragend'].forEach(function (type) {
      zone.addEventListener(type, function () { zone.classList.remove('dragover'); });
    });
    zone.addEventListener('drop', function (e) {
      e.preventDefault();
      zone.classList.remove('dragover');
      var dt = e.dataTransfer;
      if (dt && dt.files && dt.files.length) setImage(slot, dt.files[0]);
    });
  });

  document.addEventListener('paste', function (e) {
    if (!e.clipboardData || !e.clipboardData.items) return;
    var file = null;
    for (var i = 0; i < e.clipboardData.items.length; i++) {
      var it = e.clipboardData.items[i];
      if (it.type && it.type.indexOf('image/') === 0) { file = it.getAsFile(); break; }
    }
    if (!file) return;
    var slot = !state.images.a ? 'a' : (!state.images.b ? 'b' : null);
    if (!slot) { setStatus('两张图片都已就绪，可先删除再用粘贴替换。'); return; }
    setImage(slot, file);
  });

  ['barWidth', 'frames', 'delay', 'colors'].forEach(function (id) {
    var out = $(id + 'Val');
    $(id).addEventListener('input', function () {
      if (id === 'barWidth') state.barTouched = true;
      var suffix = id === 'barWidth' ? ' px' : (id === 'delay' ? ' ms' : '');
      if (out) out.textContent = $(id).value + suffix;
    });
  });

  $('barWidth').addEventListener('input', function () { drawPreview(); });
  $('barColor').addEventListener('input', function () { drawPreview(); });
  ['mode', 'swap'].forEach(function (id) {
    $(id).addEventListener('change', function () {
      if (id === 'swap') scheduleRebuild(); else drawPreview();
    });
  });
  ['scale', 'fit'].forEach(function (id) {
    $(id).addEventListener('change', scheduleRebuild);
  });

  $('playBtn').addEventListener('click', function () { setPlaying(!state.playing); });

  $('scrub').addEventListener('input', function () {
    setPlaying(false);
    state.t = +$('scrub').value / 1000;
    drawPreview();
  });

  $('generateBtn').addEventListener('click', generate);

  // 空格键播放/暂停
  document.addEventListener('keydown', function (e) {
    if (e.code === 'Space' && e.target === document.body) {
      e.preventDefault();
      if (!$('playBtn').disabled) setPlaying(!state.playing);
    }
  });

  updateReadyState();
  requestAnimationFrame(loop);
})();

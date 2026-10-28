# img-compare-gif · 重建规格书（AI Agent 可执行版）

> 本文档的唯一用途：让任意 AI Agent（或人类）在**不看现有源码**的前提下，也能复刻出功能、交互、视觉完全一致的「白条滑动前后对比 GIF 生成器」。
>
> 阅读顺序建议：§1 产品定义 → §2 硬约束 → §5 界面 → §6 算法 → §8 验收。
> 文中所有数值（默认值、颜色、时长、边界）都是契约，不要"顺手优化"。

---

## 1. 产品定义

一个**纯前端、零依赖、零构建**的网页工具：

1. 用户提供两张图片（A=前/左，B=后/右），支持点击选择、拖拽、`Ctrl+V` 粘贴。
2. 页面实时预览：一根**竖直色条（默认白条）**在画面上左右循环滑动；条左侧显示 A，右侧显示 B，形成"揭示式"前后对比效果。
3. 点击生成后，在浏览器内完成：铺图 → 全局调色板量化 → 逐帧合成 → 帧差定位 → GIF89a 编码 → `Blob` 下载。
4. 输出 GIF 默认与图片 A 同尺寸，无限循环，可调白条宽度/颜色、帧数、帧间隔、往返/单向、输出缩放、适配方式、颜色数、抖动、左右对调。

**不可改变的产品事实**

- 图片不上传服务器，服务端只托管静态文件。
- 不使用任何第三方运行时依赖（不要引入 gif.js / sharp / canvas / Express 等）。
- 前端全部是 classic script（非 ESM），保证 `file://` 直开可用。
- 输出只有 GIF；不提供批量、WebP/APNG、服务端渲染。

---

## 2. 硬性技术约束

| 约束 | 具体要求 |
| --- | --- |
| 运行时依赖 | 0 个。`package.json` 不得出现 `dependencies` / `devDependencies` |
| 构建 | 无。不要加 webpack/vite/rollup/ts |
| 前端模块 | ES5 IIFE + `'use strict'`，挂全局：`GifQuantizer` / `GifEncoder` / `ImgCompare` / `Dropdown`，同时保留 `module.exports` 分支供 Node 测试 `require` |
| 前端加载方式 | `<script src>` 顺序引入，**不得**改成 `type="module"`，不得用 `fetch`/接口 |
| 服务端 | 只用 Node 内置模块 `http/fs/path/url` |
| 浏览器能力 | `canvas`、`Blob`、`URL.createObjectURL`；`createImageBitmap` 与 `OffscreenCanvas` 需有降级路径 |
| Node | `>= 18` |
| 注释/文案 | 中文，与既有风格一致 |

**脚本引入顺序（有依赖，不可调换）**

`public/js/quantizer.js` → `public/js/gif-encoder.js` → `public/js/comparer.js` → `public/js/dropdown.js` → `public/js/app.js`

原因：`comparer.js` 的 UMD 工厂在**加载时**就解析 `GifQuantizer` / `GifEncoder` 全局；`app.js` 在加载时立即调用 `Dropdown.enhanceAll`。

---

## 3. 目录与文件职责

```
package.json              脚本与元信息（无依赖）
server.js                 零依赖静态服务器（唯一服务端文件）
SPEC.md                   本规格书
README.md                 用户向说明
AGENTS.md                 现有实现约定与踩坑记录
public/
  index.html              页面骨架（唯一 HTML）
  css/style.css           全部样式（唯一 CSS）
  js/quantizer.js         调色板 + 量化 + LZW 无关的像素映射（UMD）
  js/gif-encoder.js       GIF89a 字节流 + LZW（UMD）
  js/comparer.js          铺图 / 合成 / 帧循环 / 帧差 / 编码调度（仅浏览器，Node 可 require）
  js/dropdown.js          原生 select 的自绘增强（仅浏览器）
  js/app.js               页面状态与所有交互（仅浏览器）
test/
  roundtrip.test.js       编码器往返校验 + 内置独立 GIF/LZW 解码器
  pipeline.test.js        桩化 canvas 跑通 comparer 全链路
```

`package.json` 必须包含：

```json
{
  "name": "img-compare-gif",
  "version": "1.0.0",
  "private": true,
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "node server.js",
    "test": "node test/roundtrip.test.js && node test/pipeline.test.js",
    "test:roundtrip": "node test/roundtrip.test.js",
    "test:pipeline": "node test/pipeline.test.js",
    "bench": "node -e \"process.env.BIG='1';require('./test/pipeline.test.js')\""
  },
  "engines": { "node": ">=18" },
  "license": "MIT"
}
```

---

## 4. 运行时数据流

```
文件/粘贴/拖拽
   └─ loadImage() ──> state.images.{a,b}（ImageBitmap 或 HTMLImageElement）
          └─ rebuildPreview()（120ms 防抖）
                ├─ prepareSource(A, w, h, fit) → 左画布
                ├─ prepareSource(B, w, h, fit) → 右画布
                └─ rAF 循环：progressToPosition → composeFrame → 预览 canvas

点击生成
   └─ createJob(opts).generate(onProgress)
          ├─ prepareSource ×2（输出尺寸 W×H）
          ├─ 采样两图像素 → createPalette(colors, [barColor])
          ├─ 循环 frames 次：
          │    合成竖带 → quantize(竖带) → 贴回整幅索引图
          │    → 帧差求最小矩形 → GifWriter.addFrame
          └─ finish() → Uint8Array → Blob
                └─ Object URL → <img> 预览 + <a download> 下载
```

---

## 5. 界面规格（必须逐项一致）

### 5.1 页面骨架

`<html lang="zh-CN">`，标题：`img-compare-gif · 前后对比 GIF 生成器`。样式表 `css/style.css`。

```html
<body>
  <div class="bg-glow"></div>

  <header class="site-header">
    <div class="brand">
      <span class="logo">GIF</span>
      <div>
        <h1>img-compare-gif</h1>
        <p>上传两张「前后」图片，一键生成一根竖直白条左右滑动的对比动图</p>
      </div>
    </div>
  </header>

  <main class="layout">
    <!-- 左列 -->
    <div class="column">
      <section class="card">
        <h2 class="card-title">1. 选择图片</h2>
        <div class="upload-grid">
          <label class="dropzone" data-slot="a" id="zoneA">
            <input type="file" accept="image/*" hidden id="fileA" />
            <div class="dz-empty">
              <div class="dz-icon">A</div>
              <strong>图片 A（前 / 左）</strong>
              <span>点击选择、拖拽到此，或直接 Ctrl+V 粘贴</span>
            </div>
            <div class="dz-preview" hidden>
              <img alt="图片 A 预览" />
              <div class="dz-meta"></div>
            </div>
          </label>
          <label class="dropzone" data-slot="b" id="zoneB">
            <input type="file" accept="image/*" hidden id="fileB" />
            <div class="dz-empty">
              <div class="dz-icon">B</div>
              <strong>图片 B（后 / 右）</strong>
              <span>两张图建议尺寸一致，效果最好</span>
            </div>
            <div class="dz-preview" hidden>
              <img alt="图片 B 预览" />
              <div class="dz-meta"></div>
            </div>
          </label>
        </div>
        <p class="tips" id="sizeHint">输出尺寸 = 图片 A 的尺寸（可在下方缩小）。</p>
      </section>

      <section class="card">
        <h2 class="card-title">2. 参数设置</h2>
        <div class="settings">
          <div class="field">
            <label for="barWidth">白条宽度 <b id="barWidthVal">8 px</b></label>
            <input type="range" id="barWidth" min="1" max="60" step="1" value="8" />
          </div>
          <div class="field">
            <label for="barColor">白条颜色</label>
            <input type="color" id="barColor" value="#ffffff" />
          </div>
          <div class="field">
            <label for="frames">帧数 <b id="framesVal">30</b></label>
            <input type="range" id="frames" min="6" max="90" step="1" value="30" />
          </div>
          <div class="field">
            <label for="delay">帧间隔 <b id="delayVal">50 ms</b></label>
            <input type="range" id="delay" min="20" max="200" step="10" value="50" />
          </div>
          <div class="field">
            <label for="mode">滑动方式</label>
            <select id="mode">
              <option value="swing" selected>左右往返（循环无缝）</option>
              <option value="wipe">单向冲刷（扫完回到起点）</option>
            </select>
          </div>
          <div class="field">
            <label for="scale">输出尺寸</label>
            <select id="scale">
              <option value="1" selected>与图片 A 同尺寸</option>
              <option value="0.75">75%</option>
              <option value="0.5">50%</option>
              <option value="0.35">35%</option>
            </select>
          </div>
          <div class="field">
            <label for="fit">两图适配</label>
            <select id="fit">
              <option value="cover" selected>铺满裁剪（尺寸不一致时裁掉多余）</option>
              <option value="contain">完整包含（尺寸不一致时留白）</option>
            </select>
          </div>
          <div class="field">
            <label for="colors">调色板颜色数 <b id="colorsVal">256</b></label>
            <input type="range" id="colors" min="16" max="256" step="8" value="256" />
          </div>
          <div class="field check">
            <label><input type="checkbox" id="dither" checked /> 抖动（渐变更平滑，体积略大）</label>
          </div>
          <div class="field check">
            <label><input type="checkbox" id="swap" /> 左右对调（B 在左、A 在右）</label>
          </div>
        </div>
      </section>
    </div>

    <!-- 右列 -->
    <div class="column">
      <section class="card">
        <h2 class="card-title">实时预览</h2>
        <div class="preview-wrap">
          <canvas id="preview"></canvas>
          <div class="preview-empty" id="previewEmpty">选择两张图片后这里会实时播放对比效果</div>
        </div>
        <div class="preview-bar">
          <button class="btn ghost" id="playBtn" type="button" disabled>暂停</button>
          <input type="range" id="scrub" min="0" max="1000" value="0" disabled />
          <span class="mono" id="previewInfo">—</span>
        </div>
        <p class="tips">拖动滑块可手动控制白条位置；播放时会自动循环。</p>
      </section>

      <section class="card">
        <h2 class="card-title">3. 生成 GIF</h2>
        <div class="actions">
          <button class="btn primary" id="generateBtn" type="button" disabled>生成对比 GIF</button>
          <a class="btn ghost" id="downloadBtn" href="#" download hidden>下载 GIF</a>
        </div>
        <div class="progress" id="progressWrap" hidden>
          <div class="progress-inner"><span id="progressBar"></span></div>
          <p class="mono" id="progressText">准备中…</p>
        </div>
        <p class="status" id="status">请先上传两张图片。</p>

        <div class="result" id="resultWrap" hidden>
          <img id="resultImg" alt="生成的对比 GIF" />
          <div class="result-meta" id="resultMeta"></div>
        </div>
      </section>

      <section class="card note">
        <h2 class="card-title">说明</h2>
        <ul>
          <li>动画与导出均在浏览器本地完成，图片不会上传到任何服务器。</li>
          <li>GIF 帧采用「只写变化区域」的差分编码，所以成品体积很小。</li>
          <li>帧间隔最小 20ms（GIF 的时间精度为 10ms，多数浏览器会把 &lt;20ms 当作 100ms 处理）。</li>
          <li>图片 A 决定输出尺寸；图 B 会按所选适配方式对齐到同一画布。</li>
        </ul>
      </section>
    </div>
  </main>

  <script src="js/quantizer.js"></script>
  <script src="js/gif-encoder.js"></script>
  <script src="js/comparer.js"></script>
  <script src="js/dropdown.js"></script>
  <script src="js/app.js"></script>
</body>
```

### 5.2 设计令牌（`:root`，逐字一致）

```css
:root {
  --bg: #0b1020;
  --bg-soft: #121a33;
  --card: rgba(255, 255, 255, 0.045);
  --card-border: rgba(255, 255, 255, 0.1);
  --text: #e8edf7;
  --text-dim: #97a3bd;
  --accent: #5eead4;
  --accent-2: #7c9cff;
  --danger: #ff8095;
  --radius: 16px;
  --shadow: 0 18px 50px rgba(0, 0, 0, 0.45);
}
```

全局：`* { box-sizing: border-box }`；`html, body { margin: 0; padding: 0 }`；`[hidden] { display: none !important }`（组件自身 `display` 会覆盖 hidden 属性，必须兜底）。

```css
body {
  min-height: 100vh;
  background:
    radial-gradient(1200px 600px at 12% -10%, #1b2a55 0%, transparent 60%),
    radial-gradient(900px 500px at 100% 0%, #1d3f45 0%, transparent 55%),
    var(--bg);
  color: var(--text);
  font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, -apple-system, sans-serif;
  font-size: 14px;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}
```

`.bg-glow`：`position:fixed; inset:0; pointer-events:none;`
`background: radial-gradient(500px 300px at 50% 120%, rgba(94,234,212,.09), transparent 70%)`。

### 5.3 组件样式契约

| 选择器 | 关键声明 |
| --- | --- |
| `.site-header` | `max-width:1280px; margin:0 auto; padding:34px 24px 10px` |
| `.brand` | `display:flex; align-items:center; gap:16px` |
| `.logo` | `52×52; border-radius:14px; display:grid; place-items:center; font-weight:800; letter-spacing:.5px; color:#07121c; background:linear-gradient(135deg,var(--accent),var(--accent-2)); box-shadow:0 10px 30px rgba(94,234,212,.25)`（字号继承 14px） |
| `.site-header h1` | `margin:0; font-size:22px; letter-spacing:.2px` |
| `.site-header p` | `margin:2px 0 0; font-size:13px; color:var(--text-dim)` |
| `.layout` | `max-width:1280px; margin:0 auto; padding:18px 24px 60px; display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:20px; align-items:start` |
| `.column` | `display:flex; flex-direction:column; gap:20px; min-width:0` |
| `.card` | `position:relative; padding:18px; border-radius:16px; background:var(--card); border:1px solid var(--card-border); backdrop-filter:blur(14px); box-shadow:var(--shadow)` |
| `.card-title` | `margin:0 0 14px; font-size:14px; font-weight:700; letter-spacing:.4px; color:#fff; display:flex; align-items:center; gap:8px` |
| `.card-title::before` | `content:""; width:4px; height:14px; border-radius:2px; background:linear-gradient(180deg,var(--accent),var(--accent-2))` |
| `.upload-grid` | `display:grid; grid-template-columns:1fr 1fr; gap:14px` |
| `.dropzone` | `display:block; min-height:178px; border-radius:14px; border:1.5px dashed rgba(255,255,255,.22); background:rgba(255,255,255,.02); cursor:pointer; overflow:hidden; transition:border-color .18s, background .18s, transform .18s` |
| `.dropzone:hover, .dropzone.dragover` | `border-color:var(--accent); background:rgba(94,234,212,.07)` |
| `.dropzone.filled` | `border-style:solid; border-color:rgba(255,255,255,.16); background:rgba(255,255,255,.05)` |
| `.dz-empty` | `height:178px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:6px; text-align:center; padding:0 12px` |
| `.dz-icon` | `34×34; border-radius:10px; display:grid; place-items:center; font-weight:800; color:#07121c; background:linear-gradient(135deg,var(--accent),var(--accent-2))` |
| `.dz-empty strong` | `font-size:13px`；`.dz-empty span`：`11.5px; color:var(--text-dim)` |
| `.dz-preview` | `display:flex; flex-direction:column; gap:8px; padding:10px` |
| `.dz-preview img` | `width:100%; height:130px; object-fit:contain; border-radius:8px; background:repeating-conic-gradient(#1a2136 0% 25%, #141a2c 0% 50%) 50% / 16px 16px` |
| `.dz-meta` | `11.5px; color:var(--text-dim); font-family:ui-monospace,Consolas,monospace; white-space:nowrap; overflow:hidden; text-overflow:ellipsis` |
| `.settings` | `display:grid; grid-template-columns:1fr 1fr; gap:12px 16px` |
| `.field` | `display:flex; flex-direction:column; gap:6px; min-width:0` |
| `.field.check` | `grid-column:span 2; flex-direction:row`；其 `label`：`display:flex; align-items:center; gap:8px; color:var(--text); font-size:12.5px; cursor:pointer` |
| `.field label` | `font-size:12.5px; color:var(--text-dim); display:flex; justify-content:space-between; gap:8px` |
| `.field label b` | `color:var(--accent); font-family:ui-monospace,Consolas,monospace; font-weight:600` |
| `input[type=range]` | `appearance:none; width:100%; height:4px; border-radius:999px; background:rgba(255,255,255,.16); outline:none` |
| `range::-webkit-slider-thumb` | `15×15; border-radius:50%; background:linear-gradient(135deg,var(--accent),var(--accent-2)); border:none; cursor:pointer; box-shadow:0 2px 8px rgba(0,0,0,.4)`；`disabled` 时轨道 `opacity:.45`、滑块 `not-allowed` |
| `input[type=color]` | `width:100%; height:30px; padding:0; border:1px solid var(--card-border); border-radius:8px; background:transparent; cursor:pointer` |
| `input[type=checkbox]` | `15×15; accent-color:#4fd1c5` |
| `.select-native` | `display:none` |
| `.select-trigger` | `height:32px; padding:0 10px; display:flex; align-items:center; justify-content:space-between; gap:8px; border-radius:8px; border:1px solid var(--card-border); background:rgba(10,16,32,.85); color:var(--text); font:inherit; font-size:12.5px; text-align:left; cursor:pointer; outline:none; transition:border-color .18s, box-shadow .18s, background .18s` |
| trigger 悬停 / 展开 / 键盘聚焦 | 悬停 `border rgba(255,255,255,.24); background rgba(16,24,46,.9)`；后两者 `border var(--accent); box-shadow 0 0 0 3px rgba(94,234,212,.14)` |
| `.select-label` | `flex:1 1 auto; min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis` |
| `.select-chevron` | `12×12; color:var(--text-dim); transition:transform .2s, color .18s`；展开时 `rotate(180deg); color:var(--accent)` |
| `.select-menu` | `position:absolute; top:calc(100% + 6px); left:0; z-index:40; min-width:100%; width:max-content; max-width:min(340px,82vw); max-height:244px; overflow-y:auto; padding:6px; border-radius:12px; border:1px solid rgba(255,255,255,.12); background:rgba(17,23,43,.97); backdrop-filter:blur(16px); box-shadow:0 20px 44px rgba(0,0,0,.55); opacity:0; transform:translateY(-6px) scale(.98); transform-origin:top center; pointer-events:none; transition:opacity .16s, transform .16s` |
| `.select.open > .select-menu` | `opacity:1; transform:none; pointer-events:auto` |
| `.select.menu-up > .select-menu` | `top:auto; bottom:calc(100% + 6px); transform:translateY(6px) scale(.98); transform-origin:bottom center`；展开时 `transform:none` |
| `.select-option` | `display:flex; align-items:center; justify-content:space-between; gap:10px; padding:7px 9px; border-radius:8px; font-size:12.5px; white-space:nowrap; cursor:pointer; color:var(--text); transition:background .14s, color .14s` |
| 选项态 | `.active`：`background:rgba(255,255,255,.07)`；`.selected`：`color:var(--accent); background:rgba(94,234,212,.12)` |
| `.select-tick` | `12×12; opacity:0; color:var(--accent); transition:opacity .14s`；`.selected .select-tick` `opacity:1` |
| 菜单滚动条 | 宽 8px；thumb `border-radius:999px; background:rgba(255,255,255,.18)`；track 透明 |
| `.card.dropdown-open` | `z-index:30`（防止菜单被下一张卡片盖住） |
| `.preview-wrap` | `position:relative; border-radius:12px; overflow:hidden; display:grid; place-items:center; min-height:240px; background:repeating-conic-gradient(#161d31 0% 25%, #10162a 0% 50%) 50% / 20px 20px` |
| `#preview` | `display:block; max-width:100%; max-height:62vh; height:auto` |
| `.preview-empty` | `position:absolute; inset:0; display:grid; place-items:center; color:var(--text-dim); font-size:12.5px; text-align:center; padding:0 24px` |
| `.preview-bar` | `display:flex; align-items:center; gap:12px; margin-top:12px`；其 range `flex:1` |
| `.mono` | `font-family:ui-monospace,Consolas,monospace; font-size:11.5px; color:var(--text-dim); white-space:nowrap` |
| `.actions` | `display:flex; gap:12px; flex-wrap:wrap` |
| `.btn` | `appearance:none; border:1px solid transparent; border-radius:10px; padding:10px 18px; font-size:13.5px; font-weight:600; cursor:pointer; text-decoration:none; display:inline-flex; align-items:center; justify-content:center; transition:transform .15s, box-shadow .15s, opacity .15s` |
| `.btn.primary` | `background:linear-gradient(135deg,var(--accent),var(--accent-2)); color:#07121c; box-shadow:0 10px 26px rgba(94,234,212,.22)` |
| `.btn.ghost` | `background:rgba(255,255,255,.06); border-color:var(--card-border); color:var(--text)` |
| `.btn:hover:not(:disabled)` | `transform:translateY(-1px)`；`:disabled` `opacity:.45; cursor:not-allowed` |
| `.progress` | `margin-top:14px`；`.progress-inner` `height:6px; border-radius:999px; background:rgba(255,255,255,.12); overflow:hidden`；内部 `span` `display:block; height:100%; width:0%; border-radius:999px; background:linear-gradient(90deg,var(--accent),var(--accent-2)); transition:width .15s` |
| `.status` | `margin:12px 0 0; font-size:12.5px; color:var(--text-dim)`；`.status.error` `color:var(--danger)`；`.status.ok` `color:var(--accent)` |
| `.result` | `margin-top:16px; display:flex; flex-direction:column; gap:10px`；`img`：`width:100%; max-height:62vh; object-fit:contain; border-radius:12px; border:1px solid var(--card-border)` + 20px 棋盘格 |
| `.result-meta` | `font-size:12px; color:var(--text-dim); font-family:ui-monospace,Consolas,monospace` |
| `.tips` | `margin:12px 0 0; font-size:11.5px; color:var(--text-dim)` |
| `.note ul` | `margin:0; padding-left:18px; color:var(--text-dim); font-size:12px`；`li + li` `margin-top:4px` |

响应式（唯一断点）：

```css
@media (max-width: 980px) {
  .layout { grid-template-columns: minmax(0, 1fr); }
  .settings { grid-template-columns: 1fr; }
  .field.check { grid-column: span 1; }
}
```

### 5.4 交互规格

**上传（两个 zone 相同逻辑）**

- `<label class="dropzone">` 包裹隐藏 `<input type=file accept="image/*">`，点击任意位置触发文件选择。
- `change` 后处理 `files[0]`，并立即把 `input.value = ''`（允许重复选同一文件）。
- 类型校验：`file.type` 匹配 `/^image\//`，或文件名匹配 `/\.(png|jpe?g|gif|webp|bmp)$/i`；否则 `setStatus('这不是图片文件：' + name, 'error')` 并中止。
- 解码失败：`setStatus('图片解析失败：' + e.message, 'error')`。
- 成功后：
  - 旧图若是 `ImageBitmap` 且有 `close()`，先释放；
  - zone 加 `.filled`，隐藏 `.dz-empty`，显示 `.dz-preview`；
  - 缩略图用 `URL.createObjectURL(file)`；换图前 revoke 旧 `dataset.url`；
  - `.dz-meta` 文本：`文件名 · 宽×高`（无文件名用 `clipboard`）；
  - 若上传的是 **A** 且用户从未手动动过白条滑块（`barTouched === false`）：建议宽度 `max(3, min(24, round(width * 0.01)))`，同步 `#barWidthVal`；
  - 更新尺寸提示、120ms 防抖重建预览、刷新按钮可用态。

**拖拽**：`dragenter/dragover` 阻止默认并加 `.dragover`；`dragleave/dragend` 移除；`drop` 阻止默认、移除类、取 `dataTransfer.files[0]`。

**粘贴**：监听 `document paste`，取 `clipboardData.items` 中第一个 `type` 以 `image/` 开头的 `getAsFile()`；
- 自动填入第一个空槽（A 优先，其次 B）；
- 两槽都满时不写入，提示：`两张图片都已就绪，可先删除再用粘贴替换。`

**尺寸提示 `#sizeHint`（三种状态，文案精确）**

1. 无 A：`输出尺寸 = 图片 A 的尺寸（可在下方缩小）。`
2. 有 A 无 B：`输出 GIF：{w}×{h}（与图片 A 相同）。等待图片 B…`
3. 有 A 有 B 且宽高比差 `> 0.01`：
   `提示：两张图比例不同（{wa}×{ha} / {wb}×{hb}），建议选「铺满裁剪」让两者对齐。`
4. 否则：`输出 GIF：{wa}×{ha}（与图片 A 相同）。`

**按钮可用态**：两张图都有时，`#generateBtn`、`#playBtn`、`#scrub` 启用，`#previewEmpty` 隐藏；生成中 `#generateBtn` 禁用。

**预览**

- 预览画布最长边限制 `PREVIEW_MAX = 1200`：`scale = min(1, 1200 / max(A.w, A.h))`，`w/h = max(2, round(原尺寸 * scale))`。
- 预览里白条宽度 = `max(1, barWidth * scale)`（可带小数）；导出时不缩放。这是"所见即所得"的关键，两侧语义不同。
- `#previewInfo` 显示预览画布尺寸 `w×h`。
- 动画循环：`requestAnimationFrame`，`dt = min(200, ts - lastTs)`；`cycle = frames * delayMs`；`t += dt/cycle`，越界减整数；`#scrub.value = round(t * 1000)`。
- 初始 `t = 0`、`playing = true`；`#playBtn` 文案在 `暂停`/`播放` 间切换，切换时 `lastTs = 0`。
- 拖 `#scrub`：暂停、`t = value/1000`、立即重绘。
- 空格：仅当 `e.target === document.body` 时切换播放/暂停，并 `preventDefault`。
- 参数变化：`barWidth`、`barColor`、`mode` 立即重绘；`swap`、`scale`、`fit` 走 120ms 防抖重建（`swap` 还要重铺源图）；`frames`/`delay`/`colors` 无需重建，实时循环读取。

**生成**

- 防重入：`generating || 缺图` 直接返回。
- 开始时：禁用生成按钮、显示进度条（0%）、`progressText = '准备中…'`、`status = '正在量化调色板并逐帧编码，请勿关闭页面…'`。
- 进度回调两次/帧（`render` 与 `encode`），百分比 `round(frame/total*100)`，文案：
  - `渲染第 {i} / {total} 帧 · {pct}%`
  - `写入 GIF 帧 {i} / {total} 帧 · {pct}%`（注意此处重复了"帧"字，保持原样）
- 成功：revoke 旧结果 URL；`resultImg.src = 新 URL`；显示结果区；`download` 文件名 `compare-{w}x{h}-{frames}f.gif`；meta 文本
  `{w}×{h} · {frames} 帧 · {体积} · 用时 {秒}s`；
  进度 100%、`progressText = '完成'`、`status = '生成成功：{体积}，可直接下载。'`（`.ok`）。
- 失败：`console.error(err)`；`status = '生成失败：' + message`（`.error`）；`progressText = '失败'`。
- `finally`：恢复 `generating=false` 并刷新按钮态。
- 体积格式：`<1024 → "N B"`；`<1MB → (n/1024).toFixed(1) + " KB"`；否则 `(n/1024/1024).toFixed(2) + " MB"`。

**自绘下拉框 `dropdown.js`**

- 只增强 `.settings select`（3 个）。
- 保留原生 `select` 作为数据源，加 `.select-native`（`display:none`），读值/派发 `change` 的既有逻辑不变。
- DOM：`div.select > button.select-trigger[role=combobox][aria-haspopup=listbox][aria-expanded] + div.select-menu[role=listbox]`；trigger 内 `span.select-label` + 12×12 折线 chevron SVG（`viewBox 0 0 12 12`，`d="M2.2 4.4 6 8.2l3.8-3.8"`，`stroke=currentColor`，`stroke-width=1.7`，圆头圆角）；菜单项 `div.select-option[role=option][data-value]` 内含 `span.select-option-text` + 对勾 chevron。
- ID：trigger `{selectId}-trigger`，menu `{selectId}-menu`；同步改写 `label[for]` 指向 trigger。
- 打开：加 `.open`、`aria-expanded=true`、激活项滚入可视区；若下方空间 `< min(menu.offsetHeight || 220, 240) + 14` 且上方更高，加 `.menu-up`；给最近的 `.card` 加 `.dropdown-open`。
- 关闭：移除 `.open`/`.menu-up`/`.dropdown-open`，`aria-expanded=false`；卸载全局监听。
- 全局监听（仅打开期间）：`document pointerdown` 捕获阶段点击外部关闭；`window resize` 关闭；`window scroll` 捕获阶段关闭。
- 选择：写 `select.value`、同步 UI、关闭、trigger 聚焦、派发 `new Event('change', { bubbles: true })`。
- 键盘：`Esc` 关闭；`↑/↓` 未展开时打开、展开后移动激活项并滚动；`Home/End` 首/尾；`Enter/Space` 选中当前激活项。
- 鼠标：`mouseenter` 更新激活项；`mousedown` preventDefault（避免抢焦点）；`click` 选中。

---

## 6. 核心算法规格

> 以下函数都是"契约级"实现，变量名可改，**顺序与公式不可改**。

### 6.1 画布与图片

```js
function createCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  var c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}
```

`hexToRgb(hex)`：正则 `^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$`（忽略大小写）；不匹配返回 `[255,255,255]`。

`loadImage(source)`：
1. 优先 `createImageBitmap(source, { imageOrientation: 'from-image' })`（自动处理 EXIF 方向）；抛错则降级。
2. 降级：`new Image()` + `URL.createObjectURL(source)`，`onload/onerror` 包装 Promise；`finally` 中异步 `revokeObjectURL`（source 是字符串时不 revoke）。

`stepDown(image, scale)`（大幅缩小时防锯齿）：
- 当前 `cur=image, w,h`；
- 当 `w>=2 && h>=2 && w/2 >= w*scale && h/2 >= h*scale` 时，反复画到 `floor(w/2) × floor(h/2)` 的新画布（`imageSmoothingEnabled=true; imageSmoothingQuality='high'`）；
- 返回最后一级画布。

`prepareSource(image, W, H, fit)`：
```
iw,ih = 原尺寸
scale = fit === 'contain' ? min(W/iw, H/ih) : max(W/iw, H/ih)
src   = scale < 0.5 ? stepDown(image, scale) : image
canvas = createCanvas(W,H); ctx = getContext('2d', { willReadFrequently:true })
ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'
ctx.fillStyle = '#ffffff'; ctx.fillRect(0,0,W,H)          // 先铺白底 => 后续所有像素 alpha=255
dw = iw*scale; dh = ih*scale
ctx.drawImage(src, (W-dw)/2, (H-dh)/2, dw, dh)            // 居中；cover 超出部分被画布裁掉
```
- `cover`：`max` 比例，短边溢出裁掉；`contain`：`min` 比例，留白为纯白。

### 6.2 合成与白条位置

`composeFrame(ctx, left, right, W, H, x, barWidth, barColor, region)`：

```js
var r = region || { x: 0, y: 0, w: W, h: H };
var half = barWidth / 2;
ctx.save();
ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();   // 外层：只在 region 内绘制
ctx.drawImage(left, 0, 0, W, H, 0, 0, W, H);                 // 整幅 A
ctx.save();
ctx.beginPath(); ctx.rect(x + half, 0, W - x - half, H); ctx.clip();
ctx.drawImage(right, 0, 0, W, H, 0, 0, W, H);                // 条右侧覆盖 B
ctx.restore();
ctx.fillStyle = barColor;
ctx.fillRect(x - half, 0, barWidth, H);                      // 最后画条
ctx.restore();
```

要点：条左侧保持 A 的像素（未被 B 覆盖）；A/B 归属由 `x + barWidth/2` 切割；条本身覆盖在两者之上。

`progressToPosition(t, W, barWidth, mode)`：

```js
var x0 = Math.min(barWidth / 2, W / 2);
var L  = Math.max(1, W - barWidth);          // 中心可移动距离
var tt = ((t % 1) + 1) % 1;                  // 归一到 [0,1)
if (mode === 'wipe') return x0 + tt * L;     // 单向：扫到底后跳回起点（循环处有跳变）
var total = 2 * L;
var s = tt * total;
return x0 + (s <= L ? s : total - s);        // 往返：0 -> L -> 0，首尾无缝
```

`framePositions(count, W, barWidth, mode)`：`out[i] = progressToPosition(i / count, ...)`，**采样 t = i/N（不取 1）**，保证循环无缝。

### 6.3 调色板 `quantizer.js`

常量：`LEVELS=32`，`BUCKETS=32768`，感知权重 `WR=0.299, WG=0.587, WB=0.114`。

`bucketKey(r,g,b) = ((r>>3)<<10) | ((g>>3)<<5) | (b>>3)`。

**直方图**：`count/sr/sg/sb` 均为 `Float64Array(32768)`；`total` 计数。
`addPixels(hist, rgba, stride)`：按 `stride*4` 字节步进；`alpha===0` 跳过；累加计数与该桶 RGB 之和。

**中位切分**：
- `makeBox` 记录桶索引列表、5bit 空间的 `r/g/bMin|Max`、`weight=Σcount`。
- `splitBox`：
  - 选跨度最大的轴（RGB 的 5bit 范围），`shift = 10/5/0`；
  - 按该轴 5bit 值排序桶；
  - 累计权重直到 `acc >= weight/2`，切点 `cut = i+1`，夹到 `[1, len-1]`；
  - 返回两个新 box。
- `medianCut(hist, maxColors)`：
  - 收集所有 `count>0` 的桶；空则返回 `[[0,0,0]]`；
  - 初始一个 box；循环直到 box 数达上限：
    在"桶数≥2 且跨度>0"的 box 中选 `weight * range` 最大者切分；
  - 每 box 的颜色 = 桶均值按计数加权：`Σ(count[k] * (sr[k]/count[k])) / weight`，`round` 并夹到 `0..255`。

**`createPalette(sources, maxColors, mustColors)`**：
1. `maxColors = clamp(2..256)`；
2. `sources` 逐项 `addPixels`（`stride` 默认 1）；
3. `pins`：`mustColors` 去重后收集（不超过 maxColors），**追加在调色板末尾**；
4. `colors = medianCut(hist, max(1, maxColors - pins.length))`，再 `colors.push(...pins)`；
5. `lut = refine(hist, colors, 2, pins.length)`；
6. 输出 `{ palette: Uint8Array(count*3), colors, lut, count }`。

**`refine(hist, colors, rounds, pinned)`**：
- `movable = colors.length - pinned`；
- 每轮：用当前 `lut` 把每个桶的 `sr/sg/sb/count` 累加到所属颜色；只更新前 `movable` 项为均值（`clamp255`）；末尾 `pinned` 项**永不参与均值更新**；重建 `lut`。
- 这就是"白条色不会被 K-means 拉偏"的保证。

**`buildLut(colors)`**：遍历 32768 个桶，取桶中心 `(v*8+4)`，在全部颜色中找加权欧氏距离最小者，写入 `lut[k]`。

**`quantize(rgba, width, height, model, out, dither)`**：
- 非抖动：`out[i] = lut[bucketKey(r,g,b)]`，O(1)。
- 抖动（Floyd–Steinberg，按行滚动误差缓冲，长度 `(width+2)*3`）：
  ```
  每像素：r = clampByte(srcR + cur[(x+1)*3])，g/b 同理
          idx = lut[bucketKey(r,g,b)]
          er = r - palette[idx*3]（g/b 同理）
          cur [x+2]  += er*7/16      // 右
          next[x]    += er*3/16      // 左下
          next[x+1]  += er*5/16      // 下
          next[x+2]  += er*1/16      // 右下
  每行结束：cur.set(next); next.fill(0)
  ```
- **注意**：导出时抖动只作用在"变化竖带"上，误差不跨竖带边界；这是既有行为，不要改成整帧抖动。

### 6.4 生成任务 `createJob(opts).generate(onProgress)`

参数与默认：

| 字段 | 默认/夹取 |
| --- | --- |
| `imageA/imageB` | 必填（A=前/左） |
| `scale` | `1`；`W = max(2, round(A.w * scale))`，`H` 同理 |
| `barWidth` | `max(1, round(opts.barWidth \|\| 6))`（**输出像素**） |
| `barColor` | `'#ffffff'` |
| `dither` | `opts.dither !== false`（默认开） |
| `frames` | `clamp(2..200, opts.frames \|\| 30)` |
| `delayCs` | `max(2, round((delayMs \|\| 50) / 10))`，GIF 单位 1/100 秒 |
| `mode` | `'wipe'` 或 `'swing'`（其余一律 `swing`） |
| `fit` | 传给 `prepareSource` |
| `swap` | `true` 时 `left=prepareSource(B)`、`right=prepareSource(A)` |

流程（顺序即契约）：

```
1. left/right = prepareSource(...)（输出尺寸 W×H）
2. stride = max(1, floor(W*H / 120000))
   model = Q.createPalette([{data:leftRGBA,stride},{data:rightRGBA,stride}],
                           opts.colors || 256, [hexToRgb(barColor)])
3. stage = createCanvas(W,H)（willReadFrequently）
   writer = new GifWriter(W,H,model.palette,0)
   total = W*H; f0/f1 = Uint8Array(total)
   prev=null, cur=f0, spare=f1; pendingDelay=0
   positions = framePositions(frames, W, barWidth, mode)
4. for i in 0..frames-1:
     a. if (prev) cur.set(prev)                  // 未变化区域沿用上一帧
     b. x = positions[i]; px = i>0 ? positions[i-1] : x
     c. region:
          首帧 = {x:0, y:0, w:W, h:H}
          其余 = x0 = max(0, floor(min(px,x) - barWidth/2) - 2)
                 x1 = min(W, ceil(max(px,x) + barWidth/2) + 2)
                 {x:x0, y:0, w:x1-x0, h:H}
     d. composeFrame(stageCtx, left, right, W, H, x, barWidth, barColor, region)
     e. img = stageCtx.getImageData(region.x, 0, region.w, H)
        strip = Q.quantize(img.data, region.w, H, model, strip, dither)
        逐行把 strip 贴回 cur（偏移 row*W + region.x）
     f. onProgress({frame:i+1, total:frames, phase:'render'})
        if (i % 2 === 1) await nextTick()
     g. 帧差（只扫 region 覆盖的列）：
          首帧：bx0=0,bx1=W-1,by0=0,by1=H-1
          其余：在 [region.x, region.x+region.w) 内逐像素比较 cur vs prev，
                记录发生变化像素的最小/最大 x/y（含端点）
     h. 若无变化：pendingDelay += delayCs; continue（**不交换缓冲**）
     i. writer.addFrame(cur, bx0, by0, bx1-bx0+1, by1-by0+1, delayCs + pendingDelay)
        pendingDelay = 0; encodedFrames++
     j. 交换三件套：tmp=cur; prev=cur; cur=spare; spare=tmp
     k. onProgress({frame:i+1, total:frames, phase:'encode'})
        if (i % 2 === 0) await nextTick()
5. bytes = writer.finish() → 复制进 Uint8Array → new Blob([...], {type:'image/gif'})
6. 返回 { blob, bytes, width:W, height:H, frames:encodedFrames, positions }
```

**必须保持的不变量**

- `cur !== prev` 永远成立；跳过无变化帧时**不能**交换缓冲（否则 `cur === spare` 别名）。
- 竖带必须覆盖整段位移 `[min(px,x) - barW/2 - 2, max(px,x) + barW/2 + 2]`；收窄会出现鬼影。
- 首帧必须全幅；否则"保留上一帧"的处置方式没有初始底图。
- `pendingDelay` 在循环结束时若仍 > 0，会被丢弃（最后一帧时长不补），保持原样。
- `res.frames` 是**实际写入的帧数**，可能小于用户设定帧数。

### 6.5 GIF 编码 `gif-encoder.js`

`ByteBuffer`：可增长 `Uint8Array`，`byte/short(LE)/bytes/view`。

`GifWriter(width, height, palette, loopCount)`：

```
colorCount = max(2, floor(palette.length / 3))
bits = 1; while ((1 << bits) < colorCount) bits++;  if (bits > 8) bits = 8
tableSize = 1 << bits
minCodeSize = max(2, bits)     // 注意：GIF 允许 2，即使只有 2 色
```

文件头字节序（缺一不可）：

| 内容 | 字节 |
| --- | --- |
| 签名 | `47 49 46 38 39 61`（"GIF89a"） |
| 逻辑屏幕宽/高 | 各 2 字节小端 |
| packed | `0x80 \| ((bits-1)<<4) \| (bits-1)`（有全局色表、色深、表大小） |
| 背景色索引 | `0x00` |
| 像素宽高比 | `0x00` |
| 全局色表 | `tableSize*3` 字节，`palette` 复制后补零 |
| NETSCAPE2.0 | `21 FF 0B` + `"NETSCAPE2.0"`(11B) + `03 01 loopLo loopHi 00`（`loopCount=0` 即无限） |

`addFrame(indices, x, y, w, h, delayCs)`：

| 内容 | 字节 |
| --- | --- |
| 图形控制扩展 | `21 F9 04 04` + `delayLo delayHi` + `00` + `00` |
| 图像描述符 | `2C` + `x,y,w,h`（各 2B 小端）+ `00`（无局部表、非交错） |
| LZW 最小码长 | `minCodeSize` |
| LZW 数据 | 若干 ≤255 字节子块，每块前置长度字节；最后 `00` |

- GCE 的 packed `0x04` 表示**处置方式 = 1（保留上一帧）**、无透明色、无用户输入。改成 2 会残影/闪烁。
- 子矩形依赖前帧内容，因此只有 1 才正确。

`finish()`：追加 `0x3B`，返回 `buf.subarray(0, len)`（不复制）。

`extractSub(indices, stride, x, y, w, h)`：`x===0 && w===stride` 时直接返回整行 `subarray`；否则逐行拷贝成 `w*h`。

**LZW 编码（关键同步逻辑，按此顺序）**：

```js
function lzwEncode(pixels, minCodeSize, out) {
  var clearCode = 1 << minCodeSize;
  var eoiCode = clearCode + 1;
  var codeSize = minCodeSize + 1;
  var next = eoiCode + 1;

  if (!DICT) DICT = new Int32Array(4096 * 256);   // 模块级复用
  var dict = DICT; dict.fill(-1);

  var blockLen = 0, bitBuf = 0, bitCount = 0;

  function pushByte(b) {
    BLOCK[blockLen++] = b;
    if (blockLen === 255) { out.byte(255); out.bytes(BLOCK); blockLen = 0; }
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

  if (pixels.length > 0) {
    var prefix = pixels[0];
    for (var i = 1; i < pixels.length; i++) {
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
        if (next >= (1 << codeSize)) codeSize++;   // 先提位宽，再分配 next
        dict[key] = next++;
      }
      prefix = k;
    }
    emit(prefix);
  }
  emit(eoiCode);
  if (bitCount > 0) pushByte(bitBuf & 0xff);
  if (blockLen > 0) { out.byte(blockLen); out.bytes(BLOCK.subarray(0, blockLen)); }
  out.byte(0);
}
```

位流是**低位优先**（LSB-first）打包。解码端的同步判据是"先 `next++`，再 `if (next >= (1 << codeSize)) codeSize++`"，与上面的相位一一对应；写错就会花屏或码字越界。

---

## 7. 静态服务器规格

| 项 | 规格 |
| --- | --- |
| 入口 | `server.js`，`ROOT = path.join(__dirname, 'public')` |
| 监听 | `HOST = process.env.HOST \|\| '127.0.0.1'`；`PORT = Number(process.env.PORT) \|\| 3000` |
| 方法 | 仅 `GET` / `HEAD`；其余 `405` + `Allow: GET, HEAD` |
| `/health` | `200`，`application/json`，body `{"ok":true,"uptime":<秒>}` |
| 路径解析 | `url.parse(req.url).pathname`；`decodeURIComponent`（失败→400）；含 `\0`→400；`normalize` 去前导斜杠；`join(ROOT, relative)`；必须满足 `file === ROOT \|\| file.startsWith(ROOT + sep)`，否则 400 |
| 目录 | 存在且是目录 → 追加 `index.html` |
| 不存在 | 交给 `readFile` 报 `404`，body `404 Not Found: <pathname>` |
| 成功 | `200` + 精确 MIME + `Content-Length` + `Cache-Control: no-cache`；`HEAD` 不发 body |
| MIME | `.html/.css/.js/.mjs/.json/.txt/.png/.jpg/.jpeg/.gif/.webp/.svg/.ico/.woff2`，未知回退 `application/octet-stream` |
| 端口占用 | 捕获 `EADDRINUSE`，端口 +1 重试，最多 10 次；仍失败则 `exit(1)` |
| 启动日志 | `img-compare-gif 已启动：http://<host>:<port>/` 与 `静态目录：<ROOT>`；`0.0.0.0/::` 显示为 `localhost` |

---

## 8. 自检与验收

### 8.1 命令

```bash
npm start                 # 静态服务，默认 127.0.0.1:3000
npm test                  # 两个 Node 自检必须全绿、退出码 0
npm run bench             # 810×1080 / 30 帧 / 256 色 基准
NODITHER=1 npm run bench  # Windows: $env:NODITHER=1; npm run bench
node --check public/js/*.js
```

### 8.2 `test/roundtrip.test.js` 必须覆盖

- 160×120、8 帧、白条 9px、96 色、stride 2；首帧全幅，后续帧差子矩形。
- 量化：颜色数 ≤ 96；`palette.length === count*3`；纯白一定在调色板中。
- 内置**独立** GIF/LZW 解码器（不得复用编码器代码）解回后：
  - 逻辑尺寸 160×120；
  - 帧数 8；
  - `loopCount === 0`；
  - 全局色表存在；
  - 逐像素索引与期望完全一致（抖动与非抖动两条路径都跑）；
  - 每帧延时 5cs（50ms）；
  - 每帧处置方式 = 1；
  - 至少存在一个子矩形帧。
- 落盘 `test/out/roundtrip.gif`，打印每帧索引/RGB 的 SHA1（前 16 位）供第三方解码器交叉验证。

### 8.3 `test/pipeline.test.js` 必须覆盖

- 在 Node 中桩化 `OffscreenCanvas`，实现 `save/restore/beginPath/rect/clip/fillRect/drawImage/getImageData` 的裁剪语义（桩**不支持**缩放绘制）。
- 240×180、10 帧、128 色、无抖动、40ms、`swing`，跑通 `createJob`：
  - 输出尺寸 = A 尺寸；
  - 解码帧数 = 10；
  - 存在局部矩形帧；
  - 每帧白条区域内 RGB 均 `> 240`（白条正确）；
  - 条左侧像素更接近 A、右侧更接近 B（逐像素判定，不允许反例）。
- `BIG=1` 时额外跑 810×1080 / 30 帧 / 256 色，打印体积与耗时。
- 参考值（同一台机器量级，不作为硬断言）：无抖动 ≈ 207 KB，抖动 ≈ 741 KB，约 0.7s。

### 8.4 人工验收清单

- [ ] 双击 `public/index.html` 可直接使用（无服务端、无控制台报错）。
- [ ] `npm start` 后页面、CSS、5 个脚本均 200；`/health` 返回 JSON；不存在的路径 404。
- [ ] 三个下拉框均为深色自绘样式，展开时有缩放淡入、选中项青色高亮、下方空间不足时向上弹。
- [ ] 点击/拖拽/粘贴三条上传路径都能填充对应槽位；缩略图棋盘格背景、元信息为 `文件名 · 宽×高`。
- [ ] 上传 A 后白条宽度自动变为 `max(3,min(24,round(宽×1%)))`；手动拖过之后不再自动改。
- [ ] 预览循环速度 = `帧数 × 帧间隔`，与导出 GIF 一致；拖动滑块立即暂停并定位；空格可播放/暂停。
- [ ] 生成的 GIF 无限循环；条左为 A、右为 B；白条颜色与选择一致；`swap` 后左右互换。
- [ ] 下载文件名 `compare-{宽}x{高}-{帧数}f.gif`；结果区显示尺寸/帧数/体积/耗时。
- [ ] 窄屏（<980px）变为单列，设置项变一列。
- [ ] 生成期间页面不卡死（每处理 1~2 帧让出一次主线程）。

---

## 9. 从零复现顺序

1. `package.json`（无依赖，脚本如上）→ `server.js` → 用 `npm start` 验证静态服务。
2. `public/js/quantizer.js`：先实现直方图 → 中位切分 → LUT → 非抖动量化；跑通颜色数/白色存在性检查。
3. `public/js/gif-encoder.js`：先写死一张 2 色小图验证文件头/色表/Trailer，再实现 LZW，最后接 `extractSub` 与子矩形帧；用独立解码器往返比对。
4. `public/js/comparer.js`：实现 `prepareSource` → `composeFrame` → `progressToPosition/framePositions` → `createJob`；先关闭抖动、全幅帧跑通，再打开竖带重绘与帧差。
5. `public/index.html` + `public/css/style.css`：按 §5 搭建；先保证结构与文案，再逐项对照样式表。
6. `public/js/dropdown.js`：先做静态开合与选中，再补键盘、外部点击、向上弹。
7. `public/js/app.js`：上传 → 预览 → 生成 → 下载，最后补提示文案、空格键、建议白条宽度。
8. 补 `test/roundtrip.test.js` 与 `test/pipeline.test.js`，直到 `npm test` 全绿。
9. 跑 `npm run bench`，确认体积在合理量级（若比参考值大一个数量级，说明帧差或竖带重绘失效）。

---

## 10. 高频坑位（逐条核对）

1. **LZW 位宽相位**：编码端"`emit` 后用即将分配的 `next` 判断 `next >= 1<<codeSize` 再提宽"；解码端"先 `next++` 再判"。两侧形式不同但必须对应。字典满 4096 时先发 CLEAR 再重置。
2. **GIF 处置方式只能是 1**：因为除首帧外只写变化矩形。要改 2 就必须回退成全幅帧。
3. **竖带范围**：必须覆盖前后两个白条位置 ±`barW/2` 再各留 2px 余量，并夹到画布内；否则鬼影。
4. **调色板 pins**：白条色追加到末尾且不参与 K-means 均值更新；`refine` 只更新前 `colors.length - pinned` 项。
5. **帧缓冲别名**：`cur !== prev` 必须始终成立；无变化帧 `continue` 前**不要**交换缓冲，也不要遗漏 `pendingDelay` 累加。
6. **5bit LUT 假设不透明**：`prepareSource` 先铺白底，所以进入量化的像素 `alpha=255`。若将来支持透明背景，必须同步改 LUT 与透明色索引。
7. **白条宽度两种语义**：预览乘 `previewScale`（可小数），导出取整且最小 1；调整时两侧都要改。
8. **抖动只作用于竖带**：误差缓冲每条带重置；不要"优化"成整帧一次性抖动，否则体积与像素结果都会变。
9. **`scale` 取整**：`W/H = max(2, round(原尺寸*scale))`；不要用 `floor`。
10. **颜色数下限**：`maxColors` 夹到 `2..256`；`GifWriter` 的 `minCodeSize` 至少为 2（GIF 规范下限），即使只有 2 种颜色。
11. **采样步长**：调色板统计用 `max(1, floor(W*H/120000))` 抽稀；不要全量统计（大图会明显变慢且收益极小）。
12. **预览与导出共用位置函数**：`progressToPosition` 与 `composeFrame` 必须是同一套，否则"所见非所得"。
13. **`[hidden]` 兜底**：`.dz-preview{display:flex}` 等会覆盖 hidden 的默认样式，必须有 `[hidden]{display:none!important}`。
14. **下拉框层级**：菜单展开时给 `.card` 加 `.dropdown-open(z-index:30)`，否则会被下一张卡片盖住。
15. **`input.value=''`**：文件选择后重置，才能连续选择同一文件。
16. **`createImageBitmap` 失败要降级**：部分浏览器不认 `imageOrientation`，直接抛错；必须回退到 `Image`，否则上传直接失败。

---

## 11. 一句话验收

在任意现代浏览器打开页面，选两张图，默认参数点一次生成：得到一张无限循环、白条左侧 A / 右侧 B、体积与「只写变化区域」相符的 GIF；`npm test` 全绿。

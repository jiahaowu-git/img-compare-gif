# AGENTS.md

面向后续维护者与 AI 编码代理的项目约定。**动手前先读「关键不变量」，那里每一条都对应一个真实踩过的坑。**

## 项目定位

纯前端、零依赖的「白条滑动前后对比 GIF」生成器。所有像素合成与 GIF 编码都跑在浏览器里，`server.js` 仅托管 `public/` 静态资源。**不要为了"看起来更正经"而引入构建工具或第三方运行时依赖**（gif.js、sharp、canvas、Express 等一律不必要）。

## 常用命令

```bash
npm start                     # 静态服务 http://127.0.0.1:3000
npm test                      # 编码器往返 + 完整链路自检（改动后必跑）
npm run bench                 # 810x1080 / 30 帧 性能与体积实测（BIG=1）
NODITHER=1 npm run bench      # Windows: $env:NODITHER=1; npm run bench
node --check public/js/*.js    # 快速语法检查
```

## 文件职责

| 文件 | 职责 | 运行环境 |
| --- | --- | --- |
| `public/js/quantizer.js` | 颜色量化：直方图分桶 → 中位切分 → K-means → 5bit LUT → FS 抖动 | UMD，可被 Node require |
| `public/js/gif-encoder.js` | GIF89a 写字节：全局色表、LZW、子矩形帧、NETSCAPE 循环 | UMD，可被 Node require |
| `public/js/comparer.js` | 合成与调度：铺图、白条位置、竖带局部重绘、帧差、逐帧编码 | **仅浏览器**（依赖 canvas） |
| `public/js/dropdown.js` | 把原生 `<select>` 增强为自绘下拉框 | 仅浏览器 |
| `public/js/app.js` | 页面交互与状态 | 仅浏览器 |
| `server.js` | 静态托管（MIME / no-cache / HEAD / `/health` / 目录穿越防护 / 端口占用自动顺延） | Node |
| `test/*.test.js` | 自检脚本，`roundtrip.test.js` 导出 `decodeGif` 供 `pipeline.test.js` 复用 | Node |

脚本引入顺序（`public/index.html` 末尾）有依赖：`quantizer.js` → `gif-encoder.js` → `comparer.js`（UMD 工厂在加载时即解析 `GifQuantizer` / `GifEncoder` 全局）→ `dropdown.js` → `app.js`。**全部为 classic script（非 ESM）**，这样 `file://` 直开也能用；不要改成 `type="module"`，也不要在前端引入 `fetch`/接口调用。

## 关键不变量（改代码前务必确认）

1. **LZW 码长同步点**：编码器在 `emit()` 之后、用"即将分配的码字值 `next`"判定 `next >= (1 << codeSize)` 再提升位宽（等价于 Poskanzer/jsgif 的做法）；字典满 4096 时先发 CLEAR 再重置。测试里的解码器必须"先 `next++` 再判 `next >= (1 << codeSize)`"才与之同步——**两侧判据形式不同但相位必须严格对应**，写错就会出现"码字越界 / 画面花屏"。改动后先跑 `npm test`，再用 Pillow 交叉验证。
2. **帧的处置方式固定为 1（保留上一帧）**：因为除首帧外只写变化矩形。改成 2（清除背景）会残影/闪烁；改成 0 未定义行为。要改必须同时回退成全幅帧。
3. **竖带范围必须覆盖整段位移**：`[min(x_prev, x) - barW/2 - 2, max(x_prev, x) + barW/2 + 2]` 再夹到画布内。收窄会导致该帧部分像素沿用旧内容，出现"鬼影"。
4. **调色板必须固定包含白条色**：`createPalette(..., mustColors)` 里的 `pins` 会追加到调色板尾部并**跳过 K-means 均值更新**（`refine(..., pinned)` 只更新前 `length - pinned` 项）。若让白条色参与聚类，白条会被拉偏成"接近白"。
5. **帧缓冲双数组不变量 `cur !== prev`**：互换三件套 `prev/cur/spare` 时必须保持两者不同。跳过无变化帧时**不要交换缓冲**（直接 `continue` 累积延时即可），否则会出现 `cur === spare` 的别名错误。
6. **5bit 查找表假设输入已是不透明像素**：`prepareSource()` 先铺白底再画图，所以所有进入量化的像素 `alpha=255`；若将来支持透明背景，需要同步处理 `lut` 与透明色索引。
7. **白条宽度按输出像素定义**：预览里乘了 `previewScale`，导出时不缩放。调整语义时两侧都要改。

## 改动检查清单

- 动了 `quantizer.js` / `gif-encoder.js` / `comparer.js` → `npm test` 必须全绿；最好再用 Pillow 交叉验证：`python -c "from PIL import Image;im=Image.open('test/out/roundtrip.gif');print(im.n_frames, im.size, im.info.get('loop'))"`。
- 动了 `comparer.js` 的合成/差分逻辑 → 除 `npm test` 外，跑 `npm run bench` 看体积是否异常膨胀（差分失效会立刻体现为几十倍体积）。
- 动了前端脚本 → `node --check` 通过，并在 `public/index.html` 中确认引入顺序；新增文件记得加进该文件与 README 的目录表。
- 任何对外的行为/参数变化 → 同步更新 `README.md` 的参数表与本文档的说明。

## 代码风格

- 前端脚本统一用 ES5 风格 IIFE + `'use strict'`，公共模块挂到全局（`GifQuantizer` / `GifEncoder` / `ImgCompare` / `Dropdown`）并保留 `module.exports` 分支，以便 Node 自检脚本直接 require。
- 不做无必要的抽象；`comparer.js` 里已明确写了"为什么这么算"的注释，保留它们。
- 注释与文档用中文，与现有风格一致。
- 不引入 `console.log` 调试残留（`app.js` 仅在生成失败时 `console.error`）。

## 已知限制 / 可扩展点

- 一次只处理一对图片；批量化需要把 `createJob()` 串行化并共享调色板。
- 逐帧编码在主线程完成，靠 `await nextTick()` 分片让 UI 不卡死；超大图可迁移到 Web Worker（`quantizer.js`/`gif-encoder.js` 已是纯函数式、无 DOM 依赖，可直接搬运）。
- 输出仅 GIF；WebP/APNG 可复用同一套合成与帧差，只替换编码器。
- 抖动为固定强度 FS，可加"抖动强度/有序抖动（Bayer）"选项以在体积与画质间取更细的平衡。

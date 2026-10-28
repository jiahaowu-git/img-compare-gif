# img-compare-gif

上传两张「前后」图片，一键生成一根**竖直白条左右循环滑动**的前后对比 GIF —— 白条左侧显示图 A、右侧显示图 B，整幅画面随白条扫过而"揭示"变化。

- 输出尺寸默认与图片 A 完全一致
- 合成与导出全部在**浏览器本地**完成，图片不上传任何服务器
- **零依赖、零构建**：不用装包、不用打包，`node server.js` 或直接双击页面即可运行
- GIF 编码器、调色板量化器均为手写实现（不依赖 gif.js / canvas / sharp）

## 快速开始

```bash
# 方式一：起本地静态服务（推荐）
npm start                 # http://127.0.0.1:3000
PORT=4000 npm start       # 换端口；Windows PowerShell: $env:PORT=4000; npm start
HOST=0.0.0.0 npm start    # 允许局域网访问
```

也可以直接用浏览器打开 `public/index.html`（纯静态，无需服务端）。

> `server.js` 只做一件事：把 `public/` 发出去（含 MIME、`no-cache`、`HEAD`、`/health`、目录穿越防护）。它不住渲染、不碰图片，所以不需要 Express 等依赖。

## 桌面版（Electron，可选）

网页版本体仍然是零依赖；Electron 只做"外壳"，窗口里加载的就是 `public/index.html`，合成与编码代码完全不分叉。

```bash
npm install              # 安装 electron / electron-builder（仅桌面版需要）
npm run electron         # 直接打开桌面窗口（开发调试）
npm run electron:dir     # 生成免安装目录 dist/win-unpacked/
npm run electron:build   # 同时生成安装包与单文件便携版（Windows 为 NSIS + portable）
```

- `npm run electron:build` 的产物：
  - `dist/img-compare-gif Setup <version>.exe`：NSIS 安装包；
  - `dist/img-compare-gif-<version>-portable.exe`：单文件免安装版，双击即用；
  - `dist/win-unpacked/`：未压缩目录，便于排查问题。
- 产物输出到 `dist/`（已加入 `.gitignore`）。
- 打包通过 `electronDist` 直接使用 `node_modules/electron/dist`，不会重复从 GitHub 下载 Electron。
- 未配置应用图标，使用 Electron 默认图标；未配置签名证书，安装包未签名。
- 桌面版禁用了 Node 注入、页面跳转与新窗口，外链交给系统浏览器。

## 使用方法

1. 上传**图片 A（前）**与**图片 B（后）**——支持点击、拖拽、`Ctrl+V` 粘贴；
2. 左下方参数面板调整白条宽度/颜色、帧数、帧间隔、滑动方式、输出尺寸、抖动等；
3. 右上方**实时预览**会立即播放对比效果，可拖动滑块手动控制白条位置；
4. 点击「生成对比 GIF」，完成后右下角可直接预览并下载 `compare-宽x高-Nf.gif`。

## 参数说明

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| 白条宽度 | 8 px | 按**输出尺寸**计算的实际像素宽（上传后会自动给一个与图宽成比例的建议值）|
| 白条颜色 | `#ffffff` | 该颜色会被强制放进调色板，保证渲染不偏色 |
| 帧数 | 30 | 一整轮动画的帧数；往返模式首尾无缝，可直接循环 |
| 帧间隔 | 50 ms | GIF 时间粒度为 10ms；多数浏览器会把 <20ms 当作 100ms 处理，故下限 20ms |
| 滑动方式 | 左右往返 | `往返`：0→L→0 采样，循环无缝；`单向冲刷`：扫到右侧后跳回起点 |
| 输出尺寸 | 与图 A 相同 | 可选 75% / 50% / 35%，大幅缩小既能提速也能显著减小体积 |
| 两图适配 | 铺满裁剪 | 两图尺寸/比例不一致时，`铺满裁剪` 对齐构图，`完整包含` 则留白 |
| 调色板颜色数 | 256 | GIF 单帧上限 256；颜色越少体积越小但渐变越容易断层 |
| 抖动 | 开 | Floyd–Steinberg 误差扩散，明显改善天空等大面积渐变，代价是体积变大 |
| 左右对调 | 关 | 交换 A/B 在画面中的左右位置 |

## 目录结构

```
server.js                 零依赖静态服务入口（只有静态资源托管）
package.json              npm start / test / bench
SPEC.md                   从零复刻用的完整规格书（功能 / 界面 / 算法 / 验收）
public/                   前端静态资源
  index.html
  css/style.css
  js/quantizer.js         调色板量化（中位切分 + K-means + 抖动 + 5bit 查找表）
  js/gif-encoder.js       GIF89a 编码器（全局色表 + LZW + 子矩形帧 + 循环扩展）
  js/comparer.js          画面合成（白条滑动、竖带局部重绘、帧差定位、逐帧编码）
  js/app.js               页面交互（上传、参数、预览、生成、下载）
  js/dropdown.js          自绘下拉框（原生 select 展开列表无法美化）
test/                     自检脚本（Node，无第三方依赖）
  roundtrip.test.js       编码器往返校验 + 内置独立 GIF/LZW 解码器
  pipeline.test.js        完整链路校验（桩化 canvas 跑通 comparer）
```

## 实现要点

**1. 合成与滑动**
`composeFrame()` 以白条中心 `x` 为界：先画整幅 A，再裁剪绘制 `x + barW/2` 之后的 B，最后覆盖白条。位置由 `progressToPosition(t)` 统一决定，预览（`requestAnimationFrame`）与导出共用同一套坐标，所见即所得。

**2. 只重绘"变化的那条竖带"**
相邻帧只有白条扫过的一条竖带会变，所以每帧只渲染 `[min(x_{前}, x_{后}) - barW/2 - 2, max(...) + barW/2 + 2]` 这一段并量化回整幅索引图，其余像素直接沿用上一帧，避免每帧整幅重绘。

**3. 帧差定位（体积关键）**
逐像素比较本帧与上一帧的索引图，求出变化的最小矩形，只把该矩形写进 GIF（图形控制扩展的处置方式固定为 1「保留上一帧」，因此子矩形依赖前帧内容）。810×1080、30 帧、256 色实测：**无抖动 ≈ 207 KB / 开启抖动 ≈ 741 KB**（约 0.7s）。

**4. 调色板量化**
两张图的像素先按 32³ 分桶统计（每通道 5bit），对桶做加权中位切分切到 N 个盒子，再用 2 轮 K-means（Lloyd）微调；白条颜色作为 `pins` 固定项**不参与均值更新**，保证白条永远是纯色。最后建立 32768 项 5bit 查找表，无抖动时像素映射为 O(1)。

**5. GIF89a 编码**
手写 LZW：字典用复用的 `Int32Array(4096*256)`，位宽在"下一个待分配码字达到 `2^codeSize`"时提升、字典满 4096 时发 CLEAR 重置——与主流解码器（giflib/Pillow/浏览器）的同步点一致；同时写入 NETSCAPE2.0 无限循环扩展。

## 测试

```bash
npm test                 # 编码器往返 + 完整链路
npm run bench            # 附带 810x1080 / 30 帧 的性能与体积实测
```

`roundtrip.test.js` 内嵌了一个**独立实现的最小 GIF/LZW 解码器**，把写出的 GIF 解回来逐像素比对（帧尺寸、帧数、延时、处置方式、局部矩形帧、循环标记），并输出每帧 RGB 的 SHA1，方便与第三方解码器交叉验证：

```python
# 可选：用 Pillow（独立解码器）核对同一份 GIF
from PIL import Image
import hashlib
im = Image.open("test/out/roundtrip.gif")
i = 0
while True:
    try:
        im.seek(i)
    except EOFError:
        break
    print(i, hashlib.sha1(im.convert("RGB").tobytes()).hexdigest()[:16])
    i += 1
```

该脚本的 `test/out/roundtrip.gif` 已用 Pillow 12 验证：`n_frames=8`、`loop=0`、每帧 50ms，8 帧 RGB SHA1 与 Node 端期望值逐帧一致。

## 兼容性与限制

- 浏览器：Chrome / Edge / Firefox / Safari 现代版本（依赖 `canvas`、`Blob`、`createImageBitmap`，后者不可用时自动回退到 `Image` 解码）。
- GIF 单帧最多 256 色，因此照片类素材会有一定色阶损失；开抖动可显著缓解。
- 超大图（如 4000×5000）会占用较多内存（每帧索引图 = 宽×高 字节，双缓冲两份），建议配合输出缩放使用。
- 白条宽度按输出像素定义，缩小输出时白条视觉上会相对变粗，可自行调小。
- 目前一次只处理一对图片；批量/多组对比、Web Worker 后台编码、WebP/APNG 输出等可作为后续扩展点（见 `AGENTS.md`）。

## License

MIT

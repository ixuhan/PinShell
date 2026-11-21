# PinShell 图标方案

> **已采用：钢印 P · 深底**（`p-dark.svg`）。`prototype/icons/app-icon-1024.png` 是它的 1024 透明底渲染，
> 已经跑过 `npx tauri icon` 铺到 `src-tauri/icons/`，`tauri.conf.json` 的 `bundle.icon` 也指全了。
> 想换成浅底或另一个概念：改 `CONCEPTS` 里对应的 `glyph` → 重跑生成器 → 用新的 1024 PNG 再跑一次 `npx tauri icon`。

6 个概念 × 2 种处理，全部 256 viewBox 的纯矢量，颜色沿用界面主色薄荷绿 `#46d19a`。

| 文件 | 概念 | 一句话 |
|---|---|---|
| `p-*.svg` | 钢印 P | 竖笔 + 半圆碗的 P 字标，最像品牌 |
| `window-*.svg` | 引脚窗口 | 终端窗 + 三根引脚，终端与硬件各占一半 |
| `prompt-*.svg` | 提示符 | 加粗尖括号 + 方块光标，最直白的终端 |
| `chip-*.svg` | 芯片 | 四边出脚的芯片，中心一个提示符 |
| `header-*.svg` | 排针 | 三根针焊在底座上，1×3 排针剪影 |
| `wave-*.svg` | 串口波形 | 一个方波脉冲，讲数据在线上跑 |

`-dark` 是深底（`#101c17`）反白，`-light` 是薄荷底（`#3fbd8e`）压深墨（`#0a1a13`）。

## 改图形

图形定义集中在 `scripts/gen-icons.mjs` 的 `CONCEPTS` 数组里，改完重跑：

```bash
node scripts/gen-icons.mjs
```

会重写本目录的 12 个 svg，并更新 `.probe/icons.html`（带 48/32/24/16 尺寸检视的对比页）。

## 换成应用图标

Tauri 只认位图，需要先从选中的 svg 导一张 1024×1024 PNG，再让它生成全套尺寸：

```bash
# 1. 用浏览器打开选中的 svg，另存为 1024×1024 PNG（或 Node 侧用 sharp 转）
# 2. 生成 icns / ico / png 全尺寸到 src-tauri/icons/
npx tauri icon path/to/icon-1024.png
```

`src-tauri/tauri.conf.json` 里的 `bundle.icon` 目前指向 `icons/icon.ico` 与 `icons/icon.png`，
`tauri icon` 会覆盖这两个文件，配置不用改。

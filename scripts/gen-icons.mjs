// PinShell 图标方案生成器
//
// 六个概念 × 两种处理（深底反白 / 浅底压深）。图形全部按 256 viewBox 画，
// 保证在 16px 下还有轮廓可认：线宽 ≥ 12，最小间距 ≥ 12。
// 输出：prototype/icons/*.svg + .probe/icons.html（对比预览）+ .probe/icons.json（画布用）

import { mkdirSync, writeFileSync } from "node:fs";

const DARK_TILE = "#101c17";
const MINT = "#46d19a";
const LIGHT_FROM = "#5ee0ab";
const LIGHT_TO = "#2b9a71";
const INK = "#0a1a13";

const S = (w, h) => `width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"`;
const stroke = (c, w, extra = "") =>
  `fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"${extra}`;

/// 每个概念返回「只含图形」的 svg 内容（背景由外层圆角方框负责）
const CONCEPTS = [
  {
    id: "p",
    name: "钢印 P",
    note: "正规的 P 字标（竖笔 + 半圆碗），最像品牌，缩到 16px 也散不开",
    glyph: (c) => `
      <rect x="70" y="52" width="38" height="152" rx="19" fill="${c}"/>
      <path d="M104 64 H130 A40 40 0 0 1 130 144 H104" ${stroke(c, 32)}/>`
  },
  {
    id: "window",
    name: "引脚窗口",
    note: "终端窗 + 三根引脚，一句话说清「跑在硬件上的终端」",
    glyph: (c) => `
      <rect x="56" y="46" width="144" height="118" rx="20" ${stroke(c, 16)}/>
      <path d="M106 88 L136 112 L106 136" ${stroke(c, 14)}/>
      <path d="M88 164 V196 M128 164 V196 M168 164 V196" ${stroke(c, 14)}/>`
  },
  {
    id: "prompt",
    name: "提示符",
    note: "加粗尖括号 + 方块光标，最直白的终端，远看最清楚",
    glyph: (c) => `
      <path d="M64 70 L144 128 L64 186" ${stroke(c, 36)}/>
      <rect x="166" y="144" width="46" height="42" rx="9" fill="${c}"/>`
  },
  {
    id: "chip",
    name: "芯片",
    note: "四边出脚的芯片，中心一个提示符，硬件的分量更重",
    glyph: (c) => `
      <rect x="78" y="78" width="100" height="100" rx="18" ${stroke(c, 14)}/>
      <path d="M56 104 H78 M56 152 H78 M178 104 H200 M178 152 H200" ${stroke(c, 12)}/>
      <path d="M104 56 V78 M152 56 V78 M104 178 V200 M152 178 V200" ${stroke(c, 12)}/>
      <path d="M106 112 L138 128 L106 144" ${stroke(c, 12)}/>`
  },
  {
    id: "header",
    name: "排针",
    note: "三根针焊在底座上，1×3 排针的剪影，硬件味最正",
    glyph: (c) => `
      <path d="M92 140 V68 M128 140 V68 M164 140 V68" ${stroke(c, 18)}/>
      <rect x="62" y="140" width="132" height="46" rx="16" fill="${c}"/>`
  },
  {
    id: "wave",
    name: "串口波形",
    note: "一个方波脉冲，讲的是数据在线上跑，和终端系图形不撞",
    glyph: (c) => `
      <path d="M52 168 H96 V88 H144 V168 H200" ${stroke(c, 18)}/>`
  }
];

// ---------- 生成 svg ----------
const TILE_RADIUS = 58;
function tileSvg(bg, glyph) {
  const bgFill = bg.from
    ? `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
         <stop offset="0" stop-color="${bg.from}"/><stop offset="1" stop-color="${bg.to}"/>
       </linearGradient></defs><rect width="256" height="256" rx="${TILE_RADIUS}" fill="url(#g)"/>`
    : `<rect width="256" height="256" rx="${TILE_RADIUS}" fill="${bg.color}"/>`;
  return `<svg ${S(256, 256)}>${bgFill}${glyph}</svg>`;
}

mkdirSync("prototype/icons", { recursive: true });
const variants = [];
for (const c of CONCEPTS) {
  const dark = tileSvg({ color: DARK_TILE }, c.glyph(MINT));
  const light = tileSvg({ from: LIGHT_FROM, to: LIGHT_TO }, c.glyph(INK));
  writeFileSync(`prototype/icons/${c.id}-dark.svg`, dark.trim());
  writeFileSync(`prototype/icons/${c.id}-light.svg`, light.trim());
  variants.push({ id: c.id, name: c.name, note: c.note, dark, light, glyph: c.glyph });
}

// ---------- 画布用的 JSON（glyph 只含图形，底色由画布上的圆角框给） ----------
writeFileSync(
  ".probe/icons.json",
  JSON.stringify(
    variants.map((v) => ({ id: v.id, name: v.name, dark: v.dark, light: v.light })),
    null,
    1
  )
);

// ---------- 预览页 ----------
const cell = (v) => `
  <figure>
    <div class="pair">
      <div class="art">${v.dark}</div>
      <div class="art">${v.light}</div>
    </div>
    <figcaption><b>${v.name}</b><span>${v.note}</span></figcaption>
  </figure>`;

const sizes = (v, variant) => `
  <div class="cell">
    <span class="szname">${v.name}</span>
    <span class="sizes">${[48, 32, 24, 16]
      .map(
        (s) =>
          `<span class="sz">${v[variant].replace('width="256" height="256"', `width="${s}" height="${s}"`)}</span>`
      )
      .join("")}</span>
  </div>`;

const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>PinShell 图标方案</title>
<style>
  body{margin:0;background:#f3f4f6;color:#171b21;font:14px/1.6 system-ui,"Segoe UI","Microsoft YaHei",sans-serif;padding:40px}
  h1{margin:0 0 6px;font-size:24px;letter-spacing:-.01em}
  p.lede{margin:0 0 28px;color:#59636f;font-size:13px}
  .grid{display:flex;flex-wrap:wrap;gap:28px}
  figure{margin:0;width:300px}
  .pair{display:flex;gap:14px}
  .art{width:142px}
  .art svg{width:100%;height:auto;display:block;border-radius:14px}
  figcaption{display:flex;flex-direction:column;gap:2px;margin-top:9px}
  figcaption b{font-size:13px}
  figcaption span{font-size:11.5px;color:#6b7480;line-height:1.5}
  h2{margin:40px 0 14px;font-size:14px;color:#3d4650}
  .bars{display:flex;flex-direction:column;gap:10px}
  .bar{border-radius:10px;padding:12px 16px;display:grid;grid-template-columns:repeat(6,1fr);gap:10px;align-items:end}
  .bar.dark{background:#101a16}
  .bar.light{background:#ffffff;border:1px solid #e2e5e9}
  .cell{display:flex;flex-direction:column;gap:8px;min-width:0}
  .szname{font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .bar.dark .szname{color:#8fae9f}
  .bar.light .szname{color:#5c6672}
  .sizes{display:flex;align-items:flex-end;gap:5px;height:48px}
  .sz{display:inline-flex}
  .sz svg{display:block;border-radius:5px}
</style></head><body>
<h1>PinShell 图标 · 6 个概念</h1>
<p class="lede">左深底右浅底，同一套图形只换处理。下面两排是 48/32/24/16 的真实尺寸——挑的时候看这两排就行。</p>
<div class="grid">${variants.map(cell).join("")}</div>
<h2>小尺寸检视 · 深底</h2>
<div class="bars"><div class="bar dark">${variants.map((v) => sizes(v, "dark")).join("")}</div></div>
<h2>小尺寸检视 · 浅底</h2>
<div class="bars"><div class="bar light">${variants.map((v) => sizes(v, "light")).join("")}</div></div>
</body></html>`;
writeFileSync(".probe/icons.html", html);
console.log("ok", variants.length, "concepts");

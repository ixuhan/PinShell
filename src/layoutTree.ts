/**
 * 分格布局的纯几何与结构规则。
 *
 * 这是 Rust 侧 `Layout` 的前端镜像：同一棵树、同一套「最深 3 层、比例 0.1–0.9」，
 * 但所有函数只吃数据、不碰 DOM，方便 vitest 直接驱动。渲染、拖拽命中、方向键搬焦点
 * 都从这里取结果，避免三处各写一套几何。
 */

export type Axis = "horizontal" | "vertical";
export type Side = "left" | "right" | "top" | "bottom";
export type Direction = "left" | "right" | "up" | "down";

export interface LeafLayout {
  kind: "leaf";
  session: string;
}

export interface SplitLayout {
  kind: "split";
  axis: Axis;
  ratio: number;
  first: PaneLayout;
  second: PaneLayout;
}

export type PaneLayout = LeafLayout | SplitLayout;

export interface PaneRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 与 core-domain 的 `MAX_SPLIT_DEPTH` 一致：再深每一格就小到不可用。 */
export const MAX_DEPTH = 3;
export const MIN_RATIO = 0.1;
export const MAX_RATIO = 0.9;

/** 命中边缘热区的宽度（占格子的比例）。中心区域留给「交换」。 */
const EDGE_BAND = 0.28;
/** 浮点比较的容差：归一化坐标相乘后会带误差，严格相等会把相邻格判成没接上。 */
const EPS = 1e-6;

export function leaf(session: string): LeafLayout {
  return { kind: "leaf", session };
}

export function paneList(layout: PaneLayout): string[] {
  if (layout.kind === "leaf") return [layout.session];
  return [...paneList(layout.first), ...paneList(layout.second)];
}

export function contains(layout: PaneLayout, session: string): boolean {
  if (layout.kind === "leaf") return layout.session === session;
  return contains(layout.first, session) || contains(layout.second, session);
}

export function depth(layout: PaneLayout): number {
  if (layout.kind === "leaf") return 0;
  return 1 + Math.max(depth(layout.first), depth(layout.second));
}

export function depthOf(layout: PaneLayout, session: string): number | null {
  if (layout.kind === "leaf") return layout.session === session ? 0 : null;
  const first = depthOf(layout.first, session);
  if (first !== null) return first + 1;
  const second = depthOf(layout.second, session);
  return second === null ? null : second + 1;
}

export function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
}

function axisOf(side: Side): Axis {
  return side === "left" || side === "right" ? "horizontal" : "vertical";
}

/** 左/上插入时新格是第一个子节点；比例永远描述第一个子节点的占比。 */
function newFirst(side: Side): boolean {
  return side === "left" || side === "top";
}

/**
 * 在 `target` 的指定一侧切一格。目标不存在、或切完超过 3 层时返回 `null`——
 * 调用方要把 `null` 变成明确的提示，不能静默失败。
 */
export function splitPane(
  layout: PaneLayout,
  target: string,
  side: Side,
  ratio: number,
  newSession: string
): PaneLayout | null {
  const split = splitInner(layout, target, side, clampRatio(ratio), newSession);
  if (!split) return null;
  return depth(split) > MAX_DEPTH ? null : split;
}

function splitInner(
  layout: PaneLayout,
  target: string,
  side: Side,
  ratio: number,
  newSession: string
): PaneLayout | null {
  if (layout.kind === "leaf") {
    if (layout.session !== target) return null;
    const created = leaf(newSession);
    const [first, second] = newFirst(side)
      ? [created, layout]
      : [layout, created];
    return { kind: "split", axis: axisOf(side), ratio, first, second };
  }
  const first = splitInner(layout.first, target, side, ratio, newSession);
  if (first) {
    return { ...layout, first };
  }
  const second = splitInner(layout.second, target, side, ratio, newSession);
  if (second) {
    return { ...layout, second };
  }
  return null;
}

/** 摘掉一个叶子并折叠父切割；返回 `null` 表示整棵树空了。 */
export function removePane(layout: PaneLayout, session: string): PaneLayout | null {
  if (layout.kind === "leaf") {
    return layout.session === session ? null : layout;
  }
  const first = removePane(layout.first, session);
  const second = removePane(layout.second, session);
  if (!first && !second) return null;
  if (!first) return second;
  if (!second) return first;
  return { ...layout, first, second };
}

/** 交换两个格子的位置；只换叶子里的会话 id，树形与比例不动。 */
export function swapPanes(layout: PaneLayout, a: string, b: string): PaneLayout {
  if (layout.kind === "leaf") {
    if (layout.session === a) return leaf(b);
    if (layout.session === b) return leaf(a);
    return layout;
  }
  return {
    ...layout,
    first: swapPanes(layout.first, a, b),
    second: swapPanes(layout.second, a, b)
  };
}

/** 递归算出每个叶子占的矩形（归一化坐标，便于与像素解耦）。 */
export function paneRects(
  layout: PaneLayout,
  rect: PaneRect = { x: 0, y: 0, width: 1, height: 1 },
  out = new Map<string, PaneRect>()
): Map<string, PaneRect> {
  if (layout.kind === "leaf") {
    out.set(layout.session, rect);
    return out;
  }
  const ratio = clampRatio(layout.ratio);
  if (layout.axis === "horizontal") {
    paneRects(
      layout.first,
      { x: rect.x, y: rect.y, width: rect.width * ratio, height: rect.height },
      out
    );
    paneRects(
      layout.second,
      {
        x: rect.x + rect.width * ratio,
        y: rect.y,
        width: rect.width * (1 - ratio),
        height: rect.height
      },
      out
    );
  } else {
    paneRects(
      layout.first,
      { x: rect.x, y: rect.y, width: rect.width, height: rect.height * ratio },
      out
    );
    paneRects(
      layout.second,
      {
        x: rect.x,
        y: rect.y + rect.height * ratio,
        width: rect.width,
        height: rect.height * (1 - ratio)
      },
      out
    );
  }
  return out;
}

export type DropZone = { kind: "center" } | { kind: "edge"; side: Side };

/**
 * 指针落在格子的哪个热区。四条边取「离得最近且足够近」的那一条，其余算中心。
 * 角上是两个方向都够近，按归一化距离取更近的一个，保证结果稳定、可测。
 */
export function hitZone(rect: PaneRect, x: number, y: number): DropZone {
  if (rect.width <= 0 || rect.height <= 0) return { kind: "center" };
  const fx = (x - rect.x) / rect.width;
  const fy = (y - rect.y) / rect.height;
  const distances: Array<[Side, number]> = [
    ["left", fx],
    ["right", 1 - fx],
    ["top", fy],
    ["bottom", 1 - fy]
  ];
  let best: [Side, number] = distances[0];
  for (const candidate of distances) {
    if (candidate[1] < best[1] - EPS) best = candidate;
  }
  if (best[1] <= EDGE_BAND) {
    return { kind: "edge", side: best[0] };
  }
  return { kind: "center" };
}

/** 只关心「哪条边」的调用方用这个；中心返回 `null`。 */
export function sideOf(rect: PaneRect, x: number, y: number): Side | null {
  const zone = hitZone(rect, x, y);
  return zone.kind === "edge" ? zone.side : null;
}

function overlap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.min(aEnd, bEnd) - Math.max(aStart, bStart);
}

/**
 * 按几何方向找最近的邻格。只看「完全在那一侧」且垂直/水平有重叠的格子，
 * 先比间隙、再比重叠长度，最后用坐标兜底，保证结果与遍历顺序无关。
 */
export function neighborOf(
  layout: PaneLayout,
  session: string,
  dir: Direction,
  rect: PaneRect = { x: 0, y: 0, width: 1, height: 1 }
): string | null {
  const rects = paneRects(layout, rect);
  const current = rects.get(session);
  if (!current) return null;

  let best: { id: string; gap: number; overlap: number; order: number } | null = null;
  for (const [id, candidate] of rects) {
    if (id === session) continue;
    let gap: number;
    let along: number;
    let order: number;
    if (dir === "left" || dir === "right") {
      along = overlap(
        current.y,
        current.y + current.height,
        candidate.y,
        candidate.y + candidate.height
      );
      if (along <= EPS) continue;
      gap =
        dir === "right"
          ? candidate.x - (current.x + current.width)
          : current.x - (candidate.x + candidate.width);
      order = candidate.y;
    } else {
      along = overlap(
        current.x,
        current.x + current.width,
        candidate.x,
        candidate.x + candidate.width
      );
      if (along <= EPS) continue;
      gap =
        dir === "down"
          ? candidate.y - (current.y + current.height)
          : current.y - (candidate.y + candidate.height);
      order = candidate.x;
    }
    if (gap < -EPS) continue;
    if (
      !best ||
      gap < best.gap - EPS ||
      (Math.abs(gap - best.gap) <= EPS && along > best.overlap + EPS) ||
      (Math.abs(gap - best.gap) <= EPS &&
        Math.abs(along - best.overlap) <= EPS &&
        order < best.order - EPS)
    ) {
      best = { id, gap: Math.max(0, gap), overlap: along, order };
    }
  }
  return best?.id ?? null;
}

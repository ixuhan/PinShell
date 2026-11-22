/**
 * 拖拽落点的纯决策规则。
 *
 * 不碰 DOM：给定「拖的是哪一格、落在哪个热区、源与目标是谁」，只回答该交换、
 * 该在某一侧切分，还是什么都不做。这样行为能用 vitest 直接钉住。
 *
 * 跨格拖动只处理**已有格子**；新建会话只有弹窗一条路（ADR 0008），
 * 所以这里没有「拖 profile 新建」这种来源。
 */

import type { DropZone, Side } from "./layoutTree";

export type DropDecision =
  | { action: "none" }
  | { action: "swap" }
  | { action: "split"; side: Side };

/**
 * - 中心 = 交换（不是替换），边缘 = 在那一侧切一格。
 * - 拖到自己身上、或没有目标格 = 回弹，不做任何改变。
 * - **中心永远不替换**：替换会悄悄关掉一个会话，要替换请走新建会话弹窗里的显式选项。
 */
export function decideDrop(
  zone: DropZone,
  source: string | null | undefined,
  target: string | null | undefined
): DropDecision {
  if (!target || !source || source === target) return { action: "none" };
  return zone.kind === "center"
    ? { action: "swap" }
    : { action: "split", side: zone.side };
}

/** 指针移动超过阈值才算拖动；没超过就把这次按下当普通点击。 */
export function exceededDragThreshold(
  startX: number,
  startY: number,
  x: number,
  y: number,
  threshold = 5
): boolean {
  return Math.hypot(x - startX, y - startY) >= threshold;
}

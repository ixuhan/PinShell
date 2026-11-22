/**
 * WebGL 上下文预算。
 *
 * 每个可见分格一个上下文，浏览器大约只给 16 个；超出后最老的会被挤掉，
 * 表现为「某个本该正常的格子整片白屏」。所以自己先设上限，超出的实例
 * 回退到 xterm 的 DOM 渲染器（xterm 6 没有 canvas addon），宁可慢一点也不要白屏。
 */

export const MAX_WEBGL_CONTEXTS = 8;

/** 现在还能不能再挂一个 WebGL 上下文。`active` 是已经挂上的可见分格数。 */
export function hasWebglRoom(
  active: number,
  max: number = MAX_WEBGL_CONTEXTS
): boolean {
  return active < max;
}

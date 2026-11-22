// 项目栏的宽度与整栏折叠规则：纯逻辑，无 DOM、无 IPC，属于常跑集（L0）。
// 与文件面板的 `clampPanelWidth` 是同一套思路：硬边界 + 给邻居留位置。

export const DEFAULT_SIDEBAR_WIDTH = 196;
export const MIN_SIDEBAR_WIDTH = 150;
export const MAX_SIDEBAR_WIDTH = 360;

export interface SidebarPrefs {
  /// 展开时的宽度；收起时不动它，展开回来还是这个宽度
  width: number;
  collapsed: boolean;
}

/// 拖动分隔条时把宽度夹进合法区间。
///
/// 上限除了硬边界，还要扣掉功能栏当前占的宽度并给终端留 `minMain`：
/// 三栏加起来超过窗口时，宁可这一栏窄一点，由用户自己去缩别的栏。
export function clampSidebarWidth(
  desired: number,
  viewport: number,
  filesWidth: number,
  minMain = 180
): number {
  const room = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, viewport - filesWidth - minMain));
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(room, Math.round(desired)));
}

/// 读回上次的宽度与折叠状态。
///
/// 三种输入都要认：没有记录、更早版本直接存的一个数字、以及只存了宽度的旧 JSON。
/// 坏数据一律回到默认值——存坏一格宽度不该让项目栏打不开。
export function parseStored(raw: string | null): SidebarPrefs {
  if (!raw) return { width: DEFAULT_SIDEBAR_WIDTH, collapsed: false };
  const legacy = Number(raw);
  if (Number.isFinite(legacy) && legacy > 0) return { width: Math.round(legacy), collapsed: false };
  try {
    const parsed = JSON.parse(raw) as Partial<SidebarPrefs>;
    const width = parsed.width;
    return {
      width:
        typeof width === "number" && Number.isFinite(width) && width > 0
          ? Math.round(width)
          : DEFAULT_SIDEBAR_WIDTH,
      collapsed: parsed.collapsed === true
    };
  } catch {
    return { width: DEFAULT_SIDEBAR_WIDTH, collapsed: false };
  }
}

export function serializePrefs(prefs: SidebarPrefs): string {
  return JSON.stringify({ width: prefs.width, collapsed: prefs.collapsed });
}

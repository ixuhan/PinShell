// 文件面板的纯逻辑：显示格式、路径拼接，以及「跟随 / 固定」两种模式下该请求哪个目录。
//
// 这里不做 DOM、不发 IPC：排序与过滤是后端的规则（`core-domain::fsview`），
// 本模块只决定「面板要什么、怎么显示」。

import { t } from "./i18n";

export type FilePanelMode = "follow" | "fixed";

/// 一个会话自己的文件面板设置：跟随/固定、自动刷新、是否显示隐藏项。
/// 面板宽度与展开状态是窗口级布局，不属于任何会话。
export interface FilePanelPrefs {
  mode: FilePanelMode;
  auto: boolean;
  showHidden: boolean;
  /// 固定模式下停在哪；跟随模式的路径由后端按会话 CWD 决定，这里恒为 null
  path: string | null;
}

export interface FilePanelStore {
  /// 整栏是否向右收起（只剩 26px 竖条）；窗口级布局，不属于任何会话
  collapsed: boolean;
  /// 文件子栏是否收起（只隐藏列表，标题栏留在原处）
  expanded: boolean;
  width: number;
  /// 文件子栏的高度（窗口级布局）；轮到它吃剩余高度时不生效
  height: number;
  /// 新建会话沿用最近一次用过的设置
  defaults: FilePanelPrefs;
  /// 按会话 id 存的设置
  sessions: Record<string, FilePanelPrefs>;
}

export const DEFAULT_PANEL_PREFS: FilePanelPrefs = {
  mode: "follow",
  auto: false,
  showHidden: false,
  path: null
};

/// 文件子栏的默认高度。轮到它吃剩余高度时这个值不生效（CSS 由 `rb-fill` 接管），
/// 被排到中间/顶部时才用它作为起始高度。
export const DEFAULT_FILE_PANEL_HEIGHT = 260;

/// 校验一份设置：字段缺失或类型不对就退回 `fallback`。`path` 只在固定模式下保留。
export function normalizePanelPrefs(
  raw: unknown,
  fallback: FilePanelPrefs = DEFAULT_PANEL_PREFS
): FilePanelPrefs {
  const source = (raw ?? {}) as Partial<FilePanelPrefs>;
  const mode: FilePanelMode =
    source.mode === "fixed" ? "fixed" : source.mode === "follow" ? "follow" : fallback.mode;
  const auto = typeof source.auto === "boolean" ? source.auto : fallback.auto;
  const showHidden = typeof source.showHidden === "boolean" ? source.showHidden : fallback.showHidden;
  const path = typeof source.path === "string" && source.path.trim() ? source.path : null;
  return { mode, auto, showHidden, path: mode === "fixed" ? path : null };
}

/// 解析 localStorage 里的整份面板状态。
///
/// 兼容旧版：旧版把 mode/auto/showHidden 放在顶层当全局一份。这里把它们读成
/// `defaults`，于是已有会话还没有自己的记录时沿用旧行为，不会突然全部重置。
export function normalizePanelStore(raw: unknown): FilePanelStore {
  const source = (raw ?? {}) as Record<string, unknown>;
  const legacy = normalizePanelPrefs(source);
  const defaults = source.defaults ? normalizePanelPrefs(source.defaults, legacy) : legacy;
  const sessions: Record<string, FilePanelPrefs> = {};
  if (source.sessions && typeof source.sessions === "object") {
    for (const [id, value] of Object.entries(source.sessions as Record<string, unknown>)) {
      if (!id) continue;
      sessions[id] = normalizePanelPrefs(value, defaults);
    }
  }
  // 整栏折叠（收成 26px 竖条）与文件子栏折叠（只隐藏列表）是两个独立状态：
  // 旧版本没有 `collapsed` 字段，缺省按展开处理。
  const collapsed = source.collapsed === true;
  const expanded = source.expanded !== false;
  const width =
    typeof source.width === "number" && Number.isFinite(source.width) && source.width > 0
      ? Math.round(source.width)
      : 0;
  const height =
    typeof source.height === "number" && Number.isFinite(source.height) && source.height > 0
      ? Math.round(source.height)
      : DEFAULT_FILE_PANEL_HEIGHT;
  return { collapsed, expanded, width, height, defaults, sessions };
}

export interface FsEntry {
  name: string;
  kind: "dir" | "file" | "other";
  link: boolean;
  size: number;
  modified_ms: number | null;
  created_ms: number | null;
  hidden: boolean;
}

export interface FsListing {
  path: string;
  parent: string | null;
  total: number;
  hidden_count: number;
  truncated: boolean;
  entries: FsEntry[];
}

/// 排序字段与方向。字段是「按什么排」，方向是正序（升序）还是倒序（降序）。
export type FileSortField = "name" | "created";
export type FileSortDir = "asc" | "desc";

export const SORT_FIELD_KEY = "pinshell.files.sort";
export const SORT_DIR_KEY = "pinshell.files.sortDir";

/// 旧版本只存了字段名，方向按字段的惯用值补：名称正序、创建时间最新优先。
export function parseSortField(raw: string | null): FileSortField {
  return raw === "created" ? "created" : "name";
}

export function parseSortDir(raw: string | null, field: FileSortField = "name"): FileSortDir {
  if (raw === "asc" || raw === "desc") return raw;
  return field === "created" ? "desc" : "asc";
}

/// 按字段与方向排一份条目。
///
/// - 名称：纯字典序（数字按大小比较），目录与文件混排，和旧版一致；
/// - 创建时间：目录始终在前（找目录不用翻到底），组内按时间排，时间相同按名称兜底；
/// - 时间缺失的条目排在该组末尾，避免「没有创建时间」的空值跑到最前面。
export function sortEntries(
  entries: FsEntry[],
  field: FileSortField,
  dir: FileSortDir
): FsEntry[] {
  const sign = dir === "asc" ? 1 : -1;
  const byName = (a: FsEntry, b: FsEntry) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  return [...entries].sort((a, b) => {
    if (field === "created") {
      if (a.kind === "dir" && b.kind !== "dir") return -1;
      if (a.kind !== "dir" && b.kind === "dir") return 1;
      const aTime = a.created_ms;
      const bTime = b.created_ms;
      if (aTime === null && bTime !== null) return 1;
      if (aTime !== null && bTime === null) return -1;
      if (aTime !== null && bTime !== null && aTime !== bTime) return aTime < bTime ? -sign : sign;
    }
    return sign * byName(a, b);
  });
}

/// 只有普通文件显示大小。目录与其它类型显示空串，避免一排 `0 B`。
export function formatSize(entry: FsEntry): string {
  if (entry.kind !== "file") return "";
  const bytes = entry.size;
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  const gb = mb / 1024;
  return `${gb < 10 ? gb.toFixed(1) : Math.round(gb)} GB`;
}

/// 当天只显示时分，同年显示月日，跨年显示完整日期。`now` 可注入，方便测试。
export function formatTime(ms: number | null, now = Date.now()): string {
  if (ms === null || !Number.isFinite(ms)) return "";
  const date = new Date(ms);
  const ref = new Date(now);
  if (Number.isNaN(date.getTime())) return "";

  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  const sameDay =
    date.getFullYear() === ref.getFullYear() &&
    date.getMonth() === ref.getMonth() &&
    date.getDate() === ref.getDate();
  if (sameDay) return `${hh}:${mm}`;
  if (date.getFullYear() === ref.getFullYear()) return `${month}-${day} ${hh}:${mm}`;
  return `${date.getFullYear()}-${month}-${day}`;
}

/// 进入子项。规则与 `core_domain::fsview::child_of` 一致：根后面不补第二个分隔符。
export function joinPath(parent: string, name: string): string {
  const base = parent.replace(/\//g, "\\").replace(/\\+$/, "");
  if (!base) return name;
  return `${base}\\${name}`;
}

function isDrive(segment: string): boolean {
  return segment.length === 2 && segment[1] === ":" && /^[A-Za-z]$/.test(segment[0]);
}

/// 统一分隔符、折叠重复分隔符、去掉 `.` 段与末尾分隔符。
/// 保留盘符根（`C:\`）、UNC 前缀（`\\server\share`）与根相对路径的前导 `\`；
/// 不解析 `..`：显示的是什么就是系统解析出的什么。规则同 `core_domain::fsview::normalize`。
export function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return "";
  const unified = trimmed.replace(/\//g, "\\");
  const unc = unified.startsWith("\\\\");
  const rooted = !unc && unified.startsWith("\\");
  const segments = unified.split("\\").filter((segment) => segment.length > 0 && segment !== ".");
  let out = unc ? "\\\\" : rooted ? "\\" : "";
  let start = 0;
  if (!unc && segments.length > 0 && isDrive(segments[0])) {
    out += `${segments[0]}\\`;
    start = 1;
  }
  return out + segments.slice(start).join("\\");
}

/// 上一级目录；已经在根上时返回 `null`。规则同 `core_domain::fsview::parent_of`：
/// 盘符根、UNC 共享根、相对路径的第一段都没有上一级。
///
/// 面板需要它的理由：目录读不出来时后端不会返回 `parent`（列表本身就是失败了），
/// 但用户仍然要能退出去，所以前端得自己算出上一级。
export function parentPath(path: string): string | null {
  const normalized = normalizePath(path);
  if (!normalized || normalized === "\\") return null;
  const unc = normalized.startsWith("\\\\");
  if (!unc && normalized.length === 3 && normalized.endsWith("\\") && isDrive(normalized.slice(0, 2))) {
    return null;
  }
  const separator = normalized.lastIndexOf("\\");
  if (separator < 0) return null;
  const parent = normalized.slice(0, separator);
  if (!parent) return null;
  if (parent.length === 2 && isDrive(parent)) return `${parent}\\`;
  // `\\server` 不是完整的 UNC 根，再往上就没有了
  const uncSegments = parent.replace(/^\\+/, "").split("\\").filter(Boolean).length;
  if (unc && uncSegments < 2) return null;
  return parent;
}

/// 路径面包屑的一段。`name` 是显示文字，`path` 是点它之后要进入的完整路径。
export interface PathSegment {
  name: string;
  path: string;
}

/// 把路径拆成面包屑。盘符根显示 `C:`，UNC 共享根显示 `\\server\share`；
/// 每段的 `path` 都能直接交给 `fs_list`（先按 `normalizePath` 规整过）。
export function pathSegments(path: string): PathSegment[] {
  const normalized = normalizePath(path);
  if (!normalized) return [];
  const unc = normalized.startsWith("\\\\");
  if (unc) {
    const parts = normalized.slice(2).split("\\").filter(Boolean);
    if (parts.length === 0) return [{ name: "\\\\", path: "\\\\" }];
    if (parts.length === 1) return [{ name: `\\\\${parts[0]}`, path: `\\\\${parts[0]}` }];
    const segments: PathSegment[] = [];
    let acc = `\\\\${parts[0]}\\${parts[1]}`;
    segments.push({ name: acc, path: acc });
    for (const part of parts.slice(2)) {
      acc = `${acc}\\${part}`;
      segments.push({ name: part, path: acc });
    }
    return segments;
  }
  const rooted = normalized.startsWith("\\");
  const parts = normalized.split("\\").filter(Boolean);
  const segments: PathSegment[] = [];
  let acc = "";
  let start = 0;
  if (!rooted && parts.length > 0 && isDrive(parts[0])) {
    acc = `${parts[0]}\\`;
    segments.push({ name: parts[0], path: acc });
    start = 1;
  } else if (rooted) {
    acc = "\\";
    segments.push({ name: "\\", path: acc });
  }
  for (const part of parts.slice(start)) {
    acc = acc === "" ? part : acc.endsWith("\\") ? `${acc}${part}` : `${acc}\\${part}`;
    segments.push({ name: part, path: acc });
  }
  return segments;
}

/// 该向 `fs_list` 请求哪个路径。
///
/// - 跟随模式返回 `null`：让后端按会话记下的 CWD 取，前端不复制「CWD 是什么」的规则。
/// - 固定模式用当前停留的路径；还没导航过就先用一次 CWD 作为起点。
export function panelTarget(
  mode: FilePanelMode,
  followCwd: string | null,
  currentPath: string | null
): string | null {
  if (mode === "follow") return null;
  return currentPath ?? followCwd ?? null;
}

/// 同一目录的两次列目录结果是否完全一样。自动刷新靠它决定要不要重画：
/// 内容没变就什么都不动，滚动位置与选中行不会被 3 秒一次的轮询打断。
export function sameListing(previous: FsListing | null, next: FsListing): boolean {
  if (!previous) return false;
  if (
    previous.path !== next.path ||
    previous.parent !== next.parent ||
    previous.total !== next.total ||
    previous.hidden_count !== next.hidden_count ||
    previous.truncated !== next.truncated ||
    previous.entries.length !== next.entries.length
  ) {
    return false;
  }
  for (let index = 0; index < next.entries.length; index += 1) {
    const a = previous.entries[index];
    const b = next.entries[index];
    if (
      a.name !== b.name ||
      a.kind !== b.kind ||
      a.link !== b.link ||
      a.size !== b.size ||
      a.modified_ms !== b.modified_ms ||
      a.hidden !== b.hidden
    ) {
      return false;
    }
  }
  return true;
}

/// 自动刷新的基础周期：普通目录 3 秒；条目多的目录放慢到 10 秒。
/// 读盘是每条目两次 stat、重绘是整表重建，几千项的目录按 3 秒轮询并不划算。
export const AUTO_REFRESH_MS = 3000;
export const AUTO_REFRESH_SLOW_MS = 10000;
/// 过滤前（含隐藏项）超过这个条目数就按「大目录」放慢。
export const AUTO_REFRESH_SLOW_TOTAL = 1000;

/// 下一次自动刷新等多久：大目录放慢；连续失败时指数退避（最多 24 秒），
/// 免得一个不可读的目录或断开的网络盘每 3 秒重试一次。
export function autoRefreshDelay(total: number, failures: number): number {
  const base = total > AUTO_REFRESH_SLOW_TOTAL ? AUTO_REFRESH_SLOW_MS : AUTO_REFRESH_MS;
  if (failures <= 0) return base;
  return Math.min(base * 2 ** Math.min(failures, 3), 24000);
}

/// 面板宽度的硬边界：太窄看不清名字，太宽会把终端挤到没法用。
export const MIN_PANEL_WIDTH = 140;
export const MAX_PANEL_WIDTH = 560;

/// 拖动分隔条时把宽度夹到合法区间。
/// 上限还要给终端留 `minMain` 像素，窗口很窄时宁可取最小值，由用户自己折叠面板。
export function clampPanelWidth(
  desired: number,
  viewport: number,
  sidebar = 196,
  minMain = 180
): number {
  const room = Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, viewport - sidebar - minMain));
  return Math.max(MIN_PANEL_WIDTH, Math.min(room, Math.round(desired)));
}

/// 右键菜单的一行。原生菜单由系统 Shell 提供；这套项只在 helper 不可用
/// （或环境里弹不出 shell 菜单）时使用，所以它必须覆盖面板最常用的几件事。
export type MenuCommand = "open" | "reveal" | "copy" | "fill" | "refresh";

export interface MenuItem {
  command: MenuCommand;
  label: string;
}

/// 一行的身份：`parent` 是列表顶部的 `..`。
export type RowKind = "parent" | "dir" | "file" | "other";

/// 降级菜单的项与顺序：打开 → 在资源管理器中显示 → 复制路径 →（文件）填入输入条。
/// `..` 行没有「填入输入条」——它不是一个具体文件的路径，填进去没有意义。
/// 文案随当前语言走：这个菜单每次右键都会重新构造，所以不必缓存。
export function rowMenu(kind: RowKind): MenuItem[] {
  const items: MenuItem[] = [
    {
      command: "open",
      label: kind === "file" || kind === "other" ? t("files.openWith") : t("files.open")
    },
    {
      command: "reveal",
      label: kind === "parent" ? t("files.revealParent") : t("files.reveal")
    },
    { command: "copy", label: t("files.copyPath") }
  ];
  if (kind === "file" || kind === "other") {
    items.push({ command: "fill", label: t("files.fill") });
  }
  return items;
}

/// 文件列表空白处的降级菜单：原生 Shell 的背景菜单弹不出来时用它。
/// 打开当前目录 → 在资源管理器中显示 → 复制路径 → 刷新。
export function blankMenu(): MenuItem[] {
  return [
    { command: "open", label: t("files.open") },
    { command: "reveal", label: t("files.reveal") },
    { command: "copy", label: t("files.copyPath") },
    { command: "refresh", label: t("files.refresh") }
  ];
}

/// 菜单与视口边缘的最小间距。
export const MENU_MARGIN = 6;

/// 把菜单夹回视口内：右键点在最右/最下一行时菜单要往左/上翻，
/// 而不是被裁掉一半。尺寸取渲染后的实际大小，所以要先渲染再定位。
export function clampMenuPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number
): { x: number; y: number } {
  const maxX = Math.max(MENU_MARGIN, viewportWidth - width - MENU_MARGIN);
  const maxY = Math.max(MENU_MARGIN, viewportHeight - height - MENU_MARGIN);
  return {
    x: Math.min(Math.max(MENU_MARGIN, Math.round(x)), maxX),
    y: Math.min(Math.max(MENU_MARGIN, Math.round(y)), maxY)
  };
}

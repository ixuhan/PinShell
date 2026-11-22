// 串口列表：功能栏里的一个**只读**面板（ADR 0007）。
//
// 它只观察系统枚举到的端口：不创建会话、不打开端口、没有行程的 ＋ 与右键菜单。
// 串口会话从项目行的「＋」新建，端口在新建会话弹窗里选；这里唯一的状态是
// 「当前焦点串口会话占着哪个口」——由 `setActivePort` 从主程序推过来。

import { invoke } from "@tauri-apps/api/core";
import { clampPanelHeight } from "./rightBar";
import { panelColumnBudget } from "./rightBarUi";
import { parseFolded, serializeFolded, setupFoldPanel } from "./panelFold";
import { dragHeight, DRAGGING_CLASS } from "./resize";
import { createPortPolling, samePorts } from "./serialPortsPanel";
import { portLabel, type SerialPort } from "./sessionDialogUi";
import { onLocaleChange, t } from "./i18n";

const FOLD_KEY = "pinshell.ports.folded";
const HEIGHT_KEY = "pinshell.ports.height";
const DEFAULT_HEIGHT = 180;

export interface SerialPortsPanelHandle {
  /// 焦点串口会话用的端口；终端会话或没有会话时传 null。
  /// 只影响高亮，不改变列表内容——这个面板没有「选中」这个交互状态。
  setActivePort(port: string | null): void;
  dispose(): void;
}

export function setupSerialPortsPanel(): SerialPortsPanelHandle {
  const root = document.getElementById("ports-panel") as HTMLElement;
  const column = document.getElementById("files") as HTMLElement;
  const resizer = document.getElementById("ports-resizer") as HTMLElement;
  const refresh = document.getElementById("ports-refresh") as HTMLButtonElement;
  const autoButton = document.getElementById("ports-auto") as HTMLButtonElement;
  const list = document.getElementById("ports-list") as HTMLElement;
  const status = document.getElementById("ports-status") as HTMLElement;
  const refreshed = document.getElementById("ports-refreshed") as HTMLElement;
  let expanded = true;
  let auto = false;
  let previous: SerialPort[] | null = null;
  let activePort: string | null = null;
  const rows = new Map<string, HTMLDivElement>();
  const storedHeight = Number(localStorage.getItem(HEIGHT_KEY));
  let height = Number.isFinite(storedHeight) && storedHeight > 0 ? storedHeight : DEFAULT_HEIGHT;

  /// 夹取高度：既不超过「可用高度的 70%」，也不把别的定高面板挤到栏底之外。
  /// 可用高度为 0（整栏收起）时 `panelColumnBudget` 会退回窗口高度。
  function clampHeight(desired: number): number {
    const budget = panelColumnBudget(root);
    return clampPanelHeight(Math.min(desired, budget.room), budget.available);
  }

  function applyHeight() {
    height = clampHeight(height);
    root.style.setProperty("--ports-height", `${height}px`);
  }

  /// 面板被取消勾选、整条功能栏收起、窗口隐藏或正在拖布局时不轮询。
  function visible() {
    return (
      expanded &&
      !root.hidden &&
      !column.classList.contains("collapsed") &&
      document.visibilityState === "visible"
    );
  }

  function paintActive() {
    for (const [port, row] of rows) row.classList.toggle("active", port === activePort);
  }

  function render(ports: SerialPort[]) {
    const present = new Set(ports.map((port) => port.port));
    for (const [port, row] of rows) {
      if (!present.has(port)) {
        row.remove();
        rows.delete(port);
      }
    }
    ports.forEach((port, index) => {
      let row = rows.get(port.port);
      if (!row) {
        row = document.createElement("div");
        row.className = "port-row";
        row.dataset.port = port.port;
        const name = document.createElement("span");
        name.className = "port-label";
        row.append(name);
        rows.set(port.port, row);
      }
      row.classList.toggle("active", port.port === activePort);
      row.title = portLabel(port);
      row.querySelector<HTMLElement>(".port-label")!.textContent = portLabel(port);
      const current = list.children[index];
      if (current !== row) list.insertBefore(row, current ?? null);
    });
  }

  function showLastRefresh(now: Date) {
    const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
      .map((part) => String(part).padStart(2, "0"))
      .join(":");
    refreshed.textContent = t("sidebar.portsRefreshed", { time });
    refreshed.dataset.auto = String(auto);
    refreshed.hidden = !auto;
  }

  const polling = createPortPolling({
    canAuto: () => visible() && !document.body.classList.contains(DRAGGING_CLASS),
    read: async () => {
      refresh.disabled = true;
      root.setAttribute("aria-busy", "true");
      if (previous === null) status.textContent = t("sidebar.enumerating");
      try {
        return await invoke<SerialPort[]>("serial_ports");
      } finally {
        refresh.disabled = false;
        root.setAttribute("aria-busy", "false");
      }
    },
    result: (ports) => {
      if (!samePorts(previous, ports)) render(ports);
      previous = ports;
      status.classList.remove("error");
      status.textContent = ports.length
        ? t("sidebar.portsCount", { n: ports.length })
        : t("sidebar.portsEmpty");
      status.title = "";
      showLastRefresh(new Date());
    },
    error: (error) => {
      previous = null;
      status.classList.add("error");
      status.textContent = t("sidebar.portsFailed");
      status.title = String(error);
    }
  });

  for (const button of [refresh, autoButton]) {
    button.addEventListener("mousedown", (event) => event.preventDefault());
  }

  // 标题栏单击折叠：只收起列表，刷新与自动刷新按钮留在标题栏上照常可用
  const fold = setupFoldPanel({
    root,
    toggle: document.getElementById("ports-toggle") as HTMLElement,
    chevron: document.getElementById("ports-chevron"),
    label: t("ports.title"),
    collapsed: parseFolded(localStorage.getItem(FOLD_KEY)),
    onChange: (next) => {
      expanded = !next;
      try {
        localStorage.setItem(FOLD_KEY, serializeFolded(next));
      } catch {
        // 存不下只影响下次打开的默认值
      }
      polling.sync();
      if (expanded && previous === null) void polling.refresh();
    }
  });
  expanded = !fold.collapsed;

  resizer.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !expanded || root.classList.contains("rb-fill")) return;
    event.preventDefault();
    polling.stop();
    dragHeight(event, resizer, {
      edge: "bottom",
      startHeight: root.getBoundingClientRect().height,
      clamp: clampHeight,
      onHeight: (next) => {
        height = next;
        applyHeight();
      },
      onEnd: (next, moved) => {
        height = next;
        if (moved) {
          localStorage.setItem(HEIGHT_KEY, String(next));
        }
        polling.sync();
      }
    });
  });
  resizer.addEventListener("dblclick", () => {
    height = clampHeight(DEFAULT_HEIGHT);
    applyHeight();
    localStorage.setItem(HEIGHT_KEY, String(height));
  });
  refresh.addEventListener("click", () => void polling.refresh());
  autoButton.addEventListener("click", () => {
    auto = !auto;
    autoButton.classList.toggle("on", auto);
    autoButton.setAttribute("aria-pressed", String(auto));
    autoButton.setAttribute("aria-label", t("sidebar.autoPorts"));
    autoButton.title = auto ? t("sidebar.autoPortsOn") : t("sidebar.autoPortsOff");
    refreshed.dataset.auto = String(auto);
    refreshed.hidden = !auto || previous === null;
    polling.setAuto(auto);
  });

  const onVisibility = () => {
    if (auto && visible()) void polling.refresh();
    else polling.sync();
  };
  document.addEventListener("visibilitychange", onVisibility);
  // 三种外部变化都会让「面板还能不能看到」改变：整条功能栏收起（#files 的类）、
  // 面板被设置里取消勾选（hidden 属性）、布局拖动（body 的类）。
  const observer = new MutationObserver(() => {
    polling.sync();
    if (visible() && previous === null && !document.body.classList.contains(DRAGGING_CLASS)) {
      void polling.refresh();
    }
  });
  observer.observe(column, { attributes: true, attributeFilter: ["class"] });
  observer.observe(root, { attributes: true, attributeFilter: ["hidden"] });
  observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  applyHeight();
  if (visible()) void polling.refresh();

  // 语言变了：面板名、行提示、自动刷新的说明都要换
  onLocaleChange(() => {
    const label = root.querySelector(".panel-title");
    if (label) label.textContent = t("ports.title");
    fold.set(fold.collapsed, true);
    if (previous) render(previous);
    autoButton.title = auto ? t("sidebar.autoPortsOn") : t("sidebar.autoPortsOff");
    autoButton.setAttribute("aria-label", t("sidebar.autoPorts"));
    if (previous) {
      status.textContent = previous.length
        ? t("sidebar.portsCount", { n: previous.length })
        : t("sidebar.portsEmpty");
    }
  });

  window.addEventListener("resize", () => {
    if (!expanded) return;
    const next = clampHeight(height);
    if (next === height) return;
    height = next;
    applyHeight();
    localStorage.setItem(HEIGHT_KEY, String(height));
  });

  return {
    setActivePort(port) {
      activePort = port;
      paintActive();
    },
    dispose() {
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      polling.setAuto(false);
    }
  };
}

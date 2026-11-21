import { invoke } from "@tauri-apps/api/core";
import { parseFolded, serializeFolded, setupFoldPanel } from "./panelFold";
import { dragHeight, DRAGGING_CLASS } from "./resize";
import { createPortPolling, samePorts } from "./serialPortsPanel";
import { portLabel, type SerialPort } from "./serialUi";
import { onLocaleChange, t } from "./i18n";
import { showPopupMenu } from "./popupMenu";

const FOLD_KEY = "pinshell.ports.folded";

export interface SerialPortsPanelDeps {
  open(port: string): void;
}

export function setupSerialPortsPanel(deps: SerialPortsPanelDeps) {
  const root = document.getElementById("ports-panel") as HTMLElement;
  const sidebar = document.getElementById("sidebar") as HTMLElement;
  const resizer = document.getElementById("ports-resizer") as HTMLElement;
  const refresh = document.getElementById("ports-refresh") as HTMLButtonElement;
  const autoButton = document.getElementById("ports-auto") as HTMLButtonElement;
  const list = document.getElementById("ports-list") as HTMLElement;
  const status = document.getElementById("ports-status") as HTMLElement;
  const refreshed = document.getElementById("ports-refreshed") as HTMLElement;
  let expanded = true;
  let auto = false;
  let previous: SerialPort[] | null = null;
  let selectedPort: string | null = null;
  const rows = new Map<string, HTMLDivElement>();
  const storedHeight = Number(localStorage.getItem("pinshell.ports.height"));
  let height = Number.isFinite(storedHeight) && storedHeight > 0 ? storedHeight : 180;

  function clampHeight(desired: number): number {
    const max = Math.max(120, Math.floor(window.innerHeight * 0.7));
    return Math.max(120, Math.min(max, Math.round(desired)));
  }

  function applyHeight() {
    root.style.setProperty("--ports-height", `${clampHeight(height)}px`);
  }
  function visible() {
    return expanded && !sidebar.classList.contains("collapsed") &&
      document.visibilityState === "visible";
  }

  function render(ports: SerialPort[]) {
    if (!ports.some((port) => port.port === selectedPort)) selectedPort = null;
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
        const add = document.createElement("button");
        add.type = "button";
        add.className = "port-add";
        add.textContent = "＋";
        row.addEventListener("mousedown", (event) => event.preventDefault());
        row.addEventListener("click", () => selectPort(row!.dataset.port ?? null));
        row.addEventListener("dblclick", () => deps.open(row!.dataset.port ?? ""));
        // 右键：菜单里直接给出「新建串口会话」，不必再去找行尾的小加号
        row.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          const target = row!.dataset.port ?? "";
          selectPort(target);
          showPopupMenu(
            { x: event.clientX, y: event.clientY },
            [
              { label: t("serial.title"), run: () => deps.open(target) },
              { label: t("sidebar.refreshPorts"), run: () => void polling.refresh() }
            ],
            { minWidth: 168 }
          );
        });
        add.addEventListener("click", (event) => {
          event.stopPropagation();
          deps.open(row!.dataset.port ?? "");
        });
        add.addEventListener("dblclick", (event) => event.stopPropagation());
        row.append(name, add);
        rows.set(port.port, row);
      }
      row.classList.toggle("sel", port.port === selectedPort);
      row.title = portLabel(port);
      row.querySelector<HTMLElement>(".port-label")!.textContent = portLabel(port);
      const add = row.querySelector<HTMLButtonElement>(".port-add")!;
      add.title = t("serial.title");
      add.setAttribute("aria-label", add.title);
      const current = list.children[index];
      if (current !== row) list.insertBefore(row, current ?? null);
    });
  }

  /// 串口列表的选中行：同一时刻只有一行带 `sel`。
  function selectPort(port: string | null) {
    selectedPort = port;
    for (const item of rows.values()) item.classList.toggle("sel", item.dataset.port === selectedPort);
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
    label: t("sidebar.serial"),
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
    if (event.button !== 0 || !expanded) return;
    event.preventDefault();
    polling.stop();
    dragHeight(event, resizer, {
      startHeight: root.getBoundingClientRect().height,
      clamp: clampHeight,
      onHeight: (next) => {
        height = next;
        applyHeight();
      },
      onEnd: (next, moved) => {
        height = next;
        if (moved) {
          localStorage.setItem("pinshell.ports.height", String(next));
        }
        polling.sync();
      }
    });
  });
  resizer.addEventListener("dblclick", () => {
    height = 180;
    applyHeight();
    localStorage.setItem("pinshell.ports.height", String(height));
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
  // 左栏收起和任意布局拖动都可能让轮询暂停，结束后重新计时。
  const observer = new MutationObserver(() => {
    polling.sync();
    if (visible() && previous === null && !document.body.classList.contains(DRAGGING_CLASS)) {
      void polling.refresh();
    }
  });
  observer.observe(sidebar, { attributes: true, attributeFilter: ["class"] });
  observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  applyHeight();
  if (visible()) void polling.refresh();

  // 语言变了：面板名、行提示、自动刷新的说明都要换
  onLocaleChange(() => {
    const label = root.querySelector(".panel-title");
    if (label) label.textContent = t("sidebar.serial");
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
    localStorage.setItem("pinshell.ports.height", String(height));
  });

  return {
    dispose() {
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      polling.setAuto(false);
    }
  };
}

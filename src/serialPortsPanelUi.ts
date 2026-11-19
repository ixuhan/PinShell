import { invoke } from "@tauri-apps/api/core";
import { dragHeight, DRAGGING_CLASS } from "./resize";
import { createPortPolling, samePorts } from "./serialPortsPanel";
import { portLabel, type SerialPort } from "./serialUi";

export interface SerialPortsPanelDeps {
  open(port: string): void;
}

export function setupSerialPortsPanel(deps: SerialPortsPanelDeps) {
  const root = document.getElementById("ports-panel") as HTMLElement;
  const sidebar = document.getElementById("sidebar") as HTMLElement;
  const toggle = document.getElementById("ports-toggle") as HTMLButtonElement;
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
        row.addEventListener("click", () => {
          selectedPort = row!.dataset.port ?? null;
          for (const item of rows.values()) {
            item.classList.toggle("sel", item.dataset.port === selectedPort);
          }
        });
        row.addEventListener("dblclick", () => deps.open(row!.dataset.port!));
        add.addEventListener("click", (event) => {
          event.stopPropagation();
          deps.open(row!.dataset.port!);
        });
        add.addEventListener("dblclick", (event) => event.stopPropagation());
        row.append(name, add);
        rows.set(port.port, row);
      }
      row.classList.toggle("sel", port.port === selectedPort);
      row.title = portLabel(port);
      row.querySelector<HTMLElement>(".port-label")!.textContent = portLabel(port);
      const add = row.querySelector<HTMLButtonElement>(".port-add")!;
      add.title = `新建 ${port.port} 串口会话`;
      add.setAttribute("aria-label", add.title);
      const current = list.children[index];
      if (current !== row) list.insertBefore(row, current ?? null);
    });
  }

  function showLastRefresh(now: Date) {
    const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
      .map((part) => String(part).padStart(2, "0"))
      .join(":");
    refreshed.textContent = `刷新于：${time}`;
    refreshed.dataset.auto = String(auto);
    refreshed.hidden = !auto;
  }

  const polling = createPortPolling({
    canAuto: () => visible() && !document.body.classList.contains(DRAGGING_CLASS),
    read: async () => {
      refresh.disabled = true;
      root.setAttribute("aria-busy", "true");
      if (previous === null) status.textContent = "正在枚举串口…";
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
      status.textContent = ports.length ? `${ports.length} 个端口` : "没有枚举到串口";
      status.title = "";
      showLastRefresh(new Date());
    },
    error: (error) => {
      previous = null;
      status.classList.add("error");
      status.textContent = "枚举串口失败";
      status.title = String(error);
    }
  });

  for (const button of [toggle, refresh, autoButton]) {
    button.addEventListener("mousedown", (event) => event.preventDefault());
  }
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
  toggle.addEventListener("click", () => {
    expanded = !expanded;
    root.classList.toggle("collapsed", !expanded);
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.title = expanded ? "收起串口面板" : "展开串口面板";
    polling.sync();
    if (expanded && previous === null) void polling.refresh();
  });
  refresh.addEventListener("click", () => void polling.refresh());
  autoButton.addEventListener("click", () => {
    auto = !auto;
    autoButton.classList.toggle("on", auto);
    autoButton.setAttribute("aria-pressed", String(auto));
    autoButton.title = auto ? "自动刷新已开：每 1 秒枚举一次，点一下关闭" : "自动刷新：每 1 秒枚举一次";
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

import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import { hasWebglRoom } from "./webglBudget";

/**
 * 每个会话一套终端的视图池。
 *
 * 三条边界写死在这里：
 * 1. `hostEl` 是持久的：布局切分/合并/交换只搬这个节点，**绝不对同一个 Terminal 再调
 *    `open()`**（xterm 的 open 只准备一次 DOM，重复调用会丢渲染器）。
 * 2. WebGL 按**可见**分格分配：隐藏时卸载上下文，重新可见再挂；超预算直接留在
 *    DOM 渲染器，不按 canvas API 写（xterm 6 没有 @xterm/addon-canvas）。
 * 3. 视图不负责 `fit()`：尺寸由调用方在「确认可见」之后统一算，`display:none` 下量到 0
 *    会把错误的 cols/rows 发给 PTY。
 */

export interface TerminalView {
  id: string;
  term: Terminal;
  fit: FitAddon;
  /// 查找插件。命中高亮、命中计数与「当前是第几个」都从这里来；
  /// 与 Terminal 同生命周期，`term.dispose()` 时一起释放。
  search: SearchAddon;
  hostEl: HTMLDivElement;
  webgl: WebglAddon | null;
  visible: boolean;
  /** 每次整屏重建 +1；回放回来时对不上就说明中间又切走了，丢弃这份过期内容。 */
  replayGen: number;
  fontSize: number;
  /** 是否把裸 `\n` 也当成「回车 + 换行」（串口需要，见 `attach` 注释）。 */
  convertEol: boolean;
}

export interface TerminalPoolOptions {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorBlink: boolean;
  scrollback: number;
  theme: () => ITheme;
  /** 全局关掉 WebGL 时一律不挂上下文，直接走 DOM 渲染器。 */
  webglEnabled: boolean;
  onData: (id: string, data: string) => void;
  onBell?: (id: string) => void;
  /** 视图里的终端拿到 DOM 焦点时上报，让应用层把上下文切到该会话。 */
  onFocus?: (id: string) => void;
}

export class TerminalPool {
  private readonly options: TerminalPoolOptions;
  private readonly views = new Map<string, TerminalView>();
  private readonly webglIds = new Set<string>();

  constructor(options: TerminalPoolOptions) {
    this.options = options;
  }

  view(id: string): TerminalView | null {
    return this.views.get(id) ?? null;
  }

  all(): TerminalView[] {
    return [...this.views.values()];
  }

  /** 把一个会话的视图挂到格子里。已存在就只搬节点，不重建 Terminal。
   *
   *  `convertEol`：串口会话传 `true`。串口设备（尤其是嵌入式/Linux 板子）经常
   *  只吐裸 `\n` 当行尾——真终端和 xterm 的默认语义是「只下移一行、列不动」，
   *  于是屏幕上每一行都从上一行结尾处接着写（阶梯状、看着像没换行），
   *  但同一个 `\n` 在日志文件里就是标准的换行。开启后 xterm 收到 `\n` 会先
   *  回到列首再下移，屏幕和文件才对得上。终端会话保持默认（ConPTY 自己发 CRLF，
   *  全屏程序也依赖裸 LF 的原始语义）。 */
  attach(id: string, container: HTMLElement, visible: boolean, convertEol = false): TerminalView {
    let view = this.views.get(id);
    if (!view) {
      view = this.create(id, container, convertEol);
    } else if (view.hostEl.parentElement !== container) {
      container.append(view.hostEl);
    }
    if (view.convertEol !== convertEol) {
      view.convertEol = convertEol;
      view.term.options.convertEol = convertEol;
    }
    this.setVisible(id, visible);
    return view;
  }

  /** 可见性变化影响 WebGL；fit 由调用方负责。
   *  可见时总是尝试补装上下文：上次可能因为预算满了没装上，空出名额后要能补。 */
  setVisible(id: string, visible: boolean): void {
    const view = this.views.get(id);
    if (!view) return;
    if (view.visible !== visible) view.visible = visible;
    if (visible) {
      this.mountWebgl(view);
    } else {
      this.unmountWebgl(view);
      // 释放出来的名额让给还没上 WebGL 的可见格，避免它们永久停在 DOM 渲染器
      this.rebalanceWebgl();
    }
  }

  focus(id: string): void {
    this.views.get(id)?.term.focus();
  }

  setFontSize(id: string, size: number): void {
    const view = this.views.get(id);
    if (!view || view.fontSize === size) return;
    view.fontSize = size;
    view.term.options.fontSize = size;
  }

  applyTheme(): void {
    const theme = this.options.theme();
    for (const view of this.views.values()) {
      view.term.options.theme = theme;
    }
  }

  /** 销毁视图：卸载 WebGL、释放 Terminal、移走宿主节点。四条关闭路径都必须走到这里。 */
  dispose(id: string): void {
    const view = this.views.get(id);
    if (!view) return;
    this.unmountWebgl(view);
    view.term.dispose();
    view.hostEl.remove();
    this.views.delete(id);
    // 关掉一格会空出一个上下文名额：让还停在 DOM 渲染器的可见格补上
    this.rebalanceWebgl();
  }

  disposeAll(): void {
    for (const id of [...this.views.keys()]) this.dispose(id);
  }

  private create(id: string, container: HTMLElement, convertEol: boolean): TerminalView {
    const term = new Terminal({
      fontFamily: this.options.fontFamily,
      fontSize: this.options.fontSize,
      lineHeight: this.options.lineHeight,
      cursorBlink: this.options.cursorBlink,
      scrollback: this.options.scrollback,
      convertEol,
      theme: this.options.theme(),
      allowProposedApi: true
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // 查找是只读的显示能力：不进「能力位」，终端与串口一视同仁（见 docs/find.md）
    const search = new SearchAddon();
    term.loadAddon(search);

    const hostEl = document.createElement("div");
    hostEl.className = "term-view";
    hostEl.dataset.sessionId = id;
    // 点击终端主体时只有 DOM 焦点会转移（xterm 自己聚焦 textarea），应用层的
    // 焦点 ids 不会跟着变。focusin 冒泡到这个持久节点，在这里统一上报。
    hostEl.addEventListener("focusin", () => this.options.onFocus?.(id));
    // 先进 DOM 再 open：xterm 的渲染器要量尺寸，脱离文档的节点会量到 0
    container.append(hostEl);
    term.open(hostEl);

    term.onData((data) => this.options.onData(id, data));
    term.onBell(() => this.options.onBell?.(id));

    const view: TerminalView = {
      id,
      term,
      fit,
      search,
      hostEl,
      webgl: null,
      visible: false,
      replayGen: 0,
      fontSize: this.options.fontSize,
      convertEol
    };
    this.views.set(id, view);
    return view;
  }

  private mountWebgl(view: TerminalView): void {
    if (view.webgl) return;
    if (!this.options.webglEnabled) return;
    // 按可见数量分配，而不是创建顺序：隐藏的格子不占上下文
    if (!hasWebglRoom(this.webglIds.size)) return;
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => {
        // 上下文被驱动或浏览器回收：退回 DOM 渲染器，别让整格白屏
        addon.dispose();
        view.webgl = null;
        this.webglIds.delete(view.id);
      });
      view.term.loadAddon(addon);
      view.webgl = addon;
      this.webglIds.add(view.id);
    } catch {
      view.webgl = null;
      this.webglIds.delete(view.id);
    }
  }

  private unmountWebgl(view: TerminalView): void {
    if (!view.webgl) return;
    view.webgl.dispose();
    view.webgl = null;
    this.webglIds.delete(view.id);
  }

  /** 名额空出来后，按视图创建顺序给还没装上下文、但当前可见的格子补装。 */
  private rebalanceWebgl(): void {
    if (!this.options.webglEnabled) return;
    for (const view of this.views.values()) {
      if (!hasWebglRoom(this.webglIds.size)) return;
      if (view.visible && !view.webgl) this.mountWebgl(view);
    }
  }
}

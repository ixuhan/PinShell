// 主题：九套配色。
//
// 配色本身全在 `styles.css` 的 CSS 变量里（`:root` 是暗黑，其余按
// `html[data-theme="…"]` 覆盖）；这里只负责三件事：读写偏好、把 `data-theme`
// 挂到 `<html>` 上、以及给 xterm 一份配套的终端配色——终端是 canvas 画的，
// 读不到 CSS 变量。
//
// `THEMES` 的顺序就是设置下拉里的顺序：先四套暗色，再五套亮色。

export type Theme =
  | "dark"
  | "midnight"
  | "ember"
  | "nord"
  | "cream"
  | "sand"
  | "bright"
  | "mist"
  | "paper";

/// 设置里的展示顺序，也是 `parseTheme` 的白名单。
export const THEMES: readonly Theme[] = [
  "dark",
  "midnight",
  "ember",
  "nord",
  "cream",
  "sand",
  "bright",
  "mist",
  "paper"
];

/// 亮色主题：要写 `color-scheme: light`，否则原生滚动条和表单控件还是深色的。
const LIGHT_THEMES: readonly Theme[] = ["cream", "sand", "bright", "mist", "paper"];

export function isLight(theme: Theme): boolean {
  return LIGHT_THEMES.includes(theme);
}

export const THEME_KEY = "pinshell.theme";

/// 兼容旧值：早期只有 `light`（乳白），读到它按乳白处理。
export function parseTheme(raw: string | null): Theme {
  if (raw === "light") return "cream";
  return THEMES.find((theme) => theme === raw) ?? "dark";
}

export function readTheme(): Theme {
  try {
    return parseTheme(localStorage.getItem(THEME_KEY));
  } catch {
    return "dark";
  }
}

export function saveTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // 存不下只影响下次启动的默认值
  }
}

/// xterm 的配色。与 CSS 变量同源：底色 = `--bg-app`，前景 = `--text-strong`。
const XTERM_THEMES: Record<Theme, Record<string, string>> = {
  dark: {
    background: "#0b0e14",
    foreground: "#e8eef7",
    cursor: "#46d19a",
    cursorAccent: "#0b0e14",
    selectionBackground: "#26405c",
    black: "#0b0e14",
    red: "#e35d6a",
    green: "#46d19a",
    yellow: "#d6a34a",
    blue: "#56b4ff",
    magenta: "#c58af9",
    cyan: "#4fd1c5",
    white: "#d7e3f0",
    brightBlack: "#65758c",
    brightRed: "#ff7b88",
    brightGreen: "#70d6a6",
    brightYellow: "#f0c477",
    brightBlue: "#9fd3ff",
    brightMagenta: "#d8b4fe",
    brightCyan: "#7de0d6",
    brightWhite: "#ffffff"
  },
  midnight: {
    background: "#10121a",
    foreground: "#ccd6ec",
    cursor: "#6ea8ff",
    cursorAccent: "#10121a",
    selectionBackground: "#2a3a55",
    black: "#10121a",
    red: "#f07178",
    green: "#9ece6a",
    yellow: "#e0af68",
    blue: "#7aa2f7",
    magenta: "#bb9af7",
    cyan: "#7dcfff",
    white: "#c7d0e0",
    brightBlack: "#7883a0",
    brightRed: "#ff8b92",
    brightGreen: "#b9f27c",
    brightYellow: "#f3cb85",
    brightBlue: "#9cc0ff",
    brightMagenta: "#d0b0ff",
    brightCyan: "#a3e2ff",
    brightWhite: "#ffffff"
  },
  ember: {
    background: "#17130f",
    foreground: "#ded0bf",
    cursor: "#e8a95f",
    cursorAccent: "#17130f",
    selectionBackground: "#3e2c1c",
    black: "#17130f",
    red: "#e8695f",
    green: "#a3be8c",
    yellow: "#e8c07a",
    blue: "#86bcd8",
    magenta: "#c08db0",
    cyan: "#8ecfc6",
    white: "#d8cbbb",
    brightBlack: "#93816d",
    brightRed: "#ff8175",
    brightGreen: "#b8d0a2",
    brightYellow: "#f5d79c",
    brightBlue: "#9cc4e0",
    brightMagenta: "#d9a8c8",
    brightCyan: "#9fd2c9",
    brightWhite: "#fff8f1"
  },
  nord: {
    background: "#262b35",
    foreground: "#d8dee9",
    cursor: "#88c0d0",
    cursorAccent: "#262b35",
    selectionBackground: "#3b4a61",
    black: "#262b35",
    red: "#bf616a",
    green: "#a3be8c",
    yellow: "#ebcb8b",
    blue: "#81a1c1",
    magenta: "#b48ead",
    cyan: "#88c0d0",
    white: "#e5e9f0",
    brightBlack: "#8993a2",
    brightRed: "#d77b83",
    brightGreen: "#b8d0a2",
    brightYellow: "#f3d9a0",
    brightBlue: "#93b0cc",
    brightMagenta: "#c6a1bf",
    brightCyan: "#9fd0dd",
    brightWhite: "#eceff4"
  },
  cream: {
    background: "#f6f1e7",
    foreground: "#2a2620",
    cursor: "#1f7a55",
    cursorAccent: "#f6f1e7",
    selectionBackground: "#cfe0d3",
    black: "#2a2620",
    red: "#b3353f",
    green: "#1f7a55",
    yellow: "#8a6216",
    blue: "#1d5fa8",
    magenta: "#8b4a9c",
    cyan: "#166f74",
    white: "#4a443a",
    brightBlack: "#7c7466",
    brightRed: "#c94a53",
    brightGreen: "#2c9468",
    brightYellow: "#a8791f",
    brightBlue: "#2f78c4",
    brightMagenta: "#a563b5",
    brightCyan: "#1f8a90",
    brightWhite: "#2a2620"
  },
  sand: {
    background: "#ece6da",
    foreground: "#241f18",
    cursor: "#2f6e63",
    cursorAccent: "#ece6da",
    selectionBackground: "#ccdacf",
    black: "#241f18",
    red: "#a8342f",
    green: "#2f6e63",
    yellow: "#7d5a16",
    blue: "#2a6094",
    magenta: "#7c4a80",
    cyan: "#216b70",
    white: "#4a4336",
    brightBlack: "#6f6759",
    brightRed: "#bf4a44",
    brightGreen: "#3a8377",
    brightYellow: "#94701f",
    brightBlue: "#3574ad",
    brightMagenta: "#925a96",
    brightCyan: "#2b8187",
    brightWhite: "#17140f"
  },
  bright: {
    background: "#ffffff",
    foreground: "#161b22",
    cursor: "#16805c",
    cursorAccent: "#ffffff",
    selectionBackground: "#cfe3f7",
    black: "#161b22",
    red: "#c02a35",
    green: "#16805c",
    yellow: "#9a6c12",
    blue: "#1763b0",
    magenta: "#8b3fa8",
    cyan: "#10707f",
    white: "#3c4552",
    brightBlack: "#76818f",
    brightRed: "#d93a45",
    brightGreen: "#1f9a70",
    brightYellow: "#b8801a",
    brightBlue: "#2a7cc9",
    brightMagenta: "#a355bd",
    brightCyan: "#178b9a",
    brightWhite: "#0b0f14"
  },
  mist: {
    background: "#f4f6f8",
    foreground: "#1a222b",
    cursor: "#1a7f9e",
    cursorAccent: "#f4f6f8",
    selectionBackground: "#cfe0ee",
    black: "#1a222b",
    red: "#b3353b",
    green: "#1d7a5a",
    yellow: "#7d5a10",
    blue: "#1a5f9e",
    magenta: "#7d4497",
    cyan: "#146b78",
    white: "#4a5560",
    brightBlack: "#6d7985",
    brightRed: "#c9464c",
    brightGreen: "#25946e",
    brightYellow: "#95701a",
    brightBlue: "#2673b8",
    brightMagenta: "#9554ae",
    brightCyan: "#1c8291",
    brightWhite: "#101820"
  },
  paper: {
    background: "#fdfcf9",
    foreground: "#12100c",
    cursor: "#27527f",
    cursorAccent: "#fdfcf9",
    selectionBackground: "#dae3ee",
    black: "#12100c",
    red: "#a02527",
    green: "#1f6b4a",
    yellow: "#77540f",
    blue: "#27527f",
    magenta: "#6f3d7a",
    cyan: "#1a6470",
    white: "#3f3a31",
    brightBlack: "#6d675c",
    brightRed: "#b83334",
    brightGreen: "#268459",
    brightYellow: "#8e6716",
    brightBlue: "#326a9e",
    brightMagenta: "#854a90",
    brightCyan: "#217c8a",
    brightWhite: "#000000"
  }
};

export function xtermTheme(theme: Theme): Record<string, string> {
  return { ...XTERM_THEMES[theme] };
}

/// 把主题挂到 `<html data-theme>` 上；样式按这个属性选变量。
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  // 原生滚动条与表单控件跟着走，否则浅色主题里会冒出深色滚动条
  document.documentElement.style.colorScheme = isLight(theme) ? "light" : "dark";
}

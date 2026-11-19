/// 不同传输通道的清屏显示策略。
///
/// 终端通道需要保留 Shell 当前提示行；串口通道没有提示符，必须连当前活动行
/// 一起清掉，否则 xterm 会把断开前最后收到的字符留在屏幕上。
export type ClearDisplayMode = "preserve-current-line" | "reset";

export function clearDisplayMode(transport: "terminal" | "serial"): ClearDisplayMode {
  return transport === "serial" ? "reset" : "preserve-current-line";
}

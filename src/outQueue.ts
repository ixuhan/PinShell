/// 输出队列的纯规则：清屏之后，哪些块还该画。
///
/// 块带会话内递增的 `seq`。清屏时后端交回「清空前的最后序号」，前端把它记成下限：
/// 序号不大于下限的块属于被清掉的那块屏幕，即使它们还在 IPC 路上、或者已经排进队里，
/// 也不能再画到空屏上（否则清屏后会冒出一截旧内容）。
export interface OutChunk {
  seq: number;
  data: string;
}

export interface KeptChunks {
  /// 按到达顺序拼好的文本
  parts: string[];
  /// 保留块里的最大序号；没有保留任何块时为 0
  lastSeq: number;
}

/// 丢掉 `seq <= floor` 的块，其余按原顺序留下。
export function keepAfter(chunks: readonly OutChunk[], floor: number): KeptChunks {
  const parts: string[] = [];
  let lastSeq = 0;
  for (const chunk of chunks) {
    if (chunk.seq <= floor) continue;
    parts.push(chunk.data);
    if (chunk.seq > lastSeq) lastSeq = chunk.seq;
  }
  return { parts, lastSeq };
}

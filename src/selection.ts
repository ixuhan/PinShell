// 列表多选的纯逻辑：全选、反选、勾选切换与失效项清理。
//
// 会话与快捷指令的批量操作共用这一套：列表本身在两边各自画，但「选了哪些」
// 只是 id 的集合运算，放这里就能单独测，不用把 DOM 拖进测试。

/// 点一项：已选则取消，未选则加上。返回新集合，调用方整体替换，避免共享引用。
export function toggleId(selected: Set<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export function selectAllIds(ids: Iterable<string>): Set<string> {
  return new Set(ids);
}

/// 反选：只保留「当前列表里有、但原来没选中」的项。
export function invertIds(selected: Set<string>, ids: Iterable<string>): Set<string> {
  const next = new Set<string>();
  for (const id of ids) if (!selected.has(id)) next.add(id);
  return next;
}

/// 刷新列表后把已经不存在的 id 剔掉：删除、新建、切会话都会走这一步。
export function pruneIds(selected: Set<string>, ids: Iterable<string>): Set<string> {
  const live = new Set(ids);
  const next = new Set<string>();
  for (const id of selected) if (live.has(id)) next.add(id);
  return next;
}

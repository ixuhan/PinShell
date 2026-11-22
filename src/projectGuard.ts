/**
 * 项目异步操作的守卫规则。
 *
 * 打开项目会异步拉起多个终端格；期间用户可能切到别的项目。
 * 每次 await 回来都要用同一组条件判断「这次回调还有没有资格改主区」，
 * 放在这里是为了能用单测挡住「旧项目把视图挂进当前主区」这类回归。
 */

export function isProjectOpenCurrent(
  token: number,
  currentToken: number,
  activeProjectId: string | null,
  projectId: string
): boolean {
  return token === currentToken && activeProjectId === projectId;
}

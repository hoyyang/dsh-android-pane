/**
 * dsh-android-pane 停靠租约：右列占位经 DSH root margin-right 实现（机制同 dsh-ios 253★ 验证方案）。
 * DSH root 是 auto-width 块 → margin-right 收窄 AppFrame 栅格腾出真实布局空间，而不是遮盖会话。
 * 租约归属记在 root dataset；release 恢复原 inline 值（HMR/重载兼容）；
 * 他人已持租约时 claim 失败返回 undefined（调用方降级浮窗形态）。
 */
export const DAP_DOCK_ATTR = 'dapDockOwner'
export const DAP_DOCK_OWNER = 'dsh-android-pane'

export interface DockLease {
  update(width: number): void
  release(): void
}

export function claimRootDock(
  root: HTMLElement,
  owner: string,
  width: number,
  computedMarginRight = 0,
): DockLease | undefined {
  const existing = root.dataset[DAP_DOCK_ATTR]
  // 已有其他插件（如 openpencil workbench dock）持有 margin 租约 → 不抢，降级浮窗
  if (existing !== undefined && existing !== owner) return undefined
  // 无主但 root 已有非零 margin（用户自定义样式）→ 同样不碰
  if (
    existing === undefined &&
    (root.style.marginRight.trim() !== '' ||
      (Number.isFinite(computedMarginRight) && computedMarginRight > 0.5))
  ) {
    return undefined
  }
  const prevMargin = root.style.marginRight
  const prevMinWidth = root.style.minWidth
  root.dataset[DAP_DOCK_ATTR] = owner
  root.style.minWidth = '0'
  let released = false
  const update = (w: number): void => {
    if (released || root.dataset[DAP_DOCK_ATTR] !== owner) return
    root.style.marginRight = `${Math.max(0, Math.round(w))}px`
  }
  const release = (): void => {
    if (released) return
    released = true
    if (root.dataset[DAP_DOCK_ATTR] !== owner) return
    root.style.marginRight = prevMargin
    root.style.minWidth = prevMinWidth
    delete root.dataset[DAP_DOCK_ATTR]
  }
  update(width)
  return { update, release }
}

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

/** 右侧邻列：dsh-project-manager 的卡片详情列（body 上的 fixed 右列，right:0）。
 *  面板要贴在它左边，四列才排成「会话 | 右侧边栏 | 面板 | 卡片详情」。
 *  认的是类名 —— 对方改名/不存在 = 恒返回 0 = 面板退回贴最右（功能不坏，只是会被详情盖住）。 */
const NEIGHBOR_SEL = '.dpm-global-detail'

/** 盯邻列，把「面板右边缘应让出的距离」回调出去；返回取消函数。
 *  dsh-project-manager 发 dpm:columns 时以它为准（它统一排全部列）；没有这个事件（旧版 / 没装）就自己量详情列。
 *  详情开/关、拖宽、隐藏（data-dpm-gd="away"）、窗口缩放都实时跟随（事件驱动，不轮询）。 */
export function watchRightNeighbor(apply: (rightPx: number, led?: { width: number; away: boolean }) => void): () => void {
  let det: HTMLElement | null = null
  let ro: ResizeObserver | null = null
  let attrs: MutationObserver | null = null
  let raf = 0
  let dead = false
  let led = false
  const measure = (): number => {
    if (det == null || det.hidden || det.getAttribute('data-dpm-gd') === 'away') return 0
    const r = det.getBoundingClientRect()
    // 已移出视口 / 没宽度 = 没占位，让出 0
    if (r.width <= 0 || r.left >= window.innerWidth) return 0
    return Math.max(0, Math.round(window.innerWidth - r.left))
  }
  const run = (): void => {
    raf = 0
    if (!dead && !led) apply(measure())
  }
  const soon = (): void => {
    if (!dead && raf === 0) raf = requestAnimationFrame(run)
  }
  /** 详情列懒创建（首次打开详情才 append 到 body）→ body 直接子节点变化就重新认一次。 */
  const bind = (): void => {
    const next = document.querySelector<HTMLElement>(NEIGHBOR_SEL)
    if (next === det) {
      soon()
      return
    }
    ro?.disconnect()
    attrs?.disconnect()
    det = next
    if (det != null) {
      ro = new ResizeObserver(soon)
      ro.observe(det)
      attrs = new MutationObserver(soon)
      attrs.observe(det, { attributes: true, attributeFilter: ['style', 'hidden', 'data-dpm-gd'] })
    }
    soon()
  }
  /* dsh-project-manager 0.57+ 有一个排版引擎管全部列（每日任务面板 | 卡片详情 | DSH 右侧栏 | Android），
     它发 dpm:columns 告诉我们该贴的 right（或叠放 away）；收到过就只听它，不再自己量详情（详情不在最右时量出来是错的）。 */
  const onCols = (e: Event): void => {
    const d = (e as CustomEvent<{ ap?: { right?: number; width?: number; away?: boolean } | null } | null>).detail
    if (d == null) { led = false; soon(); return }
    led = true
    const ap = d.ap
    if (!dead) apply(ap && !ap.away && typeof ap.right === 'number' ? Math.max(0, Math.round(ap.right)) : 0, { width: ap && !ap.away && typeof ap.width === 'number' ? Math.round(ap.width) : 0, away: !!ap?.away })
  }
  window.addEventListener('dpm:columns', onCols)
  const bodyMo = new MutationObserver(bind)
  bodyMo.observe(document.body, { childList: true })
  window.addEventListener('resize', soon)
  bind()
  return () => {
    dead = true
    window.removeEventListener('dpm:columns', onCols)
    bodyMo.disconnect()
    ro?.disconnect()
    attrs?.disconnect()
    window.removeEventListener('resize', soon)
    if (raf !== 0) cancelAnimationFrame(raf)
  }
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

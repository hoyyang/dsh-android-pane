/**
 * dsh-android-pane 停靠租约：右列占位经 DSH root margin-right 实现（机制同 dsh-ios 253★ 验证方案）。
 * DSH root 是 auto-width 块 → margin-right 收窄 AppFrame 栅格腾出真实布局空间，而不是遮盖会话。
 * 租约归属记在 root dataset；release 恢复原 inline 值（HMR/重载兼容）；
 * 他人已持租约时 claim 失败返回 undefined（调用方降级浮窗形态）。
 */
export const DAP_DOCK_ATTR = 'dapDockOwner';
export const DAP_DOCK_OWNER = 'dsh-android-pane';
/** 右侧邻列：dsh-project-manager 的卡片详情列（body 上的 fixed 右列，right:0）。
 *  面板要贴在它左边，四列才排成「会话 | 右侧边栏 | 面板 | 卡片详情」。
 *  认的是类名 —— 对方改名/不存在 = 恒返回 0 = 面板退回贴最右（功能不坏，只是会被详情盖住）。 */
const NEIGHBOR_SEL = '.dpm-global-detail';
/** 盯邻列，把「面板右边缘应让出的距离」回调出去；返回取消函数。
 *  详情开/关、拖宽、隐藏（data-dpm-gd="away"）、窗口缩放都实时跟随（事件驱动，不轮询）。 */
export function watchRightNeighbor(apply) {
    let det = null;
    let ro = null;
    let attrs = null;
    let raf = 0;
    let dead = false;
    const measure = () => {
        if (det == null || det.hidden || det.getAttribute('data-dpm-gd') === 'away')
            return 0;
        const r = det.getBoundingClientRect();
        // 已移出视口 / 没宽度 = 没占位，让出 0
        if (r.width <= 0 || r.left >= window.innerWidth)
            return 0;
        return Math.max(0, Math.round(window.innerWidth - r.left));
    };
    const run = () => {
        raf = 0;
        if (!dead)
            apply(measure());
    };
    const soon = () => {
        if (!dead && raf === 0)
            raf = requestAnimationFrame(run);
    };
    /** 详情列懒创建（首次打开详情才 append 到 body）→ body 直接子节点变化就重新认一次。 */
    const bind = () => {
        const next = document.querySelector(NEIGHBOR_SEL);
        if (next === det) {
            soon();
            return;
        }
        ro?.disconnect();
        attrs?.disconnect();
        det = next;
        if (det != null) {
            ro = new ResizeObserver(soon);
            ro.observe(det);
            attrs = new MutationObserver(soon);
            attrs.observe(det, { attributes: true, attributeFilter: ['style', 'hidden', 'data-dpm-gd'] });
        }
        soon();
    };
    const bodyMo = new MutationObserver(bind);
    bodyMo.observe(document.body, { childList: true });
    window.addEventListener('resize', soon);
    bind();
    return () => {
        dead = true;
        bodyMo.disconnect();
        ro?.disconnect();
        attrs?.disconnect();
        window.removeEventListener('resize', soon);
        if (raf !== 0)
            cancelAnimationFrame(raf);
    };
}
export function claimRootDock(root, owner, width, computedMarginRight = 0) {
    const existing = root.dataset[DAP_DOCK_ATTR];
    // 已有其他插件（如 openpencil workbench dock）持有 margin 租约 → 不抢，降级浮窗
    if (existing !== undefined && existing !== owner)
        return undefined;
    // 无主但 root 已有非零 margin（用户自定义样式）→ 同样不碰
    if (existing === undefined &&
        (root.style.marginRight.trim() !== '' ||
            (Number.isFinite(computedMarginRight) && computedMarginRight > 0.5))) {
        return undefined;
    }
    const prevMargin = root.style.marginRight;
    const prevMinWidth = root.style.minWidth;
    root.dataset[DAP_DOCK_ATTR] = owner;
    root.style.minWidth = '0';
    let released = false;
    const update = (w) => {
        if (released || root.dataset[DAP_DOCK_ATTR] !== owner)
            return;
        root.style.marginRight = `${Math.max(0, Math.round(w))}px`;
    };
    const release = () => {
        if (released)
            return;
        released = true;
        if (root.dataset[DAP_DOCK_ATTR] !== owner)
            return;
        root.style.marginRight = prevMargin;
        root.style.minWidth = prevMinWidth;
        delete root.dataset[DAP_DOCK_ATTR];
    };
    update(width);
    return { update, release };
}
//# sourceMappingURL=dock.js.map
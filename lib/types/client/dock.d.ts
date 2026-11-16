/**
 * dsh-android-pane 停靠租约：右列占位经 DSH root margin-right 实现（机制同 dsh-ios 253★ 验证方案）。
 * DSH root 是 auto-width 块 → margin-right 收窄 AppFrame 栅格腾出真实布局空间，而不是遮盖会话。
 * 租约归属记在 root dataset；release 恢复原 inline 值（HMR/重载兼容）；
 * 他人已持租约时 claim 失败返回 undefined（调用方降级浮窗形态）。
 */
export declare const DAP_DOCK_ATTR = "dapDockOwner";
export declare const DAP_DOCK_OWNER = "dsh-android-pane";
export interface DockLease {
    update(width: number): void;
    release(): void;
}
/** 盯邻列，把「面板右边缘应让出的距离」回调出去；返回取消函数。
 *  dsh-project-manager 发 dpm:columns 时以它为准（它统一排全部列）；没有这个事件（旧版 / 没装）就自己量详情列。
 *  详情开/关、拖宽、隐藏（data-dpm-gd="away"）、窗口缩放都实时跟随（事件驱动，不轮询）。 */
export declare function watchRightNeighbor(apply: (rightPx: number, led?: {
    width: number;
    away: boolean;
}) => void): () => void;
export declare function claimRootDock(root: HTMLElement, owner: string, width: number, computedMarginRight?: number): DockLease | undefined;

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
export declare function claimRootDock(root: HTMLElement, owner: string, width: number, computedMarginRight?: number): DockLease | undefined;

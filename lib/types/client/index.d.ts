/**
 * dsh-android-pane client：右侧停靠列（margin-right 租约）+ 浮窗降级 + 侧栏入口。
 * 风格：playful-pop × oat-terracotta（Style Studio 拍板 2026-09-04）——胖圆字、2px 描边、
 * 硬阴影 0 3px 0、果冻 hover、磁吸按钮（magnetic-btn）。跑马灯字带已按用户裁定移除。
 * 两必坑（骨架实测）：apply 用 ctx.slots 必须 export const inject = ['slots']；register 必带 name。
 * 流消费：fetch 流式分帧 [u32 type][u64 pts][u32 len][payload] → WebCodecs VideoDecoder(AnnexB) → canvas；
 * 降级：/stream 不可用（poll 模式）→ <img> 每 600ms 拉 /frame。
 * 手势：pointer 事件 → 设备物理坐标 → POST /act（agent 忙碌时 409 → 提示等徽标）。
 */
import { createElement as h, Component } from 'react';
type Rec = Record<string, unknown>;
interface MitigateView {
    pixelPossible: boolean;
    steps: Array<{
        step: string;
        status: string;
        detail: string;
    }>;
    checkedAt: number;
}
interface OutlineNode {
    text: string;
    desc: string;
    cls: string;
    clickable: boolean;
    center: [number, number];
    depth: number;
}
interface DeviceRow {
    serial: string;
    state: string;
    model: string | null;
    name?: string;
    isEmulator: boolean;
    claimedBy: string | null;
    busy: boolean;
    mode: 'h264' | 'poll' | null;
}
type PaneForm = 'dock' | 'overlay';
interface PaneWindowState {
    open: boolean;
    form: PaneForm;
    serial: string | null;
    devices: DeviceRow[];
    busy: boolean;
    claimsSeen: boolean;
    mode: 'h264' | 'poll' | null;
    error: string | null;
    streamError: string | null;
    fps: number;
    quality: {
        maxSize: number;
        maxFps: number;
    };
    recording: boolean;
    debug: {
        id: string;
        startedAt: number;
    } | null;
    note: string | null;
    claimSessionId: string | null;
    secure: {
        secure: boolean;
        pkg: string | null;
        checkedAt: number;
        captureVisible?: boolean;
        lastMitigate: MitigateView | null;
    } | null;
    secView: 'stream' | 'outline';
    secBusy: boolean;
    secSteps: Array<{
        step: string;
        status: string;
        detail: string;
    }> | null;
    outline: OutlineNode[] | null;
    /** B22f：画面可见性实证（客户端画布/截图亮度采样）——可见则横幅隐藏 */
    secCanvasVisible: boolean;
    /** 流尺寸（meta 帧）：canvas 重挂载（大纲切回画面）时恢复正确长宽，B22g */
    streamSize: {
        w: number;
        h: number;
    } | null;
}
export declare class PaneWindow extends Component<Record<string, never>, PaneWindowState> {
    state: PaneWindowState;
    private pollTimer;
    private secLumTimer;
    private secVisStreak;
    private fpsTimer;
    private stream;
    private pollImgTimer;
    private canvasRef;
    private imgRef;
    private frameCount;
    private frameTotal;
    private pointer;
    private gestureMoved;
    private lastReattachAt;
    private h264Retries;
    private pref;
    private lease;
    private magEl;
    private magCleanup;
    componentDidMount(): void;
    private removeToggle;
    private onResize;
    private onKeyDown;
    componentDidUpdate(): void;
    componentWillUnmount(): void;
    private setOpen;
    /** 停靠租约生命周期：开面板时按 pref/窗宽决定形态；claim 失败（他人持租约/窄窗）→ 浮窗降级。 */
    private syncForm;
    private releaseLease;
    private toggleForm;
    private poll;
    private dispatchState;
    private stopStream;
    /** attach 代际守卫：用户切设备/重连会让旧代 attach 的所有异步回调（含定时重试）作废，
     *  防止并发 attach 互相覆盖（实测：切设备被旧自愈重试抢回 → 选中项弹回 + 错误闪烁）。 */
    private attachSeq;
    private attach;
    private startPollImg;
    private act;
    private canvasPoint;
    private onPointerDown;
    private onPointerMove;
    private onPointerUp;
    private forceRelease;
    private toggleDebug;
    private toggleRecord;
    private setQuality;
    private tryShow;
    private tapOutline;
    /** B22f：采样当前显示元素（canvas/img）的亮度与方差，判定 FLAG_SECURE 页面是否实际可见。
     *  黑帧：mean≈0 且 std≈0；内容帧：mean 或 std 显著非零。连续 2 次可见才判定（防单帧抖动）。 */
    private sampleSecVisibility;
    private fetchOutline;
    private bindMagnets;
    render(): ReturnType<typeof h>;
}
/** 头部入口按钮：渐变胶囊 + 光泽扫过 + 按压缩放 + 设备呼吸灯 + 面板开启高亮态。 */
export declare function PaneSidebarButton(): ReturnType<typeof h>;
export declare const inject: string[];
export declare function apply(ctx: {
    slots: {
        inject(slot: string, register: () => unknown): void;
        register(meta: Rec, component?: unknown): unknown;
    };
    effect(fn: () => unknown, label?: string): void;
}): void;
export {};

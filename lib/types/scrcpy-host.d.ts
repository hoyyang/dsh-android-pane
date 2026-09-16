export declare const NO_PTS = 9223372036854775808n;
export interface ScrcpyQuality {
    maxSize: number;
    maxFps: number;
    videoBitRate: number;
}
export interface StreamMeta {
    deviceName: string;
    streamWidth: number;
    streamHeight: number;
    codecString: string;
}
export interface ScrcpyFrame {
    /** 已剥离标志位的纯 pts（µs）。 */
    pts: bigint;
    /** AnnexB 数据（含起始码）。 */
    data: Buffer;
    key: boolean;
    /** CODEC_CONFIG 包（SPS/PPS）。 */
    config: boolean;
}
export type FrameSink = (frame: ScrcpyFrame) => void;
export type MetaSink = (meta: StreamMeta) => void;
export type DeadSink = (reason: string) => void;
/** MotionEvent action 常量（Android）。 */
export declare const ACTION_DOWN = 0;
export declare const ACTION_UP = 1;
export declare const ACTION_MOVE = 2;
export declare class StreamSession {
    private readonly adbPath;
    private readonly serial;
    private readonly jarPath;
    private quality;
    private readonly log;
    private proc;
    private videoSock;
    private controlSock;
    private videoBuf;
    private gotConfig;
    private closed;
    private stderrTail;
    private readonly sinks;
    private metaSink;
    private deadSink;
    private meta;
    private scid;
    private port;
    private gop;
    private lastConfigFrame;
    displaySize: {
        w: number;
        h: number;
    };
    constructor(adbPath: string, serial: string, jarPath: string, quality: ScrcpyQuality, log: (msg: string) => void);
    get info(): StreamMeta | null;
    /** 物理分辨率（wm size 实测），供流↔物理坐标换算。 */
    get displayDim(): {
        w: number;
        h: number;
    };
    get running(): boolean;
    onFrame(fn: FrameSink): () => void;
    onMeta(fn: MetaSink): void;
    onDead(fn: DeadSink): void;
    /** 观察者心跳（/stream 路由 ping 时调用）：有活跃观看者的流不被 reaper 回收。 */
    viewerAt: number;
    touchViewer(): void;
    hasActiveViewer(windowMs?: number): boolean;
    /** 晚加入观看者的重放序列（config+自最近关键帧起的增量包）。 */
    replayGop(): ScrcpyFrame[];
    /** 重放缓存是否可独立解码（必须同时含 config=SPS/PPS 与关键帧）。 */
    replayDecodable(): boolean;
    /** B22b：按 ARGS 精准清理设备端残留 scrcpy server（`com.genymobil[e]` 字符类防误杀自身 grep）。 */
    private killOrphanServers;
    /** 完整启动：push → forward → spawn server（tunnel_forward）→ 双连接 → 首包。 */
    start(signal?: AbortSignal): Promise<StreamMeta>;
    /** 连接 video socket 并读走 1 字节 dummy（设备名在 control 连上之后才发，见 start() 注释）。
     *  实测教训链：设备端 listener 未就绪时首个连接会 EOF，且 adbd 会随之拆掉 forward 监听
     *  （后续连接全部 ECONNREFUSED）。因此：① 先 poll 设备 abstract socket 出现再连；
     *  ② 每次重试前重新下发 forward（幂等）。 */
    private connectSocketWithDummy;
    /** 连接 control socket（server accept 顺序在 video 之后）。 */
    private connectControl;
    /** 画质重配 = 重建会话（由上层调用 stop + start）。 */
    updateQuality(q: ScrcpyQuality): void;
    /** 连接 adb forward 出来的本地端口（server 未起时短重试）。 */
    private connectWithRetry;
    private onVideoData;
    private waitForConfig;
    private send;
    injectTouch(x: number, y: number, action: number): void;
    /** 诊断探针（注入器上下文里同步 require 不可用，必须动态 import）。 */
    private touchProbe;
    /** 触控坐标系 = 流尺寸（晚于 meta 到达前回退物理分辨率）。 */
    private touchSpace;
    /** 流坐标 → 设备物理坐标（poll 降级走 adb input 时必须换算，adb input 只认物理坐标）。 */
    mapToDisplay(x: number, y: number): {
        x: number;
        y: number;
    };
    /** ⚠️ MOVE 事件必须按 durationMs 真实间隔发送：一次性灌完 = Android 端 0 速度瞬移手势，
     *  被桌面/应用吞掉（实测「面板无法操作」根因之一——tap 正常所以此前漏网）。 */
    injectSwipe(x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<void>;
    injectKey(action: number, keycode: number, metaState?: number, repeat?: number): void;
    /** 按键按下+抬起。 */
    tapKey(keycode: number, metaState?: number): void;
    /** 文本输入：ASCII 走 TYPE_TEXT，其余走剪贴板粘贴（对齐 scrcpy 桌面端行为）。 */
    injectText(text: string): void;
    setClipboardPaste(text: string): void;
    scroll(x: number, y: number, deltaX: number, deltaY: number): void;
    backOrScreenOn(action: number): void;
    expandNotifications(): void;
    collapsePanels(): void;
    markDead(reason: string): void;
    /** 停止并清理（幂等）。 */
    stop(): void;
}
export interface ParsedH264 {
    sps: Buffer | null;
    pps: Buffer | null;
    width: number;
    height: number;
    codecString: string;
}
/** 解析 AnnexB：提取 SPS/PPS、分辨率、avc1.PPCCLL codec string。 */
export declare function parseH264AnnexB(data: Buffer): ParsedH264 | null;
/** 按 00 00 01 / 00 00 00 01 起始码切 NAL（保留 NAL 头字节）。 */
export declare function splitAnnexB(data: Buffer): Buffer[];
/** 极简 SPS 解析（Exp-Golomb），取 coded width/height（不含 crop 校正的场合足够用）。 */
export declare function parseSpsSize(sps: Buffer): {
    w: number;
    h: number;
};
export declare function jarPathIn(pluginRoot: string): string;
/** 从编译产物路径反推插件包根（lib/scrcpy-host.js → 包根）。 */
export declare function pluginRootFromImportMeta(importMetaUrl: string): string;

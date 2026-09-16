/**
 * PaneHub：设备/认领/串流/操作的中枢。
 * 规则落地点（设计卡）：
 *  - 设备独占（规则2）：claims 单属主，冲突明确报错；
 *  - 人机互斥提示（规则3）：agent 每次操作刷新 busyUntil，路由暴露给 UI 亮徽标；
 *  - 闲置回收（规则4）：10 分钟无活动 → 释放认领 + 停流；模拟器额外 emu kill，真机仅断开；
 *  - 资源上限（规则7）：每会话 4 路、全局 8 路；
 *  - 降级（规则6/MVP）：scrcpy 启动失败 → 该设备进入 poll 模式（截图轮播），注入走 adb input；
 *  - 隐私（规则8）：截图只落 <dshHome>/dsh-android-pane/shots，路径透明。
 */
import { type ChildProcess } from 'node:child_process';
import { type WriteStream } from 'node:fs';
import { Adb } from './adb.js';
import { PaneStateStore, type QualityPrefs } from './state.js';
import { StreamSession } from './scrcpy-host.js';
import { type MitigateResult, type SecureFocus } from './flag-secure.js';
export interface DebugSegment {
    remote: string;
    local?: string;
    startEpoch: number;
    endEpoch?: number;
}
export interface DebugAct {
    t: number;
    action: string;
    detail?: string;
}
export interface DebugSession {
    id: string;
    serial: string;
    mode: 'human' | 'agent';
    startedAt: number;
    stoppedAt?: number;
    segments: DebugSegment[];
    recordProc: ChildProcess | null;
    logProc: ChildProcess | null;
    logRing: string[];
    logRingBytes: number;
    errFile: string;
    errStream: WriteStream | null;
    acts: DebugAct[];
    segIndex: number;
    shortRotations: number;
    rotateTimer: NodeJS.Timeout | null;
    dir: string;
}
export interface DebugSummary {
    id: string;
    serial: string;
    mode: 'human' | 'agent';
    startedAt: number;
    durationMs: number;
    mp4s: string[];
    errFile: string;
    acts: number;
}
export interface DebugAnalysis {
    id: string;
    serial: string;
    durationMs: number;
    timeline: string[];
    frames: Array<{
        file: string;
        label: string;
        t: number;
        kind: 'pre' | 'post' | 'sample';
    }>;
    logSlices: string[];
    errorLines: string[];
    logTail: string[];
    mp4s: string[];
    errFile: string;
}
export interface ClaimInfo {
    serial: string;
    sessionId: string;
    claimedAt: number;
    lastActivityAt: number;
}
export interface DeviceView {
    serial: string;
    state: string;
    model: string | null;
    isEmulator: boolean;
    claimedBy: string | null;
    busy: boolean;
    mode: 'h264' | 'poll' | null;
}
export interface ActRequest {
    action: 'tap' | 'swipe' | 'key' | 'text' | 'scroll' | 'back' | 'home' | 'recents' | 'volume_up' | 'volume_down' | 'rotate';
    serial?: string;
    x?: number;
    y?: number;
    x2?: number;
    y2?: number;
    durationMs?: number;
    key?: string;
    text?: string;
}
export declare class PaneHub {
    private readonly adb;
    private readonly state;
    private readonly opts;
    private devicesCache;
    private devicesAt;
    private readonly claims;
    private readonly streams;
    private readonly modes;
    private readonly streamErrors;
    private readonly busyUntil;
    private readonly pollSince;
    private readonly records;
    private readonly deviceInfo;
    /** attach 时切换到 ADBKeyboard 前的原输入法（detach 时还原） */
    private readonly prevIme;
    private readonly seenDetached;
    private reaperTimer;
    private refreshTimer;
    /** dispose 竞态守卫（B22b）：start 在途的会话集合——dispose 时一并 stop，防孤儿 server 占编码器 */
    private readonly pendingStarts;
    /** FLAG_SECURE（B22）：焦点窗口 SECURE 位缓存 / 检测与缓解链在-flight / root 能力缓存 */
    private readonly secureStates;
    private readonly secureInflight;
    private readonly mitigateInflight;
    private readonly lastMitigate;
    private readonly rootProbe;
    private secureTimer;
    constructor(adb: Adb, state: PaneStateStore, opts: {
        jarPath: string;
        shotsDir: string;
        log: (msg: string) => void;
        idleDetachMs: number;
        maxPerSession: number;
        globalMax: number;
        autoBootEmulator: boolean;
        flagSecureCheck: boolean;
        emulatorBin?: string;
    });
    startTimers(): void;
    private refreshDevices;
    private ensureDevices;
    listDevices(): Promise<{
        devices: DeviceView[];
        quality: QualityPrefs;
    }>;
    sessionState(): Promise<{
        claims: ClaimInfo[];
        busy: Record<string, boolean>;
        streamErrors: Record<string, string>;
        debug: Record<string, {
            id: string;
            startedAt: number;
            mode: string;
        }>;
        secure: Record<string, {
            secure: boolean;
            pkg: string | null;
            checkedAt: number;
            captureVisible?: boolean;
            lastMitigate: MitigateResult | null;
        }>;
    }>;
    /** 工具 attach（agent 路径）：DSH 工具审批 = 首次授权点，创建会话级认领。 */
    attachForTool(sessionId: string, serial: string | undefined, signal?: AbortSignal): Promise<{
        serial: string;
        model: string | null;
        isEmulator: boolean;
        mode: 'h264' | 'poll';
        size: {
            w: number;
            h: number;
        } | null;
        deviceName: string | null;
        screenshotPath: string | null;
        streamError: string | null;
    }>;
    /** 面板 attach（观察者路径）：用户手势即授权；只确保串流在跑，不创建认领、不与 agent 抢设备。 */
    attachViewer(serial: string, signal?: AbortSignal): Promise<{
        serial: string;
        model: string | null;
        isEmulator: boolean;
        mode: 'h264' | 'poll';
        size: {
            w: number;
            h: number;
        } | null;
        streamError: string | null;
    }>;
    private ensuring;
    /** 每设备最近一次成功流的坐标系（流↔物理），供 adb 兜底路径换算（adb input 只认物理坐标）。 */
    private lastDims;
    private adbPoint;
    /** /stream 订阅前保证可解码：重放缓存缺 config/IDR（溢出裁剪后）→ 重启会话换新关键帧。 */
    ensureDecodableStream(s: string, signal?: AbortSignal): Promise<void>;
    /** 设备保护保险丝：会话启动频率上限（每设备 60s 内 ≤6 次）。超限 → 拒绝再拉起，防 app_process/
     *  MediaCodec 高频 churn 伤设备（实测教训：粗暴对待 app_process 可致系统不稳/设备重启）。
     *  超限期间返回 'poll'（正常降级），冷却后自动恢复。 */
    private startTimes;
    private static readonly FUSE_WINDOW_MS;
    private static readonly FUSE_MAX_STARTS;
    private fuseOpen;
    /** 确保 h264 串流在跑（per-device 互斥：并发调用共享同一次启动，防双 server 冲突）。 */
    private ensureStream;
    private ensureStreamInner;
    /** 面板强制解锁：人显式接管（记录原因；被锁会话的下一次操作会收到「未被认领」并需重新 attach）。 */
    forceRelease(serial: string): {
        released: boolean;
        note: string;
    };
    detach(sessionId: string | null, serial: string): {
        released: boolean;
    };
    private releaseClaim;
    private reapIdle;
    getStream(serial: string): StreamSession | null;
    getMode(serial: string): 'h264' | 'poll' | null;
    /** 焦点窗口 SECURE 位检测（dumpsys window windows → 解析）。2.5s 定时器 + attach 即检共用；在-flight 去重。 */
    checkSecure(serial: string, signal?: AbortSignal): Promise<SecureFocus>;
    secureInfo(serial: string): SecureFocus | null;
    /** root 能力探测（60s 缓存）：构建类型 / su / Magisk|LSPosed 框架。只探测，绝不执行提权。 */
    private probeRootCapability;
    /** userdebug/eng：adb root（必须带 -s——多设备在线时裸 `adb root` 直接 exit 1，实测教训；
     *  adbd 重启后 id -u 重试确认）。保留原始输出用于 fail loud。user 构建绝不调用。 */
    private tryAdbRoot;
    /** 串流重启（缓解链内用）：停旧会话 → 等编码器释放 → 重新拉起。 */
    private restartStream;
    /** B22d：实测截图通道可见性（原始帧缓冲采样）。双机校准：黑帧 distinct≈47/top2≈100%，
     *  内容帧 distinct 211-256/top2≤95%。零副作用：不改 root 态、不动流。 */
    private probeCaptureVisible;
    /** 缓解链（用户点「尝试显示」触发）。B22d 实证版：
     *  ① 无 root 态实测截图通道（零副作用）→ 可见即切快照流（部分 userdebug 机器 screencap 不受 FLAG_SECURE 限制）
     *  ② 不可见且 userdebug/eng → adb root 后复测 → 可见即【保持 root】+ 快照流（绝不无谓 unroot）
     *  ③ 全部不可见 → （试过 root 则还原）→ 降级内容通道。判定全部基于像素实测，不以 FLAG 位推断。 */
    secureMitigate(serial: string, signal?: AbortSignal): Promise<MitigateResult>;
    /** agent 操作：认领校验 + busy 徽标 + 动作 + 自动截图。 */
    act(sessionId: string, req: ActRequest, signal?: AbortSignal): Promise<{
        serial: string;
        performed: string;
        screenshotPath: string | null;
        secureHint?: string;
    }>;
    /** 面板手势：不需要认领；**设备被任一智能体会话认领即全程锁定**（用户预期：锁到任务完成才释放）。
     *  紧急接管：面板「强制解锁」按钮（POST /claim/release）或该会话 detach/闲置自动释放。 */
    actPanel(req: ActRequest, signal?: AbortSignal): Promise<{
        serial: string;
        performed: string;
    }>;
    /** 工具层解析目标设备（公开入口）。 */
    serialForSession(sessionId: string, serial?: string): string;
    /** 解析会话目标设备：显式 serial 须是本会话认领的；缺省时本会话仅认领一台才可自动选。 */
    private resolveSerialForSession;
    /** ⚠️ touch 注入通道决策（Android 17 + HyperOS 实测教训）：
     *  scrcpy 3.3.4 在此组合下把 touch 注入绑定到其虚拟 display（displayId 3, layerStack 3），
     *  事件到不了真实 display 0 的应用（keycode 不受影响）——故 touch 一律走 `adb input`（物理坐标），
     *  key/text/rotate 走 control socket（已实测可用）。adbPoint 负责流坐标→物理坐标换算。 */
    private static readonly TOUCH_VIA_CONTROL;
    /** performAct：调试会话时间线钩子 + 内层分发。agent 与面板操作都经此（单一咽喉）。 */
    private performAct;
    private performActInner;
    /** ADBKeyboard 输入法状态。 */
    imeStatus(s: string, signal?: AbortSignal): Promise<{
        installed: boolean;
        current: string;
    }>;
    /** 中文等非 ASCII 文本：ADBKeyboard 已在 attach 时激活，直接广播注入。 */
    imeSend(s: string, text: string, signal?: AbortSignal): Promise<string>;
    /** 安装 ADBKeyboard.apk 并启用输入法（一次性设置；MIUI 会弹设备端确认）。 */
    installIme(serial: string, signal?: AbortSignal): Promise<{
        installed: boolean;
        note: string;
    }>;
    /** 首个在线设备 serial。 */
    firstOnlineSerial(): string | null;
    rotate(s: string, signal?: AbortSignal): Promise<string>;
    saveScreenshot(serial: string, signal?: AbortSignal): Promise<string>;
    screenshotBuffer(serial: string, signal?: AbortSignal): Promise<Buffer>;
    /** uiautomator 结构化控件树（规则：验证闭环增强）。 */
    uidump(serial: string, signal?: AbortSignal): Promise<Array<{
        text: string;
        desc: string;
        cls: string;
        clickable: boolean;
        center: [number, number];
        depth: number;
    }>>;
    /** 停止录制并 pull 出 mp4（幂等）。 */
    private stopRecord;
    record(serial: string, action: 'start' | 'stop', outDir?: string, signal?: AbortSignal): Promise<{
        file?: string;
        note: string;
    }>;
    /** 元素级操作基础：按条件在 uiautomator 树里找节点（权威坐标，杜绝截图目测打偏）。 */
    uiFind(serial: string, criteria: {
        target?: string;
        index?: number;
    }, signal?: AbortSignal): Promise<{
        index: number;
        total: number;
        text: string;
        desc: string;
        cls: string;
        clickable: boolean;
        center: [number, number];
        bounds: [number, number, number, number];
    }>;
    /** 元素点击：解析权威坐标后走统一注入通道。 */
    uiTap(serial: string, criteria: {
        target?: string;
        index?: number;
    }, signal?: AbortSignal): Promise<{
        performed: string;
        node: Awaited<ReturnType<PaneHub['uiFind']>>;
    }>;
    /** 元素设值：定位 → 点聚焦 → 按原内容长度清空 → ADBKeyboard/文本注入。中文可靠。 */
    uiSetText(serial: string, args: {
        target?: string;
        index?: number;
        text: string;
        clear?: boolean;
    }, signal?: AbortSignal): Promise<{
        performed: string;
        node: Awaited<ReturnType<PaneHub['uiFind']>>;
        screenshotPath: string | null;
    }>;
    private debugSessions;
    private debugBySerial;
    debugStart(serial: string, mode: 'human' | 'agent', signal?: AbortSignal): {
        id: string;
        note: string;
    };
    private debugSpawnSegment;
    /** 段轮转：杀当前 screenrecord（设备端自动落盘）→ 异步 pull → 拉起下一段。 */
    private debugRotate;
    private debugPullSegment;
    private debugSpawnLogcat;
    debugStop(serial: string): Promise<{
        id: string;
        note: string;
        summary?: DebugSummary;
    }>;
    private debugSummarize;
    debugStatus(serial?: string): {
        active: boolean;
        id?: string;
        startedAt?: number;
        mode?: string;
        acts?: number;
        sessions?: DebugSummary[];
    };
    debugList(): DebugSummary[];
    /** analyze：把每个操作的「前后帧图 + logcat 片段」物化为文件返回——证据强制进入 agent 上下文。 */
    debugAnalyze(id?: string): Promise<DebugAnalysis>;
    listAvds(): Promise<string[]>;
    /** 启动一台关机的模拟器（面板设备菜单手势）。MVP：等待 boot_completed，最长 120s。 */
    bootEmulator(avd: string): Promise<{
        serial?: string;
        note: string;
    }>;
    setQuality(patch: Partial<QualityPrefs>): Promise<QualityPrefs>;
    /** 还原设备原输入法。 */
    private restoreIme;
    dispose(): void;
}

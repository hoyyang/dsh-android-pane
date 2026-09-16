export interface AdbDevice {
    serial: string;
    state: string;
    model: string | null;
    device: string | null;
    product: string | null;
    isEmulator: boolean;
}
export interface RunResult {
    code: number;
    stdout: string;
    stderr: string;
}
export declare class AdbError extends Error {
    readonly args: readonly string[];
    readonly code: number | null;
    readonly stderr: string;
    constructor(message: string, args: readonly string[], code: number | null, stderr: string);
}
export declare class Adb {
    private readonly adbPath;
    private readonly defaultTimeoutMs;
    constructor(adbPath: string, defaultTimeoutMs?: number);
    /** adb 可执行文件路径（供 spawn 场景复用）。 */
    get path(): string;
    /** 执行一条 adb 子命令；signal 取消会 kill 进程。 */
    run(args: readonly string[], opts?: {
        timeoutMs?: number;
        signal?: AbortSignal;
    }): Promise<RunResult>;
    /** 期待退出码 0 的 run，否则抛 AdbError。 */
    runOk(args: readonly string[], opts?: {
        timeoutMs?: number;
        signal?: AbortSignal;
    }): Promise<string>;
    devices(signal?: AbortSignal): Promise<AdbDevice[]>;
    shell(serial: string, cmd: string, opts?: {
        timeoutMs?: number;
        signal?: AbortSignal;
    }): Promise<RunResult>;
    shellOk(serial: string, cmd: string, opts?: {
        timeoutMs?: number;
        signal?: AbortSignal;
    }): Promise<string>;
    /** 二进制输出命令（exec-out），返回原始 buffer。 */
    execOutBinary(args: readonly string[], opts?: {
        timeoutMs?: number;
        signal?: AbortSignal;
    }): Promise<Buffer>;
    screencap(serial: string, opts?: {
        timeoutMs?: number;
        signal?: AbortSignal;
    }): Promise<Buffer>;
    push(serial: string, local: string, remote: string, opts?: {
        timeoutMs?: number;
        signal?: AbortSignal;
    }): Promise<void>;
    forward(serial: string, localPort: number, abstractName: string, opts?: {
        signal?: AbortSignal;
    }): Promise<void>;
    removeForward(serial: string, localPort: number): Promise<void>;
    /** 关停模拟器（仅模拟器使用；真机禁用）。 */
    emuKill(serial: string): Promise<void>;
    /** 设备品牌信息（一次 getprop 批量取回）。 */
    getDeviceInfo(serial: string, opts?: {
        signal?: AbortSignal;
    }): Promise<{
        brand: string;
        market: string;
        model: string;
        type: string;
    }>;
    /** 设备物理/覆盖分辨率（`wm size`，如 "Physical size: 1080x2400"）。 */
    displaySize(serial: string, opts?: {
        signal?: AbortSignal;
    }): Promise<{
        w: number;
        h: number;
    } | null>;
}
export declare function isEmulatorSerial(serial: string): boolean;

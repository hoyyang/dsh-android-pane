export interface QualityPrefs {
    /** 视频最大边长（0 = 原生分辨率） */
    maxSize: number;
    maxFps: number;
    videoBitRate: number;
}
export interface PaneState {
    /** 已授权设备序列号（首次 attach 经 DSH 工具审批后记住） */
    trustedDevices: string[];
    quality: QualityPrefs;
    updatedAt: string;
}
export declare const DEFAULT_QUALITY: QualityPrefs;
export declare class PaneStateStore {
    private readonly file;
    private cached;
    private constructor();
    static open(dir: string): PaneStateStore;
    get data(): Readonly<PaneState>;
    isTrusted(serial: string): boolean;
    trust(serial: string): void;
    untrust(serial: string): void;
    setQuality(patch: Partial<QualityPrefs>): QualityPrefs;
    private flush;
}

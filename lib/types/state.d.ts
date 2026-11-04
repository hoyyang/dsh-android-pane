export interface QualityPrefs {
    maxSize: number;
    maxFps: number;
    videoBitRate: number;
}
export interface CaptureOutput {
    id: string;
    type: 'screenshot' | 'record' | 'debug';
    files: string[];
    at: number;
    error?: string;
    identities: Array<{
        dev: number;
        ino: number;
    }>;
}
export interface DebugClock {
    minOffsetMs: number;
    maxOffsetMs: number;
}
/** One sampler round trip may bound the offset to ±1ms; both sides enforce this same ceiling. */
export declare const MAX_CLOCK_WIDTH_MS = 1000;
export interface PendingCapture {
    id: string;
    type: 'record' | 'debug';
    serial: string;
    dir: string;
    startedAt: number;
    stoppedAt?: number;
    error?: string;
    captureError?: string;
    remote?: string;
    logRemote?: string;
    clockStart?: DebugClock;
    clockEnd?: DebugClock;
    segments?: Array<{
        remote: string;
        startEpoch: number;
        endEpoch?: number;
        clock?: DebugClock;
    }>;
    actions?: Array<{
        t: number;
        endedAt?: number;
        action: string;
        detail?: string;
    }>;
}
export interface PaneState {
    trustedDevices: string[];
    quality: QualityPrefs;
    updatedAt: string;
    directory: string;
    outputs: CaptureOutput[];
    pending: PendingCapture[];
    volumeRestore: Record<string, number>;
}
export declare const DEFAULT_QUALITY: QualityPrefs;
/** No relative/device/browser paths. Probe the actual host directory before committing a preference. */
export declare function validateCaptureDirectory(directory: string): string;
export declare class PaneStateStore {
    private readonly file;
    private cached;
    private constructor();
    static open(dir: string): PaneStateStore;
    get data(): Readonly<PaneState>;
    reload(): Readonly<PaneState>;
    isTrusted(serial: string): boolean;
    trust(serial: string): void;
    untrust(serial: string): void;
    setQuality(patch: Partial<QualityPrefs>): QualityPrefs;
    setDirectory(directory: string): string;
    upsertPending(job: PendingCapture): void;
    setVolumeRestore(serial: string, value?: number): void;
    registerOutput(id: string, type: CaptureOutput['type'], files: string[], error?: string): void;
    private flush;
}

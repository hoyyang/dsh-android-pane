/**
 * 插件状态：受信设备 + 默认画质。
 * 落盘 <dshHome>/dsh-android-pane/state.json，原子写（tmp+rename），损坏时 fail loud 报错但不炸进程。
 * 无凭据、无敏感数据（设计卡规则 8：隐私红线只涉及提示，不落任何账号信息）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
export const DEFAULT_QUALITY = { maxSize: 1280, maxFps: 30, videoBitRate: 8_000_000 };
export class PaneStateStore {
    file;
    cached;
    constructor(file, cached) {
        this.file = file;
        this.cached = cached;
    }
    static open(dir) {
        const file = join(dir, 'state.json');
        let state = { trustedDevices: [], quality: { ...DEFAULT_QUALITY }, updatedAt: new Date().toISOString() };
        if (existsSync(file)) {
            try {
                const raw = JSON.parse(readFileSync(file, 'utf8'));
                state = {
                    trustedDevices: Array.isArray(raw.trustedDevices) ? raw.trustedDevices.filter((s) => typeof s === 'string') : [],
                    quality: { ...DEFAULT_QUALITY, ...(raw.quality ?? {}) },
                    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : state.updatedAt,
                };
            }
            catch (e) {
                throw new Error(`dsh-android-pane 状态文件损坏（${file}）：${String(e).slice(0, 200)}。请删除该文件后重试。`);
            }
        }
        mkdirSync(dir, { recursive: true });
        return new PaneStateStore(file, state);
    }
    get data() {
        return this.cached;
    }
    isTrusted(serial) {
        return this.cached.trustedDevices.includes(serial);
    }
    trust(serial) {
        if (!this.cached.trustedDevices.includes(serial)) {
            this.cached.trustedDevices.push(serial);
            this.flush();
        }
    }
    untrust(serial) {
        this.cached.trustedDevices = this.cached.trustedDevices.filter((s) => s !== serial);
        this.flush();
    }
    setQuality(patch) {
        this.cached.quality = { ...this.cached.quality, ...patch };
        this.flush();
        return { ...this.cached.quality };
    }
    flush() {
        this.cached.updatedAt = new Date().toISOString();
        const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
        try {
            mkdirSync(dirname(this.file), { recursive: true });
            writeFileSync(tmp, JSON.stringify(this.cached, null, 2), 'utf8');
            renameSync(tmp, this.file);
        }
        catch (e) {
            try {
                if (existsSync(tmp))
                    renameSync(tmp, tmp); // no-op 保留现场
            }
            catch {
                /* ignore */
            }
            throw new Error(`dsh-android-pane 状态写入失败（${this.file}）：${String(e).slice(0, 200)}`);
        }
    }
}
//# sourceMappingURL=state.js.map
/**
 * @dsh-external/dsh-android-pane — host 入口（hybrid：工具 + 路由；无 module 级副作用）。
 * 生命周期：apply 注入 webServer/tools → 建服务 → 挂路由与工具 → 返回 dispose；
 * 卸载即净（规则10）：路由注销、流停止、子进程回收、定时器清除、认领表清空。
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { Adb } from './adb.js';
import { mountPaneRoutes } from './routes.js';
import { PaneHub } from './pane-service.js';
import { jarPathIn } from './scrcpy-host.js';
import { PaneStateStore } from './state.js';
import { registerPaneTools } from './tools.js';
export const name = 'dsh-android-pane';
export const Config = z.object({
    adbPath: z.string().default('adb').description('adb 可执行文件路径'),
    idleDetachMinutes: z.number().min(1).max(120).default(10).description('闲置回收分钟数（规则4）'),
    maxPerSession: z.number().min(1).max(8).default(4).description('每会话设备上限（规则7）'),
    globalMax: z.number().min(1).max(16).default(8).description('全局设备上限（规则7）'),
    autoBootEmulator: z.boolean().default(false).description('面板可启动关机模拟器（需本机 Android SDK）'),
    flagSecureCheck: z.boolean().default(true).description('FLAG_SECURE 页面自动识别（B22）：检测到时面板出横幅与降级内容通道'),
    stateDir: z.string().default('').description('状态目录（缺省 <DSH_HOME>/dsh-android-pane）'),
});
export function apply(ctx, config = {}) {
    const cfg = {
        adbPath: config.adbPath ?? 'adb',
        idleDetachMinutes: config.idleDetachMinutes ?? 10,
        maxPerSession: config.maxPerSession ?? 4,
        globalMax: config.globalMax ?? 8,
        autoBootEmulator: config.autoBootEmulator ?? false,
        flagSecureCheck: config.flagSecureCheck ?? true,
        stateDir: config.stateDir ?? '',
    };
    ctx.inject(['webServer', 'tools'], (hostCtx) => {
        const host = hostCtx;
        if (host.webServer == null)
            throw new Error('dsh-android-pane 需要 webServer 服务（web profile 才提供）');
        if (host.tools == null)
            throw new Error('dsh-android-pane 需要 tools 服务');
        const log = (msg) => {
            try {
                host.logger?.info?.(`[dsh-android-pane] ${msg}`);
            }
            catch {
                /* logger 缺失不致命 */
            }
        };
        const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
        const stateDir = cfg.stateDir !== '' ? cfg.stateDir : join(dshHome, 'dsh-android-pane');
        const state = PaneStateStore.open(stateDir);
        const emulatorBin = cfg.autoBootEmulator ? joinAndroidEmulator() : undefined;
        const hub = new PaneHub(new Adb(cfg.adbPath), state, {
            jarPath: jarPathIn(pluginRoot()),
            shotsDir: join(stateDir, 'shots'),
            log,
            idleDetachMs: cfg.idleDetachMinutes * 60_000,
            maxPerSession: cfg.maxPerSession,
            globalMax: cfg.globalMax,
            autoBootEmulator: cfg.autoBootEmulator,
            flagSecureCheck: cfg.flagSecureCheck,
            emulatorBin,
        });
        hub.startTimers();
        const unregisterRoutes = mountPaneRoutes(host.webServer, hub, (req) => {
            const h = req.headers;
            const v = h?.['x-dsh-session-id'];
            const id = Array.isArray(v) ? v[0] : v;
            return id != null && id !== '' ? id : null;
        });
        const unregisterToolsGuard = guardToolUnregister(host);
        registerPaneTools(host.tools, hub);
        log(`routes+tools mounted（adb=${cfg.adbPath}, idle=${cfg.idleDetachMinutes}min）`);
        return () => {
            unregisterRoutes();
            unregisterToolsGuard();
            hub.dispose();
            log('disposed（规则10：卸载零残留）');
        };
    });
}
/**
 * 工具注销：cordis 的 tools.register 返回值未在所有版本保证可注销；
 * 这里通过 ctx.effect 生命周期兜底 —— hub.dispose 已断流；tools schema 层面
 * 由宿主在插件 dispose 时回收（cordis 语义：apply 内注册随 fiber 销毁）。
 */
function guardToolUnregister(_host) {
    return () => undefined;
}
function pluginRoot() {
    // lib/ 的上一级 = 插件包根（dev 目录与安装后一致）
    const here = new URL('.', import.meta.url).pathname;
    return join(here, '..');
}
function joinAndroidEmulator() {
    const sdk = process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME ?? join(homedir(), 'Library/Android/sdk');
    const bin = join(sdk, 'emulator', 'emulator');
    return bin;
}
//# sourceMappingURL=index.js.map
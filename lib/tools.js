/**
 * 10 个 agent 工具（+debug 调试会话托管、+ui 元素级操作：杜绝截图目测坐标打偏，见 STATE）。
 * 会话身份：exec.agent?.id（dsh-agent runtime-types 实证）→ 设备认领隔离。
 * 取消：exec.signal 转发给所有 adb 子进程与流会话。
 * 授权：android_pane_attach 的 DSH 工具审批 = 规则1 的「首次逐设备授权」；成功后按序列号记住受信。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
/** 规范化输出：深度冻结结构收敛为 JsonValue（mall 同款实测模式）。 */
function toJson(x) {
    return JSON.parse(JSON.stringify(x));
}
export const TOOL_NAMES = [
    'android_pane_devices',
    'android_pane_attach',
    'android_pane_act',
    'android_pane_screen',
    'android_pane_uidump',
    'android_pane_record',
    'android_pane_ui',
    'android_pane_debug',
    'android_pane_detach',
];
function sessionIdOf(ctx) {
    const id = ctx.agent?.id;
    if (id == null || id === '')
        throw new Error('无法识别当前会话（agent id 缺失），设备认领需要会话身份');
    return id;
}
const serialParam = {
    type: 'string',
    description: '设备 serial（adb devices 列出的）。缺省=本会话已认领的唯一设备；attach 时缺省=唯一在线设备。',
};
export function registerPaneTools(tools, hub) {
    tools.register(defineTool({
        name: 'android_pane_devices',
        description: 'List Android devices (real + emulator) with online state, model, panel claim owner and stream mode. Use before attach to pick a serial.',
        parameters: {},
        output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
        execute: async (_args, ctx) => {
            void ctx;
            const r = await hub.listDevices();
            const st = await hub.sessionState();
            return toJson({ ...r, claims: st.claims });
        },
        timeoutMs: 15_000,
    }));
    tools.register(defineTool({
        name: 'android_pane_attach',
        description: 'Claim an Android device for this session and open its live screen in the DSH pane (H.264 stream; auto-fallback to screenshot polling). ' +
            'First attach to a device is the consent point (user approves this tool call). Returns serial, stream mode/size and a first screenshot path — read that image to see the screen.',
        parameters: { serial: serialParam },
        output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
        execute: async (args, ctx) => {
            const { serial } = args;
            return toJson(await hub.attachForTool(sessionIdOf(ctx), serial, ctx.signal));
        },
        timeoutMs: 60_000,
    }));
    tools.register(defineTool({
        name: 'android_pane_act',
        description: 'Interact with the claimed Android device, then auto-capture a screenshot so you can verify the result. ' +
            'actions: tap(x,y) | swipe(x,y→x2,y2,durationMs) | text(text) | key(back|home|recents|volume_up|volume_down|enter|tab|esc|dpad_*) | scroll(x,y,y2=±1) | rotate. ' +
            'Coordinates are device physical pixels (use android_pane_uidump for exact element centers). ' +
            'If the screenshot/stream looks all black, the page is FLAG_SECURE-protected: use android_pane_uidump / android_pane_ui instead (accessibility channel still works; results include secureHint).',
        parameters: {
            action: { type: 'string', required: true, description: 'tap|swipe|text|key|scroll|rotate' },
            serial: serialParam,
            x: { type: 'number', description: '起点/点按 X（设备物理像素）' },
            y: { type: 'number', description: '起点/点按 Y' },
            x2: { type: 'number', description: 'swipe 终点 X / scroll 用作横向增量' },
            y2: { type: 'number', description: 'swipe 终点 Y / scroll 用作纵向增量（负=向上滑）' },
            durationMs: { type: 'number', description: 'swipe 时长（默认 300ms）' },
            key: { type: 'string', description: 'key 动作的按键名' },
            text: { type: 'string', description: 'text 动作的文本（支持中文，走剪贴板粘贴）' },
        },
        output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
        execute: async (args, ctx) => {
            return toJson(await hub.act(sessionIdOf(ctx), args, ctx.signal));
        },
        timeoutMs: 30_000,
    }));
    tools.register(defineTool({
        name: 'android_pane_screen',
        description: 'Capture a fresh PNG screenshot of the claimed Android device and return the file path (read the image with your vision tooling).',
        parameters: { serial: serialParam },
        output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
        execute: async (args, ctx) => {
            const { serial } = args;
            const s = hub.serialForSession(sessionIdOf(ctx), serial);
            const file = await hub.saveScreenshot(s, ctx.signal);
            return toJson({ serial: s, file });
        },
        timeoutMs: 20_000,
    }));
    tools.register(defineTool({
        name: 'android_pane_uidump',
        description: 'Dump the Android UI hierarchy (uiautomator) and return up to 100 interactive/labeled nodes with text, content-desc, class, clickability and center coordinates. ' +
            'Use it to find exact tap targets and verify UI state — far more precise than screenshots.',
        parameters: { serial: serialParam },
        output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
        execute: async (args, ctx) => {
            const { serial } = args;
            const s = hub.serialForSession(sessionIdOf(ctx), serial);
            const nodes = await hub.uidump(s, ctx.signal);
            return toJson({ serial: s, nodes });
        },
        timeoutMs: 30_000,
    }));
    tools.register(defineTool({
        name: 'android_pane_ui',
        description: 'Element-level UI operations backed by uiautomator authoritative coordinates — eliminates blind-coordinate tap misses entirely. ' +
            'Actions: find (resolve an element by text/content-desc and return exact bounds+center), click (tap the resolved element center), ' +
            'setText (focus the element, clear its current content, then type — Chinese-safe via ADBKeyboard). ' +
            'ALWAYS prefer this over android_pane_act tap coordinates for anything inside an app UI: eyeballed screenshot coordinates routinely miss. ' +
            'target also matches widget class (e.g. target="EditText" finds input fields even when empty). ' +
            'target matches by substring against node text or content-desc (e.g. "请输入手机号", "登录"); index picks among multiple matches (0-based).',
        parameters: {
            action: { type: 'string', required: true, description: 'find|click|setText' },
            target: { type: 'string', description: '按文本/content-desc 模糊匹配元素（如「请输入手机号」「登录」「搜索」）' },
            index: { type: 'number', description: '多个匹配时选第 N 个（0 起，默认 0）' },
            text: { type: 'string', description: 'setText：要输入的内容（支持中文）' },
            clear: { type: 'boolean', description: 'setText：输入前清空原内容（默认 true）' },
            serial: serialParam,
        },
        output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
        execute: async (args, ctx) => {
            const { action, target, index, text, clear, serial } = args;
            const s = hub.serialForSession(sessionIdOf(ctx), serial);
            if (action === 'find')
                return toJson({ serial: s, ...(await hub.uiFind(s, { target, index }, ctx.signal)) });
            if (action === 'click')
                return toJson(await hub.uiTap(s, { target, index }, ctx.signal));
            if (!text)
                throw new Error('setText 需要 text 参数');
            return toJson(await hub.uiSetText(s, { target, index, text, clear }, ctx.signal));
        },
        timeoutMs: 60_000,
    }));
    tools.register(defineTool({
        name: 'android_pane_record',
        description: 'Start or stop an mp4 screen recording (adb screenrecord, max 180s per clip) on the claimed device; stop returns the saved file path.',
        parameters: {
            action: { type: 'string', required: true, description: 'start|stop' },
            serial: serialParam,
            dir: { type: 'string', description: 'mp4 保存目录（缺省=插件 shots 目录）' },
        },
        output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
        execute: async (args, ctx) => {
            const { serial, action, dir } = args;
            const s = hub.serialForSession(sessionIdOf(ctx), serial);
            return toJson(await hub.record(s, action, dir, ctx.signal));
        },
        timeoutMs: 60_000,
    }));
    tools.register(defineTool({
        name: 'android_pane_install_ime',
        description: 'One-time setup for Chinese text input: install the bundled ADBKeyboard IME on the device (a confirm dialog appears on the phone; MIUI needs "USB install" enabled) and enable it. Call once per device when Chinese text input is required.',
        parameters: { serial: serialParam },
        output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
        execute: async (args, ctx) => {
            const { serial } = args;
            const s = serial ?? hub.firstOnlineSerial();
            if (!s)
                throw new Error('没有在线设备');
            return toJson(await hub.installIme(s, ctx.signal));
        },
        timeoutMs: 120_000,
    }));
    tools.register(defineTool({
        name: 'android_pane_debug',
        description: 'Managed debug session — the HOST (not you) enforces screen recording (segmented mp4), full logcat capture and a structured action timeline; you cannot forget or fake it. ' +
            'Actions: start (begin capture BEFORE touching the device; works for your own operations too), stop (finalize; returns artifact summary), list, analyze ' +
            '(materializes per-action pre/post frames extracted from the recording + logcat excerpts around each action into the result — you MUST read every returned frame image with your vision tooling and base your analysis on those frames and log excerpts; claiming conclusions without reading them is a violation).',
        parameters: {
            action: { type: 'string', required: true, description: 'start|stop|list|analyze' },
            mode: { type: 'string', description: "start 时：'agent'=AI 操作+AI 分析（默认，需先 attach 认领）；'human'=人操作+AI 分析（无需认领，AI 注入被阻止，面板留给用户）" },
            serial: serialParam,
            id: { type: 'string', description: '调试会话 id（analyze 缺省=最近一次已结束的会话）' },
        },
        output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 1) }] },
        execute: async (args, ctx) => {
            const { action, serial, id } = args;
            if (action === 'list')
                return toJson({ sessions: hub.debugList() });
            if (action === 'analyze')
                return toJson(await hub.debugAnalyze(id));
            const s = hub.serialForSession(sessionIdOf(ctx), serial);
            if (action === 'start')
                return toJson({ serial: s, ...hub.debugStart(s, 'agent', ctx.signal) });
            return toJson({ serial: s, ...(await hub.debugStop(s)) });
        },
        timeoutMs: 180_000,
    }));
    tools.register(defineTool({
        name: 'android_pane_detach',
        description: 'Release this session\'s claim on the device (stream stops; emulator will be shut down after the idle window per design rules).',
        parameters: { serial: serialParam },
        output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
        execute: async (args, ctx) => {
            const { serial } = args;
            const s = hub.serialForSession(sessionIdOf(ctx), serial);
            const r = hub.detach(sessionIdOf(ctx), s);
            return toJson({ serial: s, ...r });
        },
        timeoutMs: 10_000,
    }));
}
//# sourceMappingURL=tools.js.map
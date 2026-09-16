import { isIP } from 'node:net';
export const ROUTE_PREFIX = '/_dsh/dsh-android-pane';
const MAX_JSON_BODY_BYTES = 64 * 1024;
function isLoopbackPeer(remote) {
    if (remote == null || remote === '')
        return false;
    if (remote === '::1')
        return true;
    const m = /^::ffff:(\d+)\.(\d+)\.(\d+)\.(\d+)$/i.exec(remote);
    if (m != null)
        return Number(m[1]) === 127;
    if (isIP(remote) === 4)
        return remote.startsWith('127.');
    return false;
}
function sameOriginHost(req) {
    const origin = req.headers.origin;
    if (origin == null)
        return true;
    const host = req.headers.host;
    if (typeof origin !== 'string' || typeof host !== 'string' || host.trim() === '')
        return false;
    try {
        return new URL(origin).host.trim().toLowerCase() === host.trim().toLowerCase();
    }
    catch {
        return false;
    }
}
/** 临时诊断日志（/tmp/dap-route.log）：定位 /stream 早期 FIN。带 DAP_QUIET=1 时静默。
 *  ⚠️ 注入器上下文里同步 require 不可用（会静默抛错），必须动态 import。 */
function dbg(msg) {
    if (process.env.DAP_QUIET != null)
        return;
    void import('node:fs')
        .then((fs) => fs.appendFileSync('/tmp/dap-route.log', `${new Date().toISOString()} ${msg}\n`))
        .catch(() => undefined);
}
function sendJson(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
}
function sendErr(res, status, code, message) {
    sendJson(res, status, { ok: false, error: { code, message } });
}
function readJsonBody(req) {
    return new Promise((resolve) => {
        const chunks = [];
        let size = 0;
        let aborted = false;
        req.on('data', (d) => {
            if (aborted)
                return;
            size += d.length;
            if (size > MAX_JSON_BODY_BYTES) {
                aborted = true;
                req.pause();
                resolve(null);
                return;
            }
            chunks.push(d);
        });
        req.on('end', () => {
            if (aborted)
                return;
            try {
                const text = Buffer.concat(chunks).toString('utf8');
                if (text.trim() === '')
                    resolve({});
                else {
                    const parsed = JSON.parse(text);
                    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed))
                        resolve(null);
                    else
                        resolve(parsed);
                }
            }
            catch {
                resolve(null);
            }
        });
        req.on('error', () => resolve(null));
    });
}
function strArg(body, key) {
    const v = body[key];
    return typeof v === 'string' ? v : undefined;
}
function numArg(body, key) {
    const v = body[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
export function mountPaneRoutes(webServer, hub, sessionIdOf) {
    const unregister = webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
            try {
                if (!isLoopbackPeer(req.socket.remoteAddress)) {
                    sendErr(res, 403, 'forbidden', '仅允许本机访问（loopback）');
                    return;
                }
                const url = new URL(req.url ?? '/', `http://127.0.0.1:${req.socket.localPort ?? 3080}`);
                const sub = url.pathname.slice(ROUTE_PREFIX.length);
                const method = (req.method ?? 'GET').toUpperCase();
                const serialQ = url.searchParams.get('serial') ?? undefined;
                const body = method === 'POST' ? await readJsonBody(req) : {};
                if (method === 'POST' && body == null) {
                    sendErr(res, 413, 'payload-too-large', `请求体超过 ${MAX_JSON_BODY_BYTES} 字节或不是合法 JSON 对象`);
                    return;
                }
                const serial = serialQ ?? strArg(body ?? {}, 'serial');
                let sessionId = sessionIdOf(req);
                if (sub === '/session-state' && method === 'GET') {
                    sendJson(res, 200, { ok: true, ...(await hub.sessionState()) });
                    return;
                }
                if (sub === '/devices' && method === 'GET') {
                    sendJson(res, 200, { ok: true, ...(await hub.listDevices()) });
                    return;
                }
                if (sub === '/avds' && method === 'GET') {
                    sendJson(res, 200, { ok: true, avds: await hub.listAvds() });
                    return;
                }
                if (sub === '/boot' && method === 'POST') {
                    if (!sameOriginHost(req)) {
                        sendErr(res, 403, 'forbidden', '跨源请求被拒绝');
                        return;
                    }
                    const avd = strArg(body ?? {}, 'avd');
                    if (avd == null || avd === '') {
                        sendErr(res, 400, 'bad-request', '缺少 avd 参数');
                        return;
                    }
                    sendJson(res, 200, { ok: true, ...(await hub.bootEmulator(avd)) });
                    return;
                }
                if (!method || (method !== 'GET' && method !== 'POST')) {
                    res.writeHead(405, { allow: 'GET, POST' });
                    res.end();
                    return;
                }
                if (sub === '/attach' && method === 'POST') {
                    if (!sameOriginHost(req)) {
                        sendErr(res, 403, 'forbidden', '跨源请求被拒绝');
                        return;
                    }
                    if (serial == null || serial === '') {
                        sendErr(res, 400, 'bad-request', '缺少 serial（面板请先在设备菜单选择设备）');
                        return;
                    }
                    // 面板 = 观察者：不创建认领（agent 认领只走工具通道，保持会话独占语义）
                    const r = await hub.attachViewer(serial, undefined);
                    sendJson(res, 200, { ok: true, ...r });
                    return;
                }
                if (sub === '/detach' && method === 'POST') {
                    if (!sameOriginHost(req)) {
                        sendErr(res, 403, 'forbidden', '跨源请求被拒绝');
                        return;
                    }
                    if (serial == null || serial === '') {
                        sendErr(res, 400, 'bad-request', '缺少 serial');
                        return;
                    }
                    sendJson(res, 200, { ok: true, ...(hub.detach(sessionId, serial)) });
                    return;
                }
                if (sub === '/act' && method === 'POST') {
                    if (!sameOriginHost(req)) {
                        sendErr(res, 403, 'forbidden', '跨源请求被拒绝');
                        return;
                    }
                    const action = strArg(body ?? {}, 'action');
                    if (action == null) {
                        sendErr(res, 400, 'bad-request', '缺少 action');
                        return;
                    }
                    const reqAct = {
                        action: action,
                        serial,
                        x: numArg(body ?? {}, 'x'),
                        y: numArg(body ?? {}, 'y'),
                        x2: numArg(body ?? {}, 'x2'),
                        y2: numArg(body ?? {}, 'y2'),
                        durationMs: numArg(body ?? {}, 'durationMs'),
                        key: strArg(body ?? {}, 'key'),
                        text: strArg(body ?? {}, 'text'),
                    };
                    if (sessionId == null) {
                        // 面板手势路径（观察者；agent-busy 时 409）
                        const r = await hub.actPanel(reqAct);
                        sendJson(res, 200, { ok: true, ...r });
                        return;
                    }
                    const r = await hub.act(sessionId, reqAct);
                    sendJson(res, 200, { ok: true, ...r });
                    return;
                }
                if (sub === '/quality' && method === 'POST') {
                    if (!sameOriginHost(req)) {
                        sendErr(res, 403, 'forbidden', '跨源请求被拒绝');
                        return;
                    }
                    const quality = await hub.setQuality({
                        maxSize: numArg(body ?? {}, 'maxSize'),
                        maxFps: numArg(body ?? {}, 'maxFps'),
                    });
                    sendJson(res, 200, { ok: true, quality });
                    return;
                }
                if (sub === '/record' && method === 'POST') {
                    if (!sameOriginHost(req)) {
                        sendErr(res, 403, 'forbidden', '跨源请求被拒绝');
                        return;
                    }
                    const act = strArg(body ?? {}, 'recordAction') ?? strArg(body ?? {}, 'action');
                    if (act !== 'start' && act !== 'stop') {
                        sendErr(res, 400, 'bad-request', 'recordAction 须为 start|stop');
                        return;
                    }
                    if (serial == null || serial === '') {
                        sendErr(res, 400, 'bad-request', '缺少 serial');
                        return;
                    }
                    const r = await hub.record(serial, act, undefined);
                    sendJson(res, 200, { ok: true, ...r });
                    return;
                }
                if (sub === '/claim/release' && method === 'POST') {
                    if (!sameOriginHost(req)) {
                        sendErr(res, 403, 'forbidden', '跨源请求被拒绝');
                        return;
                    }
                    if (serial == null || serial === '') {
                        sendErr(res, 400, 'bad-request', '缺少 serial');
                        return;
                    }
                    sendJson(res, 200, { ok: true, ...hub.forceRelease(serial) });
                    return;
                }
                if (sub === '/debug' && method === 'GET') {
                    const st = hub.debugStatus(serial ?? undefined);
                    sendJson(res, 200, { ok: true, ...st });
                    return;
                }
                if (sub === '/debug' && method === 'POST') {
                    if (!sameOriginHost(req)) {
                        sendErr(res, 403, 'forbidden', '跨源请求被拒绝');
                        return;
                    }
                    const act = strArg(body ?? {}, 'action');
                    if (act !== 'start' && act !== 'stop') {
                        sendErr(res, 400, 'bad-request', 'action 须为 start|stop');
                        return;
                    }
                    if (serial == null || serial === '') {
                        sendErr(res, 400, 'bad-request', '缺少 serial');
                        return;
                    }
                    const r = act === 'start' ? hub.debugStart(serial, 'human') : await hub.debugStop(serial);
                    sendJson(res, 200, { ok: true, ...r });
                    return;
                }
                if (sub === '/secure/mitigate' && method === 'POST') {
                    if (!sameOriginHost(req)) {
                        sendErr(res, 403, 'forbidden', '跨源请求被拒绝');
                        return;
                    }
                    if (serial == null || serial === '') {
                        sendErr(res, 400, 'bad-request', '缺少 serial');
                        return;
                    }
                    const r = await hub.secureMitigate(serial);
                    sendJson(res, 200, { ok: true, ...r });
                    return;
                }
                if (sub === '/secure/outline' && method === 'POST') {
                    if (!sameOriginHost(req)) {
                        sendErr(res, 403, 'forbidden', '跨源请求被拒绝');
                        return;
                    }
                    if (serial == null || serial === '') {
                        sendErr(res, 400, 'bad-request', '缺少 serial');
                        return;
                    }
                    const all = await hub.uidump(serial);
                    // 大纲只保留有文本/desc 的节点（纯容器行是噪声，B22b 用户实测反馈）
                    const nodes = all.filter((n) => n.text !== '' || n.desc !== '');
                    const info = hub.secureInfo(serial);
                    sendJson(res, 200, {
                        ok: true,
                        serial,
                        nodes,
                        secure: { secure: info?.secure ?? false, pkg: info?.pkg ?? null, checkedAt: info?.checkedAt ?? 0, captureVisible: info?.captureVisible },
                    });
                    return;
                }
                if (sub === '/frame' && method === 'GET') {
                    if (serial == null || serial === '') {
                        sendErr(res, 400, 'bad-request', '缺少 serial');
                        return;
                    }
                    const png = await hub.screenshotBuffer(serial);
                    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
                    res.end(png);
                    return;
                }
                if (sub === '/stream' && method === 'GET') {
                    if (serial == null || serial === '') {
                        sendErr(res, 400, 'bad-request', '缺少 serial');
                        return;
                    }
                    dbg(`stream request serial=${serial}`);
                    // 订阅前保证重放缓存可解码（缺 config/IDR → 重启会话拿新关键帧，防晚加入者黑屏）
                    await hub.ensureDecodableStream(serial);
                    const session = hub.getStream(serial);
                    dbg(`stream session=${session == null ? 'null' : session.running ? 'running' : 'dead'}`);
                    if (session == null || !session.running) {
                        dbg(`stream 409 no-stream serial=${serial}`);
                        sendErr(res, 409, 'no-stream', '该设备没有运行中的 H.264 串流（可能处于 poll 降级模式）');
                        return;
                    }
                    res.writeHead(200, {
                        'content-type': 'application/octet-stream',
                        'cache-control': 'no-store',
                        'x-accel-buffering': 'no',
                        'transfer-encoding': 'chunked',
                    });
                    const off = session.onFrame((frame) => {
                        // 帧格式：[u32 type=1][u64 pts|flags][u32 len][annexb]；flag: bit63=CONFIG bit62=KEY
                        let ptsFlags = frame.pts;
                        if (frame.config)
                            ptsFlags |= 0x8000000000000000n;
                        if (frame.key)
                            ptsFlags |= 0x4000000000000000n;
                        const head = Buffer.alloc(4 + 8 + 4);
                        head.writeUInt32BE(1, 0);
                        head.writeBigUInt64BE(ptsFlags, 4);
                        head.writeUInt32BE(frame.data.length, 12);
                        if (!res.writableEnded) {
                            res.write(Buffer.concat([head, frame.data]));
                        }
                    });
                    const meta = session.info;
                    if (meta != null) {
                        const metaJson = Buffer.from(JSON.stringify({ w: meta.streamWidth, h: meta.streamHeight, codec: meta.codecString }), 'utf8');
                        // 统一帧格式：[u32 type=0][u64 pts=0][u32 len][json]
                        const head = Buffer.alloc(4 + 8 + 4);
                        head.writeUInt32BE(0, 0);
                        head.writeBigUInt64BE(0n, 4);
                        head.writeUInt32BE(metaJson.length, 12);
                        res.write(Buffer.concat([head, metaJson]));
                    }
                    // 晚加入观看者：重放 GoP（config+IDR+增量），画面立即出现
                    for (const f of session.replayGop()) {
                        if (res.writableEnded)
                            break;
                        let ptsFlags = f.pts;
                        if (f.config)
                            ptsFlags |= 0x8000000000000000n;
                        if (f.key)
                            ptsFlags |= 0x4000000000000000n;
                        const fh = Buffer.alloc(4 + 8 + 4);
                        fh.writeUInt32BE(1, 0);
                        fh.writeBigUInt64BE(ptsFlags, 4);
                        fh.writeUInt32BE(f.data.length, 12);
                        res.write(Buffer.concat([fh, f.data]));
                    }
                    session.touchViewer();
                    // 心跳 = 规范 type=2 空帧（文本 ping 会污染二进制帧边界 → 客户端 desync 实测教训）
                    const pingFrame = Buffer.alloc(16);
                    pingFrame.writeUInt32BE(2, 0);
                    const ping = setInterval(() => {
                        session.touchViewer();
                        if (!res.writableEnded)
                            res.write(pingFrame);
                    }, 5_000);
                    const t0 = Date.now();
                    // ⚠️ 实测教训：Node 18+ 对 GET 的 req 'close' 在请求头接收完即触发（而非客户端断开），
                    // 会导致订阅者 ~8s 后被误摘 → 画面冻结。必须监听 res 'close'（真正的连接断开）。
                    res.on('close', () => {
                        dbg(`stream res close serial=${serial} queued=${res.writableLength} ended=${res.writableEnded} at=${Date.now() - t0}ms`);
                        clearInterval(ping);
                        off();
                    });
                    dbg(`stream subscribed serial=${serial}`);
                    return;
                }
                sendErr(res, 404, 'not-found', `未知子路由 ${sub}`);
            }
            catch (e) {
                const code = e.code;
                const msg = String(e instanceof Error ? e.message : e).slice(0, 400);
                dbg(`route exception path=${req.url?.slice(-40)} headersSent=${res.headersSent} msg=${msg}`);
                if (!res.headersSent) {
                    if (code === 'agent-busy')
                        sendErr(res, 409, 'agent-busy', msg);
                    else
                        sendErr(res, 500, 'internal', msg);
                }
                else {
                    try {
                        res.end();
                    }
                    catch {
                        /* ignore */
                    }
                }
            }
        },
    });
    return unregister;
}
//# sourceMappingURL=routes.js.map
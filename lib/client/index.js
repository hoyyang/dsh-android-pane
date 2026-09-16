/**
 * dsh-android-pane client：右侧停靠列（margin-right 租约）+ 浮窗降级 + 侧栏入口。
 * 风格：playful-pop × oat-terracotta（Style Studio 拍板 2026-09-04）——胖圆字、2px 描边、
 * 硬阴影 0 3px 0、果冻 hover、磁吸按钮（magnetic-btn）。跑马灯字带已按用户裁定移除。
 * 两必坑（骨架实测）：apply 用 ctx.slots 必须 export const inject = ['slots']；register 必带 name。
 * 流消费：fetch 流式分帧 [u32 type][u64 pts][u32 len][payload] → WebCodecs VideoDecoder(AnnexB) → canvas；
 * 降级：/stream 不可用（poll 模式）→ <img> 每 600ms 拉 /frame。
 * 手势：pointer 事件 → 设备物理坐标 → POST /act（agent 忙碌时 409 → 提示等徽标）。
 */
import { createElement as h, Component, useState, useEffect } from 'react';
import { claimRootDock, DAP_DOCK_OWNER } from './dock.js';
const NS = 'dsh-android-pane';
const API = '/_dsh/dsh-android-pane';
/** 头部按钮样式（渐变胶囊 + 悬停光泽扫过 + 按压缩放 + 呼吸灯），类名全部 dap- 前缀防泄漏。 */
const BTN_CSS = `
.dap-btn{position:relative;display:inline-flex;align-items:center;justify-content:flex-start;gap:0;
  margin-left:auto;
  width:34px;min-width:34px;height:31px;padding:0 8px;box-sizing:border-box;
  border-radius:999px;cursor:pointer;font-size:12.5px;font-weight:600;letter-spacing:.2px;
  color:#eaf4f0;background:linear-gradient(135deg,#24405c 0%,#14665a 55%,#0f7a52 100%);
  border:1px solid rgba(61,213,166,.38);overflow:hidden;user-select:none;vertical-align:middle;
  transition:width .34s cubic-bezier(.22,1,.36,1),margin-left .34s cubic-bezier(.22,1,.36,1),box-shadow .28s ease,border-color .28s ease,filter .28s ease;
  box-shadow:0 1px 8px rgba(20,150,110,.28),inset 0 1px 0 rgba(255,255,255,.12)}
.dap-btn:hover{width:148px;border-color:rgba(61,213,166,.85);
  box-shadow:0 6px 22px rgba(35,200,150,.5),0 0 0 1px rgba(61,213,166,.25),inset 0 1px 0 rgba(255,255,255,.18);
  filter:brightness(1.08)}
.dap-btn:active{filter:brightness(.92);transition-duration:.06s}
.dap-btn:focus-visible{outline:2px solid rgba(61,213,166,.6);outline-offset:2px}
.dap-btn .dap-ico{display:inline-flex;width:17px;height:17px;line-height:1;flex:none;
  filter:drop-shadow(0 1px 3px rgba(61,220,132,.45));
  transition:transform .32s cubic-bezier(.34,1.8,.64,1)}
.dap-btn:hover .dap-ico{transform:rotate(-8deg) translateY(-1px)}
.dap-btn:active .dap-ico{transform:rotate(6deg)}
.dap-btn .dap-ico svg{width:100%;height:100%;display:block}
.dap-btn .dap-wave{opacity:.35;transition:opacity .25s ease}
.dap-btn:hover .dap-wave{animation:dap-wave-lit 1.1s ease forwards}
.dap-btn:hover .dap-wave.w2{animation-delay:.12s}
.dap-btn:hover .dap-wave.w3{animation-delay:.24s}
@keyframes dap-wave-lit{0%,60%{opacity:.35}100%{opacity:1}}
.dap-btn.dap-open .dap-wave{animation:dap-wave-flow 1.5s ease-in-out infinite}
.dap-btn.dap-open .dap-wave.w2{animation-delay:.18s}
.dap-btn.dap-open .dap-wave.w3{animation-delay:.36s}
@keyframes dap-wave-flow{0%,100%{opacity:.35}45%{opacity:1}}
.dap-btn .dap-label{text-shadow:0 1px 2px rgba(0,0,0,.3);white-space:nowrap;opacity:0;max-width:0;margin-left:0;
  transition:opacity .2s ease .08s,max-width .34s cubic-bezier(.22,1,.36,1),margin-left .34s cubic-bezier(.22,1,.36,1)}
.dap-btn .dap-dot{width:0;height:7px;border-radius:50%;background:#3ddc84;flex:none;opacity:0;
  box-shadow:0 0 7px #3ddc84,0 0 2px #fff;animation:dap-pulse 1.7s ease-in-out infinite;
  transition:width .34s cubic-bezier(.22,1,.36,1),opacity .2s ease .1s,box-shadow .28s ease}
.dap-btn .dap-dot.off{background:#8b93a3;box-shadow:none;animation:none}
@keyframes dap-pulse{0%,100%{opacity:.45;transform:scale(.8)}50%{opacity:1;transform:scale(1.2)}}
.dap-btn:hover .dap-label{opacity:1;max-width:92px;margin-left:7px}
.dap-btn:hover .dap-dot{width:7px;margin-left:7px;opacity:1}
.dap-btn:hover .dap-dot.off{opacity:.6}
.dap-btn .dap-shine{position:absolute;top:-20%;left:-65%;width:38%;height:140%;pointer-events:none;
  background:linear-gradient(100deg,transparent 8%,rgba(255,255,255,.38) 50%,transparent 92%);
  transform:skewX(-22deg)}
.dap-btn:hover .dap-shine{animation:dap-shine .85s ease}
@keyframes dap-shine{0%{left:-65%}100%{left:135%}}
.dap-btn.dap-open{background:linear-gradient(135deg,#0f5f7a 0%,#137a82 50%,#0f9d6e 100%);
  border-color:rgba(90,210,255,.6);
  box-shadow:0 0 14px rgba(56,189,248,.45),0 2px 10px rgba(20,120,160,.3),inset 0 1px 0 rgba(255,255,255,.15)}
.dap-btn.dap-open:hover{box-shadow:0 6px 26px rgba(56,189,248,.55),0 0 0 1px rgba(90,210,255,.3)}
@media (prefers-reduced-motion: reduce){.dap-btn,.dap-btn .dap-ico,.dap-btn .dap-dot{animation:none!important;transition:none!important}}
`;
function ensureBtnStyles() {
    if (document.getElementById('dsh-android-pane-btn-css') != null)
        return;
    const el = document.createElement('style');
    el.id = 'dsh-android-pane-btn-css';
    el.textContent = BTN_CSS;
    document.head.appendChild(el);
}
/** 面板样式：playful-pop × oat-terracotta 令牌化（--dap-*），停靠列 + 浮窗双形态 + 三态 + 两标志性效果。 */
const PANE_CSS = `
.dap-pane{
  --dap-bg:#f2ede2;--dap-panel:#faf7ef;--dap-ink:#3a3128;--dap-muted:#6d6152;
  --dap-accent:#8d4a2a;--dap-line:#e2dcc9;--dap-error:#b3402e;--dap-cream:#fdfbf5;
  --dap-hf:'Fredoka','Noto Sans SC',system-ui,sans-serif;
  --dap-spring:cubic-bezier(.34,1.56,.64,1);
  font-family:var(--dap-hf);color:var(--dap-ink);display:flex;flex-direction:column;gap:10px}
.dap-dock{position:fixed;top:0;right:0;bottom:0;width:420px;z-index:60;padding:14px;
  background:var(--dap-bg);border-left:2px solid var(--dap-ink);
  box-shadow:-6px 0 24px rgba(58,49,40,.18)}
.dap-overlay{position:fixed;right:16px;bottom:72px;width:400px;max-height:82vh;z-index:99990;padding:12px;
  background:var(--dap-bg);border:2px solid var(--dap-ink);border-radius:16px;
  box-shadow:0 10px 34px rgba(0,0,0,.35),0 3px 0 var(--dap-ink)}
.dap-head{display:flex;gap:8px;align-items:center;flex:none}
.dap-title{font-weight:700;font-size:13px;letter-spacing:1px;background:var(--dap-panel);
  border:2px solid var(--dap-ink);border-radius:10px;padding:3px 10px;box-shadow:0 3px 0 var(--dap-ink);
  transform:rotate(-2deg);user-select:none;flex:none}
.dap-select{flex:1;min-width:0;background:var(--dap-panel);border:2px solid var(--dap-ink);border-radius:10px;
  padding:4px 8px;font:600 12px var(--dap-hf);color:var(--dap-ink)}
.dap-btn2{display:inline-flex;align-items:center;justify-content:center;gap:4px;min-width:34px;height:30px;
  padding:0 10px;border:2px solid var(--dap-ink);border-radius:12px;background:var(--dap-panel);color:var(--dap-ink);
  font:700 12px var(--dap-hf);box-shadow:0 3px 0 var(--dap-ink);cursor:pointer;flex:none;
  transition:transform .2s var(--dap-spring),box-shadow .2s ease;will-change:transform}
.dap-btn2:hover{transform:scale(1.07)}
.dap-btn2:active{transform:translateY(3px);box-shadow:0 0 0 var(--dap-ink);transition-duration:.06s}
.dap-btn2.dap-accent{background:var(--dap-accent);color:var(--dap-cream)}
.dap-btn2.dap-rec{background:var(--dap-error);color:#fff;border-color:var(--dap-ink)}
.dap-busy{align-self:center;flex:none;background:var(--dap-panel);border:2px solid var(--dap-error);border-radius:999px;
  padding:3px 14px;font:700 12px var(--dap-hf);color:var(--dap-error);box-shadow:0 3px 0 var(--dap-error);
  transform:rotate(-1.5deg);animation:dap-busy-pulse 1.6s ease-in-out infinite}
@keyframes dap-busy-pulse{0%,100%{transform:rotate(-1.5deg) scale(1)}50%{transform:rotate(-1.5deg) scale(1.05)}}
.dap-screen{position:relative;flex:1;min-height:180px;background:var(--dap-ink);border:2px solid var(--dap-ink);
  border-radius:16px;overflow:hidden;display:flex;align-items:center;justify-content:center}
.dap-overlay .dap-screen{min-height:200px}
.dap-screen canvas,.dap-screen img{max-width:100%;max-height:100%;display:block}
.dap-overlay .dap-screen canvas,.dap-overlay .dap-screen img{max-height:46vh}
.dap-state{display:flex;flex-direction:column;align-items:center;gap:10px;padding:18px;text-align:center}
.dap-skel{width:70%;height:12px;border-radius:8px;
  background:linear-gradient(90deg,#4a4036,#615444,#4a4036);background-size:200% 100%;
  animation:dap-shimmer 1.2s ease-in-out infinite}
.dap-skel.b{width:48%}.dap-skel.c{width:60%}
@keyframes dap-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
.dap-state-txt{font:700 13px var(--dap-hf);color:#efe9db}
.dap-state-sub{font:500 11px/1.6 var(--dap-hf);color:#c9bfae;max-width:270px}
.dap-errrow{display:flex;gap:8px;align-items:center;font:600 11px var(--dap-hf);color:var(--dap-error);
  word-break:break-all;flex:none}
.dap-errrow>span{flex:1}
.dap-reconnect{display:flex;gap:8px;align-items:center;font:600 11px var(--dap-hf);
  color:#a8842c;word-break:break-all;flex:none;animation:dap-reconnect-pulse 1.2s ease-in-out infinite}
.dap-reconnect>span{flex:1}
@keyframes dap-reconnect-pulse{0%,100%{opacity:.75}50%{opacity:1}}
.dap-meta{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font:600 11px var(--dap-hf);color:var(--dap-muted);flex:none}
.dap-meta .grow{flex:1}
.dap-mini{background:var(--dap-panel);border:2px solid var(--dap-ink);border-radius:9px;
  font:600 11px var(--dap-hf);color:var(--dap-ink);padding:2px 4px}
.dap-note{font:500 10px/1.5 var(--dap-hf);color:var(--dap-muted);flex:none}
.dap-note-hl{font:600 11px/1.5 var(--dap-hf);color:var(--dap-accent);flex:none}
.dap-busy{display:flex;gap:8px;align-items:center;justify-content:center}
.dap-unlock{margin-left:6px;background:var(--dap-error);color:#fff;border:none;border-radius:8px;
  padding:2px 9px;font:700 11px var(--dap-hf);cursor:pointer}
.dap-secrow{display:flex;gap:8px;align-items:center;flex:none;
  background:repeating-linear-gradient(45deg,#3a2f1a,#3a2f1a 10px,#43371e 10px,#43371e 20px);
  border:2px solid var(--dap-ink);border-radius:12px;padding:5px 10px;box-shadow:0 3px 0 var(--dap-ink)}
.dap-sectext{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font:700 11.5px var(--dap-hf);color:#f3d98b;letter-spacing:.3px}
.dap-secrow .dap-btn2{flex:none}
.dap-secsteps{display:flex;flex-direction:column;gap:5px;flex:none;background:var(--dap-panel);
  border:2px solid var(--dap-ink);border-radius:12px;padding:8px 10px;box-shadow:0 3px 0 var(--dap-ink)}
.dap-step{display:flex;gap:7px;align-items:baseline;font:500 11px/1.5 var(--dap-hf)}
.dap-st-ic{flex:none;width:16px;text-align:center;color:var(--dap-muted)}
.dap-st-nm{flex:none;font-weight:700;color:var(--dap-accent);min-width:56px}
.dap-st-dt{flex:1;color:var(--dap-muted);word-break:break-all}
.dap-step.st-failed .dap-st-ic{color:var(--dap-error)}
.dap-step.st-ok .dap-st-ic{color:#2e7d32}
.dap-step.st-hint .dap-st-ic{color:#a8842c}
.dap-outline{display:flex;flex-direction:column;width:100%;height:100%;min-height:180px;background:var(--dap-cream)}
.dap-outline-hd{display:flex;gap:8px;align-items:center;flex:none;padding:8px 10px;
  border-bottom:2px solid var(--dap-line);font:700 11px/1.5 var(--dap-hf);color:var(--dap-accent)}
.dap-outline-hd span{flex:1;min-width:0}
.dap-outline-list{flex:1;overflow:auto;padding:6px;display:flex;flex-direction:column;gap:4px;align-items:stretch}
.dap-outline-item{display:flex;gap:6px;align-items:baseline;justify-content:space-between;
  border:2px solid transparent;border-radius:9px;background:var(--dap-panel);padding:5px 8px;
  font:500 11.5px/1.45 var(--dap-hf);color:var(--dap-ink);cursor:default;text-align:left;transition:transform .15s var(--dap-spring)}
.dap-outline-item.ck{cursor:pointer;border-color:var(--dap-line)}
.dap-outline-item.ck:hover{border-color:var(--dap-accent);transform:translateY(-1px)}
.dap-ot{flex:1;min-width:0;word-break:break-all}
.dap-oc{flex:none;font:500 9.5px var(--dap-hf);color:var(--dap-muted);opacity:.75}
.dap-outline-empty{font:600 12px var(--dap-hf);color:var(--dap-muted);text-align:center;padding:14px}
@media (prefers-reduced-motion:reduce){
  .dap-busy,.dap-skel{animation:none!important}
  .dap-btn2{transition:none}
  .dap-btn2:hover,.dap-btn2:active{transform:none}
}
`;
function ensurePaneStyles() {
    if (document.getElementById('dsh-android-pane-pane-css') != null)
        return;
    const el = document.createElement('style');
    el.id = 'dsh-android-pane-pane-css';
    el.textContent = PANE_CSS;
    document.head.appendChild(el);
}
/** playful-pop 标题字体（Fredoka）——在线加载，失败静默回退 system-ui。 */
function ensureFontLink() {
    if (document.getElementById('dsh-android-pane-font-link') != null)
        return;
    const l = document.createElement('link');
    l.id = 'dsh-android-pane-font-link';
    l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?family=Fredoka:wght@500;600;700&family=Noto+Sans+SC:wght@500;700&display=swap';
    document.head.appendChild(l);
}
async function api(path, body) {
    const res = await fetch(API + path, {
        method: body == null ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: body == null ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null));
    if (!res.ok || json == null || json.ok !== true) {
        throw new Error(json?.error?.message ?? `${path} HTTP ${res.status}`);
    }
    return json;
}
// ───────────────────── H.264 流消费 ─────────────────────
class StreamReader {
    serial;
    onFrame;
    onMeta;
    onDead;
    draw;
    reader = null;
    buf = new Uint8Array(0);
    decoder = null;
    aborted = false;
    frames = 0;
    codecCfg = null;
    curCodec = null;
    lastFrameAt = 0;
    startedAt = Date.now();
    constructor(serial, onFrame, onMeta, onDead, draw) {
        this.serial = serial;
        this.onFrame = onFrame;
        this.onMeta = onMeta;
        this.onDead = onDead;
        this.draw = draw;
    }
    async start() {
        const res = await fetch(`${API}/stream?serial=${encodeURIComponent(this.serial)}`);
        if (!res.ok || res.body == null) {
            const j = (await res.json().catch(() => null));
            throw new Error(j?.error?.message ?? `/stream HTTP ${res.status}`);
        }
        this.reader = res.body.getReader();
        void this.pump();
    }
    async pump() {
        try {
            for (;;) {
                if (this.aborted)
                    return;
                const { done, value } = await this.reader.read();
                if (done) {
                    this.onDead('串流结束');
                    return;
                }
                this.append(value);
                void this.drain();
            }
        }
        catch (e) {
            if (!this.aborted)
                this.onDead(`串流中断: ${String(e).slice(0, 120)}`);
        }
    }
    append(chunk) {
        const merged = new Uint8Array(this.buf.length + chunk.length);
        merged.set(this.buf);
        merged.set(chunk, this.buf.length);
        this.buf = merged;
    }
    async drain() {
        // 统一帧：[u32 type][u64 pts][u32 len][payload]
        for (;;) {
            if (this.buf.length < 16)
                return;
            const view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
            const type = view.getUint32(0);
            const len = view.getUint32(12);
            // ⚠️ desync 自愈：流中任何一次解析错位都会卡死在一个不可能的大包上（实测冻结根因）。
            // 非法帧头 → 逐字节前移重同步（type∈{0,1,2} 且 len 合理才算帧头）。
            if (type > 2 || len > 8_000_000) {
                this.buf = this.buf.subarray(1);
                continue;
            }
            const pts = view.getBigUint64(4);
            if (this.buf.length < 16 + len)
                return;
            const payload = this.buf.subarray(16, 16 + len);
            this.buf = this.buf.subarray(16 + len);
            if (type === 0) {
                try {
                    const meta = JSON.parse(new TextDecoder().decode(payload));
                    this.onMeta(meta); // 尺寸用于 canvas；codec 以 config 包实测 SPS 为准（initDecoder 在 config 到达时调用）
                }
                catch {
                    /* meta 坏帧忽略 */
                }
            }
            else if (type === 2) {
                // 心跳帧，跳过（也视为连接活性）
                this.lastFrameAt = Date.now();
            }
            else if (type === 1) {
                // 实测：部分编码器不设 scrcpy 的 CONFIG/KEY 标志位 → 改用 NAL 类型分析（可靠）
                const nals = annexBNalTypes(payload);
                if (nals.sps || nals.pps) {
                    // 参数集包：缓存 + 按 SPS 实测值配置解码器
                    this.codecCfg = payload.slice();
                    const codec = annexBCodecString(payload);
                    if (codec != null && this.curCodec !== codec) {
                        this.curCodec = codec;
                        this.initDecoder(codec);
                    }
                    if (!nals.idr)
                        continue; // 纯参数集不单独解码（Chrome 不接受）
                }
                if (this.decoder == null || this.curCodec == null)
                    continue; // 等参数集先行
                const isKey = nals.idr || nals.sps;
                let data = payload;
                if (isKey && !nals.sps && this.codecCfg != null) {
                    // IDR 不带参数集 → 拼接缓存的 SPS/PPS（Chrome AnnexB 需要完整参数集）
                    data = new Uint8Array(this.codecCfg.length + payload.length);
                    data.set(this.codecCfg);
                    data.set(payload, this.codecCfg.length);
                }
                const chunk = new EncodedVideoChunk({
                    type: isKey ? 'key' : 'delta',
                    timestamp: Number(pts & 0x3fffffffffffffffn),
                    data,
                });
                try {
                    this.decoder.decode(chunk);
                    this.frames++;
                    this.lastFrameAt = Date.now();
                    this.onFrame();
                }
                catch (e) {
                    this.onDead(`解码失败: ${String(e).slice(0, 120)}`);
                    return;
                }
            }
        }
    }
    initDecoder(codec) {
        if (typeof VideoDecoder === 'undefined')
            throw new Error('本浏览器不支持 WebCodecs');
        try {
            this.decoder?.close();
        }
        catch {
            /* ignore */
        }
        this.decoder = new VideoDecoder({
            output: (vf) => {
                try {
                    this.draw(vf);
                }
                finally {
                    vf.close();
                }
            },
            error: (e) => this.onDead(`VideoDecoder 错误: ${String(e).slice(0, 160)}`),
        });
        this.decoder.configure({ codec, optimizeForLatency: true });
    }
    stop() {
        this.aborted = true;
        this.codecCfg = null;
        this.curCodec = null;
        try {
            this.reader?.cancel().catch(() => undefined);
        }
        catch {
            /* ignore */
        }
        try {
            this.decoder?.close();
        }
        catch {
            /* ignore */
        }
        this.decoder = null;
        this.reader = null;
    }
}
/** AnnexB NAL 类型分析：是否含 SPS/PPS/IDR。 */
function annexBNalTypes(data) {
    let sps = false, pps = false, idr = false;
    let zeros = 0;
    let nalStart = -1;
    const scan = [];
    for (let i = 0; i < data.length; i++) {
        const b = data[i];
        if (b === 0) {
            zeros++;
            continue;
        }
        if (b === 1 && zeros >= 2) {
            if (nalStart >= 0 && i - zeros > nalStart)
                scan.push(data.subarray(nalStart, i - zeros));
            nalStart = i + 1;
        }
        zeros = 0;
    }
    if (nalStart >= 0)
        scan.push(data.subarray(nalStart));
    for (const nal of scan) {
        if (nal.length === 0)
            continue;
        const t = nal[0] & 0x1f;
        if (t === 7)
            sps = true;
        if (t === 8)
            pps = true;
        if (t === 5)
            idr = true;
    }
    return { sps, pps, idr };
}
/** 从 AnnexB 的 SPS 提取 avc1.PPCCLL codec string（host 端 parseH264AnnexB 的客户端版）。 */
function annexBCodecString(data) {
    let sps = null;
    let zeros = 0;
    let nalStart = -1;
    const nals = [];
    for (let i = 0; i < data.length; i++) {
        const b = data[i];
        if (b === 0) {
            zeros++;
            continue;
        }
        if (b === 1 && zeros >= 2) {
            if (nalStart >= 0 && i - zeros > nalStart)
                nals.push(data.subarray(nalStart, i - zeros));
            nalStart = i + 1;
        }
        zeros = 0;
    }
    if (nalStart >= 0)
        nals.push(data.subarray(nalStart));
    for (const nal of nals) {
        if (nal.length > 3 && (nal[0] & 0x1f) === 7) {
            sps = nal;
            break;
        }
    }
    if (sps == null || sps.length < 4)
        return null;
    const hex = (n) => n.toString(16).padStart(2, '0');
    return `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`;
}
const DOCK_W = 420;
const DOCK_MIN_W = 1200;
const PREF_KEY = 'dsh-android-pane:form';
let openCount = 0;
export class PaneWindow extends Component {
    state = {
        open: false,
        form: 'overlay',
        serial: null,
        devices: [],
        busy: false,
        claimsSeen: false,
        mode: null,
        error: null,
        streamError: null,
        fps: 0,
        quality: { maxSize: 1280, maxFps: 30 },
        recording: false,
        debug: null,
        note: null,
        claimSessionId: null,
        secure: null,
        secView: 'stream',
        secBusy: false,
        secSteps: null,
        outline: null,
        secCanvasVisible: false,
        streamSize: null,
    };
    pollTimer = null;
    secLumTimer = null;
    secVisStreak = 0;
    fpsTimer = null;
    stream = null;
    pollImgTimer = null;
    canvasRef = null;
    imgRef = null;
    frameCount = 0;
    frameTotal = 0;
    pointer = null;
    gestureMoved = false;
    lastReattachAt = 0;
    h264Retries = 0;
    pref = 'auto';
    lease = null;
    magEl = null;
    magCleanup = null;
    componentDidMount() {
        ensureFontLink();
        try {
            const saved = localStorage.getItem(PREF_KEY);
            if (saved === 'dock' || saved === 'overlay')
                this.pref = saved;
        }
        catch {
            /* 隐私模式等：保持 auto */
        }
        this.dispatchState();
        this.pollTimer = setInterval(() => void this.poll(), 2_000);
        // B22f：FLAG_SECURE 画面可见性实证——客户端直接采样显示像素（黑屏 vs 内容），2s 周期
        this.secLumTimer = setInterval(() => this.sampleSecVisibility(), 2_000);
        this.fpsTimer = setInterval(() => {
            this.setState({ fps: this.frameCount });
            this.frameCount = 0;
        }, 1_000);
        const onToggle = () => this.setOpen(!this.state.open);
        window.addEventListener('dsh-android-pane:toggle', onToggle);
        this.removeToggle = () => window.removeEventListener('dsh-android-pane:toggle', onToggle);
        this.onResize = () => this.syncForm();
        window.addEventListener('resize', this.onResize);
        this.onKeyDown = (e) => {
            if (e.key === 'Escape' && this.state.open)
                this.setOpen(false);
        };
        window.addEventListener('keydown', this.onKeyDown);
        void this.poll();
    }
    removeToggle = () => undefined;
    onResize = () => undefined;
    onKeyDown = () => undefined;
    componentDidUpdate() {
        this.dispatchState();
    }
    componentWillUnmount() {
        if (this.pollTimer != null)
            clearInterval(this.pollTimer);
        if (this.fpsTimer != null)
            clearInterval(this.fpsTimer);
        if (this.secLumTimer != null)
            clearInterval(this.secLumTimer);
        this.stopStream();
        this.releaseLease();
        this.magCleanup?.();
        this.removeToggle();
        window.removeEventListener('resize', this.onResize);
        window.removeEventListener('keydown', this.onKeyDown);
    }
    setOpen(open) {
        this.setState({ open }, () => {
            if (open) {
                void this.poll();
                this.syncForm();
                // 重开面板：serial 保留（记忆用户选择）但流已停——必须主动重连，
                // 否则 poll() 的自动连分支（serial==null 才触发）被跳过 → 冻在假 poll 态（实测缺陷）
                if (this.state.serial != null)
                    void this.attach(this.state.serial);
            }
            else {
                this.stopStream();
                this.releaseLease();
            }
        });
    }
    /** 停靠租约生命周期：开面板时按 pref/窗宽决定形态；claim 失败（他人持租约/窄窗）→ 浮窗降级。 */
    syncForm() {
        if (!this.state.open)
            return;
        const narrow = window.innerWidth < 1000;
        const shouldDock = !narrow && (this.pref === 'dock' || (this.pref === 'auto' && window.innerWidth >= DOCK_MIN_W));
        if (shouldDock && this.state.form === 'dock' && this.lease != null)
            return; // 已停靠
        if (shouldDock) {
            const root = document.getElementById('root');
            const lease = root != null
                ? claimRootDock(root, DAP_DOCK_OWNER, DOCK_W, Number.parseFloat(window.getComputedStyle(root).marginRight))
                : undefined;
            if (lease != null) {
                this.releaseLease();
                this.lease = lease;
                lease.update(DOCK_W);
                if (this.state.form !== 'dock')
                    this.setState({ form: 'dock' });
                return;
            }
        }
        this.releaseLease();
        if (this.state.form !== 'overlay')
            this.setState({ form: 'overlay' });
    }
    releaseLease() {
        this.lease?.release();
        this.lease = null;
    }
    toggleForm() {
        this.pref = this.state.form === 'dock' ? 'overlay' : 'dock';
        try {
            localStorage.setItem(PREF_KEY, this.pref);
        }
        catch {
            /* ignore */
        }
        this.syncForm();
    }
    async poll() {
        if (document.hidden)
            return;
        try {
            const st = await api('/session-state');
            const dv = await api('/devices');
            const claims = st.claims ?? [];
            // 自动跟随（iOS 面板语义）：agent attach 的设备 → 面板自动打开并连接到该设备的流
            const claimed = claims[0]?.serial;
            if (claimed != null && claimed !== this.state.serial) {
                this.setState({ open: true, devices: dv.devices, quality: dv.quality, busy: Object.values(st.busy).some(Boolean), secure: null, secView: 'stream', secSteps: null, outline: null }, () => this.syncForm());
                void this.attach(claimed);
                return;
            }
            // 面板已开、无认领、恰一台在线设备、尚未连接 → 自动连（单人单机的最常见场景）
            const online = dv.devices.filter((d) => d.state === 'device');
            if (this.state.open && this.state.serial == null && online.length >= 1) {
                const target = online.find((d) => d.claimedBy != null)?.serial ?? online[0].serial;
                void this.attach(target);
                return;
            }
            // h264 静默自愈：10s 无任何帧/心跳（desync 卡死等）→ 静默重连一次（15s 防抖）
            if (this.state.mode === 'h264' && this.state.serial != null && this.stream != null) {
                const silentFor = Date.now() - Math.max(this.stream.lastFrameAt, this.stream.startedAt);
                if (silentFor > 10_000 && Date.now() - this.lastReattachAt > 15_000) {
                    this.lastReattachAt = Date.now();
                    this.stopStream();
                    void this.attach(this.state.serial);
                    return;
                }
            }
            // 解码饥荒看门狗：字节在流（心跳续着）但 >12s 零解码帧——重放缓存不可解码（缺 config/IDR）的
            // 典型症状 → 重连触发服务端 ensureDecodableStream 重启会话拿新关键帧（15s 防抖）
            if (this.state.mode === 'h264' && this.state.serial != null && this.stream != null &&
                this.stream.frames === 0 && Date.now() - this.stream.startedAt > 12_000 &&
                Date.now() - this.lastReattachAt > 15_000) {
                this.lastReattachAt = Date.now();
                this.stopStream();
                void this.attach(this.state.serial);
                return;
            }
            // poll 降级自愈：attach 失败/保险丝冷却期间没有任何自动恢复路径 → 永远卡「重连中」（实测死锁）。
            // 每 15s 静默重试一次；服务端保险丝未冷却时快速返回，冷却后自然恢复 h264（15s 节奏 < 保险丝 6 次/60s 预算）
            if (this.state.mode === 'poll' && this.state.serial != null && this.state.open && !document.hidden &&
                Date.now() - this.lastReattachAt > 15_000) {
                this.lastReattachAt = Date.now();
                void this.attach(this.state.serial);
                return;
            }
            const patch = {
                devices: dv.devices,
                quality: dv.quality,
                busy: Object.values(st.busy).some(Boolean),
                debug: this.state.serial != null ? (st.debug?.[this.state.serial] ?? null) : this.state.debug,
                claimSessionId: this.state.serial != null ? (st.claims.find((cl) => cl.serial === this.state.serial)?.sessionId.slice(8, 16) ?? null) : null,
                // 保留客户端侧错误（onDead/解码失败），仅当服务端有新错误时覆盖
                streamError: this.state.serial != null ? (st.streamErrors?.[this.state.serial] ?? this.state.streamError) : this.state.streamError,
                // B22：FLAG_SECURE 状态随轮询推送
                secure: this.state.serial != null ? (st.secure?.[this.state.serial] ?? null) : null,
            };
            this.setState(patch);
            // FLAG_SECURE 退出 → 自动退出降级内容通道与缓解步骤（横幅随 secure=false 消失）
            if (this.state.secure?.secure !== true &&
                (this.state.secView === 'outline' || this.state.secSteps != null || this.state.outline != null)) {
                this.setState({ secView: 'stream', secSteps: null, outline: null });
            }
            // 健康流自清错：h264 稳定出帧后，残留的瞬态错误文案立即消失（防红色异常字常驻——用户实测反馈）
            if (this.state.mode === 'h264' && this.stream != null && this.stream.frames > 10 &&
                (this.state.streamError != null || this.state.error != null)) {
                this.setState({ streamError: null, error: null });
            }
            if (this.state.serial != null && !dv.devices.some((d) => d.serial === this.state.serial)) {
                this.setState({ serial: null, mode: null });
                this.stopStream();
            }
        }
        catch {
            /* adb 不在 / 服务未挂载：静默轮询 */
        }
    }
    dispatchState() {
        const online = this.state.devices.filter((d) => d.state === 'device').length;
        window.dispatchEvent(new CustomEvent('dsh-android-pane:state', { detail: { open: this.state.open, online, busy: this.state.busy } }));
    }
    stopStream() {
        this.stream?.stop();
        this.stream = null;
        if (this.pollImgTimer != null) {
            clearInterval(this.pollImgTimer);
            this.pollImgTimer = null;
        }
    }
    /** attach 代际守卫：用户切设备/重连会让旧代 attach 的所有异步回调（含定时重试）作废，
     *  防止并发 attach 互相覆盖（实测：切设备被旧自愈重试抢回 → 选中项弹回 + 错误闪烁）。 */
    attachSeq = 0;
    async attach(serial, retried = false) {
        const seq = ++this.attachSeq;
        const stale = () => seq !== this.attachSeq;
        this.setState({ error: null });
        try {
            const r = await api('/attach', { serial });
            if (stale())
                return;
            if (r.mode === 'poll' && !retried && r.streamError != null) {
                // 设备端 encoder 释放竞态等瞬态失败：1.5s 后重试一次
                await new Promise((res) => setTimeout(res, 1_500));
                if (stale())
                    return;
                return this.attach(serial, true);
            }
            if (stale())
                return;
            this.setState({ serial: r.serial, mode: r.mode, streamError: r.streamError, error: null });
            this.stopStream();
            if (r.mode === 'h264') {
                const gen = seq;
                this.stream = new StreamReader(r.serial, () => {
                    this.frameCount++;
                    this.frameTotal++;
                    if (this.frameTotal > 5)
                        this.h264Retries = 0; // 稳定出帧 → 重置重连预算
                }, (meta) => {
                    this.setState({ streamSize: { w: meta.w, h: meta.h } });
                    const c = this.canvasRef;
                    if (c != null) {
                        c.width = meta.w;
                        c.height = meta.h;
                    }
                }, (reason) => {
                    if (stale())
                        return; // 旧代 reader 的死亡事件不污染新代状态
                    this.setState({ streamError: reason, mode: 'poll' });
                    this.startPollImg();
                    // 流被服务端旧流 teardown 竞态立即掐断（典型：页面刷新后 attach 撞上重建窗口）：
                    // 不粘死在 poll 降级——静默重连恢复 h264（≤3 次，出帧重置；2.5s 退避）
                    if (this.h264Retries < 3 && this.state.serial != null) {
                        this.h264Retries++;
                        const s = this.state.serial;
                        this.lastReattachAt = Date.now();
                        setTimeout(() => {
                            if (this.attachSeq !== gen)
                                return; // 用户已切走/ newer 操作：作废
                            if (this.state.open && this.state.serial === s && this.state.mode === 'poll' && !document.hidden) {
                                void this.attach(s);
                            }
                        }, 2_500);
                    }
                }, (vf) => {
                    const c = this.canvasRef;
                    if (c != null) {
                        const ctx2d = c.getContext('2d');
                        ctx2d?.drawImage(vf, 0, 0, c.width, c.height);
                    }
                });
                this.frameCount = 0;
                await this.stream.start().catch((e) => {
                    if (stale())
                        return;
                    this.setState({ streamError: String(e).replace(/^Error:\s*/, '').slice(0, 200), mode: 'poll' });
                    this.startPollImg();
                });
            }
            else {
                this.startPollImg();
            }
        }
        catch (e) {
            if (stale())
                return;
            this.setState({ error: String(e instanceof Error ? e.message : e).slice(0, 220) });
        }
    }
    startPollImg() {
        if (this.pollImgTimer != null)
            clearInterval(this.pollImgTimer);
        this.pollImgTimer = setInterval(() => {
            const img = this.imgRef;
            if (img != null && this.state.serial != null && !document.hidden) {
                img.src = `${API}/frame?serial=${encodeURIComponent(this.state.serial)}&t=${Date.now()}`;
                this.frameCount++;
            }
        }, 600);
    }
    async act(body) {
        if (this.state.serial == null)
            return;
        try {
            await api('/act', { serial: this.state.serial, ...body });
        }
        catch (e) {
            this.setState({ error: String(e instanceof Error ? e.message : e).slice(0, 200) });
            setTimeout(() => this.setState({ error: null }), 4000);
        }
    }
    canvasPoint(e) {
        const el = (this.canvasRef ?? this.imgRef);
        if (el == null)
            return null;
        const rect = el.getBoundingClientRect();
        const srcW = this.canvasRef != null && this.canvasRef.width > 0 ? this.canvasRef.width : el.naturalWidth ?? 0;
        const srcH = this.canvasRef != null && this.canvasRef.height > 0 ? this.canvasRef.height : el.naturalHeight ?? 0;
        if (srcW === 0 || srcH === 0 || rect.width === 0)
            return null;
        return {
            x: Math.round(((e.clientX - rect.left) / rect.width) * srcW),
            y: Math.round(((e.clientY - rect.top) / rect.height) * srcH),
        };
    }
    onPointerDown = (e) => {
        if (this.state.busy)
            return;
        const p = this.canvasPoint(e);
        if (p == null)
            return;
        this.pointer = { ...p, t: Date.now() };
        this.gestureMoved = false;
    };
    onPointerMove = (e) => {
        if (this.pointer == null)
            return;
        const p = this.canvasPoint(e);
        if (p == null)
            return;
        if (Math.abs(p.x - this.pointer.x) + Math.abs(p.y - this.pointer.y) > 10)
            this.gestureMoved = true;
        // 拖拽预览不需要逐帧注入：抬起时合成 swipe（简化且省电量）
    };
    onPointerUp = (e) => {
        if (this.pointer == null)
            return;
        const p = this.canvasPoint(e);
        const start = this.pointer;
        this.pointer = null;
        if (p == null)
            return;
        const held = Date.now() - start.t;
        if (this.gestureMoved) {
            void this.act({ action: 'swipe', x: start.x, y: start.y, x2: p.x, y2: p.y, durationMs: Math.min(1200, Math.max(120, held)) });
        }
        else if (held > 600) {
            // 长按：同坐标 swipe（down-move-up 序列 ≈ Android 长按，弹出上下文菜单等）
            void this.act({ action: 'swipe', x: start.x, y: start.y, x2: start.x, y2: start.y, durationMs: Math.min(900, held) });
        }
        else {
            void this.act({ action: 'tap', x: p.x, y: p.y });
        }
    };
    async forceRelease() {
        if (this.state.serial == null)
            return;
        try {
            const r = await api('/claim/release', { serial: this.state.serial });
            this.setState({ claimSessionId: null, note: r.note });
            setTimeout(() => this.setState({ note: null }), 6000);
        }
        catch (e) {
            this.setState({ error: String(e instanceof Error ? e.message : e).slice(0, 200) });
            setTimeout(() => this.setState({ error: null }), 4000);
        }
    }
    async toggleDebug() {
        if (this.state.serial == null)
            return;
        const active = this.state.debug != null;
        try {
            const r = await api(`/debug`, { serial: this.state.serial, action: active ? 'stop' : 'start' });
            if (active) {
                this.setState({ debug: null, note: `${r.note}——对 AI 说「分析调试会话」即可出帧图+日志分析` });
            }
            else {
                this.setState({ debug: { id: r.id ?? `dbg-${Date.now()}`, startedAt: Date.now() }, note: r.note });
            }
            setTimeout(() => this.setState({ note: null }), 8000);
        }
        catch (e) {
            this.setState({ error: String(e instanceof Error ? e.message : e).slice(0, 200) });
            setTimeout(() => this.setState({ error: null }), 4000);
        }
    }
    async toggleRecord() {
        if (this.state.serial == null)
            return;
        try {
            const r = await api('/record', { serial: this.state.serial, recordAction: this.state.recording ? 'stop' : 'start' });
            this.setState({ recording: !this.state.recording, error: r.file != null ? `已保存: ${r.file}` : null });
        }
        catch (e) {
            this.setState({ error: String(e instanceof Error ? e.message : e).slice(0, 200) });
        }
    }
    async setQuality(maxSize, maxFps) {
        try {
            await api('/quality', { maxSize, maxFps });
            if (this.state.serial != null) {
                this.stopStream();
                await this.attach(this.state.serial);
            }
        }
        catch (e) {
            this.setState({ error: String(e instanceof Error ? e.message : e).slice(0, 200) });
        }
    }
    // ── FLAG_SECURE（B22）：尝试显示（缓解链）→ 判定成功重连流 / 失败自动进降级内容通道 ──
    async tryShow() {
        if (this.state.serial == null || this.state.secBusy)
            return;
        this.setState({ secBusy: true, secSteps: null });
        try {
            const r = await api('/secure/mitigate', { serial: this.state.serial });
            this.setState({ secBusy: false, secSteps: r.steps });
            if (r.pixelPossible) {
                // 保留步骤卡（成功原因也要让用户看到，「知道了」收起）；切快照流
                this.setState({ secView: 'stream' });
                this.stopStream();
                void this.attach(this.state.serial);
            }
            else {
                // 失败 → 自动切降级内容通道（控件树文本视图）
                await this.fetchOutline();
            }
        }
        catch (e) {
            this.setState({ secBusy: false, error: String(e instanceof Error ? e.message : e).slice(0, 200) });
            setTimeout(() => this.setState({ error: null }), 4000);
        }
    }
    tapOutline(x, y) {
        void this.act({ action: 'tap', x, y });
    }
    /** B22f：采样当前显示元素（canvas/img）的亮度与方差，判定 FLAG_SECURE 页面是否实际可见。
     *  黑帧：mean≈0 且 std≈0；内容帧：mean 或 std 显著非零。连续 2 次可见才判定（防单帧抖动）。 */
    sampleSecVisibility() {
        if (this.state.secure?.secure !== true || this.state.serial == null || document.hidden) {
            if (this.state.secCanvasVisible)
                this.setState({ secCanvasVisible: false });
            this.secVisStreak = 0;
            return;
        }
        const cv = this.canvasRef;
        const img = this.imgRef;
        const el = cv && cv.width > 0 ? cv : img && img.naturalWidth > 0 ? img : null;
        let mean = 0;
        let std = 0;
        if (el != null) {
            try {
                const t = document.createElement('canvas');
                t.width = 24;
                t.height = 48;
                const g = t.getContext('2d');
                if (g != null) {
                    g.drawImage(el, 0, 0, 24, 48);
                    const d = g.getImageData(0, 0, 24, 48).data;
                    const vals = [];
                    for (let i = 0; i < d.length; i += 4)
                        vals.push((d[i] + d[i + 1] + d[i + 2]) / 3);
                    mean = vals.reduce((a, b) => a + b, 0) / vals.length;
                    std = Math.sqrt(vals.reduce((a, b) => a + (b - mean) * (b - mean), 0) / vals.length);
                }
            }
            catch {
                /* 跨域/未就绪：跳过本次 */
            }
        }
        const visible = mean > 25 || std > 12;
        this.secVisStreak = visible ? this.secVisStreak + 1 : 0;
        const next = this.secVisStreak >= 2;
        if (next !== this.state.secCanvasVisible)
            this.setState({ secCanvasVisible: next });
    }
    async fetchOutline() {
        if (this.state.serial == null)
            return;
        try {
            const r = await api('/secure/outline', { serial: this.state.serial });
            this.setState({ outline: r.nodes, secView: 'outline' });
        }
        catch (e) {
            this.setState({ error: String(e instanceof Error ? e.message : e).slice(0, 220) });
            setTimeout(() => this.setState({ error: null }), 4000);
        }
    }
    // ── magnetic-btn（拍板标志性效果②）：指针靠近 80px 内按钮被吸向指针（rAF lerp 0.18）──
    bindMagnets = (el) => {
        if (el === this.magEl)
            return;
        this.magCleanup?.();
        this.magCleanup = null;
        this.magEl = el;
        if (el == null)
            return;
        if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
            return;
        const items = Array.from(el.querySelectorAll('[data-dap-mag]')).map((b) => ({ b, x: 0, y: 0, tx: 0, ty: 0 }));
        let raf = 0;
        let inside = false;
        const tick = () => {
            let live = false;
            for (const it of items) {
                it.x += (it.tx - it.x) * 0.18;
                it.y += (it.ty - it.y) * 0.18;
                if (Math.abs(it.x) > 0.05 || Math.abs(it.y) > 0.05)
                    live = true;
                else {
                    it.x = it.tx;
                    it.y = it.ty;
                }
                it.b.style.transform = `translate(${it.x.toFixed(2)}px, ${it.y.toFixed(2)}px)`;
            }
            if (live || inside) {
                raf = requestAnimationFrame(tick);
            }
            else {
                raf = 0;
                for (const it of items)
                    it.b.style.transform = '';
            }
        };
        const onMove = (e) => {
            inside = true;
            for (const it of items) {
                const r = it.b.getBoundingClientRect();
                const dx = e.clientX - (r.left + r.width / 2);
                const dy = e.clientY - (r.top + r.height / 2);
                if (Math.hypot(dx, dy) < 80) {
                    it.tx = dx * 0.25;
                    it.ty = dy * 0.25;
                }
                else {
                    it.tx = 0;
                    it.ty = 0;
                }
            }
            if (raf === 0)
                raf = requestAnimationFrame(tick);
        };
        const onLeave = () => {
            inside = false;
            for (const it of items) {
                it.tx = 0;
                it.ty = 0;
            }
            if (raf === 0)
                raf = requestAnimationFrame(tick);
        };
        el.addEventListener('pointermove', onMove);
        el.addEventListener('pointerleave', onLeave);
        this.magCleanup = () => {
            el.removeEventListener('pointermove', onMove);
            el.removeEventListener('pointerleave', onLeave);
            if (raf !== 0)
                cancelAnimationFrame(raf);
            for (const it of items)
                it.b.style.transform = '';
        };
    };
    render() {
        if (!this.state.open) {
            return h('div', { style: { display: 'none' } });
        }
        const { devices, serial, busy, mode, error, streamError, fps, quality, recording, form, debug, note, claimSessionId } = this.state;
        const online = devices.filter((d) => d.state === 'device');
        const sel = serial ?? (online.length === 1 ? online[0].serial : '');
        const docked = form === 'dock';
        const errMsg = streamError ?? error;
        // 瞬态错误分类：自愈重试尚有预算时，409/断流/限频等只作「重连中」灰字提示，不渲染红色异常（防错误闪烁刷屏）
        const TRANSIENT_RE = /HTTP 409|串流结束|串流中断|重启过频/;
        const recovering = errMsg != null && mode === 'poll' && this.h264Retries < 3 && TRANSIENT_RE.test(errMsg);
        // B22f：画面可见性实证（客户端像素采样）→ 横幅隐藏（画面本就可看）；黑屏才提示
        const snapVisible = this.state.secCanvasVisible;
        const screenCursor = busy ? 'not-allowed' : 'grab';
        return h('div', {
            className: `dap-pane ${docked ? 'dap-dock' : 'dap-overlay'}`,
            role: 'complementary',
            'aria-label': 'Android 设备面板',
        }, 
        // 头部：贴纸标题 + 设备菜单 + 形态切换 + 关闭
        h('div', { className: 'dap-head' }, h('span', { className: 'dap-title' }, 'DROID'), h('select', {
            className: 'dap-select',
            value: sel,
            onChange: (e) => {
                const v = e.target.value;
                if (v != null && v !== '' && v !== this.state.serial) {
                    this.stopStream();
                    this.setState({ serial: v, mode: null, streamError: null, error: null, recording: false, secure: null, secView: 'stream', secSteps: null, outline: null, streamSize: null });
                    void this.attach(v);
                }
            },
        }, online.length === 0 ? h('option', { value: '' }, '无在线设备') : null, online.map((d) => h('option', { key: d.serial, value: d.serial }, `${d.name ?? d.model ?? d.serial}${d.claimedBy != null ? ' · 智能体认领中' : ''}`))), h('button', { className: 'dap-btn2', title: docked ? '切到浮窗' : '停靠到右侧', onClick: () => this.toggleForm() }, docked ? '◫' : '▥'), h('button', { className: 'dap-btn2', title: '关闭面板（Esc）', onClick: () => this.setOpen(false) }, '✕')), 
        // 锁定徽标：被智能体会话认领 → 全程锁（用户可强制解锁接管）
        claimSessionId != null
            ? h('div', { className: 'dap-busy' }, h('span', null, `🔒 智能体锁定中 · ${claimSessionId}`), h('button', { className: 'dap-unlock', title: '强制释放认领锁（原会话下次操作需重新 attach）', onClick: () => void this.forceRelease() }, '强制解锁'))
            : busy
                ? h('div', { className: 'dap-busy' }, '智能体操作中 · 请稍候')
                : null, 
        // FLAG_SECURE 横幅（B22）：仅在「检测到但未可见（h264 黑屏）」或「大纲模式」时出现；
        // 快照流已可见时隐藏（B22e 用户反馈：都看到了就不必再提示，状态看 FPS 行「快照流 · FLAG_SECURE 可见」）
        this.state.secure?.secure === true && serial != null && !snapVisible
            ? h('div', { className: 'dap-secrow' }, h('span', {
                className: 'dap-sectext',
                title: 'FLAG_SECURE：应用声明此页面禁止截屏/录屏，系统层面屏蔽画面（非面板故障）',
            }, `🔒 FLAG_SECURE${this.state.secure.pkg != null ? ` · ${this.state.secure.pkg}` : ''}`), this.state.secView === 'outline'
                ? h('button', { className: 'dap-btn2', title: '回到画面视图（FLAG_SECURE 下仍为黑屏）', onClick: () => this.setState({ secView: 'stream' }) }, '切回画面')
                : h('button', { className: 'dap-btn2', disabled: this.state.secBusy, title: '执行 adb root 等必要动作并判定像素是否可见', onClick: () => void this.tryShow() }, this.state.secBusy ? '尝试中…' : '尝试显示'))
            : null, 
        // 画面区：三态（连接中骨架屏 / 空态 / 直播画面）+ FLAG_SECURE 降级内容通道
        h('div', {
            className: 'dap-screen',
            onPointerDown: this.onPointerDown, onPointerMove: this.onPointerMove, onPointerUp: this.onPointerUp,
        }, this.state.secView === 'outline' && this.state.outline != null
            ? h('div', { className: 'dap-outline' }, h('div', { className: 'dap-outline-hd' }, h('span', null, 'FLAG_SECURE 页面 · 目前设备状态不支持显示画面，已切至内容通道（控件树文本视图）'), h('button', { className: 'dap-btn2', title: '重新读取控件树', onClick: () => void this.fetchOutline() }, '刷新')), h('div', { className: 'dap-outline-list' }, this.state.outline.length === 0 ? h('div', { className: 'dap-outline-empty' }, '无可见文本节点') : null, this.state.outline.map((n, i) => h('button', {
                key: i,
                className: `dap-outline-item${n.clickable ? ' ck' : ''}`,
                style: { paddingLeft: `${6 + Math.min(n.depth, 10) * 12}px` },
                title: n.clickable ? '点击 = 点按该元素中心' : '仅文本（不可点）',
                onClick: () => this.tapOutline(n.center[0], n.center[1]),
            }, h('span', { className: 'dap-ot' }, n.text || n.desc), h('span', { className: 'dap-oc' }, (n.clickable ? '▸ ' : '') + (n.cls.split('.').pop() ?? n.cls))))))
            : mode === 'poll'
                ? h('img', {
                    ref: (el) => {
                        this.imgRef = el;
                    },
                    src: serial != null ? `${API}/frame?serial=${encodeURIComponent(serial)}&t=${Date.now()}` : undefined,
                    draggable: false,
                    alt: '设备画面（截图轮播）',
                })
                : mode === 'h264'
                    ? h('canvas', {
                        width: this.state.streamSize?.w,
                        height: this.state.streamSize?.h,
                        ref: (el) => {
                            this.canvasRef = el;
                        },
                        style: { touchAction: 'none', cursor: screenCursor },
                    })
                    : null, // mode==null：连接中，只显示骨架屏（不渲染残留画面）
        serial == null && online.length === 0
            ? h('div', { className: 'dap-state' }, h('svg', { viewBox: '0 0 24 24', width: 54, height: 54, fill: 'none', 'aria-hidden': 'true' }, h('path', { d: 'M7.4 4.4 9.1 6.5 M16.6 4.4 14.9 6.5', stroke: '#efe9db', 'stroke-width': '1.5', 'stroke-linecap': 'round' }), h('path', { d: 'M4.6 15.2 a7.4 7.4 0 0 1 14.8 0 Z', fill: '#efe9db' }), h('circle', { cx: '9.3', cy: '12.6', r: '0.95', fill: '#3a3128' }), h('circle', { cx: '14.7', cy: '12.6', r: '0.95', fill: '#3a3128' })), h('div', { className: 'dap-state-txt' }, '没有在线设备'), h('div', { className: 'dap-state-sub' }, '用 adb 连接一台设备，或启动一个模拟器——面板会自动出现画面'))
            : null, serial == null && online.length > 0
            ? h('div', { className: 'dap-state' }, h('div', { className: 'dap-skel' }), h('div', { className: 'dap-skel b' }), h('div', { className: 'dap-skel c' }), h('div', { className: 'dap-state-txt' }, '连接中…'))
            : null, serial != null && mode == null
            ? h('div', { className: 'dap-state' }, h('div', { className: 'dap-skel' }), h('div', { className: 'dap-skel c' }), h('div', { className: 'dap-state-txt' }, '连接中…'))
            : null), 
        // 工具栏（磁吸按钮组）
        h('div', {
            className: 'dap-head',
            ref: this.bindMagnets,
        }, h('button', { className: 'dap-btn2', 'data-dap-mag': '1', title: '返回 BACK', onClick: () => void this.act({ action: 'key', key: 'back' }) }, '←'), h('button', { className: 'dap-btn2', 'data-dap-mag': '1', title: 'HOME', onClick: () => void this.act({ action: 'key', key: 'home' }) }, '⌂'), h('button', { className: 'dap-btn2', 'data-dap-mag': '1', title: '多任务 RECENTS', onClick: () => void this.act({ action: 'key', key: 'recents' }) }, '▭'), h('button', { className: 'dap-btn2', 'data-dap-mag': '1', title: '音量+', onClick: () => void this.act({ action: 'key', key: 'volume_up' }) }, 'Vol+'), h('button', { className: 'dap-btn2', 'data-dap-mag': '1', title: '音量-', onClick: () => void this.act({ action: 'key', key: 'volume_down' }) }, 'Vol-'), h('button', { className: 'dap-btn2', 'data-dap-mag': '1', title: '旋转', onClick: () => void this.act({ action: 'rotate' }) }, '⟳'), h('button', {
            className: 'dap-btn2', 'data-dap-mag': '1', title: '截图保存',
            onClick: () => { if (serial != null)
                window.open(`${API}/frame?serial=${encodeURIComponent(serial)}`, '_blank'); },
        }, '截图'), h('button', {
            className: `dap-btn2${recording ? ' dap-rec' : ''}`, 'data-dap-mag': '1', title: '录屏开/停',
            onClick: () => void this.toggleRecord(),
        }, recording ? '停' : '录'), h('button', {
            className: `dap-btn2${debug != null ? ' dap-rec' : ''}`, 'data-dap-mag': '1',
            title: '调试会话：录屏(分段)+logcat 全量+操作时间线，host 强制托管',
            onClick: () => void this.toggleDebug(),
        }, debug != null ? `⏺ ${Math.floor((Date.now() - debug.startedAt) / 60000)}:${String(Math.floor(((Date.now() - debug.startedAt) / 1000) % 60)).padStart(2, '0')}` : '调试')), 
        // 画质行
        h('div', { className: 'dap-meta' }, h('span', null, `FPS ${fps}`), h('span', null, mode != null ? (mode === 'h264' ? 'H.264 实时' : this.state.secure?.secure === true && this.state.secure?.captureVisible === true ? '快照流 · FLAG_SECURE 可见' : '截图轮播（降级）') : '未连接'), h('span', { className: 'grow' }), h('select', {
            className: 'dap-mini',
            value: String(quality.maxSize),
            onChange: (e) => void this.setQuality(Number(e.target.value), quality.maxFps),
        }, [[0, '原生'], [800, '800p'], [1280, '1280'], [1920, '1920']].map(([v, label]) => h('option', { key: String(v), value: String(v) }, `清晰度 ${label}`))), h('select', {
            className: 'dap-mini',
            value: String(quality.maxFps),
            onChange: (e) => void this.setQuality(quality.maxSize, Number(e.target.value)),
        }, [15, 30, 60].map((v) => h('option', { key: v, value: String(v) }, `${v} fps`)))), 
        // 错误行：瞬态 → 灰字「重连中」；真异常 → 红字 + 一键重试
        errMsg != null && serial != null
            ? h('div', { className: recovering ? 'dap-reconnect' : 'dap-errrow' }, h('span', null, recovering ? `重连中… ${errMsg}` : errMsg), recovering ? null : h('button', { className: 'dap-btn2', onClick: () => void this.attach(serial) }, '重试'))
            : null, 
        // FLAG_SECURE 缓解链结果（B22）：每步 ✓/✗/⏭/💡 + 明确判定；点「知道了」收起
        this.state.secSteps != null
            ? h('div', { className: 'dap-secsteps' }, this.state.secSteps.map((s, i) => h('div', { key: i, className: `dap-step st-${s.status}` }, h('span', { className: 'dap-st-ic' }, s.status === 'ok' ? '✓' : s.status === 'failed' ? '✗' : s.status === 'hint' ? '💡' : '⏭'), h('span', { className: 'dap-st-nm' }, s.step), h('span', { className: 'dap-st-dt' }, s.detail))), h('button', { className: 'dap-btn2', onClick: () => this.setState({ secSteps: null }) }, '知道了'))
            : null, 
        // 提示行（调试会话开/关反馈）
        note != null ? h('div', { className: 'dap-note-hl' }, note) : null, 
        // 隐私提示
        h('div', { className: 'dap-note' }, '受控设备勿登录真实账号（截屏会发给模型）· 点击=点按，拖动=滑动，长按=长按'));
    }
}
/** 头部入口按钮：渐变胶囊 + 光泽扫过 + 按压缩放 + 设备呼吸灯 + 面板开启高亮态。 */
export function PaneSidebarButton() {
    const [open, setOpen] = useState(false);
    const [online, setOnline] = useState(0);
    useEffect(() => {
        const onState = (e) => {
            const d = e.detail;
            if (d == null)
                return;
            setOpen(!!d.open);
            setOnline(d.online ?? 0);
        };
        window.addEventListener('dsh-android-pane:state', onState);
        return () => window.removeEventListener('dsh-android-pane:state', onState);
    }, []);
    return h('button', {
        className: `dap-btn${open ? ' dap-open' : ''}`,
        onClick: () => window.dispatchEvent(new CustomEvent('dsh-android-pane:toggle')),
        title: 'Android 设备画面面板（点击开/关）',
        'aria-pressed': open ? 'true' : 'false',
    }, h('span', { className: 'dap-ico', 'aria-hidden': 'true' }, h('svg', { viewBox: '0 0 24 24', fill: 'none' }, h('defs', null, h('linearGradient', { id: 'dap-grad', x1: '0', y1: '0', x2: '1', y2: '1' }, h('stop', { offset: '0', 'stop-color': '#3ddc84' }), h('stop', { offset: '1', 'stop-color': '#38bdf8' }))), 
    // 天线
    h('path', { d: 'M7.4 4.4 9.1 6.5 M16.6 4.4 14.9 6.5', stroke: '#3ddc84', 'stroke-width': '1.5', 'stroke-linecap': 'round' }), 
    // 头部（半圆拱 + 平底）
    h('path', { d: 'M4.6 15.2 a7.4 7.4 0 0 1 14.8 0 Z', fill: 'url(#dap-grad)' }), 
    // 眼睛
    h('circle', { cx: '9.3', cy: '12.1', r: '0.95', fill: '#0d1420' }), h('circle', { cx: '14.7', cy: '12.1', r: '0.95', fill: '#0d1420' }), 
    // 投屏波纹（右下，青色，逐道点亮/流动）
    h('path', { className: 'dap-wave w1', d: 'M14.6 17.4 a4.6 4.6 0 0 1 4.6 4.6', stroke: '#38bdf8', 'stroke-width': '1.6', 'stroke-linecap': 'round' }), h('path', { className: 'dap-wave w2', d: 'M14.6 19.8 a2.2 2.2 0 0 1 2.2 2.2', stroke: '#38bdf8', 'stroke-width': '1.6', 'stroke-linecap': 'round' }), h('circle', { className: 'dap-wave w3', cx: '21', cy: '22', r: '1.05', fill: '#38bdf8' }))), h('span', { className: 'dap-label' }, 'Android 面板'), online > 0 ? h('span', { className: 'dap-dot', title: `${online} 台设备在线` }) : h('span', { className: 'dap-dot off' }), h('span', { className: 'dap-shine', 'aria-hidden': 'true' }));
}
export const inject = ['slots'];
export function apply(ctx) {
    ensureBtnStyles();
    ensurePaneStyles();
    ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: `${NS}:pane`, order: 90 }, PaneWindow)), `${NS}: overlay/dock pane`);
    ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({ name: 'conversation.session.header.utilities', id: `${NS}:entry`, order: -1 }, PaneSidebarButton)), `${NS}: header utilities entry（Session log 左侧紧贴）`);
    void openCount;
}
//# sourceMappingURL=index.js.map
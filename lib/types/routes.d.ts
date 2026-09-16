/**
 * HTTP 传输面（host half）：/​_dsh/dsh-android-pane/ 前缀路由。
 * 门禁（沿用 dsh-session-manager 的传输纪律，Phase 2 实测来源）：
 *  - 仅 loopback 对端（127/8、::1、::ffff:127.x）→ 其余 403；
 *  - 变更类 POST 追加同源校验（浏览器带 Origin 时必须与 Host 一致）；
 *  - JSON 体上限 64KB（暂停读取，防 413 竞态）；错误一律 {ok:false,error:{code,message}}。
 *  - GET /stream 为长连接流式响应（分帧 H.264），对端断开即回收订阅。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PaneHub } from './pane-service.js';
export declare const ROUTE_PREFIX = "/_dsh/dsh-android-pane";
export declare function mountPaneRoutes(webServer: {
    register(route: {
        kind: 'exact' | 'prefix';
        path: string;
        handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
    }): () => void;
}, hub: PaneHub, sessionIdOf: (req: IncomingMessage) => string | null): () => void;

import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import z from "@deepseek-ai/schemastery";
import { execFile, spawn } from "node:child_process";
import { connect, createServer, isIP } from "node:net";
import { closeSync, constants, createReadStream, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { defineTool } from "@deepseek-ai/dsh-tools";
//#region src/adb.ts
/**
* adb 命令薄封装：所有设备交互的唯一出口。
* - run(): execFile + AbortSignal 转发 + 超时（工具取消 → 进程杀掉）
* - devices(): `devices -l` 解析 + 模拟器识别（emulator-N / 127.0.0.1:N）
* - shell/push/forward/emu-kill/screencap/uiautomator 等原语
* 约定：命令失败时抛出点名 adb 与参数的 Error（fail loud，无静默回退）。
*/
var AdbError = class extends Error {
	args;
	code;
	stderr;
	constructor(message, args, code, stderr) {
		super(`${message} (adb ${args.join(" ")}${code === null ? "" : ` exit=${code}`}${stderr ? ` stderr=${stderr.slice(0, 300)}` : ""})`);
		this.args = args;
		this.code = code;
		this.stderr = stderr;
		this.name = "AdbError";
	}
};
var Adb = class {
	adbPath;
	defaultTimeoutMs;
	constructor(adbPath, defaultTimeoutMs = 15e3) {
		this.adbPath = adbPath;
		this.defaultTimeoutMs = defaultTimeoutMs;
	}
	/** adb 可执行文件路径（供 spawn 场景复用）。 */
	get path() {
		return this.adbPath;
	}
	/** 执行一条 adb 子命令；signal 取消会 kill 进程。 */
	run(args, opts = {}) {
		const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
		return new Promise((resolve, reject) => {
			const child = execFile(this.adbPath, [...args], {
				timeout: timeoutMs,
				maxBuffer: 64 * 1024 * 1024,
				killSignal: "SIGKILL",
				windowsHide: true
			}, (err, stdout, stderr) => {
				if (err != null && typeof err.code !== "string") {
					reject(new AdbError(`adb 启动失败：${String(err.code ?? err.message)}`, args, null, String(stderr ?? "")));
					return;
				}
				resolve({
					code: err ? err.code ?? 1 : 0,
					stdout: String(stdout ?? ""),
					stderr: String(stderr ?? "")
				});
			});
			if (opts.signal != null) {
				const onAbort = () => child.kill("SIGKILL");
				if (opts.signal.aborted) onAbort();
				else opts.signal.addEventListener("abort", onAbort, { once: true });
			}
		});
	}
	/** 期待退出码 0 的 run，否则抛 AdbError。 */
	async runOk(args, opts = {}) {
		const r = await this.run(args, opts);
		if (r.code !== 0) throw new AdbError("adb 命令失败", args, r.code, r.stderr);
		return r.stdout;
	}
	async devices(signal) {
		const out = await this.runOk(["devices", "-l"], { signal });
		const list = [];
		for (const line of out.split("\n").slice(1)) {
			const trimmed = line.trim();
			if (trimmed === "") continue;
			const parts = trimmed.split(/\s+/);
			if (parts.length < 2) continue;
			const serial = parts[0];
			const state = parts[1];
			const kv = {};
			for (const p of parts.slice(2)) {
				const i = p.indexOf(":");
				if (i > 0) kv[p.slice(0, i)] = p.slice(i + 1);
			}
			list.push({
				serial,
				state,
				model: kv.model ?? null,
				device: kv.device ?? null,
				product: kv.product ?? null,
				isEmulator: /^emulator-\d+$/.test(serial) || /^127\.0\.0\.1:\d+$/.test(serial)
			});
		}
		return list;
	}
	async shell(serial, cmd, opts = {}) {
		return this.run([
			"-s",
			serial,
			"shell",
			cmd
		], opts);
	}
	async shellOk(serial, cmd, opts = {}) {
		const r = await this.shell(serial, cmd, opts);
		if (r.code !== 0) throw new AdbError(`设备 shell 失败`, [
			"-s",
			serial,
			"shell",
			cmd
		], r.code, r.stderr);
		return r.stdout;
	}
	/** 二进制输出命令（exec-out），返回原始 buffer。 */
	execOutBinary(args, opts = {}) {
		const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
		return new Promise((resolve, reject) => {
			const child = execFile(this.adbPath, [...args], {
				timeout: timeoutMs,
				maxBuffer: 64 * 1024 * 1024,
				killSignal: "SIGKILL",
				encoding: "buffer",
				windowsHide: true
			}, (err, stdout, stderr) => {
				const stderrText = Buffer.isBuffer(stderr) ? stderr.toString("utf8") : String(stderr ?? "");
				if (err != null && err.code !== 0 && err.code !== void 0) {
					reject(new AdbError("adb exec-out 失败", args, err.code ?? null, stderrText));
					return;
				}
				resolve(stdout);
			});
			if (opts.signal != null) {
				const onAbort = () => child.kill("SIGKILL");
				if (opts.signal.aborted) onAbort();
				else opts.signal.addEventListener("abort", onAbort, { once: true });
			}
		});
	}
	async screencap(serial, opts = {}) {
		return this.execOutBinary([
			"-s",
			serial,
			"exec-out",
			"screencap",
			"-p"
		], {
			timeoutMs: opts.timeoutMs ?? 2e4,
			signal: opts.signal
		});
	}
	async push(serial, local, remote, opts = {}) {
		await this.runOk([
			"-s",
			serial,
			"push",
			local,
			remote
		], opts);
	}
	async forward(serial, localPort, abstractName, opts = {}) {
		await this.runOk([
			"-s",
			serial,
			"forward",
			`tcp:${localPort}`,
			`localabstract:${abstractName}`
		], opts);
	}
	async removeForward(serial, localPort) {
		await this.run([
			"-s",
			serial,
			"forward",
			"--remove",
			`tcp:${localPort}`
		], { timeoutMs: 5e3 });
	}
	/** 关停模拟器（仅模拟器使用；真机禁用）。 */
	async emuKill(serial) {
		await this.run([
			"-s",
			serial,
			"emu",
			"kill"
		], { timeoutMs: 8e3 });
	}
	/** 设备品牌信息（一次 getprop 批量取回）。 */
	async getDeviceInfo(serial, opts = {}) {
		const fallback = {
			brand: "",
			market: "",
			model: "",
			type: "手机"
		};
		try {
			const lines = (await this.shell(serial, "getprop ro.product.brand; getprop ro.product.marketname; getprop ro.product.model; getprop ro.build.characteristics", {
				...opts,
				timeoutMs: 6e3
			})).stdout.split("\n").map((l) => l.trim().replace(/\r/g, ""));
			return {
				brand: lines[0] ?? "",
				market: lines[1] ?? "",
				model: lines[2] ?? "",
				type: (lines[3] ?? "").toLowerCase().includes("tablet") ? "平板" : "手机"
			};
		} catch {
			return fallback;
		}
	}
	/** 设备物理/覆盖分辨率（`wm size`，如 "Physical size: 1080x2400"）。 */
	async displaySize(serial, opts = {}) {
		const out = await this.shell(serial, "wm size", opts).catch(() => null);
		if (out == null) return null;
		const m = /(\d+)x(\d+)/.exec(out.stdout);
		if (m == null) return null;
		return {
			w: Number(m[1]),
			h: Number(m[2])
		};
	}
};
function isEmulatorSerial(serial) {
	return /^emulator-\d+$/.test(serial) || /^127\.0\.0\.1:\d+$/.test(serial);
}
//#endregion
//#region src/routes.ts
const ROUTE_PREFIX = "/_dsh/dsh-android-pane";
const MAX_JSON_BODY_BYTES = 64 * 1024;
function isLoopbackPeer(remote) {
	if (remote == null || remote === "") return false;
	if (remote === "::1") return true;
	const m = /^::ffff:(\d+)\.(\d+)\.(\d+)\.(\d+)$/i.exec(remote);
	if (m != null) return Number(m[1]) === 127;
	if (isIP(remote) === 4) return remote.startsWith("127.");
	return false;
}
function sameOriginHost(req) {
	const origin = req.headers.origin;
	if (origin == null) return true;
	const host = req.headers.host;
	if (typeof origin !== "string" || typeof host !== "string" || host.trim() === "") return false;
	try {
		return new URL(origin).host.trim().toLowerCase() === host.trim().toLowerCase();
	} catch {
		return false;
	}
}
/** 临时诊断日志（/tmp/dap-route.log）：定位 /stream 早期 FIN。带 DAP_QUIET=1 时静默。
*  ⚠️ 注入器上下文里同步 require 不可用（会静默抛错），必须动态 import。 */
function dbg(msg) {
	if (process.env.DAP_QUIET != null) return;
	import("node:fs").then((fs) => fs.appendFileSync("/tmp/dap-route.log", `${(/* @__PURE__ */ new Date()).toISOString()} ${msg}\n`)).catch(() => void 0);
}
function sendJson(res, status, body) {
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store"
	});
	res.end(JSON.stringify(body));
}
function sendErr(res, status, code, message) {
	sendJson(res, status, {
		ok: false,
		error: {
			code,
			message
		}
	});
}
function readJsonBody(req) {
	return new Promise((resolve) => {
		const chunks = [];
		let size = 0;
		let aborted = false;
		req.on("data", (d) => {
			if (aborted) return;
			size += d.length;
			if (size > MAX_JSON_BODY_BYTES) {
				aborted = true;
				req.pause();
				resolve(null);
				return;
			}
			chunks.push(d);
		});
		req.on("end", () => {
			if (aborted) return;
			try {
				const text = Buffer.concat(chunks).toString("utf8");
				if (text.trim() === "") resolve({});
				else {
					const parsed = JSON.parse(text);
					if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) resolve(null);
					else resolve(parsed);
				}
			} catch {
				resolve(null);
			}
		});
		req.on("error", () => resolve(null));
	});
}
function strArg(body, key) {
	const v = body[key];
	return typeof v === "string" ? v : void 0;
}
function numArg(body, key) {
	const v = body[key];
	return typeof v === "number" && Number.isFinite(v) ? v : void 0;
}
function mountPaneRoutes(webServer, hub, sessionIdOf, pickDirectory = async (signal) => {
	const { pickNativeDirectory } = await import("@deepseek-ai/dsh-host-directory-picker-native");
	signal.throwIfAborted();
	return pickNativeDirectory(signal);
}) {
	let picker = null;
	const unregister = webServer.register({
		kind: "prefix",
		path: ROUTE_PREFIX,
		handler: async (req, res) => {
			try {
				if (!isLoopbackPeer(req.socket.remoteAddress)) {
					sendErr(res, 403, "forbidden", "仅允许本机访问（loopback）");
					return;
				}
				const url = new URL(req.url ?? "/", `http://127.0.0.1:${req.socket.localPort ?? 3080}`);
				const sub = url.pathname.slice(22);
				const method = (req.method ?? "GET").toUpperCase();
				const serialQ = url.searchParams.get("serial") ?? void 0;
				const body = method === "POST" ? await readJsonBody(req) : {};
				if (method === "POST" && body == null) {
					sendErr(res, 413, "payload-too-large", `请求体超过 ${MAX_JSON_BODY_BYTES} 字节或不是合法 JSON 对象`);
					return;
				}
				const serial = serialQ ?? strArg(body ?? {}, "serial");
				let sessionId = sessionIdOf(req);
				if (sub === "/capture" && method === "GET") {
					sendJson(res, 200, {
						ok: true,
						...hub.captureState()
					});
					return;
				}
				if (sub === "/capture/file" && method === "GET") {
					if (!sameOriginHost(req) || req.headers["sec-fetch-site"] === "cross-site") {
						sendErr(res, 403, "forbidden", "跨源文件预览被拒绝");
						return;
					}
					const id = url.searchParams.get("id") ?? "";
					const rawIndex = url.searchParams.get("index") ?? "";
					if (!/^\d+$/.test(rawIndex)) {
						sendErr(res, 400, "bad-request", "index 须为非负整数");
						return;
					}
					const registered = hub.captureFile(id, Number(rawIndex));
					const fd = openSync(registered.file, constants.O_RDONLY | constants.O_NOFOLLOW);
					try {
						const stat = fstatSync(fd);
						if (!stat.isFile() || stat.dev !== registered.dev || stat.ino !== registered.ino) {
							closeSync(fd);
							sendErr(res, 404, "not-found", "保存文件已被替换");
							return;
						}
						let start = 0, end = stat.size - 1, status = 200;
						const range = req.headers.range;
						if (range != null) {
							const match = /^bytes=(\d*)-(\d*)$/.exec(range);
							if (match == null || !match[1] && !match[2]) {
								closeSync(fd);
								res.writeHead(416, { "content-range": "bytes */" + stat.size });
								res.end();
								return;
							}
							if (match[1]) {
								start = Number(match[1]);
								end = match[2] ? Math.min(Number(match[2]), end) : end;
							} else start = Math.max(0, stat.size - Number(match[2]));
							if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= stat.size || match[1] === "" && Number(match[2]) === 0) {
								closeSync(fd);
								res.writeHead(416, { "content-range": "bytes */" + stat.size });
								res.end();
								return;
							}
							status = 206;
						}
						res.writeHead(status, {
							"content-type": {
								".png": "image/png",
								".mp4": "video/mp4",
								".log": "text/plain; charset=utf-8",
								".json": "application/json; charset=utf-8"
							}[extname(registered.file)] ?? "application/octet-stream",
							"content-length": end - start + 1,
							"accept-ranges": "bytes",
							"cache-control": "no-store",
							"x-content-type-options": "nosniff",
							"cross-origin-resource-policy": "same-origin",
							...status === 206 ? { "content-range": "bytes " + start + "-" + end + "/" + stat.size } : {}
						});
						const stream = createReadStream(registered.file, {
							fd,
							autoClose: true,
							start,
							end
						});
						stream.on("error", () => res.destroy());
						res.on("close", () => stream.destroy());
						stream.pipe(res);
					} catch (e) {
						try {
							closeSync(fd);
						} catch {}
						throw e;
					}
					return;
				}
				if (sub === "/capture/pick-directory" && method === "POST") {
					if (!sameOriginHost(req) || req.headers["sec-fetch-site"] === "cross-site") {
						sendErr(res, 403, "forbidden", "跨源请求被拒绝");
						return;
					}
					if (picker) {
						sendErr(res, 409, "picker-busy", "系统目录选择器已打开");
						return;
					}
					const controller = new AbortController();
					picker = controller;
					const abort = () => controller.abort();
					res.once("close", abort);
					try {
						const directory = await pickDirectory(controller.signal);
						if (!controller.signal.aborted) sendJson(res, 200, {
							ok: true,
							directory
						});
					} finally {
						res.off("close", abort);
						picker = null;
					}
					return;
				}
				if (sub.startsWith("/capture/") && method === "POST") {
					if (!sameOriginHost(req)) {
						sendErr(res, 403, "forbidden", "跨源请求被拒绝");
						return;
					}
					const operation = sub.slice(9);
					if (operation === "directory") {
						const directory = strArg(body ?? {}, "directory");
						if (directory == null) {
							sendErr(res, 400, "bad-request", "缺少 directory");
							return;
						}
						hub.setCaptureDirectory(directory);
					} else {
						if (![
							"screenshot",
							"record",
							"debug",
							"mute"
						].includes(operation)) {
							sendErr(res, 404, "not-found", "未知采集操作");
							return;
						}
						if (serial == null || serial === "") {
							sendErr(res, 400, "bad-request", "缺少 serial");
							return;
						}
						const action = strArg(body ?? {}, "action");
						if ((operation === "record" || operation === "debug") && action !== "start" && action !== "stop") {
							sendErr(res, 400, "bad-request", "action 须为 start|stop");
							return;
						}
						await hub.capturePanel(serial, operation, action);
					}
					sendJson(res, 200, {
						ok: true,
						...hub.captureState()
					});
					return;
				}
				if (sub === "/session-state" && method === "GET") {
					sendJson(res, 200, {
						ok: true,
						...await hub.sessionState()
					});
					return;
				}
				if (sub === "/devices" && method === "GET") {
					sendJson(res, 200, {
						ok: true,
						...await hub.listDevices()
					});
					return;
				}
				if (sub === "/avds" && method === "GET") {
					sendJson(res, 200, {
						ok: true,
						avds: await hub.listAvds()
					});
					return;
				}
				if (sub === "/boot" && method === "POST") {
					if (!sameOriginHost(req)) {
						sendErr(res, 403, "forbidden", "跨源请求被拒绝");
						return;
					}
					const avd = strArg(body ?? {}, "avd");
					if (avd == null || avd === "") {
						sendErr(res, 400, "bad-request", "缺少 avd 参数");
						return;
					}
					sendJson(res, 200, {
						ok: true,
						...await hub.bootEmulator(avd)
					});
					return;
				}
				if (!method || method !== "GET" && method !== "POST") {
					res.writeHead(405, { allow: "GET, POST" });
					res.end();
					return;
				}
				if (sub === "/attach" && method === "POST") {
					if (!sameOriginHost(req)) {
						sendErr(res, 403, "forbidden", "跨源请求被拒绝");
						return;
					}
					if (serial == null || serial === "") {
						sendErr(res, 400, "bad-request", "缺少 serial（面板请先在设备菜单选择设备）");
						return;
					}
					sendJson(res, 200, {
						ok: true,
						...await hub.attachViewer(serial, void 0)
					});
					return;
				}
				if (sub === "/detach" && method === "POST") {
					if (!sameOriginHost(req)) {
						sendErr(res, 403, "forbidden", "跨源请求被拒绝");
						return;
					}
					if (serial == null || serial === "") {
						sendErr(res, 400, "bad-request", "缺少 serial");
						return;
					}
					sendJson(res, 200, {
						ok: true,
						...hub.detach(sessionId, serial)
					});
					return;
				}
				if (sub === "/act" && method === "POST") {
					if (!sameOriginHost(req)) {
						sendErr(res, 403, "forbidden", "跨源请求被拒绝");
						return;
					}
					const action = strArg(body ?? {}, "action");
					if (action == null) {
						sendErr(res, 400, "bad-request", "缺少 action");
						return;
					}
					if (action === "input") {
						sendJson(res, 200, {
							ok: true,
							...hub.panelInput(serial, body?.input)
						});
						return;
					}
					const coordinateSpace = body?.coordinateSpace;
					if (coordinateSpace != null && coordinateSpace !== "physical" && coordinateSpace !== "stream") {
						sendErr(res, 400, "bad-request", "coordinateSpace 须为 stream|physical");
						return;
					}
					const reqAct = {
						coordinateSpace,
						action,
						serial,
						x: numArg(body ?? {}, "x"),
						y: numArg(body ?? {}, "y"),
						x2: numArg(body ?? {}, "x2"),
						y2: numArg(body ?? {}, "y2"),
						durationMs: numArg(body ?? {}, "durationMs"),
						key: strArg(body ?? {}, "key"),
						text: strArg(body ?? {}, "text")
					};
					if (sessionId == null) {
						sendJson(res, 200, {
							ok: true,
							...await hub.actPanel(reqAct)
						});
						return;
					}
					sendJson(res, 200, {
						ok: true,
						...await hub.act(sessionId, reqAct)
					});
					return;
				}
				if (sub === "/stream-mode" && method === "POST") {
					if (!sameOriginHost(req)) {
						sendErr(res, 403, "forbidden", "跨源请求被拒绝");
						return;
					}
					if (serial == null || serial === "") {
						sendErr(res, 400, "bad-request", "缺少 serial");
						return;
					}
					const mode = strArg(body ?? {}, "mode");
					if (mode !== "auto" && mode !== "screenshot") {
						sendErr(res, 400, "bad-request", "mode 须为 auto|screenshot");
						return;
					}
					sendJson(res, 200, {
						ok: true,
						...hub.setStreamMode(serial, mode)
					});
					return;
				}
				if (sub === "/quality" && method === "POST") {
					if (!sameOriginHost(req)) {
						sendErr(res, 403, "forbidden", "跨源请求被拒绝");
						return;
					}
					sendJson(res, 200, {
						ok: true,
						quality: await hub.setQuality({
							maxSize: numArg(body ?? {}, "maxSize"),
							maxFps: numArg(body ?? {}, "maxFps")
						})
					});
					return;
				}
				if (sub === "/record" && method === "POST") {
					if (!sameOriginHost(req)) {
						sendErr(res, 403, "forbidden", "跨源请求被拒绝");
						return;
					}
					const act = strArg(body ?? {}, "recordAction") ?? strArg(body ?? {}, "action");
					if (act !== "start" && act !== "stop") {
						sendErr(res, 400, "bad-request", "recordAction 须为 start|stop");
						return;
					}
					if (serial == null || serial === "") {
						sendErr(res, 400, "bad-request", "缺少 serial");
						return;
					}
					await hub.capturePanel(serial, "record", act);
					sendJson(res, 200, {
						ok: true,
						...hub.captureState()
					});
					return;
				}
				if (sub === "/claim/release" && method === "POST") {
					if (!sameOriginHost(req)) {
						sendErr(res, 403, "forbidden", "跨源请求被拒绝");
						return;
					}
					if (serial == null || serial === "") {
						sendErr(res, 400, "bad-request", "缺少 serial");
						return;
					}
					sendJson(res, 200, {
						ok: true,
						...hub.forceRelease(serial)
					});
					return;
				}
				if (sub === "/debug" && method === "GET") {
					sendJson(res, 200, {
						ok: true,
						...hub.debugStatus(serial ?? void 0)
					});
					return;
				}
				if (sub === "/debug" && method === "POST") {
					if (!sameOriginHost(req)) {
						sendErr(res, 403, "forbidden", "跨源请求被拒绝");
						return;
					}
					const act = strArg(body ?? {}, "action");
					if (act !== "start" && act !== "stop") {
						sendErr(res, 400, "bad-request", "action 须为 start|stop");
						return;
					}
					if (serial == null || serial === "") {
						sendErr(res, 400, "bad-request", "缺少 serial");
						return;
					}
					await hub.capturePanel(serial, "debug", act);
					sendJson(res, 200, {
						ok: true,
						...hub.captureState()
					});
					return;
				}
				if (sub === "/secure/mitigate" && method === "POST") {
					if (!sameOriginHost(req)) {
						sendErr(res, 403, "forbidden", "跨源请求被拒绝");
						return;
					}
					if (serial == null || serial === "") {
						sendErr(res, 400, "bad-request", "缺少 serial");
						return;
					}
					sendJson(res, 200, {
						ok: true,
						...await hub.secureMitigate(serial)
					});
					return;
				}
				if (sub === "/secure/outline" && method === "POST") {
					if (!sameOriginHost(req)) {
						sendErr(res, 403, "forbidden", "跨源请求被拒绝");
						return;
					}
					if (serial == null || serial === "") {
						sendErr(res, 400, "bad-request", "缺少 serial");
						return;
					}
					const nodes = (await hub.uidump(serial)).filter((n) => n.text !== "" || n.desc !== "");
					const info = hub.secureInfo(serial);
					sendJson(res, 200, {
						ok: true,
						serial,
						nodes,
						secure: {
							secure: info?.secure ?? false,
							pkg: info?.pkg ?? null,
							checkedAt: info?.checkedAt ?? 0,
							captureVisible: info?.captureVisible
						}
					});
					return;
				}
				if (sub === "/frame" && method === "GET") {
					if (serial == null || serial === "") {
						sendErr(res, 400, "bad-request", "缺少 serial");
						return;
					}
					const png = await hub.screenshotBuffer(serial);
					res.writeHead(200, {
						"content-type": "image/png",
						"cache-control": "no-store"
					});
					res.end(png);
					return;
				}
				if (sub === "/stream" && method === "GET") {
					if (serial == null || serial === "") {
						sendErr(res, 400, "bad-request", "缺少 serial");
						return;
					}
					dbg(`stream request serial=${serial}`);
					await hub.ensureDecodableStream(serial);
					const session = hub.getStream(serial);
					dbg(`stream session=${session == null ? "null" : session.running ? "running" : "dead"}`);
					if (session == null || !session.running) {
						dbg(`stream 409 no-stream serial=${serial}`);
						sendErr(res, 409, "no-stream", "该设备没有运行中的 H.264 串流（可能处于 poll 降级模式）");
						return;
					}
					res.writeHead(200, {
						"content-type": "application/octet-stream",
						"cache-control": "no-store",
						"x-accel-buffering": "no",
						"transfer-encoding": "chunked"
					});
					const off = session.onFrame((frame) => {
						let ptsFlags = frame.pts;
						if (frame.config) ptsFlags |= 9223372036854775808n;
						if (frame.key) ptsFlags |= 4611686018427387904n;
						const head = Buffer.alloc(16);
						head.writeUInt32BE(1, 0);
						head.writeBigUInt64BE(ptsFlags, 4);
						head.writeUInt32BE(frame.data.length, 12);
						if (!res.writableEnded) res.write(Buffer.concat([head, frame.data]));
					});
					const meta = session.info;
					if (meta != null) {
						const metaJson = Buffer.from(JSON.stringify({
							w: meta.streamWidth,
							h: meta.streamHeight,
							codec: meta.codecString
						}), "utf8");
						const head = Buffer.alloc(16);
						head.writeUInt32BE(0, 0);
						head.writeBigUInt64BE(0n, 4);
						head.writeUInt32BE(metaJson.length, 12);
						res.write(Buffer.concat([head, metaJson]));
					}
					for (const f of session.replayGop()) {
						if (res.writableEnded) break;
						let ptsFlags = f.pts;
						if (f.config) ptsFlags |= 9223372036854775808n;
						if (f.key) ptsFlags |= 4611686018427387904n;
						const fh = Buffer.alloc(16);
						fh.writeUInt32BE(1, 0);
						fh.writeBigUInt64BE(ptsFlags, 4);
						fh.writeUInt32BE(f.data.length, 12);
						res.write(Buffer.concat([fh, f.data]));
					}
					session.touchViewer();
					const pingFrame = Buffer.alloc(16);
					pingFrame.writeUInt32BE(2, 0);
					const ping = setInterval(() => {
						session.touchViewer();
						if (!res.writableEnded) res.write(pingFrame);
					}, 5e3);
					const t0 = Date.now();
					res.on("close", () => {
						dbg(`stream res close serial=${serial} queued=${res.writableLength} ended=${res.writableEnded} at=${Date.now() - t0}ms`);
						clearInterval(ping);
						off();
					});
					dbg(`stream subscribed serial=${serial}`);
					return;
				}
				sendErr(res, 404, "not-found", `未知子路由 ${sub}`);
			} catch (e) {
				const code = e.code;
				const msg = String(e instanceof Error ? e.message : e).slice(0, 400);
				dbg(`route exception path=${req.url?.slice(-40)} headersSent=${res.headersSent} msg=${msg}`);
				if (!res.headersSent) if (code === "bad-request") sendErr(res, 400, code, msg);
				else if (code === "not-found") sendErr(res, 404, code, msg);
				else if (code === "capture-busy") sendErr(res, 409, code, msg);
				else if (code === "agent-busy" || code === "input-busy" || code === "input-stale" || code === "no-stream") sendErr(res, 409, code, msg);
				else sendErr(res, 500, "internal", msg);
				else try {
					res.end();
				} catch {}
			}
		}
	});
	return () => {
		picker?.abort();
		unregister();
	};
}
function validClock(clock) {
	return clock == null || Number.isFinite(clock.minOffsetMs) && Number.isFinite(clock.maxOffsetMs) && clock.maxOffsetMs >= clock.minOffsetMs && clock.maxOffsetMs - clock.minOffsetMs <= 1e3;
}
function validPending(job) {
	if (!job || typeof job.id !== "string" || !/^(record|dbg)-[0-9a-f-]{36}$/.test(job.id) || !["record", "debug"].includes(job.type) || typeof job.serial !== "string" || !job.serial || typeof job.dir !== "string" || !isAbsolute(job.dir) || job.dir.includes("\0") || !Number.isFinite(job.startedAt)) return false;
	if (job.stoppedAt != null && !Number.isFinite(job.stoppedAt)) return false;
	if (!validClock(job.clockStart) || !validClock(job.clockEnd)) return false;
	if (job.type === "record") return job.remote === "/data/local/tmp/dsh_" + job.id + ".mp4";
	return job.logRemote === "/data/local/tmp/dsh_" + job.id + "-logcat.log" && Array.isArray(job.segments) && job.segments.every((seg, i) => seg && seg.remote === "/data/local/tmp/dsh_" + job.id + "_" + i + ".mp4" && Number.isFinite(seg.startEpoch) && (seg.endEpoch == null || Number.isFinite(seg.endEpoch)) && validClock(seg.clock)) && Array.isArray(job.actions) && job.actions.every((a) => a && Number.isFinite(a.t) && (a.endedAt == null || Number.isFinite(a.endedAt) && a.endedAt >= a.t) && typeof a.action === "string" && (a.detail == null || typeof a.detail === "string"));
}
const DEFAULT_QUALITY = {
	maxSize: 1280,
	maxFps: 30,
	videoBitRate: 8e6
};
/** No relative/device/browser paths. Probe the actual host directory before committing a preference. */
function validateCaptureDirectory(directory) {
	if (typeof directory !== "string" || !isAbsolute(directory) || directory.includes("\0")) throw Object.assign(/* @__PURE__ */ new Error("保存目录必须是宿主电脑的绝对路径"), { code: "bad-request" });
	const canonical = realpathSync(directory);
	if (!lstatSync(canonical).isDirectory()) throw new Error("目录不是文件夹：" + directory);
	const probe = join(canonical, ".dsh-write-" + randomUUID());
	try {
		writeFileSync(probe, "", {
			flag: "wx",
			mode: 384
		});
	} finally {
		try {
			unlinkSync(probe);
		} catch {}
	}
	return canonical;
}
var PaneStateStore = class PaneStateStore {
	file;
	cached;
	constructor(file, cached) {
		this.file = file;
		this.cached = cached;
	}
	static open(dir) {
		const file = join(dir, "state.json");
		let raw = {};
		try {
			raw = JSON.parse(readFileSync(file, "utf8"));
			if (raw == null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("状态须为 JSON 对象");
		} catch (e) {
			if (e.code !== "ENOENT") throw new Error("dsh-android-pane 状态文件损坏（" + file + "）：" + String(e));
		}
		if (raw.pending != null && (!Array.isArray(raw.pending) || !raw.pending.every(validPending))) throw new Error("dsh-android-pane 待保存清单损坏；保留原件并修复 state.json 后重试");
		if (raw.volumeRestore != null && (typeof raw.volumeRestore !== "object" || Array.isArray(raw.volumeRestore) || Object.values(raw.volumeRestore).some((v) => !Number.isSafeInteger(v) || v < 0))) throw new Error("dsh-android-pane 音量还原状态损坏");
		const state = {
			pending: raw.pending ?? [],
			volumeRestore: raw.volumeRestore ?? {},
			trustedDevices: Array.isArray(raw.trustedDevices) ? raw.trustedDevices.filter((s) => typeof s === "string") : [],
			quality: {
				...DEFAULT_QUALITY,
				...raw.quality ?? {}
			},
			updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : (/* @__PURE__ */ new Date()).toISOString(),
			directory: typeof raw.directory === "string" && isAbsolute(raw.directory) ? raw.directory : resolve(dir, "shots"),
			outputs: Array.isArray(raw.outputs) ? raw.outputs.filter((o) => o && typeof o.id === "string" && [
				"screenshot",
				"record",
				"debug"
			].includes(o.type) && Array.isArray(o.files) && o.files.every((f) => typeof f === "string" && isAbsolute(f)) && Array.isArray(o.identities) && o.identities.length === o.files.length) : [],
			streamMode: raw.streamMode != null && typeof raw.streamMode === "object" && !Array.isArray(raw.streamMode) ? Object.fromEntries(Object.entries(raw.streamMode).filter(([, v]) => v === "screenshot")) : {}
		};
		mkdirSync(dir, { recursive: true });
		return new PaneStateStore(file, state);
	}
	get data() {
		return this.cached;
	}
	reload() {
		this.cached = PaneStateStore.open(dirname(this.file)).cached;
		return this.cached;
	}
	isTrusted(serial) {
		return this.cached.trustedDevices.includes(serial);
	}
	trust(serial) {
		if (!this.isTrusted(serial)) this.flush({ trustedDevices: [...this.cached.trustedDevices, serial] });
	}
	untrust(serial) {
		this.flush({ trustedDevices: this.cached.trustedDevices.filter((s) => s !== serial) });
	}
	setQuality(patch) {
		this.flush({ quality: {
			...this.cached.quality,
			...patch
		} });
		return { ...this.cached.quality };
	}
	setStreamMode(serial, mode) {
		const streamMode = { ...PaneStateStore.open(dirname(this.file)).data.streamMode };
		if (mode === "auto") delete streamMode[serial];
		else streamMode[serial] = "screenshot";
		this.flush({ streamMode });
	}
	setDirectory(directory) {
		const validated = validateCaptureDirectory(directory);
		this.flush({ directory: validated });
		return validated;
	}
	upsertPending(job) {
		if (!validPending(job)) throw new Error("无效待保存采集清单");
		const pending = PaneStateStore.open(dirname(this.file)).data.pending.filter((p) => p.id !== job.id);
		this.flush({ pending: [...pending, job] });
	}
	setVolumeRestore(serial, value) {
		const volumeRestore = { ...PaneStateStore.open(dirname(this.file)).data.volumeRestore };
		if (value == null) delete volumeRestore[serial];
		else volumeRestore[serial] = value;
		this.flush({ volumeRestore });
	}
	registerOutput(id, type, files, error) {
		const identities = files.map((file) => {
			const stat = lstatSync(file);
			if (!stat.isFile() || stat.size === 0 || realpathSync(file) !== file) throw new Error("保存文件无效：" + file);
			return {
				dev: stat.dev,
				ino: stat.ino
			};
		});
		const output = {
			id,
			type,
			files: [...files],
			at: Date.now(),
			identities,
			...error ? { error } : {}
		};
		const latest = PaneStateStore.open(dirname(this.file)).data;
		this.flush({
			pending: latest.pending.filter((job) => job.id !== id),
			outputs: [...latest.outputs.filter((o) => o.id !== id), output]
		});
	}
	flush(patch) {
		const tmp = this.file + "." + randomUUID() + ".tmp";
		try {
			const next = {
				...PaneStateStore.open(dirname(this.file)).data,
				...patch,
				updatedAt: (/* @__PURE__ */ new Date()).toISOString()
			};
			writeFileSync(tmp, JSON.stringify(next, null, 2), {
				flag: "wx",
				mode: 384
			});
			renameSync(tmp, this.file);
			this.cached = next;
		} catch (e) {
			try {
				unlinkSync(tmp);
			} catch {}
			throw new Error("dsh-android-pane 状态写入失败（" + this.file + "）：" + String(e));
		}
	}
};
const SERVER_VERSION = "3.3.4";
const REMOTE_JAR = "/data/local/tmp/dsh_scrcpy_server.jar";
/** Reject the whole batch: silently filtering/truncating could discard an UP. */
function parsePanelInput(value) {
	const v = value;
	if (v == null || typeof v.gesture !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(v.gesture) || !Number.isInteger(v.w) || !Number.isInteger(v.h) || v.w < 1 || v.h < 1 || v.w > 65535 || v.h > 65535 || !Array.isArray(v.events) || v.events.length < 1 || v.events.length > 64 || !v.events.every((e) => e != null && [
		"down",
		"move",
		"up",
		"scroll"
	].includes(e.p) && Number.isFinite(e.x) && Number.isFinite(e.y) && Math.abs(e.x) <= 2147483647 && Math.abs(e.y) <= 2147483647 && (e.p !== "scroll" || Number.isFinite(e.dx) && Number.isFinite(e.dy) && Math.abs(e.dx) <= 16 && Math.abs(e.dy) <= 16))) throw Object.assign(/* @__PURE__ */ new Error("Invalid panel input batch"), { code: "bad-request" });
	return v;
}
var StreamSession = class {
	adbPath;
	serial;
	jarPath;
	quality;
	log;
	proc = null;
	videoSock = null;
	controlSock = null;
	panelTouch = null;
	videoBuf = Buffer.alloc(0);
	gotConfig = false;
	closed = false;
	stderrTail = "";
	sinks = /* @__PURE__ */ new Set();
	metaSink = null;
	deadSink = null;
	meta = null;
	scid = "";
	port = 0;
	gop = [];
	lastConfigFrame = null;
	displaySize = {
		w: 1080,
		h: 1920
	};
	constructor(adbPath, serial, jarPath, quality, log) {
		this.adbPath = adbPath;
		this.serial = serial;
		this.jarPath = jarPath;
		this.quality = quality;
		this.log = log;
	}
	get info() {
		return this.meta;
	}
	/** 物理分辨率（wm size 实测），供流↔物理坐标换算。 */
	get displayDim() {
		return this.displaySize;
	}
	get running() {
		return !this.closed && this.proc != null;
	}
	onFrame(fn) {
		this.sinks.add(fn);
		return () => this.sinks.delete(fn);
	}
	onMeta(fn) {
		this.metaSink = fn;
		if (this.meta != null) fn(this.meta);
	}
	onDead(fn) {
		this.deadSink = fn;
	}
	/** 观察者心跳（/stream 路由 ping 时调用）：有活跃观看者的流不被 reaper 回收。 */
	viewerAt = 0;
	touchViewer() {
		this.viewerAt = Date.now();
	}
	hasActiveViewer(windowMs = 6e4) {
		return this.viewerAt > 0 && Date.now() - this.viewerAt < windowMs;
	}
	/** 晚加入观看者的重放序列（config+自最近关键帧起的增量包）。 */
	replayGop() {
		return [...this.gop];
	}
	/** 重放缓存是否可独立解码（必须同时含 config=SPS/PPS 与关键帧）。 */
	replayDecodable() {
		return this.gop.some((f) => f.config) && this.gop.some((f) => f.key);
	}
	/** B22b：按 ARGS 精准清理设备端残留 scrcpy server（`com.genymobil[e]` 字符类防误杀自身 grep）。 */
	async killOrphanServers(signal) {
		const FIND = "ps -A -o PID,ARGS | grep 'com.genymobil[e].scrcpy.Server' | grep -v grep | awk '{print $1}'";
		const listPids = async () => {
			return (await run(this.adbPath, [
				"-s",
				this.serial,
				"shell",
				FIND
			], signal, 8e3)).stdout.split(/\s+/).map((s) => s.trim()).filter((s) => /^\d+$/.test(s));
		};
		try {
			const pids = await listPids();
			if (pids.length === 0) return;
			this.log(`[${this.serial}] 清理孤儿 scrcpy server: ${pids.join(",")}`);
			await run(this.adbPath, [
				"-s",
				this.serial,
				"shell",
				`kill ${pids.join(" ")} 2>/dev/null; true`
			], signal, 8e3);
			await new Promise((res) => setTimeout(res, 500));
			const left = await listPids();
			if (left.length > 0) {
				this.log(`[${this.serial}] 孤儿 server TERM 未退（${left.join(",")}）→ KILL 补刀`);
				await run(this.adbPath, [
					"-s",
					this.serial,
					"shell",
					`kill -9 ${left.join(" ")} 2>/dev/null; true`
				], signal, 8e3);
			}
		} catch {}
	}
	/** 完整启动：push → forward → spawn server（tunnel_forward）→ 双连接 → 首包。 */
	async start(signal) {
		const scidHex = Math.floor(Math.random() * 2147483647).toString(16).padStart(8, "0");
		this.scid = scidHex;
		const port = await freePort();
		this.port = port;
		await this.killOrphanServers(signal);
		this.log(`[${this.serial}] push server jar`);
		await run(this.adbPath, [
			"-s",
			this.serial,
			"push",
			this.jarPath,
			REMOTE_JAR
		], signal, 3e4);
		await run(this.adbPath, [
			"-s",
			this.serial,
			"forward",
			`tcp:${port}`,
			`localabstract:scrcpy_${scidHex}`
		], signal, 1e4);
		const wmSize = await run(this.adbPath, [
			"-s",
			this.serial,
			"shell",
			"wm size"
		], signal, 8e3).then((r) => r.stdout, () => "");
		const m = /(\d+)x(\d+)/.exec(wmSize);
		if (m != null) this.displaySize = {
			w: Number(m[1]),
			h: Number(m[2])
		};
		const serverArgs = [
			"-s",
			this.serial,
			"shell",
			`CLASSPATH=${REMOTE_JAR} app_process / com.genymobile.scrcpy.Server ${SERVER_VERSION} ` + [
				`scid=${scidHex}`,
				"log_level=info",
				"video=true",
				"audio=false",
				"control=true",
				"send_frame_meta=true",
				"send_dummy_byte=true",
				"cleanup=true",
				"tunnel_forward=true",
				"stay_awake=true",
				"downsize_on_error=true",
				"video_codec=h264",
				`max_size=${this.quality.maxSize > 0 ? this.quality.maxSize : 0}`,
				`max_fps=${this.quality.maxFps}`,
				`video_bit_rate=${this.quality.videoBitRate}`,
				"video_codec_options=i-frame-interval=2"
			].join(" ")
		];
		this.log(`[${this.serial}] spawn scrcpy server (port ${port})`);
		this.proc = spawn(this.adbPath, serverArgs, {
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			],
			windowsHide: true
		});
		this.proc.stdout?.on("data", (d) => {
			const s = d.toString("utf8");
			if (s.includes("ERROR") || s.includes("WARN")) this.log(`[${this.serial}] server stdout: ${s.trim().slice(0, 300)}`);
		});
		this.proc.stderr?.on("data", (d) => {
			this.stderrTail = (this.stderrTail + d.toString("utf8")).slice(-2e3);
		});
		this.proc.on("exit", (code, sig) => {
			if (this.closed) return;
			this.markDead(`scrcpy server 退出 code=${code ?? "null"} signal=${sig ?? "null"} stderr尾: ${this.stderrTail.slice(-400)}`);
		});
		try {
			const sock = (await this.connectSocketWithDummy(port, signal)).sock;
			this.videoSock = sock;
			sock.on("error", (e) => this.markDead(`video socket 错误: ${String(e)}`));
			sock.on("close", () => this.markDead("video socket 关闭"));
			const ctl = await this.connectControl(port, signal);
			this.controlSock = ctl;
			ctl.on("error", (e) => this.log(`[${this.serial}] control socket 错误: ${String(e)}`));
			const deviceName = (await readExactly(sock, 64, 6e3)).toString("utf8").replace(/\0+$/, "");
			const codecHeader = await readExactly(sock, 12, 6e3);
			const codecId = codecHeader.readUInt32BE(0);
			if (codecId !== 1748121140) throw new Error(`codec header 异常：期望 h264(0x68323634)，实得 0x${codecId.toString(16)}`);
			const w = codecHeader.readUInt32BE(4);
			const h = codecHeader.readUInt32BE(8);
			this.meta = {
				deviceName,
				streamWidth: w,
				streamHeight: h,
				codecString: "avc1.640028"
			};
			this.metaSink?.(this.meta);
			sock.on("data", (d) => this.onVideoData(d));
			await this.waitForConfig(signal);
			this.log(`[${this.serial}] stream ready: ${this.meta?.streamWidth}x${this.meta?.streamHeight} ${this.meta?.codecString} (${deviceName})`);
			return this.meta;
		} catch (e) {
			const hint = this.stderrTail !== "" ? ` | server stderr 尾部: ${this.stderrTail.slice(-500)}` : "";
			this.stop();
			throw new Error(`scrcpy 会话启动失败（${this.serial}）：${String(e instanceof Error ? e.message : e)}${hint}`);
		}
	}
	/** 连接 video socket 并读走 1 字节 dummy（设备名在 control 连上之后才发，见 start() 注释）。
	*  实测教训链：设备端 listener 未就绪时首个连接会 EOF，且 adbd 会随之拆掉 forward 监听
	*  （后续连接全部 ECONNREFUSED）。因此：① 先 poll 设备 abstract socket 出现再连；
	*  ② 每次重试前重新下发 forward（幂等）。 */
	async connectSocketWithDummy(port, signal) {
		const deadline = Date.now() + 15e3;
		for (let i = 0; i < 25; i++) {
			if (this.proc?.exitCode != null) throw new Error(`scrcpy server 已退出（exit=${this.proc.exitCode}）${this.stderrTail.slice(-300)}`);
			try {
				const out = await run(this.adbPath, [
					"-s",
					this.serial,
					"shell",
					"cat /proc/net/unix 2>/dev/null | grep -c scrcpy_" + this.scid
				], signal, 3e3);
				if (out.stdout.trim() !== "" && out.stdout.trim() !== "0") break;
			} catch (e) {
				if (!String(e).includes("exit=1")) break;
			}
			await new Promise((r) => setTimeout(r, 300));
		}
		let lastErr = "";
		for (;;) {
			if (Date.now() > deadline) throw new Error(`video 握手超时（${lastErr || "EOF"}）`);
			if (this.proc?.exitCode != null) throw new Error(`scrcpy server 已退出（exit=${this.proc.exitCode}）${this.stderrTail.slice(-300)}`);
			let sock = null;
			try {
				sock = await this.connectWithRetry(port, signal, 1500);
				const dummy = await readExactly(sock, 1, 1e4);
				if (dummy[0] !== 0) throw new Error(`协议头异常：期望 dummy 0x00，实得 0x${dummy[0].toString(16)}`);
				return { sock };
			} catch (e) {
				lastErr = String(e instanceof Error ? e.message : e).slice(0, 160);
				try {
					sock?.destroy();
				} catch {}
				if (lastErr.includes("协议头异常")) throw new Error(lastErr);
				await run(this.adbPath, [
					"-s",
					this.serial,
					"forward",
					`tcp:${this.port}`,
					`localabstract:scrcpy_${this.scid}`
				], signal, 5e3).catch(() => void 0);
				await new Promise((r) => setTimeout(r, 300));
			}
		}
	}
	/** 连接 control socket（server accept 顺序在 video 之后）。 */
	async connectControl(port, signal) {
		const deadline = Date.now() + 1e4;
		for (;;) {
			if (Date.now() > deadline) throw new Error("control 连接超时");
			if (this.proc?.exitCode != null) throw new Error(`scrcpy server 已退出（exit=${this.proc.exitCode}）`);
			try {
				return await this.connectWithRetry(port, signal, 1500);
			} catch (e) {
				if (signal?.aborted) throw e;
				await new Promise((r) => setTimeout(r, 200));
			}
		}
	}
	/** 画质重配 = 重建会话（由上层调用 stop + start）。 */
	updateQuality(q) {
		this.quality = q;
	}
	/** 连接 adb forward 出来的本地端口（server 未起时短重试）。 */
	connectWithRetry(port, signal, totalMs = 8e3) {
		const deadline = Date.now() + totalMs;
		const attempt = () => new Promise((resolve, reject) => {
			if (signal?.aborted) {
				reject(/* @__PURE__ */ new Error("aborted"));
				return;
			}
			const s = connect({
				port,
				host: "127.0.0.1"
			}, () => {
				s.setNoDelay(true);
				resolve(s);
			});
			s.once("error", (e) => reject(e));
		});
		return (async () => {
			for (;;) try {
				return await attempt();
			} catch (e) {
				if (Date.now() >= deadline) throw new Error(`连接 scrcpy 端口 ${port} 超时（最后一次: ${String(e)}）`);
				await new Promise((r) => setTimeout(r, 150));
			}
		})();
	}
	onVideoData(d) {
		this.videoBuf = Buffer.concat([this.videoBuf, d]);
		for (;;) {
			if (this.videoBuf.length < 12) return;
			const ptsFlags = this.videoBuf.readBigUInt64BE(0);
			const len = this.videoBuf.readUInt32BE(8);
			if (this.videoBuf.length < 12 + len) return;
			const data = this.videoBuf.subarray(12, 12 + len);
			this.videoBuf = this.videoBuf.subarray(12 + len);
			const isConfig = (ptsFlags & 9223372036854775808n) !== 0n;
			const isKey = (ptsFlags & 4611686018427387904n) !== 0n;
			const pts = ptsFlags & 4611686018427387903n;
			if (isConfig && this.meta != null) {
				const parsed = parseH264AnnexB(data);
				if (parsed != null && parsed.sps != null) {
					this.meta = {
						...this.meta,
						codecString: parsed.codecString
					};
					this.metaSink?.(this.meta);
				}
			}
			const frame = {
				pts,
				data: Buffer.from(data),
				key: isConfig || isKey || isKeyAccessUnit(data),
				config: isConfig
			};
			if (isConfig) {
				this.lastConfigFrame = frame;
				this.gop = [frame];
			} else if (isKey) this.gop = this.lastConfigFrame != null ? [this.lastConfigFrame, frame] : [frame];
			else {
				this.gop.push(frame);
				if (this.gop.length > 512 || this.gop.reduce((a, f) => a + f.data.length, 0) > 3e6) this.gop = [];
			}
			for (const fn of this.sinks) try {
				fn(frame);
			} catch (e) {
				this.log(`[${this.serial}] frame sink 异常: ${String(e).slice(0, 200)}`);
			}
		}
	}
	waitForConfig(signal, timeoutMs = 12e3) {
		return new Promise((resolve, reject) => {
			const started = Date.now();
			const timer = setInterval(() => {
				if (this.meta != null) {
					clearInterval(timer);
					resolve();
				} else if (Date.now() - started > timeoutMs) {
					clearInterval(timer);
					reject(/* @__PURE__ */ new Error("等待 H.264 codec config 超时（12s）"));
				} else if (signal?.aborted) {
					clearInterval(timer);
					reject(/* @__PURE__ */ new Error("aborted"));
				}
			}, 50);
		});
	}
	send(buf) {
		const sock = this.controlSock;
		if (sock == null || sock.destroyed) throw new Error("control socket 未就绪（设备串流未运行）");
		sock.write(buf);
	}
	/** One active finger per stream; IDs prevent late cleanup from releasing another viewer. */
	injectPanelInput(input) {
		const { gesture, events, w, h } = parsePanelInput(input);
		const size = this.touchSpace();
		if (!events.every((e) => e.p === "up") && (w !== size.w || h !== size.h)) {
			this.cancelPanelTouch(gesture);
			throw Object.assign(/* @__PURE__ */ new Error("Panel frame size changed; retry the gesture"), { code: "input-stale" });
		}
		let id = this.panelTouch?.id;
		for (const e of events) if (e.p === "down") {
			if (id != null) throw Object.assign(/* @__PURE__ */ new Error("Another panel gesture is active"), { code: "input-busy" });
			id = gesture;
		} else if (e.p === "move" && id !== gesture) throw Object.assign(/* @__PURE__ */ new Error("Panel gesture expired"), { code: "input-stale" });
		else if (e.p === "up" && id === gesture) id = void 0;
		else if (e.p === "scroll" && id != null) throw Object.assign(/* @__PURE__ */ new Error("Finish the active touch before scrolling"), { code: "input-busy" });
		try {
			for (const e of events) if (e.p === "scroll") this.scroll(e.x, e.y, e.dx, e.dy);
			else if (e.p === "up") {
				if (this.panelTouch?.id === gesture) {
					this.panelTouch.x = e.x;
					this.panelTouch.y = e.y;
					this.cancelPanelTouch(gesture);
				}
			} else {
				if (e.p === "down") this.panelTouch = {
					id: gesture,
					x: e.x,
					y: e.y,
					timer: null
				};
				this.injectTouch(e.x, e.y, e.p === "down" ? 0 : 2);
				this.panelTouch.x = e.x;
				this.panelTouch.y = e.y;
			}
			if (this.panelTouch?.id === gesture) {
				if (this.panelTouch.timer != null) clearTimeout(this.panelTouch.timer);
				this.panelTouch.timer = setTimeout(() => this.cancelPanelTouch(gesture, false), 2e3);
			}
		} catch (e) {
			this.cancelPanelTouch(gesture, false);
			throw e;
		}
	}
	cancelPanelTouch(gesture, strict = true) {
		const touch = this.panelTouch;
		if (touch == null || gesture != null && gesture !== touch.id) return;
		try {
			this.injectTouch(touch.x, touch.y, 1);
		} catch (e) {
			if (strict) throw e;
			this.log("Panel touch release failed; closing control socket: " + String(e));
			this.controlSock?.destroy();
		}
		this.panelTouch = null;
		if (touch.timer != null) clearTimeout(touch.timer);
	}
	injectTouch(x, y, action) {
		const { w, h } = this.touchSpace();
		x = Math.max(0, Math.min(w - 1, Math.round(x)));
		y = Math.max(0, Math.min(h - 1, Math.round(y)));
		this.touchProbe(action, x, y, w, h);
		const b = Buffer.alloc(32);
		b.writeUInt8(2, 0);
		b.writeUInt8(action, 1);
		b.writeBigUInt64BE(0n, 2);
		b.writeUInt32BE(x, 10);
		b.writeUInt32BE(y, 14);
		b.writeUInt16BE(w, 18);
		b.writeUInt16BE(h, 20);
		b.writeUInt16BE(action === 1 ? 0 : 65535, 22);
		b.writeUInt32BE(0, 24);
		b.writeUInt32BE(0, 28);
		this.send(b);
	}
	/** 诊断探针（注入器上下文里同步 require 不可用，必须动态 import）。 */
	touchProbe(action, x, y, w, h) {
		if (process.env.DAP_QUIET != null) return;
		import("node:fs").then((fs) => fs.appendFileSync("/tmp/dap-route.log", `${(/* @__PURE__ */ new Date()).toISOString()} touch a=${action} x=${x} y=${y} w=${w} h=${h} meta=${this.meta ? `${this.meta.streamWidth}x${this.meta.streamHeight}` : "null"} ctl=${this.controlSock ? this.controlSock.destroyed ? "dead" : "ok" : "null"}\n`)).catch(() => void 0);
	}
	/** 触控坐标系 = 流尺寸（晚于 meta 到达前回退物理分辨率）。 */
	touchSpace() {
		if (this.meta != null && this.meta.streamWidth > 0) return {
			w: this.meta.streamWidth,
			h: this.meta.streamHeight
		};
		return this.displaySize;
	}
	/** 流坐标 → 设备物理坐标（poll 降级走 adb input 时必须换算，adb input 只认物理坐标）。 */
	mapToDisplay(x, y) {
		const m = this.meta;
		if (m != null && m.streamWidth > 0 && m.streamHeight > 0 && this.displaySize.w > 0 && this.displaySize.h > 0) return {
			x: Math.max(0, Math.min(this.displaySize.w - 1, Math.round(x * this.displaySize.w / m.streamWidth))),
			y: Math.max(0, Math.min(this.displaySize.h - 1, Math.round(y * this.displaySize.h / m.streamHeight)))
		};
		return {
			x,
			y
		};
	}
	/** ⚠️ MOVE 事件必须按 durationMs 真实间隔发送：一次性灌完 = Android 端 0 速度瞬移手势，
	*  被桌面/应用吞掉（实测「面板无法操作」根因之一——tap 正常所以此前漏网）。 */
	async injectSwipe(x1, y1, x2, y2, durationMs) {
		const steps = Math.max(2, Math.min(40, Math.round(durationMs / 16)));
		const interval = Math.max(8, Math.round(durationMs / steps));
		this.injectTouch(x1, y1, 0);
		for (let i = 1; i <= steps; i++) {
			await new Promise((r) => setTimeout(r, interval));
			const t = i / steps;
			const x = Math.round(x1 + (x2 - x1) * t);
			const y = Math.round(y1 + (y2 - y1) * t);
			this.injectTouch(x, y, 2);
		}
		await new Promise((r) => setTimeout(r, interval));
		this.injectTouch(x2, y2, 1);
	}
	injectKey(action, keycode, metaState = 0, repeat = 0) {
		const b = Buffer.alloc(14);
		b.writeUInt8(0, 0);
		b.writeUInt8(action, 1);
		b.writeUInt32BE(keycode >>> 0, 2);
		b.writeUInt32BE(repeat >>> 0, 6);
		b.writeUInt32BE(metaState >>> 0, 10);
		this.send(b);
	}
	/** 按键按下+抬起。 */
	tapKey(keycode, metaState = 0) {
		this.injectKey(0, keycode, metaState);
		this.injectKey(1, keycode, metaState);
	}
	/** 文本输入：ASCII 走 TYPE_TEXT，其余走剪贴板粘贴（对齐 scrcpy 桌面端行为）。 */
	injectText(text) {
		if (/^[\x20-\x7e]*$/.test(text) && Buffer.byteLength(text, "utf8") <= 300) {
			const payload = Buffer.from(text, "utf8");
			const b = Buffer.alloc(5 + payload.length);
			b.writeUInt8(1, 0);
			b.writeUInt32BE(payload.length, 1);
			payload.copy(b, 5);
			this.send(b);
			return;
		}
		this.setClipboardPaste(text);
	}
	setClipboardPaste(text) {
		const payload = Buffer.from(text, "utf8");
		if (payload.length > 1e6) throw new Error(`文本过长（${payload.length} 字节 > 1MB 上限）`);
		const b = Buffer.alloc(14 + payload.length);
		b.writeUInt8(8, 0);
		b.writeBigUInt64BE(0n, 1);
		b.writeUInt8(1, 9);
		b.writeUInt32BE(payload.length, 10);
		payload.copy(b, 14);
		this.send(b);
	}
	scroll(x, y, deltaX, deltaY) {
		const { w, h } = this.touchSpace();
		const b = Buffer.alloc(21);
		b.writeUInt8(3, 0);
		b.writeUInt32BE(Math.max(0, Math.min(w - 1, Math.round(x))), 1);
		b.writeUInt32BE(Math.max(0, Math.min(h - 1, Math.round(y))), 5);
		b.writeUInt16BE(w, 9);
		b.writeUInt16BE(h, 11);
		b.writeInt16BE(Math.max(-32768, Math.min(32767, Math.trunc(deltaX * 2048))), 13);
		b.writeInt16BE(Math.max(-32768, Math.min(32767, Math.trunc(deltaY * 2048))), 15);
		b.writeUInt32BE(0, 17);
		this.send(b);
	}
	backOrScreenOn(action) {
		const b = Buffer.alloc(2);
		b.writeUInt8(4, 0);
		b.writeUInt8(action, 1);
		this.send(b);
	}
	expandNotifications() {
		this.send(Buffer.from([5]));
	}
	collapsePanels() {
		this.send(Buffer.from([6]));
	}
	markDead(reason) {
		if (this.closed) return;
		this.closed = true;
		this.log(`[${this.serial}] stream dead: ${reason}`);
		this.stop();
		this.deadSink?.(reason);
	}
	/** 停止并清理（幂等）。 */
	stop() {
		this.cancelPanelTouch(void 0, false);
		this.closed = true;
		for (const sock of [this.videoSock, this.controlSock]) try {
			sock?.destroy();
		} catch {}
		this.videoSock = null;
		this.controlSock = null;
		if (this.port !== 0) {
			spawn(this.adbPath, [
				"-s",
				this.serial,
				"forward",
				"--remove",
				`tcp:${this.port}`
			], {
				stdio: "ignore",
				windowsHide: true
			}).unref();
			this.port = 0;
			this.scid = "";
		}
		if (this.proc != null) {
			try {
				this.proc.kill("SIGKILL");
			} catch {}
			this.proc = null;
		}
		this.sinks.clear();
	}
};
/** 解析 AnnexB：提取 SPS/PPS、分辨率、avc1.PPCCLL codec string。 */
function parseH264AnnexB(data) {
	const nals = splitAnnexB(data);
	let sps = null;
	let pps = null;
	for (const nal of nals) {
		if (nal.length === 0) continue;
		const type = nal[0] & 31;
		if (type === 7 && sps == null) sps = nal;
		if (type === 8 && pps == null) pps = nal;
	}
	if (sps == null) return null;
	const dims = parseSpsSize(sps);
	const profile = sps[1] ?? 66;
	const compat = sps[2] ?? 0;
	const level = sps[3] ?? 31;
	const hex = (n) => n.toString(16).padStart(2, "0");
	return {
		sps,
		pps,
		width: dims.w,
		height: dims.h,
		codecString: `avc1.${hex(profile)}${hex(compat)}${hex(level)}`
	};
}
/** 按 00 00 01 / 00 00 00 01 起始码切 NAL（保留 NAL 头字节）。 */
function splitAnnexB(data) {
	const out = [];
	let i = 0;
	let start = -1;
	while (i < data.length - 2) if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
		const scLen = i > 0 && data[i - 1] === 0 ? 4 : 3;
		const nalStart = i - (scLen - 3);
		if (start >= 0 && nalStart > start) out.push(data.subarray(start, nalStart));
		start = i + 3;
		i += 3;
	} else i++;
	if (start >= 0 && start < data.length) out.push(data.subarray(start));
	return out;
}
function isKeyAccessUnit(data) {
	for (const nal of splitAnnexB(data)) {
		if (nal.length === 0) continue;
		if ((nal[0] & 31) === 5) return true;
	}
	return false;
}
/** 极简 SPS 解析（Exp-Golomb），取 coded width/height（不含 crop 校正的场合足够用）。 */
function parseSpsSize(sps) {
	try {
		const br = new BitReader(sps.subarray(4));
		br.readBits(8);
		br.readBits(8);
		br.readBits(8);
		br.readUe();
		const chromaFormatIdc = br.readUe();
		if (chromaFormatIdc === 3) br.readBits(1);
		br.readUe();
		br.readUe();
		br.readBits(1);
		br.readBits(1);
		br.readUe();
		const picOrderCntType = br.readUe();
		if (picOrderCntType === 0) br.readUe();
		else if (picOrderCntType === 1) {
			br.readBits(1);
			br.readSe();
			br.readSe();
			const n = br.readUe();
			for (let i = 0; i < n; i++) br.readSe();
		}
		br.readUe();
		br.readBits(1);
		const picWidthInMbsMinus1 = br.readUe();
		const picHeightInMapUnitsMinus1 = br.readUe();
		br.readBits(1);
		br.readBits(1);
		br.readBits(1);
		const cropL = br.readBits(1);
		let crop = {
			l: 0,
			r: 0,
			t: 0,
			b: 0
		};
		if (cropL === 1) crop = {
			l: br.readUe(),
			r: br.readUe(),
			t: br.readUe(),
			b: br.readUe()
		};
		const width = (picWidthInMbsMinus1 + 1) * 16 - (crop.l + crop.r) * (chromaFormatIdc === 0 ? 1 : 2);
		const height = 16 * (picHeightInMapUnitsMinus1 + 1) - (crop.t + crop.b) * (chromaFormatIdc === 0 ? 1 : 2) * 2;
		return {
			w: width,
			h: Math.max(16, height)
		};
	} catch {
		return {
			w: 1080,
			h: 1920
		};
	}
}
var BitReader = class {
	buf;
	pos = 0;
	constructor(buf) {
		this.buf = buf;
	}
	readBit() {
		const byte = this.buf[Math.floor(this.pos / 8)];
		if (byte === void 0) throw new Error("SPS 越界");
		const bit = byte >> 7 - this.pos % 8 & 1;
		this.pos++;
		return bit;
	}
	readBits(n) {
		let v = 0;
		for (let i = 0; i < n; i++) v = v << 1 | this.readBit();
		return v;
	}
	readUe() {
		let zeros = 0;
		while (this.readBit() === 0) {
			zeros++;
			if (zeros > 31) throw new Error("SPS Exp-Golomb 异常");
		}
		return (1 << zeros) - 1 + (zeros > 0 ? this.readBits(zeros) : 0);
	}
	readSe() {
		const ue = this.readUe();
		return ue % 2 === 0 ? -(ue / 2) : (ue + 1) / 2;
	}
};
function run(adbPath, args, signal, timeoutMs) {
	return new Promise((resolve, reject) => {
		const child = spawn(adbPath, [...args], {
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			],
			windowsHide: true
		});
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(/* @__PURE__ */ new Error(`adb ${args[0]} 超时（${timeoutMs}ms）`));
		}, timeoutMs);
		child.stdout?.on("data", (d) => stdout += d.toString("utf8"));
		child.stderr?.on("data", (d) => stderr += d.toString("utf8"));
		child.on("error", (e) => {
			clearTimeout(timer);
			reject(e);
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			if (code !== 0) {
				reject(/* @__PURE__ */ new Error(`adb ${args.slice(0, 3).join(" ")}… 失败 exit=${code} stderr=${stderr.slice(0, 300)}`));
				return;
			}
			resolve({
				code: code ?? -1,
				stdout,
				stderr
			});
		});
		if (signal != null) if (signal.aborted) child.kill("SIGKILL");
		else signal.addEventListener("abort", () => child.kill("SIGKILL"), { once: true });
	});
}
function freePort() {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.listen(0, "127.0.0.1", () => {
			const addr = srv.address();
			const port = typeof addr === "object" && addr != null ? addr.port : 0;
			srv.close(() => port > 0 ? resolve(port) : reject(/* @__PURE__ */ new Error("无可用本地端口")));
		});
		srv.on("error", reject);
	});
}
function readExactly(sock, n, timeoutMs) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let have = 0;
		let timer = null;
		const cleanup = () => {
			if (timer != null) clearTimeout(timer);
			sock.off("readable", onReadable);
			sock.off("end", onEnd);
			sock.off("error", onErr);
		};
		const fail = (e) => {
			cleanup();
			if (timeoutMs != null) sock.destroy();
			reject(e);
		};
		const onReadable = () => {
			try {
				for (;;) {
					const chunk = sock.read();
					if (chunk == null) break;
					chunks.push(chunk);
					have += chunk.length;
					if (have >= n) {
						cleanup();
						const all = Buffer.concat(chunks);
						const rest = all.subarray(n);
						if (rest.length > 0) sock.unshift(rest);
						resolve(all.subarray(0, n));
						return;
					}
				}
			} catch (e) {
				fail(e instanceof Error ? e : new Error(String(e)));
			}
		};
		const onEnd = () => {
			fail(/* @__PURE__ */ new Error(`scrcpy 连接提前关闭（需要 ${n} 字节，实得 ${have}）`));
		};
		const onErr = (e) => {
			fail(e);
		};
		sock.on("readable", onReadable);
		sock.once("end", onEnd);
		sock.once("error", onErr);
		if (timeoutMs != null) timer = setTimeout(() => {
			fail(/* @__PURE__ */ new Error(`读取超时（${timeoutMs}ms，实得 ${have}/${n} 字节）`));
		}, timeoutMs);
		onReadable();
	});
}
function jarPathIn(pluginRoot) {
	return join(pluginRoot, "assets", "scrcpy-server-v3.3.4");
}
/** 解析 dumpsys window windows 全量输出。 */
function parseWindowDump(dump) {
	let focusHash = null;
	for (const m of dump.matchAll(/mCurrentFocus=Window\{([0-9a-fA-F]+) u0 ([^}]*)\}/g)) {
		focusHash = m[1];
		break;
	}
	const windows = [];
	let cur = null;
	for (const raw of dump.split("\n")) {
		const line = raw.replace(/\s+$/, "");
		const head = /Window #\d+ Window\{([0-9a-fA-F]+) u0 ([^}]*)\}:/.exec(line);
		if (head != null) {
			const title = head[2].trim();
			const slash = title.split("/")[0] ?? "";
			cur = {
				hash: head[1],
				title,
				pkg: /^[\w.$]+$/.test(slash) ? slash : null,
				secure: false,
				source: "none"
			};
			windows.push(cur);
			continue;
		}
		if (cur == null) continue;
		if (cur.source !== "fl-token" && /\bfl=/.test(line)) {
			if (/\bSECURE\b/.test(line)) {
				cur.secure = true;
				cur.source = "fl-token";
			} else if (cur.source === "none") cur.secure = false;
			continue;
		}
		if (cur.source === "none") {
			const mf = /\bmFlags=(0x[0-9a-fA-F]+)/.exec(line);
			if (mf != null) {
				const v = Number.parseInt(mf[1], 16);
				if (Number.isFinite(v) && (v & 8192) !== 0) {
					cur.secure = true;
					cur.source = "mflags-bit";
				}
			}
		}
	}
	return {
		focusHash,
		windows
	};
}
/** 从全量 dump 提取「焦点窗口是否 FLAG_SECURE」。焦点窗缺 fl= 时回退：同包名任一窗口带 SECURE。 */
function extractSecureState(dump) {
	const { focusHash, windows } = parseWindowDump(dump);
	const now = Date.now();
	if (focusHash == null) return {
		secure: false,
		pkg: null,
		activity: null,
		focusTitle: null,
		source: "none",
		checkedAt: now
	};
	const focus = windows.find((w) => w.hash === focusHash);
	if (focus == null) return {
		secure: false,
		pkg: null,
		activity: null,
		focusTitle: null,
		source: "none",
		checkedAt: now
	};
	let secure = focus.secure;
	let source = focus.source;
	if (!secure) {
		const alt = windows.find((w) => w.pkg != null && w.pkg === focus.pkg && w.secure);
		if (alt != null) {
			secure = true;
			source = alt.source;
		}
	}
	const activity = focus.title.includes("/") ? focus.title.split("/").slice(1).join("/") || null : null;
	return {
		secure,
		pkg: focus.pkg,
		activity,
		focusTitle: focus.title,
		source,
		checkedAt: now
	};
}
const HINT_DISABLE_FLAG_SECURE = "检测到 root 框架（Magisk/LSPosed）——像素级可见需安装并启用 DisableFlagSecure 模块（Zygisk/LSPosed 模块，仓库: xposed-modules-repo/com.varuns2002.disable_flag_secure）。模块按窗口层剥离 FLAG_SECURE；启用后需重启目标应用再点「尝试显示」复验。本插件绝不代装模块。";
//#endregion
//#region src/pane-service.ts
/**
* PaneHub：设备/认领/串流/操作的中枢。
* 规则落地点（设计卡）：
*  - 设备独占（规则2）：claims 单属主，冲突明确报错；
*  - 人机互斥提示（规则3）：agent 每次操作刷新 busyUntil，路由暴露给 UI 亮徽标；
*  - 闲置回收（规则4）：10 分钟无活动 → 释放认领 + 停流；模拟器额外 emu kill，真机仅断开；
*  - 资源上限（规则7）：每会话 4 路、全局 8 路；
*  - 降级（规则6/MVP）：scrcpy 启动失败 → 该设备进入 poll 模式（截图轮播），注入走 adb input；
*  - 隐私（规则8）：截图/录屏/调试写入宿主配置的绝对目录，路径透明。
*/
const PNG_SIG = Buffer.from([
	137,
	80,
	78,
	71,
	13,
	10,
	26,
	10
]);
/**
* Only a frame written by this exact extraction may become evidence: a stale PNG at the same deterministic
* name, or a zero-byte "successful" decode, must never be reported as the requested frame.
*/
function commitFrame(tmp, file) {
	if (!existsSync(tmp)) throw new Error("没有生成新的有效PNG");
	const png = readFileSync(tmp);
	if (png.length < 24 || !png.subarray(0, 8).equals(PNG_SIG)) throw new Error("没有生成新的有效PNG");
	renameSync(tmp, file);
}
/**
* Native screenrecord trailer layout (verified against 12 real segments): 16-byte tag, u32 version=2,
* i64 device wall clock at first frame in ns, u32 frame count, then i64 monotonic ns per frame.
* Maps monotonic nanoseconds to device wall time, not host spawn time.
*/
function nativeFrameEpochs(bytes, pts) {
	const at = bytes.indexOf("#VV1NSC0PET1ME2#");
	if (at < 0 || at + 32 > bytes.length || bytes.readUInt32LE(at + 16) !== 2) throw new Error("缺少受支持的原生帧时间元数据");
	const count = bytes.readUInt32LE(at + 28);
	if (!count || count !== pts.length || at + 32 + count * 8 > bytes.length) throw new Error("原生帧时间数量或长度不匹配");
	const offset = bytes.readBigInt64LE(at + 20);
	const epochs = pts.map((_, i) => Number(bytes.readBigInt64LE(at + 32 + i * 8) + offset) / 1e6);
	if (epochs.some((t, i) => !Number.isFinite(t) || !Number.isFinite(pts[i]) || i > 0 && (t <= epochs[i - 1] || pts[i] <= pts[i - 1]) || Math.abs((t - epochs[0]) / 1e3 - (pts[i] - pts[0])) > .001)) throw new Error("原生帧时间与视频时间不一致");
	return epochs;
}
function debugClockBounds(start, end) {
	if (!start || !end || Math.max(start.minOffsetMs, end.minOffsetMs) > Math.min(start.maxOffsetMs, end.maxOffsetMs)) return;
	return {
		minOffsetMs: Math.min(start.minOffsetMs, end.minOffsetMs),
		maxOffsetMs: Math.max(start.maxOffsetMs, end.maxOffsetMs)
	};
}
function selectDebugFrame(epochs, clock, target, kind) {
	if (kind === "pre") return epochs.findLastIndex((t) => t + clock.maxOffsetMs <= target);
	return epochs.findIndex((t) => t + clock.minOffsetMs >= target);
}
const KEYCODE = {
	back: 4,
	home: 3,
	recents: 187,
	volume_up: 24,
	volume_down: 25,
	power: 26,
	enter: 66,
	tab: 61,
	esc: 111,
	del: 67,
	move_end: 123,
	dpad_up: 19,
	dpad_down: 20,
	dpad_left: 21,
	dpad_right: 22
};
var PaneHub = class PaneHub {
	adb;
	state;
	opts;
	devicesCache = [];
	devicesAt = 0;
	claims = /* @__PURE__ */ new Map();
	streams = /* @__PURE__ */ new Map();
	modes = /* @__PURE__ */ new Map();
	streamErrors = /* @__PURE__ */ new Map();
	busyUntil = /* @__PURE__ */ new Map();
	pollSince = /* @__PURE__ */ new Map();
	records = /* @__PURE__ */ new Map();
	captureStarting = false;
	captureWrites = 0;
	disposed = false;
	muteQueue = Promise.resolve();
	captureProcesses = /* @__PURE__ */ new WeakMap();
	deviceInfo = /* @__PURE__ */ new Map();
	/** attach 时切换到 ADBKeyboard 前的原输入法（detach 时还原） */
	prevIme = /* @__PURE__ */ new Map();
	seenDetached = /* @__PURE__ */ new Set();
	reaperTimer = null;
	refreshTimer = null;
	/** dispose 竞态守卫（B22b）：start 在途的会话集合——dispose 时一并 stop，防孤儿 server 占编码器 */
	pendingStarts = /* @__PURE__ */ new Set();
	/** FLAG_SECURE（B22）：焦点窗口 SECURE 位缓存 / 检测与缓解链在-flight / root 能力缓存 */
	secureStates = /* @__PURE__ */ new Map();
	secureInflight = /* @__PURE__ */ new Map();
	mitigateInflight = /* @__PURE__ */ new Map();
	lastMitigate = /* @__PURE__ */ new Map();
	rootProbe = /* @__PURE__ */ new Map();
	secureTimer = null;
	constructor(adb, state, opts) {
		this.adb = adb;
		this.state = state;
		this.opts = opts;
		mkdirSync(this.opts.shotsDir, { recursive: true });
		for (const job of state.data.pending) {
			const error = job.error ?? "服务重载，采集已转待保存；请重试保存（先结束可能仍在运行的设备采集）。";
			if (job.type === "record") this.records.set(job.serial, {
				proc: null,
				file: job.remote,
				...job,
				status: "pending-save",
				error
			});
			else {
				this.debugSessions.set(job.id, {
					...job,
					captureOptions: "",
					mode: "human",
					stoppedAt: job.stoppedAt ?? Date.now(),
					segments: job.segments,
					acts: job.actions,
					recordProc: null,
					logProc: null,
					logRing: [],
					logRingBytes: 0,
					errFile: join(job.dir, job.id + "-logcat.log"),
					errStream: null,
					segIndex: job.segments.length,
					shortRotations: 0,
					rotateTimer: null,
					logRemote: job.logRemote,
					error
				});
				this.debugBySerial.set(job.serial, job.id);
			}
		}
	}
	persistRecord(serial) {
		const r = this.records.get(serial);
		this.state.upsertPending({
			id: r.id,
			type: "record",
			serial,
			dir: r.dir,
			startedAt: r.startedAt,
			stoppedAt: r.stoppedAt,
			remote: r.file,
			error: r.error,
			captureError: r.captureError
		});
	}
	persistDebug(sess) {
		this.state.upsertPending({
			id: sess.id,
			type: "debug",
			serial: sess.serial,
			dir: sess.dir,
			startedAt: sess.startedAt,
			stoppedAt: sess.stoppedAt,
			logRemote: sess.logRemote,
			clockStart: sess.clockStart,
			clockEnd: sess.clockEnd,
			segments: sess.segments,
			actions: sess.acts,
			error: sess.error,
			captureError: sess.captureError
		});
	}
	async stopRecoveredCapture(serial, remote, signal) {
		const command = remote.endsWith(".log") ? "logcat -v epoch -f " + remote : "screenrecord --time-limit " + (remote.includes("dsh_record-") ? "180 " : "170 ") + remote;
		const pids = async () => {
			return (await this.adb.runOk([
				"-s",
				serial,
				"shell",
				"ps",
				"-A",
				"-o",
				"PID,ARGS"
			], {
				signal,
				timeoutMs: 8e3
			})).split("\n").flatMap((line) => {
				const match = /^\s*(\d+)\s+(.*)$/.exec(line);
				if (!match) return [];
				const argv = match[2].trim();
				if (argv === command || argv === "/system/bin/" + command) return [match[1]];
				const words = argv.split(/\s+/), executable = words.shift(), file = words.pop();
				const limit = remote.includes("dsh_record-") ? 180 : 170;
				return !remote.endsWith(".log") && (executable === "screenrecord" || executable === "/system/bin/screenrecord") && file === remote && new RegExp("^--size [0-9]+x[0-9]+ --bit-rate [0-9]+ --time-limit " + limit + "$").test(words.join(" ")) ? [match[1]] : [];
			});
		};
		for (const pid of await pids()) await this.adb.runOk([
			"-s",
			serial,
			"shell",
			"kill",
			"-2",
			pid
		], {
			signal,
			timeoutMs: 8e3
		});
		const deadline = Date.now() + 15e3;
		while ((await pids()).length) {
			if (Date.now() >= deadline) throw new Error("重载采集停止超时；原件已保留：" + remote);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
	startTimers() {
		this.refreshTimer = setInterval(() => {
			this.refreshDevices().catch(() => {});
		}, 2e3);
		this.reaperTimer = setInterval(() => {
			this.reapIdle();
		}, 3e4);
		if (this.opts.flagSecureCheck) this.secureTimer = setInterval(() => {
			const serials = /* @__PURE__ */ new Set();
			for (const [serial, st] of this.streams) if (st.running) serials.add(serial);
			for (const serial of this.claims.keys()) serials.add(serial);
			for (const [serial, m] of this.modes) if (m === "poll") serials.add(serial);
			for (const serial of serials) this.checkSecure(serial).catch(() => void 0);
		}, 2500);
	}
	async refreshDevices() {
		const list = await this.adb.devices();
		for (const d of list) if (!this.deviceInfo.has(d.serial) && !d.isEmulator) this.adb.getDeviceInfo(d.serial).then((i) => this.deviceInfo.set(d.serial, i)).catch(() => void 0);
		this.devicesCache = list;
		this.devicesAt = Date.now();
		const online = new Set(list.map((d) => d.serial));
		for (const serial of [...this.claims.keys()]) if (!online.has(serial)) {
			this.claims.delete(serial);
			this.streams.get(serial)?.stop();
			this.streams.delete(serial);
			this.modes.delete(serial);
		}
		return list;
	}
	async ensureDevices() {
		if (Date.now() - this.devicesAt > 2e3) await this.refreshDevices();
		return this.devicesCache;
	}
	async listDevices() {
		const list = await this.ensureDevices();
		const now = Date.now();
		return {
			devices: list.map((d) => {
				const info = this.deviceInfo.get(d.serial);
				const brand = info?.brand || d.model || d.serial;
				const market = info?.market || "";
				const type = info?.type ?? "手机";
				const parts = [
					brand,
					market && brand && market.toLowerCase().startsWith(brand.toLowerCase()) ? market.slice(brand.length).trim() : market,
					d.model ?? ""
				].map((x) => x.trim()).filter((x) => x !== "");
				const uniq = [...new Set(parts)];
				const name = d.isEmulator ? `模拟器 ${d.model ?? d.serial}` : `${uniq.join(" ") || d.serial}（${type}）`;
				return {
					serial: d.serial,
					state: d.state,
					model: d.model,
					isEmulator: d.isEmulator,
					claimedBy: this.claims.get(d.serial)?.sessionId ?? null,
					busy: (this.busyUntil.get(d.serial) ?? 0) > now,
					mode: this.modes.get(d.serial) ?? null,
					streamMode: this.state.data.streamMode[d.serial] === "screenshot" ? "screenshot" : "auto",
					name: name.replace(/\s+/g, " ").trim()
				};
			}),
			quality: { ...this.state.data.quality }
		};
	}
	async sessionState() {
		const now = Date.now();
		const busy = {};
		for (const [serial, until] of this.busyUntil) busy[serial] = until > now;
		const errors = {};
		for (const [serial, err] of this.streamErrors) if (this.streams.get(serial)?.running !== true) errors[serial] = err;
		const debug = {};
		for (const sess of this.debugSessions.values()) if (sess.stoppedAt == null) debug[sess.serial] = {
			id: sess.id,
			startedAt: sess.startedAt,
			mode: sess.mode
		};
		const secure = {};
		for (const [serial, info] of this.secureStates) secure[serial] = {
			secure: info.secure,
			pkg: info.pkg,
			checkedAt: info.checkedAt,
			captureVisible: info.captureVisible,
			lastMitigate: this.lastMitigate.get(serial) ?? null
		};
		return {
			claims: [...this.claims.values()],
			busy,
			streamErrors: errors,
			debug,
			secure
		};
	}
	/** 工具 attach（agent 路径）：DSH 工具审批 = 首次授权点，创建会话级认领。 */
	async attachForTool(sessionId, serial, signal, prefs) {
		const devices = await this.ensureDevices();
		let target;
		if (serial == null || serial === "") {
			const online = devices.filter((d) => d.state === "device");
			if (online.length === 0) throw new Error("没有在线设备（`adb devices` 为空）。请插入真机（开 USB 调试）或启动模拟器。");
			if (online.length > 1) throw new Error(`检测到 ${online.length} 台设备，请指定 serial：${online.map((d) => d.serial).join(", ")}`);
			target = online[0];
		} else {
			target = devices.find((d) => d.serial === serial);
			if (target == null) {
				if (isEmulatorSerial(serial)) throw new Error(`模拟器 ${serial} 当前不在线。可在面板设备菜单里启动，或先在 Android Studio 里启动它。`);
				throw new Error(`设备 ${serial} 不在线（adb devices 无此设备）。`);
			}
			if (target.state !== "device") throw new Error(`设备 ${serial} 状态为 ${target.state}（ unauthorized 需在手机上确认 USB 调试授权）`);
		}
		const s = target.serial;
		const dbgId = this.debugBySerial.get(s);
		if (dbgId != null) {
			const dbg = this.debugSessions.get(dbgId);
			if (dbg != null && dbg.stoppedAt == null && dbg.mode === "human") throw new Error(`调试会话进行中（人操作模式，${dbg.id}）——AI 请勿认领；结束调试会话后再 attach`);
		}
		const existing = this.claims.get(s);
		if (existing != null && existing.sessionId !== sessionId) throw new Error(`设备 ${s} 已被会话 ${existing.sessionId} 认领（设计规则：一台设备同时只归一个会话）。请先让该会话 detach，或换一台设备。`);
		const mine = [...this.claims.values()].filter((c) => c.sessionId === sessionId).length;
		if (existing == null && mine >= this.opts.maxPerSession) throw new Error(`本会话已认领 ${mine} 台设备（上限 ${this.opts.maxPerSession}），请先 detach。`);
		if (existing == null && this.claims.size >= this.opts.globalMax) throw new Error(`全局已认领 ${this.claims.size} 台设备（上限 ${this.opts.globalMax}）。`);
		this.streams.get(s)?.cancelPanelTouch();
		this.state.trust(s);
		await this.adb.shell(s, "input keyevent KEYCODE_WAKEUP", {
			signal,
			timeoutMs: 5e3
		}).catch(() => void 0);
		await this.adb.shell(s, "wm dismiss-keyguard", {
			signal,
			timeoutMs: 5e3
		}).catch(() => void 0);
		if (!s.startsWith("emulator")) {
			const ime = await this.imeStatus(s, signal).catch(() => ({
				installed: false,
				current: ""
			}));
			if (ime.installed && ime.current !== "com.android.adbkeyboard/.AdbIME") {
				await this.activateIme(s, ime.current, signal);
				this.opts.log(`[${s}] IME → ADBKeyboard（原: ${ime.current}）`);
			}
		}
		if (prefs?.mode != null) this.state.setStreamMode(s, prefs.mode);
		const forced = this.state.data.streamMode[s] === "screenshot";
		const mode = await this.ensureStream(s, signal);
		const streamError = forced ? null : mode === "poll" ? this.streamErrors.get(s) ?? "poll 模式（此前 scrcpy 启动失败）" : null;
		const meta = this.streams.get(s)?.info ?? null;
		const size = meta != null ? {
			w: meta.streamWidth,
			h: meta.streamHeight
		} : null;
		const deviceName = meta?.deviceName || null;
		this.streams.get(s)?.cancelPanelTouch();
		const claimedAt = existing?.claimedAt ?? Date.now();
		this.claims.set(s, {
			serial: s,
			sessionId,
			claimedAt,
			lastActivityAt: Date.now()
		});
		this.seenDetached.delete(s);
		this.checkSecure(s, signal).catch(() => void 0);
		const shot = await this.saveScreenshot(s, signal).catch(() => null);
		return {
			serial: s,
			model: target.model,
			isEmulator: target.isEmulator,
			mode,
			size,
			deviceName,
			screenshotPath: shot,
			streamError,
			streamMode: forced ? "screenshot" : "auto"
		};
	}
	/** 面板 attach（观察者路径）：用户手势即授权；只确保串流在跑，不创建认领、不与 agent 抢设备。 */
	async attachViewer(serial, signal) {
		const target = (await this.ensureDevices()).find((d) => d.serial === serial);
		if (target == null) throw new Error(`设备 ${serial} 不在线`);
		if (target.state !== "device") throw new Error(`设备 ${serial} 状态为 ${target.state}（unauthorized 需在手机上确认 USB 调试授权）`);
		const s = target.serial;
		if (!s.startsWith("emulator")) {
			await this.adb.shell(s, "input keyevent KEYCODE_WAKEUP", {
				signal,
				timeoutMs: 5e3
			}).catch(() => void 0);
			await this.adb.shell(s, "wm dismiss-keyguard", {
				signal,
				timeoutMs: 5e3
			}).catch(() => void 0);
			const ime = await this.imeStatus(s, signal).catch(() => ({
				installed: false,
				current: ""
			}));
			if (ime.installed && ime.current !== "com.android.adbkeyboard/.AdbIME") await this.activateIme(s, ime.current, signal);
		}
		await this.ensureStream(s, signal);
		this.checkSecure(s, signal).catch(() => void 0);
		const meta = this.streams.get(s)?.info ?? null;
		const forcedViewer = this.state.data.streamMode[s] === "screenshot";
		return {
			serial: s,
			model: target.model,
			isEmulator: target.isEmulator,
			mode: this.modes.get(s) ?? (forcedViewer ? "poll" : "h264"),
			size: meta != null ? {
				w: meta.streamWidth,
				h: meta.streamHeight
			} : null,
			streamError: forcedViewer ? null : this.streamErrors.get(s) ?? null,
			streamMode: forcedViewer ? "screenshot" : "auto"
		};
	}
	ensuring = /* @__PURE__ */ new Map();
	/** 每设备最近一次成功流的坐标系（流↔物理），供 adb 兜底路径换算（adb input 只认物理坐标）。 */
	lastDims = /* @__PURE__ */ new Map();
	adbPoint(s, x, y) {
		const d = this.lastDims.get(s);
		if (d != null && d.sw > 0 && d.sh > 0 && d.dw > 0 && d.dh > 0) return {
			x: Math.max(0, Math.min(d.dw - 1, Math.round(x * d.dw / d.sw))),
			y: Math.max(0, Math.min(d.dh - 1, Math.round(y * d.dh / d.sh)))
		};
		return {
			x,
			y
		};
	}
	/** /stream 订阅前保证可解码：重放缓存缺 config/IDR（溢出裁剪后）→ 重启会话换新关键帧。 */
	async ensureDecodableStream(s, signal) {
		const session = this.streams.get(s);
		if (session == null || !session.running) return;
		if (session.replayDecodable()) return;
		try {
			(await import("node:fs")).appendFileSync("/tmp/dap-route.log", `${(/* @__PURE__ */ new Date()).toISOString()} restart-for-decodability serial=${s}\n`);
		} catch {}
		this.opts.log(`[${s}] 重放缓存不可解码（缺 config/IDR）→ 重启串流会话`);
		session.stop();
		this.streams.delete(s);
		this.modes.delete(s);
		await this.ensureStream(s, signal);
	}
	/** 设备保护保险丝：会话启动频率上限（每设备 60s 内 ≤6 次）。超限 → 拒绝再拉起，防 app_process/
	*  MediaCodec 高频 churn 伤设备（实测教训：粗暴对待 app_process 可致系统不稳/设备重启）。
	*  超限期间返回 'poll'（正常降级），冷却后自动恢复。 */
	startTimes = /* @__PURE__ */ new Map();
	static FUSE_WINDOW_MS = 6e4;
	static FUSE_MAX_STARTS = 6;
	fuseOpen(s) {
		const now = Date.now();
		const times = (this.startTimes.get(s) ?? []).filter((t) => now - t < PaneHub.FUSE_WINDOW_MS);
		this.startTimes.set(s, times);
		return times.length >= PaneHub.FUSE_MAX_STARTS;
	}
	/** 确保 h264 串流在跑（per-device 互斥：并发调用共享同一次启动，防双 server 冲突）。 */
	async ensureStream(s, signal) {
		const inflight = this.ensuring.get(s);
		if (inflight != null) return inflight;
		const p = this.ensureStreamInner(s, signal).finally(() => this.ensuring.delete(s));
		this.ensuring.set(s, p);
		return p;
	}
	async ensureStreamInner(s, signal) {
		if (this.state.data.streamMode[s] === "screenshot") {
			const live = this.streams.get(s);
			if (live != null) {
				live.stop();
				this.streams.delete(s);
			}
			this.modes.set(s, "poll");
			this.pollSince.set(s, Date.now());
			this.streamErrors.delete(s);
			return "poll";
		}
		let session = this.streams.get(s);
		if (session == null || !session.running) {
			if (this.fuseOpen(s)) {
				this.opts.log(`[${s}] 会话重启保险丝熔断（60s 内 >6 次启动）→ 本分钟内降级 poll，保护设备`);
				this.modes.set(s, "poll");
				this.pollSince.set(s, Date.now());
				this.streamErrors.set(s, "会话重启过频（设备保护保险丝），稍后自动恢复");
				return "poll";
			}
			const times = this.startTimes.get(s) ?? [];
			times.push(Date.now());
			this.startTimes.set(s, times);
			try {
				session = new StreamSession(this.adb.path, s, this.opts.jarPath, this.state.data.quality, this.opts.log);
				this.pendingStarts.add(session);
				let meta;
				try {
					meta = await session.start(signal);
				} finally {
					this.pendingStarts.delete(session);
				}
				this.lastDims.set(s, {
					sw: meta.streamWidth,
					sh: meta.streamHeight,
					dw: session.displayDim.w,
					dh: session.displayDim.h
				});
				session.onDead((reason) => {
					if (this.streams.get(s) !== session) return;
					this.streamErrors.set(s, reason);
					this.streams.delete(s);
					this.modes.delete(s);
				});
				this.streams.set(s, session);
				this.streamErrors.delete(s);
				this.modes.delete(s);
				this.pollSince.delete(s);
				return "h264";
			} catch (e) {
				const msg = String(e instanceof Error ? e.message : e);
				this.opts.log(`[${s}] scrcpy 启动失败，降级 poll 模式：${msg}`);
				session?.stop();
				this.modes.set(s, "poll");
				this.pollSince.set(s, Date.now());
				this.streamErrors.set(s, msg);
				return "poll";
			}
		}
		return "h264";
	}
	/** 面板强制解锁：人显式接管（记录原因；被锁会话的下一次操作会收到「未被认领」并需重新 attach）。 */
	forceRelease(serial) {
		if (this.claims.get(serial) == null) return {
			released: false,
			note: "该设备未被认领"
		};
		this.releaseClaim(serial, "面板强制解锁（人工接管）");
		return {
			released: true,
			note: "已强制释放认领锁——原会话下次操作需重新 attach"
		};
	}
	detach(sessionId, serial) {
		const claim = this.claims.get(serial);
		if (claim == null) return { released: false };
		if (sessionId != null && claim.sessionId !== sessionId) throw new Error(`设备 ${serial} 由会话 ${claim.sessionId} 认领，无权从会话 ${sessionId} 释放。`);
		this.releaseClaim(serial, "manual detach");
		return { released: true };
	}
	releaseClaim(serial, reason) {
		this.restoreIme(serial);
		this.claims.delete(serial);
		this.seenDetached.add(serial);
		const stream = this.streams.get(serial);
		if (stream != null) {
			stream.stop();
			this.streams.delete(serial);
		}
		this.modes.delete(serial);
		if (this.records.get(serial) != null) this.stopRecord(serial).catch((e) => this.opts.log("停止录屏失败：" + String(e)));
		this.opts.log(`[${serial}] claim released: ${reason}`);
	}
	async reapIdle() {
		const now = Date.now();
		for (const [serial, claim] of [...this.claims]) if (now - claim.lastActivityAt > this.opts.idleDetachMs) {
			const isEmu = isEmulatorSerial(serial);
			this.releaseClaim(serial, `闲置 ${Math.round(this.opts.idleDetachMs / 6e4)} 分钟`);
			if (isEmu) await this.adb.emuKill(serial).catch(() => void 0);
		}
		for (const [serial, stream] of [...this.streams]) if (!this.claims.has(serial)) {
			if (stream.hasActiveViewer()) continue;
			stream.stop();
			this.streams.delete(serial);
			this.modes.delete(serial);
		}
	}
	getStream(serial) {
		return this.streams.get(serial) ?? null;
	}
	getMode(serial) {
		return this.modes.get(serial) ?? null;
	}
	/** 焦点窗口 SECURE 位检测（dumpsys window windows → 解析）。2.5s 定时器 + attach 即检共用；在-flight 去重。 */
	async checkSecure(serial, signal) {
		const inflight = this.secureInflight.get(serial);
		if (inflight != null) return inflight;
		const p = (async () => {
			const r = await this.adb.shell(serial, "dumpsys window", {
				signal,
				timeoutMs: 12e3
			}).catch(() => null);
			const info = r != null && r.code === 0 && r.stdout.length > 200 ? extractSecureState(r.stdout) : {
				secure: false,
				pkg: null,
				activity: null,
				focusTitle: null,
				source: "none",
				checkedAt: Date.now()
			};
			this.secureStates.set(serial, info);
			if (info.secure && info.captureVisible === void 0) {
				const cap = await this.probeCaptureVisible(serial, signal).catch(() => ({
					visible: false,
					metric: "probe-failed"
				}));
				info.captureVisible = cap.visible;
				this.secureStates.set(serial, info);
				this.opts.log(`[${serial}] FLAG_SECURE 页面截图通道实测: ${cap.visible ? "可见" : "黑帧"}（${cap.metric}）`);
			}
			if (!info.secure) info.captureVisible = void 0;
			return info;
		})().finally(() => this.secureInflight.delete(serial));
		this.secureInflight.set(serial, p);
		return p;
	}
	secureInfo(serial) {
		return this.secureStates.get(serial) ?? null;
	}
	/** root 能力探测（60s 缓存）：构建类型 / su / Magisk|LSPosed 框架。只探测，绝不执行提权。 */
	async probeRootCapability(serial, signal) {
		const cached = this.rootProbe.get(serial);
		if (cached != null && Date.now() - cached.at < 6e4) return cached;
		const bt = (await this.adb.shell(serial, "getprop ro.build.type", {
			signal,
			timeoutMs: 6e3
		}).catch(() => ({
			stdout: "",
			code: 1
		}))).stdout.trim();
		const su = (await this.adb.shell(serial, "command -v su", {
			signal,
			timeoutMs: 6e3
		}).catch(() => ({
			stdout: "",
			code: 1
		}))).code === 0;
		const pkgs = (await this.adb.shell(serial, "pm list packages 2>/dev/null | grep -iE \"magisk|lsposed|edxposed\" || true", {
			signal,
			timeoutMs: 15e3
		}).catch(() => ({
			stdout: "",
			code: 1
		}))).stdout.trim();
		const framework = /magisk/i.test(pkgs) ? "Magisk" : /lsposed|edxposed/i.test(pkgs) ? "LSPosed/EdXposed" : pkgs !== "" ? pkgs.split("\n")[0] : null;
		const v = {
			buildType: bt === "" ? "unknown" : bt,
			su,
			framework
		};
		this.rootProbe.set(serial, {
			...v,
			at: Date.now()
		});
		return v;
	}
	/** userdebug/eng：adb root（必须带 -s——多设备在线时裸 `adb root` 直接 exit 1，实测教训；
	*  adbd 重启后 id -u 重试确认）。保留原始输出用于 fail loud。user 构建绝不调用。 */
	async tryAdbRoot(serial, signal) {
		const r = await this.adb.run([
			"-s",
			serial,
			"root"
		], {
			signal,
			timeoutMs: 15e3
		}).catch((e) => ({
			code: -1,
			stdout: "",
			stderr: String(e instanceof Error ? e.message : e).slice(0, 160)
		}));
		if (r.code !== 0) return {
			ok: false,
			note: `adb root 失败（exit=${r.code}）: ${(r.stderr || r.stdout || "无输出").slice(0, 160)}`
		};
		for (let i = 0; i < 8; i++) {
			await new Promise((res) => setTimeout(res, 1200));
			const id = await this.adb.shell(serial, "id -u", {
				signal,
				timeoutMs: 6e3
			}).catch(() => null);
			if (id != null && id.code === 0 && id.stdout.trim() === "0") return {
				ok: true,
				note: "adbd 已 root（还原: adb unroot）"
			};
		}
		return {
			ok: false,
			note: "adb root 已执行但 8 次重试内 id -u 非 0（adbd 未切 root，设备策略可能限制）"
		};
	}
	/** 串流重启（缓解链内用）：停旧会话 → 等编码器释放 → 重新拉起。 */
	async restartStream(serial, signal) {
		this.streams.get(serial)?.stop();
		this.streams.delete(serial);
		this.modes.delete(serial);
		await new Promise((res) => setTimeout(res, 1200));
		await this.ensureStream(serial, signal).catch(() => void 0);
	}
	/** B22d：实测截图通道可见性（原始帧缓冲采样）。双机校准：黑帧 distinct≈47/top2≈100%，
	*  内容帧 distinct 211-256/top2≤95%。零副作用：不改 root 态、不动流。 */
	async probeCaptureVisible(serial, signal) {
		const buf = await this.adb.execOutBinary([
			"-s",
			serial,
			"exec-out",
			"screencap"
		], {
			signal,
			timeoutMs: 2e4
		}).catch(() => null);
		if (buf == null || buf.length < 1e5) return {
			visible: false,
			metric: "capture-failed"
		};
		const hist = new Array(256).fill(0);
		let n = 0;
		for (let i = 12; i < buf.length; i += 89) {
			hist[buf[i]]++;
			n++;
		}
		hist.sort((a, b) => b - a);
		const top2 = (hist[0] + hist[1]) / n;
		let distinct = 0;
		for (const c of hist) if (c > 0) distinct++;
		return {
			visible: distinct >= 100 && top2 <= .97,
			metric: `distinct=${distinct},top2=${Math.round(top2 * 100)}%`
		};
	}
	/** 缓解链（用户点「尝试显示」触发）。B22d 实证版：
	*  ① 无 root 态实测截图通道（零副作用）→ 可见即切快照流（部分 userdebug 机器 screencap 不受 FLAG_SECURE 限制）
	*  ② 不可见且 userdebug/eng → adb root 后复测 → 可见即【保持 root】+ 快照流（绝不无谓 unroot）
	*  ③ 全部不可见 → （试过 root 则还原）→ 降级内容通道。判定全部基于像素实测，不以 FLAG 位推断。 */
	async secureMitigate(serial, signal) {
		const inflight = this.mitigateInflight.get(serial);
		if (inflight != null) return inflight;
		const p = (async () => {
			const steps = [];
			let rootApplied = false;
			const uidNote = (await this.adb.shell(serial, "id -u", {
				signal,
				timeoutMs: 6e3
			}).catch(() => ({
				stdout: "",
				code: 1
			}))).stdout.trim() === "0" ? "adbd=root" : "adbd=shell";
			let cap = await this.probeCaptureVisible(serial, signal);
			if (cap.visible) steps.push({
				step: "截图通道",
				status: "ok",
				detail: `实测本机 screencap 不受 FLAG_SECURE 限制（${cap.metric}，${uidNote}）`
			});
			else {
				steps.push({
					step: "截图通道",
					status: "skipped",
					detail: `screencap 为黑帧（${cap.metric}，${uidNote}）——尝试 adb root 路径`
				});
				const probe = await this.probeRootCapability(serial, signal);
				if (probe.buildType === "user" || probe.buildType === "unknown") steps.push({
					step: "adb root",
					status: "skipped",
					detail: `ro.build.type=${probe.buildType}——adb root 仅对 userdebug/eng 设备可用（生产构建 adbd 拒绝 root），跳过`
				});
				else {
					const root = await this.tryAdbRoot(serial, signal);
					if (root.ok) {
						rootApplied = true;
						steps.push({
							step: "adb root",
							status: "ok",
							detail: `ro.build.type=${probe.buildType} → ${root.note}`
						});
						cap = await this.probeCaptureVisible(serial, signal);
						if (cap.visible) steps.push({
							step: "root 截图通道",
							status: "ok",
							detail: `root 态 screencap 实测可见（${cap.metric}）——adbd 保持 root（还原: adb unroot）`
						});
						else steps.push({
							step: "root 截图通道",
							status: "failed",
							detail: `root 态 screencap 仍为黑帧（${cap.metric}）——root 无增益`
						});
					} else steps.push({
						step: "adb root",
						status: "failed",
						detail: `ro.build.type=${probe.buildType} 但 ${root.note}`
					});
				}
			}
			const pixelPossible = cap.visible;
			if (pixelPossible) steps.push({
				step: "判定",
				status: "ok",
				detail: "像素可见（实证）——画面保持当前通道实时显示，横幅不再提示"
			});
			else {
				if (rootApplied) {
					const ur = await this.adb.run([
						"-s",
						serial,
						"unroot"
					], {
						signal,
						timeoutMs: 15e3
					}).catch(() => null);
					if (ur != null && ur.code === 0) {
						await new Promise((res) => setTimeout(res, 2e3));
						await this.restartStream(serial, signal).catch(() => void 0);
						steps.push({
							step: "还原",
							status: "ok",
							detail: "adb unroot 已执行——root 对本场景无增益，设备回到原状态"
						});
					} else steps.push({
						step: "还原",
						status: "failed",
						detail: "adb unroot 失败——如需还原请手动执行 adb unroot"
					});
				}
				const probe2 = await this.probeRootCapability(serial, signal);
				if (probe2.framework != null) steps.push({
					step: "root 框架",
					status: "hint",
					detail: `${probe2.framework}——${HINT_DISABLE_FLAG_SECURE}`
				});
				else if (probe2.su) steps.push({
					step: "root 框架",
					status: "hint",
					detail: "存在 su 但未检测到 Magisk/LSPosed——像素级镜像需 DisableFlagSecure 类模块（Zygisk/LSPosed）。本插件绝不代装模块。"
				});
				else steps.push({
					step: "root 框架",
					status: "skipped",
					detail: "无 su、无 Magisk/LSPosed（command -v su + pm list packages 实测）——模块路径不可用"
				});
				const after = await this.checkSecure(serial, signal);
				steps.push({
					step: "判定",
					status: "failed",
					detail: `焦点窗口仍带 FLAG_SECURE${after.pkg != null ? `（${after.pkg}）` : ""}，截图通道实测黑帧 → 像素不可显示（系统级保护）；已切降级内容通道（控件树文本视图）`
				});
			}
			const result = {
				serial,
				pixelPossible,
				steps,
				checkedAt: Date.now()
			};
			this.lastMitigate.set(serial, result);
			return result;
		})().finally(() => this.mitigateInflight.delete(serial));
		this.mitigateInflight.set(serial, p);
		return p;
	}
	/** agent 操作：认领校验 + busy 徽标 + 动作 + 自动截图。 */
	async act(sessionId, req, signal) {
		const s = this.resolveSerialForSession(sessionId, req.serial);
		const now = Date.now();
		this.busyUntil.set(s, now + 4e3);
		this.claims.get(s).lastActivityAt = now;
		if (this.modes.get(s) === "poll" || this.streams.get(s)?.running !== true) await this.ensureStream(s, signal);
		const performed = await this.performAct(s, req, signal, "agent");
		const shot = await this.saveScreenshot(s, signal).catch(() => null);
		const sec = this.secureStates.get(s);
		if (sec?.secure === true) {
			if (sec.captureVisible !== true) return {
				serial: s,
				performed,
				screenshotPath: shot,
				secureHint: `当前页面受 FLAG_SECURE 保护（${sec.pkg ?? "未知包名"}）——串流画面为黑屏（系统行为，非故障）。读取内容/定位元素请改用 android_pane_uidump / android_pane_ui（无障碍通道不受影响）；面板可点「尝试显示」走缓解链。`
			};
		}
		return {
			serial: s,
			performed,
			screenshotPath: shot
		};
	}
	/** 面板手势：不需要认领；**设备被任一智能体会话认领即全程锁定**（用户预期：锁到任务完成才释放）。
	*  紧急接管：面板「强制解锁」按钮（POST /claim/release）或该会话 detach/闲置自动释放。 */
	async actPanel(req, signal) {
		const serial = req.serial;
		if (req.coordinateSpace != null && req.coordinateSpace !== "stream" && req.coordinateSpace !== "physical") throw Object.assign(/* @__PURE__ */ new Error("coordinateSpace 须为 stream|physical"), { code: "bad-request" });
		if (req.coordinateSpace === "physical" && (req.action !== "tap" || !Number.isFinite(req.x) || !Number.isFinite(req.y) || req.x < 0 || req.y < 0 || req.x > 65535 || req.y > 65535)) throw Object.assign(/* @__PURE__ */ new Error("physical 仅允许有效物理坐标的 tap"), { code: "bad-request" });
		if (serial == null || serial === "") throw new Error("面板操作需要 serial");
		this.assertPanelAvailable(serial);
		if (this.streams.get(serial)?.running !== true) await this.ensureStream(serial, signal).catch(() => void 0);
		this.assertPanelAvailable(serial);
		return {
			serial,
			performed: await this.performAct(serial, req, signal, "panel")
		};
	}
	assertPanelAvailable(serial) {
		const claim = this.claims.get(serial);
		if (claim != null) {
			const err = /* @__PURE__ */ new Error(`设备已被智能体会话锁定（${claim.sessionId.slice(0, 8)}）——任务完成后自动释放；紧急接管请点面板「强制解锁」`);
			err.code = "agent-busy";
			throw err;
		}
		if ((this.busyUntil.get(serial) ?? 0) > Date.now()) {
			const err = /* @__PURE__ */ new Error("智能体正在操作此设备，请稍候（人机互斥）");
			err.code = "agent-busy";
			throw err;
		}
	}
	/** Panel input stays separate from agent act: no session header can bypass the human lock. */
	panelInput(serial, raw) {
		if (serial == null || serial === "") throw Object.assign(/* @__PURE__ */ new Error("Panel input requires serial"), { code: "bad-request" });
		const input = parsePanelInput(raw);
		const stream = this.streams.get(serial);
		if (input.events.every((e) => e.p === "up")) {
			stream?.cancelPanelTouch(input.gesture);
			return {
				serial,
				performed: "input(released)"
			};
		}
		this.assertPanelAvailable(serial);
		if (stream == null || !stream.running) throw Object.assign(/* @__PURE__ */ new Error("Panel control stream unavailable; reconnect"), { code: "no-stream" });
		stream.injectPanelInput(input);
		const dbg = this.debugSessions.get(this.debugBySerial.get(serial) ?? "");
		const performed = "input(" + input.events.map((e) => e.p).join(",") + ")|ctl";
		if (dbg != null && dbg.stoppedAt == null) {
			dbg.acts.push({
				t: Date.now(),
				action: "input",
				detail: performed
			});
			this.persistDebug(dbg);
		}
		return {
			serial,
			performed
		};
	}
	/** 工具层解析目标设备（公开入口）。 */
	serialForSession(sessionId, serial) {
		return this.resolveSerialForSession(sessionId, serial);
	}
	/** 解析会话目标设备：显式 serial 须是本会话认领的；缺省时本会话仅认领一台才可自动选。 */
	resolveSerialForSession(sessionId, serial) {
		const mine = [...this.claims.entries()].filter(([, c]) => c.sessionId === sessionId);
		if (serial != null && serial !== "") {
			const claim = this.claims.get(serial);
			if (claim == null || claim.sessionId !== sessionId) throw new Error(`设备 ${serial} 未被本会话认领。先调用 android_pane_attach。`);
			return serial;
		}
		if (mine.length === 1) return mine[0][0];
		if (mine.length === 0) throw new Error("本会话尚未 attach 任何设备。先调用 android_pane_attach。");
		throw new Error(`本会话认领了 ${mine.length} 台设备，请指定 serial：${mine.map(([s]) => s).join(", ")}`);
	}
	/** ⚠️ touch 注入通道决策（Android 17 + 深度定制系统 实测教训）：
	*  scrcpy 3.3.4 在此组合下把 touch 注入绑定到其虚拟 display（displayId 3, layerStack 3），
	*  事件到不了真实 display 0 的应用（keycode 不受影响）——故 touch 一律走 `adb input`（物理坐标），
	*  key/text/rotate 走 control socket（已实测可用）。adbPoint 负责流坐标→物理坐标换算。 */
	static TOUCH_VIA_CONTROL = false;
	/** performAct：调试会话时间线钩子 + 内层分发。agent 与面板操作都经此（单一咽喉）。 */
	async performAct(s, req, signal, via = "agent") {
		const dbgId = this.debugBySerial.get(s);
		const dbg = dbgId != null ? this.debugSessions.get(dbgId) : void 0;
		if (via === "agent" && dbg != null && dbg.stoppedAt == null && dbg.mode === "human") throw new Error("调试会话进行中（人操作模式）——AI 请勿注入干扰；如需接管先停止调试会话");
		if (via === "agent") this.streams.get(s)?.cancelPanelTouch();
		const act = dbg != null && dbg.stoppedAt == null ? {
			t: Date.now(),
			action: req.action
		} : void 0;
		let completed;
		let pending;
		if (act != null) {
			dbg.acts.push(act);
			this.persistDebug(dbg);
			pending = new Promise((resolve) => {
				completed = resolve;
			});
			(dbg.pendingActions ??= /* @__PURE__ */ new Set()).add(pending);
		}
		try {
			const performed = await this.performActInner(s, req, signal, via);
			if (act != null) act.detail = performed;
			return performed;
		} catch (e) {
			if (act != null) act.detail = "FAILED: " + String(e instanceof Error ? e.message : e);
			throw e;
		} finally {
			if (act != null) {
				act.endedAt = Date.now();
				completed();
				dbg.pendingActions.delete(pending);
				if (!dbg.saved && !this.disposed) this.persistDebug(dbg);
			}
		}
	}
	async performActInner(s, req, signal, via = "agent") {
		const stream = this.streams.get(s);
		const h264 = stream != null && stream.running;
		switch (req.action) {
			case "tap": {
				const x = Math.round(req.x ?? 0);
				const y = Math.round(req.y ?? 0);
				if (PaneHub.TOUCH_VIA_CONTROL && h264) {
					stream.injectTouch(x, y, 0);
					stream.injectTouch(x, y, 1);
				} else {
					const p = via === "panel" && req.coordinateSpace !== "physical" ? this.adbPoint(s, x, y) : {
						x,
						y
					};
					await this.adb.shellOk(s, `input tap ${p.x} ${p.y}`, {
						signal,
						timeoutMs: 1e4
					});
				}
				return `tap(${x},${y})${PaneHub.TOUCH_VIA_CONTROL && h264 ? "|ctl" : "|adb"}`;
			}
			case "swipe": {
				const x1 = Math.round(req.x ?? 0);
				const y1 = Math.round(req.y ?? 0);
				const x2 = Math.round(req.x2 ?? req.x ?? 0);
				const y2 = Math.round(req.y2 ?? req.y ?? 0);
				const dur = Math.min(2e3, Math.max(80, req.durationMs ?? 300));
				if (PaneHub.TOUCH_VIA_CONTROL && h264) await stream.injectSwipe(x1, y1, x2, y2, dur);
				else {
					const p1 = via === "panel" ? this.adbPoint(s, x1, y1) : {
						x: x1,
						y: y1
					};
					const p2 = via === "panel" ? this.adbPoint(s, x2, y2) : {
						x: x2,
						y: y2
					};
					await this.adb.shellOk(s, `input swipe ${p1.x} ${p1.y} ${p2.x} ${p2.y} ${dur}`, {
						signal,
						timeoutMs: 12e3
					});
				}
				return `swipe(${x1},${y1}→${x2},${y2},${dur}ms)${PaneHub.TOUCH_VIA_CONTROL && h264 ? "|ctl" : "|adb"}`;
			}
			case "key": {
				const name = req.key ?? "";
				const keycode = KEYCODE[name];
				if (keycode == null) throw new Error(`未知按键 ${name}（可用：${Object.keys(KEYCODE).join("/")}）`);
				if (h264) stream.tapKey(keycode);
				else await this.adb.shellOk(s, `input keyevent ${keycode}`, {
					signal,
					timeoutMs: 1e4
				});
				return `key(${name})`;
			}
			case "text": {
				const text = req.text ?? "";
				if (text === "") throw new Error("text 不能为空");
				const ascii = /^[\x20-\x7e]*$/.test(text) && Buffer.byteLength(text, "utf8") <= 300;
				if (h264) if (ascii) stream.injectText(text);
				else {
					if ((await this.imeStatus(s, signal)).installed) return `text(${text.length} chars): ${await this.imeSend(s, text, signal)}`;
					stream.injectText(text);
					return `text(${text.length} chars via clipboard)`;
				}
				else {
					if (!ascii) throw new Error("poll 降级模式不支持非 ASCII 文本；请安装 ADBKeyboard（android_pane_install_ime）或恢复 h264 模式");
					await this.adb.shellOk(s, `input text ${JSON.stringify(text).slice(1, -1).replace(/ /g, "%s")}`, {
						signal,
						timeoutMs: 1e4
					});
				}
				return `text(${text.length} chars)`;
			}
			case "scroll": {
				const x = Math.round(req.x ?? 0);
				const y = Math.round(req.y ?? 0);
				const dy = req.y2 != null ? Math.round(req.y2) : -1;
				if (h264) {
					const meta = stream.info;
					const dim = stream.displayDim;
					const sx = via === "agent" && meta != null ? x * meta.streamWidth / dim.w : x;
					const sy = via === "agent" && meta != null ? y * meta.streamHeight / dim.h : y;
					stream.scroll(sx, sy, 0, dy);
				} else {
					const p = via === "panel" ? this.adbPoint(s, x, y) : {
						x,
						y
					};
					await this.adb.shellOk(s, `input swipe ${p.x} ${p.y} ${p.x} ${p.y + dy * 400} 300`, {
						signal,
						timeoutMs: 1e4
					});
				}
				return `scroll(${x},${y},dy=${dy})`;
			}
			case "back":
			case "home":
			case "recents":
			case "volume_up":
			case "volume_down": {
				const keycode = KEYCODE[req.action];
				if (h264) stream.tapKey(keycode);
				else await this.adb.shellOk(s, `input keyevent ${keycode}`, {
					signal,
					timeoutMs: 1e4
				});
				return req.action;
			}
			case "rotate": return this.rotate(s, signal);
			default: throw new Error(`未知动作 ${String(req.action)}`);
		}
	}
	/** ADBKeyboard 输入法状态。 */
	async imeStatus(s, signal) {
		return {
			installed: (await this.adb.shell(s, "ime list -a -s", {
				signal,
				timeoutMs: 8e3
			}).catch(() => ({ stdout: "" }))).stdout.split("\n").some((l) => l.trim().startsWith("com.android.adbkeyboard")),
			current: (await this.adb.shell(s, "settings get secure default_input_method", {
				signal,
				timeoutMs: 6e3
			}).catch(() => ({ stdout: "" }))).stdout.trim()
		};
	}
	async activateIme(s, previous, signal) {
		await this.adb.shellOk(s, "ime enable com.android.adbkeyboard/.AdbIME", {
			signal,
			timeoutMs: 8e3
		});
		await this.adb.shellOk(s, "ime set com.android.adbkeyboard/.AdbIME", {
			signal,
			timeoutMs: 8e3
		});
		if ((await this.imeStatus(s, signal)).current !== "com.android.adbkeyboard/.AdbIME") throw new Error("ADBKeyboard 激活回读失败，不能保证中文输入");
		if (!this.prevIme.has(s)) this.prevIme.set(s, previous);
	}
	/** Input method must still be active; never report a broadcast to an inactive IME as typed text. */
	async imeSend(s, text, signal) {
		if ((await this.imeStatus(s, signal)).current !== "com.android.adbkeyboard/.AdbIME") throw new Error("ADBKeyboard 未激活，中文未发送；重新连接设备后再聚焦输入框");
		const escaped = text.replace(/'/g, "'\\''");
		await this.adb.shellOk(s, `am broadcast -a ADB_INPUT_TEXT --es msg '${escaped}'`, {
			signal,
			timeoutMs: 1e4
		});
		await new Promise((r) => setTimeout(r, 350));
		return `text(${text.length} chars via ADBKeyboard)`;
	}
	/** 安装 ADBKeyboard.apk 并启用输入法（一次性设置；深度定制系统 会弹设备端确认）。 */
	async installIme(serial, signal) {
		const imeApk = join(dirname(this.opts.jarPath), "ADBKeyboard.apk");
		const r = await this.adb.run([
			"-s",
			serial,
			"install",
			"-r",
			imeApk
		], {
			signal,
			timeoutMs: 9e4
		});
		if (r.code !== 0 || /Failure/.test(r.stdout + r.stderr)) throw new Error(`ADBKeyboard 安装失败：${(r.stderr || r.stdout).slice(0, 200)}（深度定制系统 需在手机上确认「USB 安装」并开启安装权限）`);
		await this.adb.shellOk(serial, "ime enable com.android.adbkeyboard/.AdbIME", {
			signal,
			timeoutMs: 8e3
		});
		return {
			installed: true,
			note: "ADBKeyboard 已安装并启用"
		};
	}
	/** 首个在线设备 serial。 */
	firstOnlineSerial() {
		return this.devicesCache.find((d) => d.state === "device")?.serial ?? null;
	}
	async rotate(s, signal) {
		const cur = (await this.adb.shell(s, "settings get system user_rotation", { signal })).stdout.trim();
		const next = ((/^\d$/.test(cur) ? Number(cur) : 0) + 1) % 4;
		await this.adb.shellOk(s, "settings put system accelerometer_rotation 0", {
			signal,
			timeoutMs: 8e3
		});
		await this.adb.shellOk(s, `settings put system user_rotation ${next}`, {
			signal,
			timeoutMs: 8e3
		});
		return `rotate→user_rotation=${next}`;
	}
	captureState() {
		const state = this.state.reload();
		const rec = [...this.records.entries()][0];
		const dbg = [...this.debugBySerial.values()].map((id) => this.debugSessions.get(id)).find((s) => s != null);
		return {
			directory: this.state.data.directory,
			record: rec == null ? null : {
				serial: rec[0],
				startedAt: rec[1].startedAt,
				stoppedAt: rec[1].stoppedAt,
				status: rec[1].status,
				...rec[1].error ? { error: rec[1].error } : {}
			},
			debug: dbg == null ? null : {
				id: dbg.id,
				serial: dbg.serial,
				startedAt: dbg.startedAt,
				stoppedAt: dbg.stoppedAt,
				status: this.debugCapturing(dbg) ? "recording" : "pending-save",
				...dbg.error ? { error: dbg.error } : {}
			},
			outputs: this.state.data.outputs.map(({ identities: _identities, ...output }) => output),
			muted: Object.fromEntries(Object.keys(state.volumeRestore).map((serial) => [serial, true]))
		};
	}
	debugCapturing(sess) {
		return sess.stoppedAt == null || [sess.recordProc, sess.logProc].some((proc) => proc != null && !this.captureProcesses.get(proc)?.done);
	}
	setCaptureDirectory(directory) {
		if (this.captureStarting || this.captureWrites > 0 || [...this.records.values()].some((r) => r.status === "recording") || [...this.debugBySerial.values()].some((id) => {
			const sess = this.debugSessions.get(id);
			return sess != null && this.debugCapturing(sess);
		})) throw Object.assign(/* @__PURE__ */ new Error("采集或保存中不能修改目录；停止后保存失败可修改并重试"), { code: "capture-busy" });
		this.state.setDirectory(directory);
	}
	async capturePanel(serial, type, action) {
		this.assertPanelAvailable(serial);
		if ((await this.ensureDevices()).find((d) => d.serial === serial && d.state === "device") == null) throw new Error("设备不在线：" + serial);
		this.assertPanelAvailable(serial);
		if (type === "screenshot") await this.saveScreenshot(serial);
		else if (type === "record") await this.record(serial, action);
		else if (type === "debug") if (action === "stop") await this.debugStop(serial);
		else {
			const { id } = await this.debugStart(serial, "human");
			const sess = this.debugSessions.get(id);
			try {
				await Promise.all([this.captureReady(sess.recordProc), this.captureReady(sess.logProc)]);
			} catch (e) {
				sess.error = String(e instanceof Error ? e.message : e);
				await this.debugStop(serial).catch(() => void 0);
				throw e;
			}
		}
		else await this.toggleMute(serial);
	}
	async toggleMute(serial) {
		const work = this.muteQueue.then(async () => {
			if (this.disposed) throw new Error("采集服务已关闭");
			this.assertPanelAvailable(serial);
			const read = async () => {
				const out = await this.adb.runOk([
					"-s",
					serial,
					"shell",
					"cmd",
					"media_session",
					"volume",
					"--stream",
					"3",
					"--get"
				], { timeoutMs: 8e3 });
				const match = /volume is (\d+)/i.exec(out);
				if (match == null) throw new Error("无法读取媒体音量（stream 3）：" + out.slice(0, 200));
				return Number(match[1]);
			};
			const current = await read();
			this.assertPanelAvailable(serial);
			const previous = this.state.reload().volumeRestore[serial];
			const desired = previous ?? 0;
			if (previous == null) this.state.setVolumeRestore(serial, current);
			try {
				await this.adb.runOk([
					"-s",
					serial,
					"shell",
					"cmd",
					"media_session",
					"volume",
					"--stream",
					"3",
					"--set",
					String(desired)
				], { timeoutMs: 8e3 });
				if (await read() !== desired) throw new Error("设备媒体音量回读与目标不一致；静音状态未改变");
			} catch (e) {
				try {
					await this.adb.runOk([
						"-s",
						serial,
						"shell",
						"cmd",
						"media_session",
						"volume",
						"--stream",
						"3",
						"--set",
						String(current)
					], { timeoutMs: 8e3 });
					if (await read() !== current) throw new Error("媒体音量回滚回读失败");
					if (previous == null) this.state.setVolumeRestore(serial);
				} catch (err) {
					this.opts.log("媒体音量失败后还原失败，已保留恢复意图：" + String(err));
				}
				throw e;
			}
			if (previous != null) this.state.setVolumeRestore(serial);
		});
		this.muteQueue = work.catch(() => void 0);
		await work;
	}
	captureFile(id, index) {
		const output = this.state.data.outputs.find((o) => o.id === id);
		const file = output?.files[index];
		const identity = output?.identities[index];
		if (file == null || identity == null || !Number.isSafeInteger(index) || index < 0) throw Object.assign(/* @__PURE__ */ new Error("未登记的保存文件"), { code: "not-found" });
		const stat = lstatSync(file);
		if (!stat.isFile() || realpathSync(file) !== file || stat.dev !== identity.dev || stat.ino !== identity.ino) throw Object.assign(/* @__PURE__ */ new Error("保存文件已被替换或不是普通文件"), { code: "not-found" });
		return {
			file,
			...identity
		};
	}
	activeDirectory() {
		return [...this.records.values()][0]?.dir ?? [...this.debugBySerial.values()].map((id) => this.debugSessions.get(id)?.dir).find((d) => d != null) ?? this.state.data.directory;
	}
	async saveScreenshot(serial, signal) {
		this.captureWrites++;
		const id = "shot-" + randomUUID();
		let tmp;
		try {
			const dir = validateCaptureDirectory(this.activeDirectory());
			const secure = await this.checkSecure(serial, signal);
			if (secure.secure && secure.captureVisible !== true) throw new Error("受保护页面不可截图：截图通道为黑屏，请改用内容大纲");
			const png = await this.adb.screencap(serial, { signal });
			if (this.disposed) throw new Error("采集服务已关闭；截图未保存");
			if (png.length < 24 || !png.subarray(0, 8).equals(Buffer.from([
				137,
				80,
				78,
				71,
				13,
				10,
				26,
				10
			]))) throw new Error("设备未返回有效 PNG；截图未保存");
			const file = join(dir, id + ".png");
			tmp = file + ".tmp";
			writeFileSync(tmp, png, {
				flag: "wx",
				mode: 384
			});
			renameSync(tmp, file);
			this.state.registerOutput(id, "screenshot", [file]);
			return file;
		} finally {
			if (tmp != null) try {
				unlinkSync(tmp);
			} catch {}
			this.captureWrites--;
		}
	}
	async screenshotBuffer(serial, signal) {
		return this.adb.screencap(serial, { signal });
	}
	/** uiautomator 结构化控件树（规则：验证闭环增强）。 */
	async uidump(serial, signal) {
		const dump = async (cmd) => {
			const r = await this.adb.shell(serial, cmd, {
				signal,
				timeoutMs: 2e4
			});
			return r.code === 0 ? r.stdout : null;
		};
		let ok = await dump("uiautomator dump --compressed /data/local/tmp/dsh_uidump.xml");
		if (ok == null) ok = await dump("uiautomator dump /data/local/tmp/dsh_uidump.xml");
		if (ok == null) throw new Error("uiautomator dump 失败（设备可能不支持或 UI 自动化被系统限制）");
		const xml = await this.adb.shellOk(serial, "cat /data/local/tmp/dsh_uidump.xml", {
			signal,
			timeoutMs: 1e4
		});
		if (xml.length < 200) throw new Error(`uiautomator dump 输出异常（${xml.length} 字节）——设备可能正在转屏或 UI 自动化被占用`);
		const nodes = [];
		let depth = 0;
		for (const tok of xml.match(/<node[^>]*?\/>|<node[^>]*>|<\/node>/g) ?? []) {
			if (tok === "</node>") {
				depth--;
				continue;
			}
			const selfClosing = tok.endsWith("/>");
			const nodeDepth = depth;
			if (!selfClosing) depth++;
			const attr = (name) => {
				return new RegExp(`${name}="([^"]*)"`).exec(tok)?.[1] ?? "";
			};
			const b = /(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)/.exec(attr("bounds"));
			if (b == null) continue;
			const x1 = Number(b[1]);
			const y1 = Number(b[2]);
			const x2 = Number(b[3]);
			const y2 = Number(b[4]);
			const text = attr("text");
			const desc = attr("content-desc");
			const clickable = attr("clickable") === "true";
			if (!clickable && text === "" && desc === "") continue;
			nodes.push({
				text: text.slice(0, 80),
				desc: desc.slice(0, 80),
				cls: attr("class").slice(0, 40),
				clickable,
				center: [Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2)],
				depth: nodeDepth
			});
			if (nodes.length >= 100) break;
		}
		return nodes;
	}
	async nativeCaptureOptions(serial, signal) {
		const { maxSize, videoBitRate } = this.state.data.quality;
		if (!Number.isSafeInteger(maxSize) || maxSize < 128 || maxSize > 4096 || !Number.isSafeInteger(videoBitRate) || videoBitRate < 1) throw new Error("录制画质参数无效");
		const png = await this.adb.screencap(serial, { signal });
		if (png.length < 24 || !png.subarray(0, 8).equals(PNG_SIG)) throw new Error("无法读取录制画面尺寸");
		const w = png.readUInt32BE(16), height = png.readUInt32BE(20);
		if (!w || !height) throw new Error("设备录制画面尺寸无效");
		const scale = Math.min(1, maxSize / Math.max(w, height));
		return "--size " + Math.max(8, Math.round(w * scale / 8) * 8) + "x" + Math.max(8, Math.round(height * scale / 8) * 8) + " --bit-rate " + videoBitRate + " ";
	}
	/** Only generated remote paths enter this command; host directories never enter a shell. */
	spawnCapture(serial, command) {
		if (this.disposed) throw new Error("采集服务已关闭");
		const proc = spawn(this.adb.path, [
			"-s",
			serial,
			"shell",
			"echo $$; exec " + command
		], {
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			],
			windowsHide: true
		});
		let resolveReady, rejectReady, resolveClosed;
		const ready = new Promise((yes, no) => {
			resolveReady = yes;
			rejectReady = no;
		});
		const info = {
			ready,
			closed: new Promise((yes) => {
				resolveClosed = yes;
			}),
			stderr: "",
			done: false,
			pid: void 0,
			error: void 0
		};
		this.captureProcesses.set(proc, info);
		ready.catch(() => void 0);
		const timer = setTimeout(() => rejectReady(/* @__PURE__ */ new Error("采集进程启动超时：" + serial)), 8e3);
		let output = "";
		proc.stdout?.on("data", (data) => {
			if (info.pid != null) return;
			output += data.toString("utf8");
			const match = /^(\d+)\r?\n/.exec(output);
			if (match != null) {
				info.pid = match[1];
				clearTimeout(timer);
				resolveReady(match[1]);
			}
		});
		proc.stderr?.on("data", (data) => {
			info.stderr = (info.stderr + data.toString("utf8")).slice(-4e3);
		});
		proc.once("error", (e) => {
			info.error = e.message;
			rejectReady(e);
		});
		proc.once("close", (code) => {
			info.done = true;
			clearTimeout(timer);
			rejectReady(/* @__PURE__ */ new Error("采集进程未启动：" + (info.error ?? info.stderr)));
			resolveClosed(code);
		});
		return proc;
	}
	async captureReady(proc) {
		const info = this.captureProcesses.get(proc);
		await info.ready;
		await new Promise((resolve) => setTimeout(resolve, 250));
		if (info.done || info.error) throw new Error("设备采集启动失败：" + (info.error ?? info.stderr));
	}
	async stopCaptureProcess(serial, proc, signal) {
		const info = this.captureProcesses.get(proc);
		if (info.done) return;
		const pid = await info.ready;
		await this.adb.runOk([
			"-s",
			serial,
			"shell",
			"kill",
			"-2",
			pid
		], {
			signal,
			timeoutMs: 8e3
		});
		let timer;
		try {
			await Promise.race([info.closed, new Promise((_, no) => {
				timer = setTimeout(() => no(/* @__PURE__ */ new Error("设备采集停止超时：" + serial)), 15e3);
			})]);
		} finally {
			if (timer != null) clearTimeout(timer);
		}
	}
	async pullCapture(serial, remote, file, signal, allowEmpty = false) {
		const tmp = file + "." + randomUUID() + ".tmp";
		try {
			await this.adb.runOk([
				"-s",
				serial,
				"pull",
				remote,
				tmp
			], {
				signal,
				timeoutMs: 12e4
			});
			if (this.disposed) throw new Error("采集服务已重载；设备原件已保留，请在当前面板重试保存");
			const stat = lstatSync(tmp);
			if (stat.isFile() && stat.size === 0 && allowEmpty) return false;
			if (!stat.isFile() || stat.size === 0) throw new Error("设备采集文件为空：" + remote);
			if (file.endsWith(".mp4")) {
				const fd = openSync(tmp, "r"), header = Buffer.alloc(16), atoms = /* @__PURE__ */ new Set();
				try {
					for (let offset = 0; offset < stat.size;) {
						if (readSync(fd, header, 0, 8, offset) !== 8) throw new Error("录屏 MP4 头被截断：" + remote);
						let size = header.readUInt32BE(0);
						const headerSize = size === 1 ? 16 : 8;
						if (size === 1) {
							if (readSync(fd, header, 8, 8, offset + 8) !== 8) throw new Error("录屏 MP4 大文件头被截断");
							size = Number(header.readBigUInt64BE(8));
						}
						if (size === 0) size = stat.size - offset;
						if (!Number.isSafeInteger(size) || size < headerSize || offset + size > stat.size) throw new Error("录屏 MP4 文件不完整：" + remote);
						atoms.add(header.toString("ascii", 4, 8));
						offset += size;
					}
					if (![
						"ftyp",
						"mdat",
						"moov"
					].every((atom) => atoms.has(atom))) throw new Error("录屏 MP4 未完成封装：" + remote);
				} finally {
					closeSync(fd);
				}
			}
			renameSync(tmp, file);
			return true;
		} finally {
			try {
				unlinkSync(tmp);
			} catch {}
		}
	}
	async stopRecord(serial, outDir, signal) {
		const rec = this.records.get(serial);
		if (rec == null) return void 0;
		if (rec.saving != null) return rec.saving;
		const retry = rec.status === "pending-save";
		this.captureWrites++;
		rec.saving = (async () => {
			try {
				if (rec.proc == null) await this.stopRecoveredCapture(serial, rec.file, signal);
				else await this.stopCaptureProcess(serial, rec.proc, signal);
				if (this.disposed) throw new Error("采集服务已重载，请在当前面板重试保存");
				rec.status = "pending-save";
				rec.stoppedAt ??= Date.now();
				this.persistRecord(serial);
				const local = join(validateCaptureDirectory(retry ? outDir ?? this.state.data.directory : rec.dir), rec.id + ".mp4");
				await this.pullCapture(serial, rec.file, local, signal);
				this.state.registerOutput(rec.id, "record", [local], rec.captureError);
				this.records.delete(serial);
				if (!this.disposed) await this.adb.run([
					"-s",
					serial,
					"shell",
					"rm",
					"-f",
					rec.file
				], { timeoutMs: 5e3 }).catch((e) => this.opts.log("设备原片清理失败：" + String(e)));
				return local;
			} catch (e) {
				rec.error = String(e instanceof Error ? e.message : e);
				if (rec.proc == null || this.captureProcesses.get(rec.proc)?.done) rec.status = "pending-save";
				if (!this.disposed) this.persistRecord(serial);
				throw e;
			} finally {
				rec.saving = void 0;
				this.captureWrites--;
			}
		})();
		return rec.saving;
	}
	async record(serial, action, outDir, signal) {
		if (action === "start") {
			if (this.disposed || this.captureStarting || this.captureWrites > 0) throw Object.assign(/* @__PURE__ */ new Error("采集服务正忙或已关闭"), { code: "capture-busy" });
			if (this.debugBySerial.size > 0) throw Object.assign(/* @__PURE__ */ new Error("存在调试或待保存会话——先停止并保存"), { code: "capture-busy" });
			if (this.records.get(serial)?.status === "recording") return { note: "已在录制中（最长 180 秒）" };
			if (this.records.size > 0) throw Object.assign(/* @__PURE__ */ new Error("存在录屏或待保存记录——先停止并保存"), { code: "capture-busy" });
			this.captureStarting = true;
			try {
				const dir = validateCaptureDirectory(outDir ?? this.state.data.directory);
				if ((await this.checkSecure(serial, signal)).secure) throw new Error("受保护页面不能开始普通录屏；调试可继续，但视频可能黑屏");
				const id = "record-" + randomUUID(), remote = "/data/local/tmp/dsh_" + id + ".mp4";
				const options = await this.nativeCaptureOptions(serial, signal);
				const rec = {
					proc: null,
					file: remote,
					id,
					dir,
					startedAt: Date.now(),
					status: "recording",
					error: void 0,
					captureError: void 0,
					saving: void 0
				};
				this.state.upsertPending({
					id,
					type: "record",
					serial,
					dir,
					startedAt: rec.startedAt,
					remote
				});
				this.records.set(serial, rec);
				const proc = this.spawnCapture(serial, "screenrecord " + options + "--time-limit 180 " + remote);
				rec.proc = proc;
				proc.once("close", (code) => {
					if (rec.status !== "recording") return;
					if (code !== 0 && rec.saving == null) rec.captureError = "设备录屏提前结束：" + (this.captureProcesses.get(proc)?.stderr ?? String(code));
					this.stopRecord(serial).catch((e) => this.opts.log("自动保存录屏失败：" + String(e)));
				});
				if (signal != null) {
					const abort = () => {
						this.stopRecord(serial).catch((e) => this.opts.log("取消录屏保存失败：" + String(e)));
					};
					if (signal.aborted) abort();
					else {
						signal.addEventListener("abort", abort, { once: true });
						proc.once("close", () => signal.removeEventListener("abort", abort));
					}
				}
				await this.captureReady(proc);
				return { note: "录制已开始（最长 180 秒，届时宿主自动保存）" };
			} catch (e) {
				const rec = this.records.get(serial);
				if (rec != null) {
					rec.error = String(e instanceof Error ? e.message : e);
					this.stopRecord(serial).catch((err) => this.opts.log("启动失败后保存录屏失败：" + String(err)));
				}
				throw e;
			} finally {
				this.captureStarting = false;
			}
		}
		const file = await this.stopRecord(serial, outDir, signal);
		return file == null ? { note: "当前没有进行中的录制" } : {
			file,
			note: "已保存"
		};
	}
	/** 元素级操作基础：按条件在 uiautomator 树里找节点（权威坐标，杜绝截图目测打偏）。 */
	async uiFind(serial, criteria, signal) {
		const nodes = await this.uidump(serial, signal);
		const target = (criteria.target ?? "").trim();
		let matched = nodes;
		if (target !== "") {
			const t = target.toLowerCase();
			const hit = (n) => n.text.toLowerCase().includes(t) || n.desc.toLowerCase().includes(t) || n.cls.toLowerCase().includes(t);
			matched = nodes.filter(hit);
			if (matched.length === 0) {
				const t2 = t.replace(/\s+/g, "");
				matched = nodes.filter((n) => n.text.replace(/\s+/g, "").toLowerCase().includes(t2) || n.desc.replace(/\s+/g, "").toLowerCase().includes(t2));
			}
		}
		if (matched.length === 0) {
			const sample = nodes.slice(0, 8).map((n) => n.text || n.desc || n.cls).filter(Boolean).join(" | ");
			throw new Error(`未找到匹配元素（target="${target}"）。当前屏可交互元素样例：${sample || "（无）"}——可先调 action=find 不带 target 看全量，或滑动/翻页后再试`);
		}
		const idx = Math.max(0, Math.min(matched.length - 1, criteria.index ?? 0));
		const n = matched[idx];
		return {
			index: idx,
			total: criteria.target == null || criteria.target === "" ? nodes.length : matched.length,
			text: n.text,
			desc: n.desc,
			cls: n.cls,
			clickable: n.clickable,
			center: n.center,
			bounds: [
				n.center[0],
				n.center[1],
				n.center[0],
				n.center[1]
			]
		};
	}
	/** 元素点击：解析权威坐标后走统一注入通道。 */
	async uiTap(serial, criteria, signal) {
		const node = await this.uiFind(serial, criteria, signal);
		return {
			performed: `${await this.performAct(serial, {
				action: "tap",
				x: node.center[0],
				y: node.center[1]
			}, signal, "agent")} @element(${node.text || node.desc || node.cls})`,
			node
		};
	}
	/** 元素设值：定位 → 点聚焦 → 按原内容长度清空 → ADBKeyboard/文本注入。中文可靠。 */
	async uiSetText(serial, args, signal) {
		const node = await this.uiFind(serial, {
			target: args.target,
			index: args.index
		}, signal);
		await this.performAct(serial, {
			action: "tap",
			x: node.center[0],
			y: node.center[1]
		}, signal, "agent");
		await new Promise((r) => setTimeout(r, 400));
		if (args.clear !== false && node.text.length > 0) {
			const n = Math.min(node.text.length + 2, 60);
			await this.performAct(serial, {
				action: "key",
				key: "move_end"
			}, signal, "agent");
			for (let i = 0; i < n; i++) await this.performAct(serial, {
				action: "key",
				key: "del"
			}, signal, "agent");
		}
		const r = await this.performAct(serial, {
			action: "text",
			text: args.text
		}, signal, "agent");
		await new Promise((r2) => setTimeout(r2, 500));
		const shot = await this.saveScreenshot(serial, signal).catch(() => null);
		return {
			performed: `${r} @element(${node.text || node.desc || node.cls})`,
			node,
			screenshotPath: shot
		};
	}
	debugSessions = /* @__PURE__ */ new Map();
	debugBySerial = /* @__PURE__ */ new Map();
	async debugStart(serial, mode, signal) {
		const existingId = this.debugBySerial.get(serial);
		if (existingId != null) {
			if (this.debugSessions.get(existingId).stoppedAt != null) throw Object.assign(/* @__PURE__ */ new Error("调试已停止，保存失败；请停止按钮重试保存"), { code: "capture-busy" });
			return {
				id: existingId,
				note: "调试会话已在进行中"
			};
		}
		if (this.disposed || this.captureStarting || this.captureWrites > 0 || this.records.size > 0 || this.debugBySerial.size > 0) throw Object.assign(/* @__PURE__ */ new Error("已有采集或待保存记录——先停止并保存"), { code: "capture-busy" });
		if (mode === "human") this.assertPanelAvailable(serial);
		this.captureStarting = true;
		let captureOptions;
		let clockStart;
		try {
			captureOptions = await this.nativeCaptureOptions(serial, signal);
			clockStart = await this.sampleDebugClock(serial, signal);
		} finally {
			this.captureStarting = false;
		}
		if (this.disposed) throw new Error("采集服务已关闭");
		if (mode === "human") this.assertPanelAvailable(serial);
		const id = "dbg-" + randomUUID();
		const dir = validateCaptureDirectory(this.state.data.directory);
		const sess = {
			id,
			serial,
			mode,
			captureOptions,
			clockStart,
			startedAt: Date.now(),
			segments: [],
			recordProc: null,
			logProc: null,
			logRing: [],
			logRingBytes: 0,
			errFile: join(dir, id + "-logcat.log"),
			errStream: null,
			acts: [],
			segIndex: 0,
			shortRotations: 0,
			rotateTimer: null,
			dir,
			logRemote: "/data/local/tmp/dsh_" + id + "-logcat.log"
		};
		this.persistDebug(sess);
		this.debugSessions.set(id, sess);
		this.debugBySerial.set(serial, id);
		try {
			await this.debugSpawnSegment(sess);
			this.debugSpawnLogcat(sess);
		} catch (e) {
			sess.error = String(e);
			this.debugStop(serial).catch((err) => this.opts.log("调试启动失败：" + String(err)));
			throw e;
		}
		if (signal != null) {
			const abort = () => {
				this.debugStop(serial).catch((e) => this.opts.log("取消调试保存失败：" + String(e)));
			};
			if (signal.aborted) abort();
			else {
				signal.addEventListener("abort", abort, { once: true });
				sess.logProc?.once("close", () => signal.removeEventListener("abort", abort));
			}
		}
		return {
			id,
			note: "调试已启动：录屏分段、全量 logcat 与操作时间线；受保护页面可能黑屏"
		};
	}
	async sampleDebugClock(serial, signal) {
		try {
			const before = Date.now();
			const out = (await this.adb.runOk([
				"-s",
				serial,
				"shell",
				"date",
				"+%s%N"
			], {
				signal,
				timeoutMs: 2e3
			})).trim();
			const after = Date.now();
			if (!/^\d{19}$/.test(out) || after < before || after - before > 998) throw new Error("设备时钟精度或往返时间不可用");
			const deviceMs = Number(BigInt(out)) / 1e6;
			return {
				minOffsetMs: before - deviceMs - 1,
				maxOffsetMs: after - deviceMs + 1
			};
		} catch (e) {
			this.opts.log("调试时间未校准（仍保留录屏与日志）：" + String(e));
			return;
		}
	}
	async debugSpawnSegment(sess) {
		if (sess.stoppedAt != null || this.disposed) return;
		const clock = await this.sampleDebugClock(sess.serial);
		if (sess.stoppedAt != null || this.disposed) return;
		const remote = "/data/local/tmp/dsh_" + sess.id + "_" + sess.segIndex++ + ".mp4";
		const seg = {
			remote,
			startEpoch: Date.now(),
			...clock == null ? {} : { clock }
		};
		sess.segments.push(seg);
		this.persistDebug(sess);
		const proc = this.spawnCapture(sess.serial, "screenrecord " + sess.captureOptions + "--time-limit 170 " + remote);
		sess.recordProc = proc;
		proc.once("close", (code) => {
			seg.endEpoch = Date.now();
			try {
				if (!this.disposed) this.persistDebug(sess);
				if (sess.stoppedAt != null || this.disposed) return;
				const info = this.captureProcesses.get(proc);
				if (code !== 0 || seg.endEpoch - seg.startEpoch < 2e4) throw new Error("设备录屏提前退出：" + (info.error ?? info.stderr ?? String(code)));
				this.debugSpawnSegment(sess).catch((e) => {
					sess.captureError = String(e instanceof Error ? e.message : e);
					this.debugStop(sess.serial).catch((err) => this.opts.log("调试异常停止：" + String(err)));
				});
			} catch (e) {
				sess.captureError = String(e instanceof Error ? e.message : e);
				this.debugStop(sess.serial).catch((err) => this.opts.log("调试异常停止：" + String(err)));
			}
		});
	}
	debugSpawnLogcat(sess) {
		const proc = this.spawnCapture(sess.serial, "logcat -v epoch -f " + sess.logRemote);
		sess.logProc = proc;
		proc.once("close", (code) => {
			if (sess.stoppedAt != null || this.disposed) return;
			sess.captureError = "设备 logcat 提前退出：" + (this.captureProcesses.get(proc)?.stderr ?? String(code));
			this.debugStop(sess.serial).catch((e) => this.opts.log("日志异常停止：" + String(e)));
		});
	}
	async loadDebugLog(sess, file) {
		sess.logRing = [];
		sess.logRingBytes = 0;
		const lines = createInterface({
			input: createReadStream(file, { encoding: "utf8" }),
			crlfDelay: Infinity
		});
		let first = 0;
		const clock = debugClockBounds(sess.clockStart, sess.clockEnd);
		const offset = clock ? (clock.minOffsetMs + clock.maxOffsetMs) / 2 : 0;
		for await (const line of lines) {
			const match = /^\s*(\d+\.\d+)/.exec(line);
			const rec = (match == null ? sess.startedAt : Math.round(Number(match[1]) * 1e3 + offset)) + "	" + line;
			sess.logRing.push(rec);
			sess.logRingBytes += Buffer.byteLength(rec) + 1;
			while (sess.logRingBytes > 24e6 && first < sess.logRing.length) sess.logRingBytes -= Buffer.byteLength(sess.logRing[first++]) + 1;
			if (first >= 1e4) {
				sess.logRing.splice(0, first);
				first = 0;
			}
		}
		if (first) sess.logRing.splice(0, first);
	}
	async debugStop(serial) {
		const id = this.debugBySerial.get(serial);
		if (id == null) return {
			id: "",
			note: "当前没有进行中的调试会话"
		};
		const sess = this.debugSessions.get(id);
		if (sess.saving != null) return sess.saving;
		const retry = sess.stoppedAt != null;
		if (sess.rotateTimer != null) {
			clearTimeout(sess.rotateTimer);
			sess.rotateTimer = null;
		}
		sess.stoppedAt ??= Date.now();
		this.captureWrites++;
		sess.saving = (async () => {
			try {
				await Promise.all([...sess.pendingActions ?? []]);
				await Promise.all([sess.recordProc == null ? Promise.all(sess.segments.map((seg) => this.stopRecoveredCapture(serial, seg.remote))) : this.stopCaptureProcess(serial, sess.recordProc), sess.logProc == null ? this.stopRecoveredCapture(serial, sess.logRemote) : this.stopCaptureProcess(serial, sess.logProc)]);
				if (this.disposed) throw new Error("采集服务已重载，请在当前面板重试保存");
				if (!retry) sess.clockEnd = await this.sampleDebugClock(serial);
				this.persistDebug(sess);
				const dir = validateCaptureDirectory(retry ? this.state.data.directory : sess.dir);
				const files = [];
				for (const [index, seg] of sess.segments.entries()) {
					const file = join(dir, sess.id + "-seg-" + String(index).padStart(3, "0") + ".mp4");
					if (await this.pullCapture(serial, seg.remote, file, void 0, sess.captureError != null)) {
						seg.local = file;
						files.push(file);
					} else seg.error = "此段采集启动失败，设备原件为空；已保留其余视频与日志";
				}
				if (files.length === 0) throw new Error("调试没有录屏段，不能报告保存成功");
				const log = join(dir, sess.id + "-logcat.log");
				await this.pullCapture(serial, sess.logRemote, log);
				await this.loadDebugLog(sess, log);
				if (this.disposed) throw new Error("采集服务已重载；设备原件已保留，请重试保存");
				const acts = join(dir, sess.id + "-actions.json"), tmp = acts + "." + randomUUID() + ".tmp";
				try {
					writeFileSync(tmp, JSON.stringify({
						id: sess.id,
						serial,
						startedAt: sess.startedAt,
						stoppedAt: sess.stoppedAt,
						segments: sess.segments,
						actions: sess.acts,
						clockStart: sess.clockStart,
						clockEnd: sess.clockEnd,
						captureError: sess.captureError
					}, null, 2), {
						flag: "wx",
						mode: 384
					});
					renameSync(tmp, acts);
				} finally {
					try {
						unlinkSync(tmp);
					} catch {}
				}
				files.push(log, acts);
				this.state.registerOutput(sess.id, "debug", files, sess.captureError);
				sess.dir = dir;
				sess.errFile = log;
				sess.logLocal = log;
				sess.saved = true;
				this.debugBySerial.delete(serial);
				if (!this.disposed) await this.adb.run([
					"-s",
					serial,
					"shell",
					"rm",
					"-f",
					...sess.segments.map((s) => s.remote),
					sess.logRemote
				], { timeoutMs: 5e3 }).catch((e) => this.opts.log("调试原件清理失败：" + String(e)));
				return {
					id,
					note: "调试文件已保存" + (sess.captureError ? "；采集曾异常：" + sess.captureError : ""),
					summary: this.debugSummarize(sess)
				};
			} catch (e) {
				sess.error = String(e instanceof Error ? e.message : e);
				if (!this.disposed) this.persistDebug(sess);
				throw e;
			} finally {
				sess.saving = void 0;
				this.captureWrites--;
			}
		})();
		return sess.saving;
	}
	debugSummarize(sess) {
		const durationMs = (sess.stoppedAt ?? Date.now()) - sess.startedAt;
		return {
			id: sess.id,
			serial: sess.serial,
			mode: sess.mode,
			startedAt: sess.startedAt,
			durationMs,
			mp4s: sess.segments.map((s) => s.local).filter((x) => x != null),
			errFile: sess.errFile,
			acts: sess.acts.length
		};
	}
	debugStatus(serial) {
		if (serial != null) {
			const id = this.debugBySerial.get(serial);
			if (id == null) return { active: false };
			const sess = this.debugSessions.get(id);
			return {
				active: sess != null && this.debugCapturing(sess),
				id,
				startedAt: sess?.startedAt,
				mode: sess?.mode,
				acts: sess?.acts.length
			};
		}
		return {
			active: false,
			sessions: [...this.debugSessions.values()].map((s) => this.debugSummarize(s))
		};
	}
	debugList() {
		return [...this.debugSessions.values()].map((s) => this.debugSummarize(s));
	}
	/** analyze：把每个操作的「前后帧图 + logcat 片段」物化为文件返回——证据强制进入 agent 上下文。 */
	async debugAnalyze(id) {
		const sess = (id != null ? this.debugSessions.get(id) : void 0) ?? [...this.debugSessions.values()].filter((s) => s.stoppedAt != null).sort((a, b) => (b.stoppedAt ?? 0) - (a.stoppedAt ?? 0))[0];
		if (sess == null) throw new Error("没有可分析的调试会话（先 start 并 stop）");
		if (sess.stoppedAt == null) throw new Error("调试会话仍在进行中——先停止再分析");
		if (!sess.saved) throw new Error("调试尚未完整保存——先重试保存再分析");
		const stoppedAt = sess.stoppedAt;
		const durationMs = stoppedAt - sess.startedAt;
		const windows = sess.acts.length > 0 ? sess.acts.slice(-12).map((a, i) => ({
			t: a.t,
			endedAt: a.endedAt,
			label: `#${sess.acts.length - sess.acts.slice(-12).length + i + 1} ${a.action}`
		})) : Array.from({ length: Math.max(3, Math.min(8, Math.floor(durationMs / 6e3))) }, (_, i) => ({
			t: sess.startedAt + Math.round(durationMs * (i + 1) / (Math.min(8, Math.max(3, Math.floor(durationMs / 6e3))) + 1)),
			label: `采样${i + 1}`
		}));
		const { execFile } = await import("node:child_process");
		const runMedia = (bin, args) => new Promise((resolve, reject) => {
			execFile(bin, args, {
				timeout: 2e4,
				maxBuffer: 16 * 1024 * 1024
			}, (err, out) => err == null ? resolve(String(out)) : reject(err));
		});
		for (const bin of ["ffmpeg", "ffprobe"]) try {
			await runMedia(bin, ["-version"]);
		} catch {
			throw new Error("调试分析需要 " + bin + "（macOS: brew install ffmpeg；Ubuntu: apt install ffmpeg）");
		}
		const framesDir = join(sess.dir, sess.id + "-frames");
		try {
			rmSync(framesDir, {
				recursive: true,
				force: true
			});
			mkdirSync(framesDir, { recursive: true });
		} catch (e) {
			throw new Error("无法准备取证帧目录：" + framesDir + "（" + (e instanceof Error ? e.message : String(e)) + "）");
		}
		const clock = debugClockBounds(sess.clockStart, sess.clockEnd);
		const frameIssues = [];
		if (!clock) frameIssues.push(sess.segments.some((s) => s.clock) ? "会话起止时钟未校准或已漂移：日志切片不可对齐；帧改用各分段启动时的时钟采样" : "设备/宿主时钟未校准或已漂移：仅返回视频采样，不能证明操作前后；日志切片不可对齐");
		if (sess.acts.length > 12) frameIssues.push("只分析最近 12 个操作；更早的 " + (sess.acts.length - 12) + " 个未取前后帧（完整时间线仍在上方）");
		const sources = [];
		for (const seg of sess.segments) {
			if (!seg.local) continue;
			try {
				const pts = JSON.parse(await runMedia("ffprobe", [
					"-v",
					"error",
					"-select_streams",
					"v:0",
					"-show_entries",
					"frame=best_effort_timestamp_time",
					"-of",
					"json",
					seg.local
				])).frames.map((f) => Number(f.best_effort_timestamp_time));
				if (!pts.length || pts.some((t, i) => !Number.isFinite(t) || i > 0 && t <= pts[i - 1])) throw new Error("视频帧时间不可用");
				const source = {
					seg,
					pts
				};
				sources.push(source);
				const segClock = seg.clock ?? clock;
				if (segClock != null) {
					const size = lstatSync(seg.local).size, fd = openSync(seg.local, "r");
					const bytes = Buffer.alloc(Math.min(size, 1024 * 1024));
					try {
						if (readSync(fd, bytes, 0, bytes.length, size - bytes.length) !== bytes.length) throw new Error("元数据读取不完整");
					} finally {
						closeSync(fd);
					}
					source.epochs = nativeFrameEpochs(bytes, pts);
					source.clock = segClock;
				}
			} catch (e) {
				frameIssues.push((seg.local ?? seg.remote) + "：" + String(e));
			}
		}
		const frames = [];
		const targets = [];
		for (const w of windows) for (const tg of sess.acts.length ? [{
			kind: "pre",
			epoch: w.t - 600
		}, {
			kind: "post",
			epoch: (w.endedAt ?? w.t) + 1200
		}] : [{
			kind: "sample",
			epoch: w.t
		}]) {
			const source = sources.find((s) => s.epochs && s.seg.startEpoch <= tg.epoch && tg.epoch <= (s.seg.endEpoch ?? stoppedAt));
			if (!source) {
				frameIssues.push(w.label + " " + tg.kind + "：该时刻不在已保存录屏段内（分段间隙或临近起止）");
				continue;
			}
			if (source.clock == null) continue;
			const index = selectDebugFrame(source.epochs, source.clock, tg.epoch, tg.kind);
			if (index >= 0) {
				targets.push({
					source,
					index,
					t: w.t,
					label: w.label,
					kind: tg.kind,
					requestedAt: tg.epoch
				});
				continue;
			}
			if (tg.kind === "pre") {
				frameIssues.push(w.label + " pre：录屏早于该操作，没有可证明的\"操作前\"画面");
				continue;
			}
			frameIssues.push(w.label + " post：该操作后设备未产生新帧（画面无可见变化），已附最后可见画面");
			targets.push({
				source,
				index: source.pts.length - 1,
				t: w.t,
				label: w.label + "（操作后无新帧）",
				kind: "sample"
			});
		}
		for (const source of sources.filter((s) => !s.epochs).slice(-4)) for (let i = 1; i <= 3; i++) targets.push({
			source,
			index: Math.min(source.pts.length - 1, Math.floor(source.pts.length * i / 4)),
			t: source.seg.startEpoch,
			label: "未校准视频采样（不代表操作前后）",
			kind: "sample"
		});
		for (const [i, target] of targets.entries()) {
			const { source, index, kind } = target;
			const file = join(framesDir, "f" + String(i + 1).padStart(2, "0") + "-" + kind + ".png");
			const tmp = file + "." + randomUUID() + ".png";
			try {
				await runMedia("ffmpeg", [
					"-v",
					"error",
					"-i",
					source.seg.local,
					"-map",
					"0:v:0",
					"-vf",
					"select=eq(n\\," + index + ")",
					"-fps_mode",
					"vfr",
					"-frames:v",
					"1",
					"-n",
					tmp
				]);
				commitFrame(tmp, file);
				const sourceClock = source.clock;
				const calibrated = source.epochs != null && sourceClock != null;
				frames.push({
					file,
					label: target.label,
					t: target.t,
					kind,
					pts: source.pts[index],
					requestedAt: target.requestedAt,
					timing: calibrated ? "calibrated" : "uncalibrated",
					...calibrated ? {
						frameAt: source.epochs[index] + (sourceClock.minOffsetMs + sourceClock.maxOffsetMs) / 2,
						uncertaintyMs: (sourceClock.maxOffsetMs - sourceClock.minOffsetMs) / 2
					} : {}
				});
			} catch (e) {
				frameIssues.push(target.label + " " + kind + "：" + (e instanceof Error ? e.message : String(e)).split(tmp).join(file));
			} finally {
				try {
					unlinkSync(tmp);
				} catch {}
			}
		}
		const logLines = sess.logRing.filter((l) => l.includes("	"));
		const slices = [];
		for (const w of clock ? windows : []) {
			const inWin = logLines.filter((l) => {
				const e = Number(l.slice(0, l.indexOf("	")));
				return Number.isFinite(e) && e >= w.t - 2e3 && e <= (w.endedAt ?? w.t) + 2500;
			});
			if (inWin.length > 0) {
				slices.push(`── ${w.label}（操作区间前2s/后2.5s，${inWin.length} 行）──`);
				slices.push(...inWin.slice(0, 40));
			}
		}
		const errLines = logLines.filter((l) => /\s[EF]\s/.test(l)).slice(-60);
		const tail = logLines.slice(-50);
		const timeline = sess.acts.length > 0 ? sess.acts.map((a) => `${new Date(a.t).toLocaleTimeString("zh-CN", { hour12: false })}  ${a.detail ?? a.action}`) : ["（无面板/agent 注入操作——纯物理操作，时间轴以采样帧为准）"];
		return {
			id: sess.id,
			serial: sess.serial,
			durationMs,
			timeline,
			frames,
			frameIssues,
			logSlices: slices.slice(0, 400),
			errorLines: errLines,
			logTail: tail,
			mp4s: sess.segments.map((s) => s.local).filter((x) => x != null),
			errFile: sess.errFile
		};
	}
	async listAvds() {
		const bin = this.opts.emulatorBin;
		if (bin == null) return [];
		const { execFile } = await import("node:child_process");
		return new Promise((resolve) => {
			execFile(bin, ["-list-avds"], { timeout: 5e3 }, (err, stdout) => {
				resolve(err ? [] : String(stdout).split("\n").map((s) => s.trim()).filter((s) => s !== ""));
			});
		});
	}
	/** 启动一台关机的模拟器（面板设备菜单手势）。MVP：等待 boot_completed，最长 120s。 */
	async bootEmulator(avd) {
		const bin = this.opts.emulatorBin;
		if (bin == null) throw new Error("未找到 emulator 可执行文件（未设置 ANDROID_SDK 或本机未装模拟器）");
		spawn(bin, [
			"-avd",
			avd,
			"-no-snapshot-save",
			"-no-boot-anim"
		], {
			stdio: "ignore",
			detached: true,
			windowsHide: true
		}).unref();
		const deadline = Date.now() + 12e4;
		while (Date.now() < deadline) {
			const emu = (await this.adb.devices().catch(() => [])).find((d) => d.isEmulator && d.state === "device");
			if (emu != null) {
				if ((await this.adb.shell(emu.serial, "getprop sys.boot_completed", { timeoutMs: 5e3 }).catch(() => null))?.stdout.trim() === "1") return {
					serial: emu.serial,
					note: `模拟器 ${avd} 已启动`
				};
			}
			await new Promise((r) => setTimeout(r, 1500));
		}
		return { note: "模拟器启动超时（120s），请到 Android Studio 查看" };
	}
	async setQuality(patch) {
		for (const serial of /* @__PURE__ */ new Set([...this.claims.keys(), ...this.busyUntil.keys()])) this.assertPanelAvailable(serial);
		if (this.captureStarting || this.captureWrites || this.records.size || this.debugBySerial.size) throw Object.assign(/* @__PURE__ */ new Error("采集或待保存时不能重建画质"), { code: "capture-busy" });
		const q = this.state.setQuality(patch);
		for (const [serial, stream] of [...this.streams]) {
			const claim = this.claims.get(serial);
			stream.stop();
			this.streams.delete(serial);
			this.modes.delete(serial);
			if (claim != null) (async () => {
				await new Promise((r) => setTimeout(r, 1500));
				await this.attachForTool(claim.sessionId, serial).catch((e) => this.opts.log(`[${serial}] 画质重建失败: ${String(e).slice(0, 200)}`));
			})();
		}
		return q;
	}
	/** 按设备设置流偏好（面板/路由入口）。'screenshot' 立即停掉在跑串流；'auto' 由下次 attach 恢复串流。 */
	setStreamMode(serial, mode) {
		this.state.setStreamMode(serial, mode);
		if (mode === "screenshot") {
			const live = this.streams.get(serial);
			if (live != null) {
				live.stop();
				this.streams.delete(serial);
				this.modes.delete(serial);
			}
			this.streamErrors.delete(serial);
		}
		this.opts.log(`[${serial}] 流偏好 → ${mode}${mode === "screenshot" ? "（防串流致系统卡死）" : ""}`);
		return {
			serial,
			streamMode: mode
		};
	}
	/** 还原设备原输入法。 */
	restoreIme(serial) {
		const prev = this.prevIme.get(serial);
		if (prev != null) {
			this.prevIme.delete(serial);
			this.adb.shell(serial, `ime set ${prev}`, { timeoutMs: 8e3 }).catch(() => void 0);
			this.opts.log(`[${serial}] IME 还原 → ${prev}`);
		}
	}
	dispose() {
		this.disposed = true;
		this.muteQueue.then(async () => {
			for (const [serial, previous] of Object.entries(this.state.reload().volumeRestore)) try {
				await this.adb.runOk([
					"-s",
					serial,
					"shell",
					"cmd",
					"media_session",
					"volume",
					"--stream",
					"3",
					"--set",
					String(previous)
				], { timeoutMs: 8e3 });
				const out = await this.adb.runOk([
					"-s",
					serial,
					"shell",
					"cmd",
					"media_session",
					"volume",
					"--stream",
					"3",
					"--get"
				], { timeoutMs: 8e3 });
				if (Number(/volume is (\d+)/i.exec(out)?.[1]) !== previous) throw new Error("媒体音量还原回读失败");
				this.state.setVolumeRestore(serial);
			} catch (e) {
				this.opts.log("卸载时媒体音量还原失败（" + serial + "）：" + String(e));
			}
		});
		if (this.refreshTimer != null) clearInterval(this.refreshTimer);
		for (const st of this.pendingStarts) st.stop();
		if (this.secureTimer != null) clearInterval(this.secureTimer);
		this.secureStates.clear();
		this.lastMitigate.clear();
		this.rootProbe.clear();
		for (const [serial] of this.prevIme) this.restoreIme(serial);
		if (this.reaperTimer != null) clearInterval(this.reaperTimer);
		for (const stream of this.streams.values()) stream.stop();
		for (const [serial, rec] of this.records) {
			rec.status = "pending-save";
			rec.stoppedAt ??= Date.now();
			try {
				this.persistRecord(serial);
			} catch (e) {
				this.opts.log("卸载时录屏清单保存失败：" + String(e));
			}
			if (rec.proc != null) this.stopCaptureProcess(serial, rec.proc).catch((e) => this.opts.log("卸载时录屏停止失败：" + String(e)));
		}
		for (const sess of this.debugSessions.values()) {
			if (sess.rotateTimer != null) clearInterval(sess.rotateTimer);
			sess.stoppedAt ??= Date.now();
			if (!sess.saved) try {
				this.persistDebug(sess);
			} catch (e) {
				this.opts.log("卸载时调试清单保存失败：" + String(e));
			}
			for (const proc of [sess.recordProc, sess.logProc]) if (proc != null) this.stopCaptureProcess(sess.serial, proc).catch((e) => this.opts.log("卸载时调试停止失败：" + String(e)));
			sess.errStream?.end();
		}
		this.streams.clear();
		this.claims.clear();
	}
};
//#endregion
//#region src/tools.ts
/**
* 10 个 agent 工具（+debug 调试会话托管、+ui 元素级操作：杜绝截图目测坐标打偏，见 STATE）。
* 会话身份：exec.agent?.id（dsh-agent runtime-types 实证）→ 设备认领隔离。
* 取消：exec.signal 转发给所有 adb 子进程与流会话。
* 授权：android_pane_attach 的 DSH 工具审批 = 规则1 的「首次逐设备授权」；成功后按序列号记住受信。
*/
/** 规范化输出：深度冻结结构收敛为 JsonValue（mall 同款实测模式）。 */
function toJson(x) {
	return JSON.parse(JSON.stringify(x));
}
function sessionIdOf(ctx) {
	const id = ctx.agent?.id;
	if (id == null || id === "") throw new Error("无法识别当前会话（agent id 缺失），设备认领需要会话身份");
	return id;
}
const serialParam = {
	type: "string",
	description: "设备 serial（adb devices 列出的）。缺省=本会话已认领的唯一设备；attach 时缺省=唯一在线设备。"
};
function registerPaneTools(tools, hub) {
	tools.register(defineTool({
		name: "android_pane_devices",
		description: "List Android devices (real + emulator) with online state, model, panel claim owner, live stream mode and per-device streamMode preference (auto|screenshot). Use before attach to pick a serial.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_a, v) => [{
				type: "text",
				text: JSON.stringify(v)
			}]
		},
		execute: async (_args, ctx) => {
			const r = await hub.listDevices();
			const st = await hub.sessionState();
			return toJson({
				...r,
				claims: st.claims
			});
		},
		timeoutMs: 15e3
	}));
	tools.register(defineTool({
		name: "android_pane_attach",
		description: "Claim an Android device for this session and open its live screen in the DSH pane (H.264 stream; auto-fallback to screenshot polling; per-device mode=screenshot forces screenshot-only, persisted — use it when streaming froze the device/system watchdog). First attach to a device is the consent point (user approves this tool call). Returns serial, stream mode/size and a first screenshot path — read that image to see the screen.",
		parameters: {
			serial: serialParam,
			mode: {
				type: "string",
				description: "'auto'=正常 H.264 串流（缺省）；'screenshot'=强制截图模式——该设备永不启动 scrcpy 串流，仅截图轮询交互，按设备持久保存（'auto' 恢复）。用于串流导致系统卡死/看门狗或硬件编码器崩溃的设备。"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_a, v) => [{
				type: "text",
				text: JSON.stringify(v)
			}]
		},
		execute: async (args, ctx) => {
			const { serial, mode } = args;
			if (mode != null && mode !== "auto" && mode !== "screenshot") throw new Error("mode 须为 auto|screenshot");
			return toJson(await hub.attachForTool(sessionIdOf(ctx), serial, ctx.signal, mode != null ? { mode } : void 0));
		},
		timeoutMs: 6e4
	}));
	tools.register(defineTool({
		name: "android_pane_act",
		description: "Interact with the claimed Android device, then auto-capture a screenshot so you can verify the result. actions: tap(x,y) | swipe(x,y→x2,y2,durationMs) | text(text) | key(back|home|recents|volume_up|volume_down|enter|tab|esc|dpad_*) | scroll(x,y,y2=±1) | rotate. Coordinates are device physical pixels (use android_pane_uidump for exact element centers). If the screenshot/stream looks all black, the page is FLAG_SECURE-protected: use android_pane_uidump / android_pane_ui instead (accessibility channel still works; results include secureHint).",
		parameters: {
			action: {
				type: "string",
				required: true,
				description: "tap|swipe|text|key|scroll|rotate"
			},
			serial: serialParam,
			x: {
				type: "number",
				description: "起点/点按 X（设备物理像素）"
			},
			y: {
				type: "number",
				description: "起点/点按 Y"
			},
			x2: {
				type: "number",
				description: "swipe 终点 X / scroll 用作横向增量"
			},
			y2: {
				type: "number",
				description: "swipe 终点 Y / scroll 用作纵向增量（负=向上滑）"
			},
			durationMs: {
				type: "number",
				description: "swipe 时长（默认 300ms）"
			},
			key: {
				type: "string",
				description: "key 动作的按键名"
			},
			text: {
				type: "string",
				description: "text 动作的文本（支持中文，走剪贴板粘贴）"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_a, v) => [{
				type: "text",
				text: JSON.stringify(v)
			}]
		},
		execute: async (args, ctx) => {
			return toJson(await hub.act(sessionIdOf(ctx), args, ctx.signal));
		},
		timeoutMs: 3e4
	}));
	tools.register(defineTool({
		name: "android_pane_screen",
		description: "Capture a fresh PNG screenshot of the claimed Android device and return the file path (read the image with your vision tooling).",
		parameters: { serial: serialParam },
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_a, v) => [{
				type: "text",
				text: JSON.stringify(v)
			}]
		},
		execute: async (args, ctx) => {
			const { serial } = args;
			const s = hub.serialForSession(sessionIdOf(ctx), serial);
			return toJson({
				serial: s,
				file: await hub.saveScreenshot(s, ctx.signal)
			});
		},
		timeoutMs: 2e4
	}));
	tools.register(defineTool({
		name: "android_pane_uidump",
		description: "Dump the Android UI hierarchy (uiautomator) and return up to 100 interactive/labeled nodes with text, content-desc, class, clickability and center coordinates. Use it to find exact tap targets and verify UI state — far more precise than screenshots.",
		parameters: { serial: serialParam },
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_a, v) => [{
				type: "text",
				text: JSON.stringify(v)
			}]
		},
		execute: async (args, ctx) => {
			const { serial } = args;
			const s = hub.serialForSession(sessionIdOf(ctx), serial);
			return toJson({
				serial: s,
				nodes: await hub.uidump(s, ctx.signal)
			});
		},
		timeoutMs: 3e4
	}));
	tools.register(defineTool({
		name: "android_pane_ui",
		description: "Element-level UI operations backed by uiautomator authoritative coordinates — eliminates blind-coordinate tap misses entirely. Actions: find (resolve an element by text/content-desc and return exact bounds+center), click (tap the resolved element center), setText (focus the element, clear its current content, then type — Chinese-safe via ADBKeyboard). ALWAYS prefer this over android_pane_act tap coordinates for anything inside an app UI: eyeballed screenshot coordinates routinely miss. target also matches widget class (e.g. target=\"EditText\" finds input fields even when empty). target matches by substring against node text or content-desc (e.g. \"请输入手机号\", \"登录\"); index picks among multiple matches (0-based).",
		parameters: {
			action: {
				type: "string",
				required: true,
				description: "find|click|setText"
			},
			target: {
				type: "string",
				description: "按文本/content-desc 模糊匹配元素（如「请输入手机号」「登录」「搜索」）"
			},
			index: {
				type: "number",
				description: "多个匹配时选第 N 个（0 起，默认 0）"
			},
			text: {
				type: "string",
				description: "setText：要输入的内容（支持中文）"
			},
			clear: {
				type: "boolean",
				description: "setText：输入前清空原内容（默认 true）"
			},
			serial: serialParam
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_a, v) => [{
				type: "text",
				text: JSON.stringify(v)
			}]
		},
		execute: async (args, ctx) => {
			const { action, target, index, text, clear, serial } = args;
			const s = hub.serialForSession(sessionIdOf(ctx), serial);
			if (action === "find") return toJson({
				serial: s,
				...await hub.uiFind(s, {
					target,
					index
				}, ctx.signal)
			});
			if (action === "click") return toJson(await hub.uiTap(s, {
				target,
				index
			}, ctx.signal));
			if (!text) throw new Error("setText 需要 text 参数");
			return toJson(await hub.uiSetText(s, {
				target,
				index,
				text,
				clear
			}, ctx.signal));
		},
		timeoutMs: 6e4
	}));
	tools.register(defineTool({
		name: "android_pane_record",
		description: "Start or stop an mp4 screen recording (adb screenrecord, max 180s per clip) on the claimed device; stop returns the saved file path.",
		parameters: {
			action: {
				type: "string",
				required: true,
				description: "start|stop"
			},
			serial: serialParam,
			dir: {
				type: "string",
				description: "mp4 保存目录（缺省=插件 shots 目录）"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_a, v) => [{
				type: "text",
				text: JSON.stringify(v)
			}]
		},
		execute: async (args, ctx) => {
			const { serial, action, dir } = args;
			const s = hub.serialForSession(sessionIdOf(ctx), serial);
			return toJson(await hub.record(s, action, dir, ctx.signal));
		},
		timeoutMs: 6e4
	}));
	tools.register(defineTool({
		name: "android_pane_install_ime",
		description: "One-time setup for Chinese text input: install the bundled ADBKeyboard IME on the device (a confirm dialog appears on the phone; custom vendor ROMs need \"USB install\" enabled) and enable it. Call once per device when Chinese text input is required.",
		parameters: { serial: serialParam },
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_a, v) => [{
				type: "text",
				text: JSON.stringify(v)
			}]
		},
		execute: async (args, ctx) => {
			const { serial } = args;
			const s = serial ?? hub.firstOnlineSerial();
			if (!s) throw new Error("没有在线设备");
			return toJson(await hub.installIme(s, ctx.signal));
		},
		timeoutMs: 12e4
	}));
	tools.register(defineTool({
		name: "android_pane_debug",
		description: "Managed debug session — the HOST (not you) enforces screen recording (segmented mp4), full logcat capture and a structured action timeline; you cannot forget or fake it. Actions: start (begin capture BEFORE touching the device; works for your own operations too), stop (finalize; returns artifact summary), list, analyze (materializes per-action pre/post frames extracted from the recording + logcat excerpts around each action into the result — you MUST read every returned frame image with your vision tooling and base your analysis on those frames and log excerpts; claiming conclusions without reading them is a violation).",
		parameters: {
			action: {
				type: "string",
				required: true,
				description: "start|stop|list|analyze"
			},
			mode: {
				type: "string",
				description: "start 时：'agent'=AI 操作+AI 分析（默认，需先 attach 认领）；'human'=人操作+AI 分析（无需认领，AI 注入被阻止，面板留给用户）"
			},
			serial: serialParam,
			id: {
				type: "string",
				description: "调试会话 id（analyze 缺省=最近一次已结束的会话）"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_a, v) => [{
				type: "text",
				text: JSON.stringify(v, null, 1)
			}]
		},
		execute: async (args, ctx) => {
			const { action, serial, id } = args;
			if (action === "list") return toJson({ sessions: hub.debugList() });
			if (action === "analyze") return toJson(await hub.debugAnalyze(id));
			const s = hub.serialForSession(sessionIdOf(ctx), serial);
			if (action === "start") return toJson({
				serial: s,
				...await hub.debugStart(s, "agent", ctx.signal)
			});
			return toJson({
				serial: s,
				...await hub.debugStop(s)
			});
		},
		timeoutMs: 18e4
	}));
	tools.register(defineTool({
		name: "android_pane_detach",
		description: "Release this session's claim on the device (stream stops; emulator will be shut down after the idle window per design rules).",
		parameters: { serial: serialParam },
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_a, v) => [{
				type: "text",
				text: JSON.stringify(v)
			}]
		},
		execute: async (args, ctx) => {
			const { serial } = args;
			const s = hub.serialForSession(sessionIdOf(ctx), serial);
			return toJson({
				serial: s,
				...hub.detach(sessionIdOf(ctx), s)
			});
		},
		timeoutMs: 1e4
	}));
}
//#endregion
//#region src/index.ts
/**
* @dsh-android-pane — host 入口（hybrid：工具 + 路由；无 module 级副作用）。
* 生命周期：apply 注入 webServer/tools → 建服务 → 挂路由与工具 → 返回 dispose；
* 卸载即净（规则10）：路由注销、流停止、子进程回收、定时器清除、认领表清空。
*/
const name = "dsh-android-pane";
const Config = z.object({
	adbPath: z.string().default("adb").description("adb 可执行文件路径"),
	idleDetachMinutes: z.number().min(1).max(120).default(10).description("闲置回收分钟数（规则4）"),
	maxPerSession: z.number().min(1).max(8).default(4).description("每会话设备上限（规则7）"),
	globalMax: z.number().min(1).max(16).default(8).description("全局设备上限（规则7）"),
	autoBootEmulator: z.boolean().default(false).description("面板可启动关机模拟器（需本机 Android SDK）"),
	flagSecureCheck: z.boolean().default(true).description("FLAG_SECURE 页面自动识别（B22）：检测到时面板出横幅与降级内容通道"),
	stateDir: z.string().default("").description("状态目录（缺省 <DSH_HOME>/dsh-android-pane）")
});
function apply(ctx, config = {}) {
	const cfg = {
		adbPath: config.adbPath ?? "adb",
		idleDetachMinutes: config.idleDetachMinutes ?? 10,
		maxPerSession: config.maxPerSession ?? 4,
		globalMax: config.globalMax ?? 8,
		autoBootEmulator: config.autoBootEmulator ?? false,
		flagSecureCheck: config.flagSecureCheck ?? true,
		stateDir: config.stateDir ?? ""
	};
	ctx.inject(["webServer", "tools"], (hostCtx) => {
		const host = hostCtx;
		if (host.webServer == null) throw new Error("dsh-android-pane 需要 webServer 服务（web profile 才提供）");
		if (host.tools == null) throw new Error("dsh-android-pane 需要 tools 服务");
		const log = (msg) => {
			try {
				host.logger?.info?.(`[dsh-android-pane] ${msg}`);
			} catch {}
		};
		const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
		const stateDir = cfg.stateDir !== "" ? cfg.stateDir : join(dshHome, "dsh-android-pane");
		const state = PaneStateStore.open(stateDir);
		const emulatorBin = cfg.autoBootEmulator ? joinAndroidEmulator() : void 0;
		const hub = new PaneHub(new Adb(cfg.adbPath), state, {
			jarPath: jarPathIn(pluginRoot()),
			shotsDir: join(stateDir, "shots"),
			log,
			idleDetachMs: cfg.idleDetachMinutes * 6e4,
			maxPerSession: cfg.maxPerSession,
			globalMax: cfg.globalMax,
			autoBootEmulator: cfg.autoBootEmulator,
			flagSecureCheck: cfg.flagSecureCheck,
			emulatorBin
		});
		hub.startTimers();
		const unregisterRoutes = mountPaneRoutes(host.webServer, hub, (req) => {
			const v = req.headers?.["x-dsh-session-id"];
			const id = Array.isArray(v) ? v[0] : v;
			return id != null && id !== "" ? id : null;
		});
		const unregisterToolsGuard = guardToolUnregister(host);
		registerPaneTools(host.tools, hub);
		log(`routes+tools mounted（adb=${cfg.adbPath}, idle=${cfg.idleDetachMinutes}min）`);
		return () => {
			unregisterRoutes();
			unregisterToolsGuard();
			hub.dispose();
			log("disposed（规则10：卸载零残留）");
		};
	});
}
/**
* 工具注销：cordis 的 tools.register 返回值未在所有版本保证可注销；
* 这里通过 ctx.effect 生命周期兜底 —— hub.dispose 已断流；tools schema 层面
* 由宿主在插件 dispose 时回收（cordis 语义：apply 内注册随 fiber 销毁）。
*/
function guardToolUnregister(_host) {
	return () => void 0;
}
function pluginRoot() {
	const here = new URL(".", import.meta.url).pathname;
	return join(here, "..");
}
function joinAndroidEmulator() {
	return join(process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME ?? join(homedir(), "Library/Android/sdk"), "emulator", "emulator");
}
//#endregion
export { Config, apply, name };

//# sourceMappingURL=index.js.map
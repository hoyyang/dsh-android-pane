window.__ModuleLoader__.load({
	id: "@dsh-external/dsh-android-pane",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_dom = require("react-dom");
		//#region src/client/dock.ts
		/**
		* dsh-android-pane 停靠租约：右列占位经 DSH root margin-right 实现（机制同 dsh-ios 253★ 验证方案）。
		* DSH root 是 auto-width 块 → margin-right 收窄 AppFrame 栅格腾出真实布局空间，而不是遮盖会话。
		* 租约归属记在 root dataset；release 恢复原 inline 值（HMR/重载兼容）；
		* 他人已持租约时 claim 失败返回 undefined（调用方降级浮窗形态）。
		*/
		const DAP_DOCK_ATTR = "dapDockOwner";
		const DAP_DOCK_OWNER = "dsh-android-pane";
		/** 右侧邻列：dsh-project-manager 的卡片详情列（body 上的 fixed 右列，right:0）。
		*  面板要贴在它左边，四列才排成「会话 | 右侧边栏 | 面板 | 卡片详情」。
		*  认的是类名 —— 对方改名/不存在 = 恒返回 0 = 面板退回贴最右（功能不坏，只是会被详情盖住）。 */
		const NEIGHBOR_SEL = ".dpm-global-detail";
		/** 盯邻列，把「面板右边缘应让出的距离」回调出去；返回取消函数。
		*  详情开/关、拖宽、隐藏（data-dpm-gd="away"）、窗口缩放都实时跟随（事件驱动，不轮询）。 */
		function watchRightNeighbor(apply) {
			let det = null;
			let ro = null;
			let attrs = null;
			let raf = 0;
			let dead = false;
			const measure = () => {
				if (det == null || det.hidden || det.getAttribute("data-dpm-gd") === "away") return 0;
				const r = det.getBoundingClientRect();
				if (r.width <= 0 || r.left >= window.innerWidth) return 0;
				return Math.max(0, Math.round(window.innerWidth - r.left));
			};
			const run = () => {
				raf = 0;
				if (!dead) apply(measure());
			};
			const soon = () => {
				if (!dead && raf === 0) raf = requestAnimationFrame(run);
			};
			/** 详情列懒创建（首次打开详情才 append 到 body）→ body 直接子节点变化就重新认一次。 */
			const bind = () => {
				const next = document.querySelector(NEIGHBOR_SEL);
				if (next === det) {
					soon();
					return;
				}
				ro?.disconnect();
				attrs?.disconnect();
				det = next;
				if (det != null) {
					ro = new ResizeObserver(soon);
					ro.observe(det);
					attrs = new MutationObserver(soon);
					attrs.observe(det, {
						attributes: true,
						attributeFilter: [
							"style",
							"hidden",
							"data-dpm-gd"
						]
					});
				}
				soon();
			};
			const bodyMo = new MutationObserver(bind);
			bodyMo.observe(document.body, { childList: true });
			window.addEventListener("resize", soon);
			bind();
			return () => {
				dead = true;
				bodyMo.disconnect();
				ro?.disconnect();
				attrs?.disconnect();
				window.removeEventListener("resize", soon);
				if (raf !== 0) cancelAnimationFrame(raf);
			};
		}
		function claimRootDock(root, owner, width, computedMarginRight = 0) {
			const existing = root.dataset[DAP_DOCK_ATTR];
			if (existing !== void 0 && existing !== owner) return void 0;
			if (existing === void 0 && (root.style.marginRight.trim() !== "" || Number.isFinite(computedMarginRight) && computedMarginRight > .5)) return;
			const prevMargin = root.style.marginRight;
			const prevMinWidth = root.style.minWidth;
			root.dataset[DAP_DOCK_ATTR] = owner;
			root.style.minWidth = "0";
			let released = false;
			const update = (w) => {
				if (released || root.dataset["dapDockOwner"] !== owner) return;
				root.style.marginRight = `${Math.max(0, Math.round(w))}px`;
			};
			const release = () => {
				if (released) return;
				released = true;
				if (root.dataset["dapDockOwner"] !== owner) return;
				root.style.marginRight = prevMargin;
				root.style.minWidth = prevMinWidth;
				delete root.dataset[DAP_DOCK_ATTR];
			};
			update(width);
			return {
				update,
				release
			};
		}
		//#endregion
		//#region src/client/index.ts
		/**
		* dsh-android-pane client：右侧停靠列（margin-right 租约）+ 浮窗降级 + 侧栏入口。
		* B28 Graphite Studio：画面优先，统一宿主目录，真实截图/录屏/调试。
		* 两必坑（骨架实测）：apply 用 ctx.slots 必须 export const inject = ['slots']；register 必带 name。
		* 流消费：fetch 流式分帧 [u32 type][u64 pts][u32 len][payload] → WebCodecs VideoDecoder(AnnexB) → canvas；
		* 降级：/stream 不可用（poll 模式）→ <img> 每 600ms 拉 /frame。
		* 手势：pointer 事件 → 设备物理坐标 → POST /act（agent 忙碌时 409 → 提示等徽标）。
		*/
		const NS = "dsh-android-pane";
		const API = "/_dsh/dsh-android-pane";
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
		/** B24 样式管理：内容即版本——与在册标签逐字比对，不一致原子换新（热重载后免整页刷新）。 */
		const BTN_STYLE_ID = "dsh-android-pane-btn-css";
		const PANE_STYLE_ID = "dsh-android-pane-pane-css";
		const CSS_VERSION = "0.2.0";
		/** 挂载或换新样式标签；返回是否发生了实际写入。 */
		function upsertStyle(id, css) {
			const el = document.getElementById(id);
			if (el == null) {
				const tag = document.createElement("style");
				tag.id = id;
				tag.textContent = css;
				document.head.appendChild(tag);
				return true;
			}
			if (el.textContent !== css) {
				el.textContent = css;
				return true;
			}
			return false;
		}
		/** 标签在且内容与当前版本一致。 */
		function styleHealthy(id, css) {
			const el = document.getElementById(id);
			return el != null && el.textContent === css;
		}
		/** 强制重挂：先摘除再挂载（标签在但规则失效时的最后手段）。 */
		function forceRemountStyle(id, css) {
			document.getElementById(id)?.remove();
			upsertStyle(id, css);
		}
		/** B28 Graphite Studio: same tokens and compact controls as the confirmed prototype. */
		const PANE_CSS = `
.dap-pane,.dap-dialog{color-scheme:dark;--bg:#101213;--panel:#191c1e;--raised:#25292c;--line:#383e42;--text:#f2f5f3;--muted:#b4bebc;--mint:#a8eed3;--amber:#ffd29a;--red:#ffb0ac;font:14px/1.5 "SF Pro Display","PingFang SC","Microsoft YaHei",sans-serif;color:var(--text);background:var(--panel)}
.dap-pane{display:flex;flex-direction:column;min-height:0;overflow:hidden;box-sizing:border-box}
.dap-pane *,.dap-dialog *{box-sizing:border-box}.dap-pane button,.dap-dialog button,.dap-dialog input,.dap-dialog select,.dap-select{font:inherit;color:inherit;outline-offset:3px}.dap-pane button,.dap-dialog button{cursor:pointer;transition:background .18s,border-color .18s,transform .18s}.dap-pane button:disabled,.dap-dialog button:disabled{cursor:not-allowed;opacity:.48}.dap-pane button:hover:not(:disabled),.dap-dialog button:hover:not(:disabled){border-color:#8b9793;background-color:#343b3a}.dap-pane button:active:not(:disabled),.dap-dialog button:active:not(:disabled){transform:translateY(1px)}.dap-pane :focus-visible,.dap-dialog :focus-visible{outline:2px solid var(--mint)}
.dap-dock{position:fixed;top:0;right:0;bottom:0;width:420px;box-sizing:border-box;z-index:60;border-left:1px solid var(--line)}
.dap-overlay{position:fixed;right:16px;top:8px;bottom:8px;width:440px;max-width:calc(100vw - 32px);z-index:99990;border:1px solid var(--line);border-radius:10px;box-shadow:0 10px 34px #0006}
.dap-head{display:flex;align-items:center;gap:4px;padding:4px 8px;flex-shrink:0}.dap-select{flex:1;min-width:0;min-height:32px;background:transparent;border:0;font-size:12px}
.dap-icon-svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.65;stroke-linecap:round;stroke-linejoin:round;flex-shrink:0}
.dap-icon{display:inline-flex;align-items:center;justify-content:center;width:32px;min-width:32px;height:32px;border:1px solid transparent;border-radius:6px;background:transparent;flex-shrink:0}
.dap-btn2,.dap-quiet{display:inline-flex;align-items:center;justify-content:center;gap:4px;min-width:32px;min-height:32px;padding:4px 8px;border:1px solid var(--line);border-radius:6px;background:#222729;font-size:12px!important}
.dap-primary{min-height:44px;padding:8px 18px;border:1px solid var(--mint);border-radius:10px;background:var(--mint);color:#12271e!important;font-weight:650}
/* 保存设置等实心主按钮：hover 必须保持浅底深字，否则会落进通用 hover 的深底规则（用户实测字看不清） */
.dap-dialog .dap-primary:hover:not(:disabled),.dap-dialog .dap-primary:focus-visible{background:var(--mint);border-color:#9af0cd;filter:brightness(1.05)}
.dap-capture-zone{padding:0 8px 4px;flex-shrink:0}.dap-directory-row{display:flex;align-items:center;gap:6px;min-height:32px;margin-bottom:4px}.dap-directory-row>svg{color:var(--muted);width:16px}.dap-path{font:12px/1.4 "SFMono-Regular",Consolas,monospace;overflow-wrap:anywhere;word-break:break-word;white-space:pre-wrap}.dap-directory-row .dap-path{flex:1;min-width:0;max-height:min(3.4em,12vh);overflow:auto}
.dap-capture-buttons{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}.dap-capture-btn{position:relative;min-width:0;min-height:36px;display:flex;align-items:center;justify-content:center;gap:6px;padding:5px 6px;border:1px solid #48504d;border-radius:6px;background:#29302d}.dap-capture-btn b{font-size:13px;font-weight:600;white-space:nowrap}.dap-capture-btn small{font:11px monospace;color:var(--muted)}.dap-capture-btn small:empty{display:none}.dap-shot{border-color:#648a79;background:#293d33}.dap-shot svg{color:var(--mint)}.dap-record svg{color:var(--red)}.dap-debug{border-color:#77644b}.dap-debug svg{color:var(--amber)}.dap-capture-btn.active{background:#493128;border-color:var(--amber)}.dap-capture-btn.active:after{content:'';position:absolute;right:3px;top:3px;width:4px;height:4px;border-radius:50%;background:var(--red);animation:dap-indicator 1s infinite}
.dap-screen{position:relative;flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:4px;background:#111516;overflow:hidden;touch-action:none}.dap-screen canvas,.dap-screen img{display:block;max-width:100%;max-height:100%;flex-shrink:0;border:2px solid #363d39;border-radius:16px;object-fit:contain}.dap-screen.capturing canvas,.dap-screen.capturing img{border-color:#8b6a45}.dap-screen.flash:after{content:'';position:absolute;inset:4px;pointer-events:none;background:#fff;animation:dap-flash .35s forwards}
.dap-navigation{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:4px 8px;border-top:1px solid var(--line);flex-shrink:0}.dap-nav-group{display:flex;gap:6px}.dap-mute[aria-pressed=true]{color:var(--mint);border-color:#779d8c;background:#273b31}.dap-text-entry{display:flex;gap:6px;padding:0 8px 6px;flex-shrink:0}.dap-text-entry input{background:#101617;border:1px solid #58605c;border-radius:6px;padding:6px;min-width:0;min-height:32px;flex:1;color:var(--text);font:12px inherit}
.dap-state-banner{margin:4px 8px;padding:6px 8px;border:1px solid #836d4c;border-radius:6px;color:var(--amber);background:#332b21;font-size:12px;display:flex;gap:6px;align-items:center;flex-shrink:0}.dap-state-banner span{flex:1}.dap-toast{display:flex;align-items:center;gap:6px;flex-shrink:0;margin:0 8px 4px;padding:6px 8px;background:#2b4035;border:1px solid #85af99;border-radius:6px;font-size:12px}.dap-toast p{margin:0;flex:1;overflow-wrap:anywhere;max-height:12vh;overflow:auto}.dap-toast.error{background:#48302d;border-color:#bc8275}.dap-toast.error svg{color:var(--red)}
.dap-state{display:flex;flex-direction:column;align-items:center;gap:10px;padding:18px;text-align:center}.dap-state-txt{font-size:17px;font-weight:600}.dap-state-sub{font-size:12px;line-height:1.8;color:var(--muted);max-width:270px}.dap-skel{width:70%;height:12px;border-radius:8px;background:linear-gradient(90deg,#25292c,#383e42,#25292c);background-size:200% 100%;animation:dap-shimmer 1.2s infinite}.dap-skel.b{width:48%}.dap-skel.c{width:60%}
.dap-outline{display:flex;flex-direction:column;width:100%;height:100%;min-height:0}.dap-outline-hd{display:flex;gap:8px;align-items:center;padding:8px;font-size:12px;border-bottom:1px solid var(--line)}.dap-outline-hd span{flex:1}.dap-outline-list{flex:1;overflow:auto;display:flex;flex-direction:column;gap:4px;padding:6px}.dap-outline-item{display:flex;gap:6px;justify-content:space-between;text-align:left;border:1px solid var(--line);border-radius:6px;background:var(--panel);padding:5px 8px;min-height:32px;font-size:12px!important}.dap-ot{flex:1;min-width:0;overflow-wrap:anywhere}.dap-oc{font-size:10px;color:var(--muted)}
.dap-dialog{width:420px;max-width:calc(100vw - 28px);max-height:calc(100dvh - 28px);padding:0;border:1px solid #68766e;border-radius:18px;box-shadow:0 24px 90px #0009}.dap-dialog::backdrop{background:#0009;backdrop-filter:blur(3px)}.dap-dialog[open]{animation:dap-enter .2s ease-out}.dap-dialog-head{display:flex;align-items:center;padding:16px 20px 12px;gap:12px}.dap-dialog-head h3{font-size:17px;font-weight:600;margin:0;flex:1}.dap-dialog-body{padding:0 20px 20px}.dap-dialog-body p{font-size:12px;color:var(--muted);margin:0 0 16px;line-height:1.8}.dap-dialog-body label{font-size:12px;display:block;margin-bottom:8px}.dap-dialog-body input,.dap-dialog-body select{width:100%;background:#111617;color:var(--text);border:1px solid #77857e;border-radius:9px;padding:10px 12px;min-height:44px}.dap-input-line{display:flex;gap:8px}.dap-input-line input{flex:1;min-width:0}.dap-dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:20px}.dap-field-error{font-size:12px;color:var(--red);margin-top:8px;overflow-wrap:anywhere}.dap-setting-row{display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--line);font-size:13px}.dap-setting-row span{flex:1}.dap-setting-row select{width:145px;font-size:12px}.dap-output{padding:10px 0;border-top:1px solid var(--line)}.dap-output-top{display:flex;align-items:center;gap:6px;font-size:12px;margin-bottom:4px}.dap-output-top time{margin-left:auto;font-size:11px;color:var(--muted)}.dap-output-files{font-size:12px;color:var(--muted);line-height:1.6;overflow-wrap:anywhere}.dap-output-preview{color:var(--mint)!important;border:0;background:transparent;padding:4px 0;min-height:32px;text-align:left;font-size:12px!important}.dap-preview-media{display:block;max-width:100%;max-height:55vh;margin:0 auto 16px}.dap-log-preview{font:11px/1.7 monospace;white-space:pre-wrap;max-height:45vh;overflow:auto}
@keyframes dap-flash{from{opacity:.8}to{opacity:0}}@keyframes dap-enter{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}@keyframes dap-indicator{50%{opacity:.35}}@keyframes dap-shimmer{from{background-position:200% 0}to{background-position:-200% 0}}
@media(max-width:999px){.dap-overlay{right:0;top:0;bottom:0;width:460px;max-width:100vw;border-radius:0}}
@media(max-width:600px){.dap-overlay{width:100vw}}
@media(pointer:coarse){.dap-pane .dap-icon,.dap-navigation .dap-btn2{min-width:44px;height:44px}.dap-select{min-height:44px}.dap-capture-btn{min-height:44px}.dap-navigation,.dap-nav-group{gap:4px}.dap-dialog-head .dap-icon,.dap-text-entry input,.dap-text-entry button,.dap-output-preview{min-height:44px}.dap-dialog-head .dap-icon{width:44px;height:44px}}
@media(prefers-reduced-motion:reduce){.dap-pane *,.dap-pane *::before,.dap-pane *::after,.dap-dialog,.dap-dialog *{animation:none!important;transition:none!important;scroll-behavior:auto!important}.dap-screen.flash::after{display:none}.dap-dialog::backdrop{backdrop-filter:none}}
`;
		const ICON_PATHS = {
			camera: "M4 6h4l2-3h4l2 3h4v15H4Z M16 13a4 4 0 1 1-8 0a4 4 0 1 1 8 0",
			video: "M3 5h13v14H3Z M16 10l5-3v10l-5-3Z",
			debug: "m8 8 4-4 4 4M7 12h10v6a5 5 0 0 1-10 0ZM12 12v10M3 10l4 3m10 0 4-3M3 18h4m10 0h4M6 22l2-2m8 0 2 2",
			folder: "M3 5h7l2 3h9v12H3Z",
			settings: "m8 3-1 3-3 1v4l2 1-2 2v4l3 1 1 3h8l1-3 3-1v-4l-2-2 2-1V7l-3-1-1-3Z M15 12a3 3 0 1 1-6 0a3 3 0 1 1 6 0",
			close: "m6 6 12 12M18 6 6 18",
			float: "M3 3h18v18H3Z M10 10h9v9h-9Z",
			refresh: "M20 8a8 8 0 1 0 0 8M20 3v5h-5",
			back: "m15 5-7 7 7 7",
			home: "M19 12a7 7 0 1 1-14 0a7 7 0 1 1 14 0",
			recents: "M5 5h14v14H5Z",
			mute: "M11 4 6 8H3v8h3l5 4ZM16 9l5 6m0-6-5 6",
			volume: "M11 4 6 8H3v8h3l5 4ZM16 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14",
			keyboard: "M2 5h20v14H2Z M6 9h1m4 0h1m4 0h1M6 13h1m4 0h1m4 0h1M8 16h8",
			check: "m5 12 4 4L19 6",
			lock: "M5 10h14v11H5Z M8 10V6a4 4 0 0 1 8 0v4M12 14v3",
			alert: "m12 3 10 18H2ZM12 9v5m0 3v1",
			stop: "M5 5h14v14H5Z"
		};
		function icon(name) {
			return (0, react.createElement)("svg", {
				className: "dap-icon-svg",
				viewBox: "0 0 24 24",
				"aria-hidden": true
			}, (0, react.createElement)("path", { d: ICON_PATHS[name] ?? ICON_PATHS.alert }));
		}
		async function api(path, body, options = {}) {
			const res = await fetch(API + path, {
				...options,
				method: body == null ? "GET" : "POST",
				headers: { "content-type": "application/json" },
				body: body == null ? void 0 : JSON.stringify(body)
			});
			const json = await res.json().catch(() => null);
			if (!res.ok || json == null || json.ok !== true) throw new Error(json?.error?.message ?? `${path} HTTP ${res.status}`);
			return json;
		}
		var StreamReader = class {
			serial;
			onFrame;
			onMeta;
			onDead;
			draw;
			reader = null;
			buf = /* @__PURE__ */ new Uint8Array(0);
			decoder = null;
			aborted = false;
			frames = 0;
			/** 收到的 type=1 视频帧计数（到达即计，与解码成功分开）——B25：区分「收到帧解不出」（真故障）
			*  与「根本没帧」（静态屏下 MediaCodec 无新输入帧就不产输出帧，健康静默）。 */
			payloadSeen = 0;
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
					const j = await res.json().catch(() => null);
					throw new Error(j?.error?.message ?? `/stream HTTP ${res.status}`);
				}
				this.reader = res.body.getReader();
				this.pump();
			}
			async pump() {
				try {
					for (;;) {
						if (this.aborted) return;
						const { done, value } = await this.reader.read();
						if (done) {
							this.onDead("串流结束");
							return;
						}
						this.append(value);
						this.drain();
					}
				} catch (e) {
					if (!this.aborted) this.onDead(`串流中断: ${String(e).slice(0, 120)}`);
				}
			}
			append(chunk) {
				const merged = new Uint8Array(this.buf.length + chunk.length);
				merged.set(this.buf);
				merged.set(chunk, this.buf.length);
				this.buf = merged;
			}
			async drain() {
				for (;;) {
					if (this.buf.length < 16) return;
					const view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
					const type = view.getUint32(0);
					const len = view.getUint32(12);
					if (type > 2 || len > 8e6) {
						this.buf = this.buf.subarray(1);
						continue;
					}
					const pts = view.getBigUint64(4);
					if (this.buf.length < 16 + len) return;
					const payload = this.buf.subarray(16, 16 + len);
					this.buf = this.buf.subarray(16 + len);
					if (type === 0) try {
						const meta = JSON.parse(new TextDecoder().decode(payload));
						this.onMeta(meta);
					} catch {}
					else if (type === 2) this.lastFrameAt = Date.now();
					else if (type === 1) {
						this.payloadSeen++;
						const nals = annexBNalTypes(payload);
						if (nals.sps || nals.pps) {
							this.codecCfg = payload.slice();
							const codec = annexBCodecString(payload);
							if (codec != null && this.curCodec !== codec) {
								this.curCodec = codec;
								this.initDecoder(codec);
							}
							if (!nals.idr) continue;
						}
						if (this.decoder == null || this.curCodec == null) continue;
						const isKey = nals.idr || nals.sps;
						let data = payload;
						if (isKey && !nals.sps && this.codecCfg != null) {
							data = new Uint8Array(this.codecCfg.length + payload.length);
							data.set(this.codecCfg);
							data.set(payload, this.codecCfg.length);
						}
						const chunk = new EncodedVideoChunk({
							type: isKey ? "key" : "delta",
							timestamp: Number(pts & 4611686018427387903n),
							data
						});
						try {
							this.decoder.decode(chunk);
							this.frames++;
							this.lastFrameAt = Date.now();
							this.onFrame();
						} catch (e) {
							this.onDead(`解码失败: ${String(e).slice(0, 120)}`);
							return;
						}
					}
				}
			}
			initDecoder(codec) {
				if (typeof VideoDecoder === "undefined") throw new Error("本浏览器不支持 WebCodecs");
				try {
					this.decoder?.close();
				} catch {}
				this.decoder = new VideoDecoder({
					output: (vf) => {
						try {
							this.draw(vf);
						} finally {
							vf.close();
						}
					},
					error: (e) => this.onDead(`VideoDecoder 错误: ${String(e).slice(0, 160)}`)
				});
				this.decoder.configure({
					codec,
					optimizeForLatency: true
				});
			}
			stop() {
				this.aborted = true;
				this.codecCfg = null;
				this.curCodec = null;
				try {
					this.reader?.cancel().catch(() => void 0);
				} catch {}
				try {
					this.decoder?.close();
				} catch {}
				this.decoder = null;
				this.reader = null;
			}
		};
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
					if (nalStart >= 0 && i - zeros > nalStart) scan.push(data.subarray(nalStart, i - zeros));
					nalStart = i + 1;
				}
				zeros = 0;
			}
			if (nalStart >= 0) scan.push(data.subarray(nalStart));
			for (const nal of scan) {
				if (nal.length === 0) continue;
				const t = nal[0] & 31;
				if (t === 7) sps = true;
				if (t === 8) pps = true;
				if (t === 5) idr = true;
			}
			return {
				sps,
				pps,
				idr
			};
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
					if (nalStart >= 0 && i - zeros > nalStart) nals.push(data.subarray(nalStart, i - zeros));
					nalStart = i + 1;
				}
				zeros = 0;
			}
			if (nalStart >= 0) nals.push(data.subarray(nalStart));
			for (const nal of nals) if (nal.length > 3 && (nal[0] & 31) === 7) {
				sps = nal;
				break;
			}
			if (sps == null || sps.length < 4) return null;
			const hex = (n) => n.toString(16).padStart(2, "0");
			return `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`;
		}
		const DOCK_W = 420;
		const DOCK_MIN_W = 1200;
		const PREF_KEY = "dsh-android-pane:form";
		/**
		* PM parity: prefer the same host directory picker project-manager drives
		* (`uiWorkspace.pickDirectory`), and on DSH Desktop use its preload bridge
		* (`__DSH_DIRECTORY_PICKER__.pick`) which opens the Electron folder dialog.
		* Only when neither exists does the pane fall back to its own HTTP picker route.
		*/
		let hostPickDirectory = null;
		/** The composed picker can be browse-only (remote/browser setups); say that in user terms. */
		function friendlyPickerError(e) {
			const text = e instanceof Error ? e.message : String(e);
			if (/native capability/.test(text) || /serves\s*"browse"/.test(text)) return "当前运行方式没有系统文件夹对话框（目录选择器为浏览模式）——请直接在输入框里填绝对路径。";
			return text;
		}
		var PaneWindow = class extends react.Component {
			state = {
				open: false,
				form: "overlay",
				serial: null,
				devices: [],
				busy: false,
				claimsSeen: false,
				mode: null,
				error: null,
				streamError: null,
				fps: 0,
				quality: {
					maxSize: 1280,
					maxFps: 30
				},
				recording: false,
				debug: null,
				note: null,
				claimSessionId: null,
				secure: null,
				secView: "stream",
				secBusy: false,
				secSteps: null,
				outline: null,
				secCanvasVisible: false,
				streamSize: null,
				dockRight: 0,
				capture: null,
				captureBusy: false,
				modal: null,
				directoryDraft: "",
				directoryError: null,
				directoryPickerOpen: false,
				textOpen: false,
				deviceText: "",
				preview: null,
				previewText: "",
				confirmTitle: "",
				confirmText: "",
				confirmLabel: ""
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
			inputQueue = [];
			inputInflight = false;
			inputRaf = 0;
			holdTimer = null;
			screenRef = null;
			unmounted = false;
			lastReattachAt = 0;
			h264Retries = 0;
			pref = "auto";
			lease = null;
			unwatchNeighbor = null;
			resizeObserver = null;
			dialogRef = null;
			confirmCallback = null;
			directoryPicking = null;
			captureInflight = false;
			captureSettled = null;
			componentDidMount() {
				try {
					const saved = localStorage.getItem(PREF_KEY);
					if (saved === "dock" || saved === "overlay") this.pref = saved;
				} catch {}
				this.dispatchState();
				this.pollTimer = setInterval(() => void this.poll(), 2e3);
				this.secLumTimer = setInterval(() => this.sampleSecVisibility(), 2e3);
				this.fpsTimer = setInterval(() => {
					this.setState({ fps: this.frameCount });
					this.frameCount = 0;
				}, 1e3);
				const onToggle = () => this.setOpen(!this.state.open);
				window.addEventListener("dsh-android-pane:toggle", onToggle);
				this.removeToggle = () => window.removeEventListener("dsh-android-pane:toggle", onToggle);
				this.onResize = () => this.syncForm();
				window.addEventListener("resize", this.onResize);
				this.onKeyDown = (e) => {
					if (e.key === "Escape" && this.state.open && this.state.modal == null) {
						e.preventDefault();
						if (this.state.textOpen) this.setState({ textOpen: false });
						else this.setOpen(false);
					}
				};
				window.addEventListener("keydown", this.onKeyDown);
				window.addEventListener("pagehide", this.clearGesture);
				this.poll();
			}
			removeToggle = () => void 0;
			onResize = () => void 0;
			onKeyDown = () => void 0;
			componentDidUpdate() {
				this.dispatchState();
				this.fitScreen();
				if (this.state.modal != null && this.dialogRef != null && !this.dialogRef.open) this.dialogRef.showModal();
			}
			componentWillUnmount() {
				this.unmounted = true;
				this.directoryPicking?.abort();
				window.removeEventListener("pagehide", this.clearGesture);
				if (this.pollTimer != null) clearInterval(this.pollTimer);
				if (this.fpsTimer != null) clearInterval(this.fpsTimer);
				if (this.secLumTimer != null) clearInterval(this.secLumTimer);
				this.stopStream();
				this.bindScreen(null);
				this.releaseLease();
				this.removeToggle();
				window.removeEventListener("resize", this.onResize);
				window.removeEventListener("keydown", this.onKeyDown);
			}
			setOpen(open) {
				if (!open) {
					if ((this.state.capture?.record ?? this.state.capture?.debug) != null) {
						this.confirmAction("采集中，关闭面板？", "停止当前采集并保存后再关闭。保存失败时保留面板和采集记录。", "停止并保存", async () => {
							await this.captureSettled;
							const current = this.state.capture?.record ?? this.state.capture?.debug;
							if (current == null) {
								this.closeNow();
								return;
							}
							if (await this.captureAction(this.state.capture?.record ? "record" : "debug", {
								serial: current.serial,
								action: "stop"
							})) this.closeNow();
						});
						return;
					}
					if (this.captureInflight) {
						this.setState({ note: "正在保存，请稍候再关闭。" });
						return;
					}
				}
				this.setState({ open }, () => {
					if (open) {
						this.poll();
						this.syncForm();
						if (this.state.serial != null) this.attach(this.state.serial);
					} else {
						this.stopStream();
						this.releaseLease();
					}
				});
			}
			closeNow() {
				this.setState({
					open: false,
					modal: null
				});
				this.stopStream();
				this.releaseLease();
			}
			/** 停靠租约生命周期：开面板时按 pref/窗宽决定形态；claim 失败（他人持租约/窄窗）→ 浮窗降级。 */
			syncForm() {
				if (!this.state.open) return;
				const shouldDock = !(window.innerWidth < 1e3) && (this.pref === "dock" || this.pref === "auto" && window.innerWidth >= DOCK_MIN_W);
				if (shouldDock && this.state.form === "dock" && this.lease != null) return;
				if (shouldDock) {
					const root = document.getElementById("root");
					const lease = root != null ? claimRootDock(root, DAP_DOCK_OWNER, DOCK_W, Number.parseFloat(window.getComputedStyle(root).marginRight)) : void 0;
					if (lease != null) {
						this.releaseLease();
						this.lease = lease;
						lease.update(DOCK_W);
						this.startNeighborWatch();
						if (this.state.form !== "dock") this.setState({ form: "dock" });
						return;
					}
				}
				this.releaseLease();
				if (this.state.form !== "overlay") this.setState({ form: "overlay" });
			}
			releaseLease() {
				this.lease?.release();
				this.lease = null;
				this.stopNeighborWatch();
			}
			/** 停靠时盯右侧邻列（dsh-project-manager 的卡片详情列）：面板右边缘 = 它左边缘。 */
			startNeighborWatch() {
				if (this.unwatchNeighbor != null) return;
				this.unwatchNeighbor = watchRightNeighbor((px) => {
					if (px !== this.state.dockRight) this.setState({ dockRight: px });
				});
			}
			stopNeighborWatch() {
				this.unwatchNeighbor?.();
				this.unwatchNeighbor = null;
				if (this.state.dockRight !== 0) this.setState({ dockRight: 0 });
			}
			toggleForm() {
				this.pref = this.state.form === "dock" ? "overlay" : "dock";
				try {
					localStorage.setItem(PREF_KEY, this.pref);
				} catch {}
				this.syncForm();
			}
			async poll() {
				if (document.hidden) return;
				try {
					const st = await api("/session-state");
					const dv = await api("/devices");
					const capture = await api("/capture");
					this.setState({ capture });
					const claimed = (st.claims ?? [])[0]?.serial;
					if (claimed != null && claimed !== this.state.serial && capture.record == null && capture.debug == null && !this.captureInflight) {
						this.setState({
							open: true,
							devices: dv.devices,
							quality: dv.quality,
							busy: Object.values(st.busy).some(Boolean),
							secure: null,
							secView: "stream",
							secSteps: null,
							outline: null
						}, () => this.syncForm());
						this.attach(claimed);
						return;
					}
					const online = dv.devices.filter((d) => d.state === "device");
					if (this.state.open && this.state.serial == null && online.length >= 1) {
						const target = online.find((d) => d.claimedBy != null)?.serial ?? online[0].serial;
						this.attach(target);
						return;
					}
					if (this.state.mode === "h264" && this.state.serial != null && this.stream != null) {
						if (Date.now() - Math.max(this.stream.lastFrameAt, this.stream.startedAt) > 1e4 && Date.now() - this.lastReattachAt > 15e3) {
							this.lastReattachAt = Date.now();
							this.stopStream();
							this.attach(this.state.serial);
							return;
						}
					}
					if (this.state.mode === "h264" && this.state.serial != null && this.stream != null && this.stream.payloadSeen > 0 && this.stream.frames === 0 && Date.now() - this.stream.startedAt > 12e3 && Date.now() - this.lastReattachAt > 15e3) {
						this.lastReattachAt = Date.now();
						this.stopStream();
						this.attach(this.state.serial);
						return;
					}
					if (this.state.mode === "poll" && this.state.serial != null && this.state.open && !document.hidden && Date.now() - this.lastReattachAt > 15e3) {
						this.lastReattachAt = Date.now();
						this.attach(this.state.serial);
						return;
					}
					const patch = {
						devices: dv.devices,
						quality: dv.quality,
						busy: Object.values(st.busy).some(Boolean),
						debug: this.state.serial != null ? st.debug?.[this.state.serial] ?? null : this.state.debug,
						claimSessionId: this.state.serial != null ? st.claims.find((cl) => cl.serial === this.state.serial)?.sessionId.slice(8, 16) ?? null : null,
						streamError: this.state.serial != null ? st.streamErrors?.[this.state.serial] ?? this.state.streamError : this.state.streamError,
						secure: this.state.serial != null ? st.secure?.[this.state.serial] ?? null : null
					};
					this.setState(patch);
					if (this.state.secure?.secure !== true && (this.state.secView === "outline" || this.state.secSteps != null || this.state.outline != null)) this.setState({
						secView: "stream",
						secSteps: null,
						outline: null
					});
					if (this.state.mode === "h264" && this.stream != null && this.stream.frames > 10 && (this.state.streamError != null || this.state.error != null)) this.setState({ streamError: null });
					if (this.state.serial != null && !dv.devices.some((d) => d.serial === this.state.serial)) {
						this.setState({
							serial: null,
							mode: null
						});
						this.stopStream();
					}
				} catch {}
			}
			dispatchState() {
				const online = this.state.devices.filter((d) => d.state === "device").length;
				window.dispatchEvent(new CustomEvent("dsh-android-pane:state", { detail: {
					open: this.state.open,
					online,
					busy: this.state.busy
				} }));
			}
			stopStream() {
				this.clearGesture();
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
				this.clearGesture();
				const seq = ++this.attachSeq;
				const stale = () => seq !== this.attachSeq;
				this.setState({ error: null });
				try {
					const r = await api("/attach", { serial });
					if (stale()) return;
					if (r.mode === "poll" && !retried && r.streamError != null) {
						await new Promise((res) => setTimeout(res, 1500));
						if (stale()) return;
						return this.attach(serial, true);
					}
					if (stale()) return;
					this.setState({
						serial: r.serial,
						mode: r.mode,
						streamError: r.streamError,
						error: null
					});
					this.stopStream();
					if (r.mode === "h264") {
						const gen = seq;
						this.stream = new StreamReader(r.serial, () => {
							this.frameCount++;
							this.frameTotal++;
							if (this.frameTotal > 5) this.h264Retries = 0;
						}, (meta) => {
							if (this.canvasRef?.width !== meta.w || this.canvasRef?.height !== meta.h) this.clearGesture();
							this.setState({ streamSize: {
								w: meta.w,
								h: meta.h
							} });
							const c = this.canvasRef;
							if (c != null) {
								if (c.width !== meta.w) c.width = meta.w;
								if (c.height !== meta.h) c.height = meta.h;
							}
						}, (reason) => {
							if (stale()) return;
							this.clearGesture();
							this.setState({
								streamError: reason,
								mode: "poll"
							});
							this.startPollImg();
							if (this.h264Retries < 3 && this.state.serial != null) {
								this.h264Retries++;
								const s = this.state.serial;
								this.lastReattachAt = Date.now();
								setTimeout(() => {
									if (this.attachSeq !== gen) return;
									if (this.state.open && this.state.serial === s && this.state.mode === "poll" && !document.hidden) this.attach(s);
								}, 2500);
							}
						}, (vf) => {
							const c = this.canvasRef;
							if (c != null) c.getContext("2d")?.drawImage(vf, 0, 0, c.width, c.height);
						});
						this.frameCount = 0;
						await this.stream.start().catch((e) => {
							if (stale()) return;
							this.setState({
								streamError: String(e).replace(/^Error:\s*/, "").slice(0, 200),
								mode: "poll"
							});
							this.startPollImg();
						});
					} else this.startPollImg();
				} catch (e) {
					if (stale()) return;
					this.stopStream();
					this.setState({
						mode: null,
						error: String(e instanceof Error ? e.message : e).slice(0, 220)
					});
				}
			}
			startPollImg() {
				if (this.pollImgTimer != null) clearInterval(this.pollImgTimer);
				this.pollImgTimer = setInterval(() => {
					const img = this.imgRef;
					if (img != null && this.state.serial != null && !document.hidden) {
						img.src = `${API}/frame?serial=${encodeURIComponent(this.state.serial)}&t=${Date.now()}`;
						this.frameCount++;
					}
				}, 600);
			}
			async act(body) {
				if (this.state.serial == null) return;
				try {
					await api("/act", {
						serial: this.state.serial,
						...body
					});
				} catch (e) {
					this.setState({ error: String(e instanceof Error ? e.message : e).slice(0, 200) });
					setTimeout(() => this.setState({ error: null }), 4e3);
				}
			}
			canvasPoint(e) {
				const el = this.canvasRef ?? this.imgRef;
				if (el == null) return null;
				const rect = el.getBoundingClientRect();
				const srcW = this.canvasRef != null && this.canvasRef.width > 0 ? this.canvasRef.width : el.naturalWidth ?? 0;
				const srcH = this.canvasRef != null && this.canvasRef.height > 0 ? this.canvasRef.height : el.naturalHeight ?? 0;
				if (srcW === 0 || srcH === 0 || rect.width === 0 || e.clientX < rect.left || e.clientX >= rect.right || e.clientY < rect.top || e.clientY >= rect.bottom) return null;
				return {
					x: Math.round((e.clientX - rect.left) / rect.width * srcW),
					y: Math.round((e.clientY - rect.top) / rect.height * srcH)
				};
			}
			/** One queue preserves touch/wheel order; only MOVE and adjacent scroll are coalesced. */
			queueInput(context, event) {
				let batch = this.inputQueue.at(-1);
				if (batch?.serial !== context.serial || batch.input.gesture !== context.gesture || batch.input.events.length >= 64) {
					batch = {
						serial: context.serial,
						input: {
							gesture: context.gesture,
							w: context.w,
							h: context.h,
							events: []
						}
					};
					this.inputQueue.push(batch);
				}
				const last = batch.input.events.at(-1);
				if (last?.p === "move" && event.p === "move") Object.assign(last, event);
				else if (last?.p === "scroll" && event.p === "scroll" && Math.abs(last.dx + event.dx) <= 15 && Math.abs(last.dy + event.dy) <= 15) {
					last.x = event.x;
					last.y = event.y;
					last.dx += event.dx;
					last.dy += event.dy;
				} else batch.input.events.push(event);
				if (event.p === "down" || event.p === "up") this.flushRealtime();
				else if (this.inputRaf === 0) this.inputRaf = requestAnimationFrame(this.flushRealtime);
			}
			flushRealtime = () => {
				if (this.inputRaf !== 0) cancelAnimationFrame(this.inputRaf);
				this.inputRaf = 0;
				if (this.inputInflight) return;
				const batch = this.inputQueue.shift();
				if (batch == null) return;
				this.inputInflight = true;
				api("/act", {
					serial: batch.serial,
					action: "input",
					input: batch.input
				}, {
					keepalive: true,
					signal: AbortSignal.timeout(2e3)
				}).catch((e) => {
					this.inputQueue = [];
					this.pointer = null;
					this.stopHoldTimer();
					if (!this.unmounted) this.setState({ error: "Panel input: " + String(e instanceof Error ? e.message : e) });
					api("/act", {
						serial: batch.serial,
						action: "input",
						input: {
							...batch.input,
							events: [{
								p: "up",
								x: 0,
								y: 0
							}]
						}
					}, {
						keepalive: true,
						signal: AbortSignal.timeout(2e3)
					}).catch((e) => console.warn("Panel release failed; host timeout will release", e));
				}).finally(() => {
					this.inputInflight = false;
					this.flushRealtime();
				});
			};
			stopHoldTimer() {
				if (this.holdTimer != null) clearInterval(this.holdTimer);
				this.holdTimer = null;
			}
			clearGesture = () => {
				const p = this.pointer;
				this.pointer = null;
				this.stopHoldTimer();
				const cancelled = this.inputQueue;
				this.inputQueue = [];
				const releases = /* @__PURE__ */ new Map();
				for (const batch of cancelled) {
					const last = batch.input.events.at(-1);
					if (last.p !== "scroll") releases.set(batch.input.gesture, {
						serial: batch.serial,
						...batch.input,
						x: last.x,
						y: last.y
					});
				}
				if (p?.realtime) releases.set(p.gesture, {
					...p,
					x: p.lastX,
					y: p.lastY
				});
				for (const ctx of releases.values()) this.queueInput(ctx, {
					p: "up",
					x: ctx.x,
					y: ctx.y
				});
			};
			onPointerDown = (e) => {
				if (this.state.busy || this.state.claimSessionId != null || this.pointer != null || e.button !== 0 || !e.isPrimary || this.state.serial == null) return;
				if (e.target !== this.canvasRef && e.target !== this.imgRef) return;
				if (this.inputQueue.length >= 8) {
					this.setState({ error: "Panel input queue busy" });
					return;
				}
				const point = this.canvasPoint(e);
				if (point == null) return;
				const el = this.canvasRef ?? this.imgRef;
				const p = {
					...point,
					lastX: point.x,
					lastY: point.y,
					t: Date.now(),
					pointerId: e.pointerId,
					serial: this.state.serial,
					gesture: crypto.randomUUID(),
					w: el instanceof HTMLCanvasElement ? el.width : el.naturalWidth,
					h: el instanceof HTMLCanvasElement ? el.height : el.naturalHeight,
					realtime: this.state.mode === "h264"
				};
				this.pointer = p;
				this.gestureMoved = false;
				e.currentTarget.setPointerCapture(e.pointerId);
				if (!p.realtime) return;
				this.queueInput(p, {
					p: "down",
					...point
				});
				this.holdTimer = setInterval(() => {
					if (this.pointer === p) this.queueInput(p, {
						p: "move",
						x: p.lastX,
						y: p.lastY
					});
				}, 750);
			};
			onPointerMove = (e) => {
				const start = this.pointer;
				if (start == null || e.pointerId !== start.pointerId) return;
				const point = this.canvasPoint(e);
				if (point == null) return;
				if (Math.abs(point.x - start.x) + Math.abs(point.y - start.y) > 10) this.gestureMoved = true;
				start.lastX = point.x;
				start.lastY = point.y;
				if (start.realtime) {
					if (this.state.mode !== "h264" || this.state.serial !== start.serial || this.canvasRef?.width !== start.w || this.canvasRef?.height !== start.h) {
						this.clearGesture();
						return;
					}
					this.queueInput(start, {
						p: "move",
						...point
					});
				}
			};
			onPointerUp = (e) => {
				const start = this.pointer;
				if (start == null || e.pointerId !== start.pointerId) return;
				const point = this.canvasPoint(e) ?? {
					x: start.lastX,
					y: start.lastY
				};
				this.pointer = null;
				this.stopHoldTimer();
				if (start.realtime) this.queueInput(start, {
					p: "up",
					...point
				});
				else if (start.serial === this.state.serial) {
					const held = Date.now() - start.t;
					if (this.gestureMoved) this.act({
						action: "swipe",
						x: start.x,
						y: start.y,
						x2: point.x,
						y2: point.y,
						durationMs: Math.min(1200, Math.max(120, held))
					});
					else if (held > 600) this.act({
						action: "swipe",
						x: start.x,
						y: start.y,
						x2: start.x,
						y2: start.y,
						durationMs: Math.min(900, held)
					});
					else this.act({
						action: "tap",
						...point
					});
				}
				if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
			};
			onPointerCancel = (e) => {
				if (this.pointer?.pointerId === e.pointerId) this.clearGesture();
			};
			onWheelNative = (e) => {
				if (this.state.mode !== "h264" || this.state.busy || this.state.claimSessionId != null || this.pointer != null || this.state.serial == null) return;
				const point = this.canvasPoint(e);
				const canvas = this.canvasRef;
				if (point == null || canvas == null || e.target !== canvas) return;
				e.preventDefault();
				const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? canvas.getBoundingClientRect().height : 1;
				let dx = -e.deltaX * unit / 100, dy = -e.deltaY * unit / 100;
				if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.abs(dx) > 128 || Math.abs(dy) > 128) {
					this.setState({ error: "Panel wheel delta out of range" });
					return;
				}
				do {
					const sx = Math.max(-15, Math.min(15, dx)), sy = Math.max(-15, Math.min(15, dy));
					this.queueInput({
						serial: this.state.serial,
						gesture: "wheel",
						w: canvas.width,
						h: canvas.height
					}, {
						p: "scroll",
						...point,
						dx: sx,
						dy: sy
					});
					dx -= sx;
					dy -= sy;
				} while (dx !== 0 || dy !== 0);
			};
			bindScreen = (el) => {
				this.screenRef?.removeEventListener("wheel", this.onWheelNative);
				this.screenRef = el;
				this.resizeObserver?.disconnect();
				this.resizeObserver = null;
				if (el != null) {
					this.resizeObserver = new ResizeObserver(() => this.fitScreen());
					this.resizeObserver.observe(el);
				}
				el?.addEventListener("wheel", this.onWheelNative, { passive: false });
			};
			async forceRelease() {
				const serial = this.state.serial;
				if (serial == null) return;
				try {
					const r = await api("/claim/release", { serial });
					if (this.state.serial !== serial) return;
					this.clearGesture();
					this.setState({
						claimSessionId: null,
						mode: r.released ? null : this.state.mode,
						note: r.note
					});
					if (r.released) await this.attach(serial);
					setTimeout(() => this.setState({ note: null }), 6e3);
				} catch (e) {
					this.setState({ error: String(e instanceof Error ? e.message : e).slice(0, 200) });
					setTimeout(() => this.setState({ error: null }), 4e3);
				}
			}
			fitScreen() {
				const el = this.canvasRef ?? this.imgRef, box = this.screenRef;
				if (!el || !box) return;
				const w = el instanceof HTMLCanvasElement ? el.width : el.naturalWidth;
				const height = el instanceof HTMLCanvasElement ? el.height : el.naturalHeight;
				if (!w || !height) return;
				const scale = Math.max(0, Math.min((box.clientWidth - 8) / w, (box.clientHeight - 8) / height));
				el.style.width = w * scale + "px";
				el.style.height = height * scale + "px";
			}
			confirmAction(title, text, label, fn) {
				this.confirmCallback = fn;
				this.setState({
					modal: "confirm",
					confirmTitle: title,
					confirmText: text,
					confirmLabel: label
				});
			}
			openDirectory() {
				this.setState({
					modal: "directory",
					directoryDraft: this.state.capture?.directory ?? "",
					directoryError: null
				});
			}
			async browseDirectory() {
				if (this.state.directoryPickerOpen || this.state.captureBusy || this.state.capture?.record?.status === "recording" || this.state.capture?.debug?.status === "recording") return;
				const controller = new AbortController();
				this.directoryPicking = controller;
				this.setState({
					directoryPickerOpen: true,
					directoryError: null
				});
				try {
					const viaHost = hostPickDirectory == null ? { handled: false } : await hostPickDirectory();
					let directory;
					if (viaHost.handled) directory = viaHost.directory ?? null;
					else ({directory} = await api("/capture/pick-directory", {}, { signal: controller.signal }));
					if (!controller.signal.aborted && !this.unmounted && this.state.modal === "directory" && directory !== null) this.setState({ directoryDraft: directory });
				} catch (e) {
					if (!controller.signal.aborted && !this.unmounted && this.state.modal === "directory") this.setState({ directoryError: friendlyPickerError(e) });
				} finally {
					this.directoryPicking = null;
					if (!this.unmounted) this.setState({ directoryPickerOpen: false });
				}
			}
			async saveDirectory() {
				if (this.captureInflight) return;
				this.captureInflight = true;
				this.setState({
					captureBusy: true,
					directoryError: null
				});
				try {
					const capture = await api("/capture/directory", { directory: this.state.directoryDraft.trim() });
					this.setState({
						capture,
						modal: null,
						note: "统一保存目录已设置。"
					});
				} catch (e) {
					this.setState({ directoryError: e instanceof Error ? e.message : String(e) });
				} finally {
					this.captureInflight = false;
					this.setState({ captureBusy: false });
				}
			}
			async captureAction(action, body) {
				if (this.captureInflight) return false;
				this.captureInflight = true;
				this.setState({
					captureBusy: true,
					error: null,
					note: null
				});
				let settle;
				this.captureSettled = new Promise((resolve) => {
					settle = resolve;
				});
				try {
					const old = this.state.capture?.outputs.length ?? 0;
					const capture = await api("/capture/" + action, body);
					const out = capture.outputs.at(-1);
					this.setState({
						capture,
						note: capture.outputs.length > old && out && !out.error ? "已保存：" + out.files.join("\n") : null,
						error: capture.outputs.length > old && out?.error ? "采集异常：" + out.error + String.fromCharCode(10) + "已保留有效文件：" + out.files.join(String.fromCharCode(10)) : null
					});
					if (action === "screenshot") {
						this.screenRef?.classList.remove("flash");
						this.screenRef?.offsetWidth;
						this.screenRef?.classList.add("flash");
					}
					return true;
				} catch (e) {
					this.setState({ error: e instanceof Error ? e.message : String(e) });
					try {
						this.setState({ capture: await api("/capture") });
					} catch {}
					return false;
				} finally {
					this.captureInflight = false;
					this.captureSettled = null;
					settle();
					if (!this.unmounted) this.setState({ captureBusy: false });
				}
			}
			toggleCapture(type) {
				const job = this.state.capture?.[type];
				if (job) {
					this.captureAction(type, {
						serial: job.serial,
						action: "stop"
					});
					return;
				}
				const serial = this.state.serial;
				if (!serial) return;
				const start = () => {
					this.captureAction(type, {
						serial,
						action: "start"
					});
				};
				if (type === "debug" && this.state.secure?.secure) this.confirmAction("受保护页面", "调试仍可抓日志，但视频中的受保护区域可能为黑屏。确认继续？", "继续调试", start);
				else start();
			}
			async previewOutput(output) {
				this.setState({
					modal: "preview",
					preview: output,
					previewText: ""
				});
				try {
					const files = await Promise.all(output.files.map(async (file, index) => {
						if (!/\.(log|json)$/i.test(file)) return "";
						const response = await fetch(this.fileUrl(output, index));
						if (!response.ok) throw new Error("预览读取失败 HTTP " + response.status);
						const reader = response.body?.getReader();
						if (!reader) throw new Error("预览响应为空");
						let bytes = 0, text = "";
						const decoder = new TextDecoder();
						try {
							while (bytes < 131072) {
								const r = await reader.read();
								if (r.done) break;
								const chunk = r.value.subarray(0, 131072 - bytes);
								bytes += chunk.length;
								text += decoder.decode(chunk, { stream: true });
							}
						} finally {
							await reader.cancel();
						}
						return file + "\n" + text + "\n";
					}));
					if (this.state.preview?.id === output.id) this.setState({ previewText: files.join("\n") });
				} catch (e) {
					if (this.state.preview?.id === output.id) this.setState({ previewText: "预览失败：" + String(e) });
				}
			}
			fileUrl(output, index) {
				return "/_dsh/dsh-android-pane/capture/file?id=" + encodeURIComponent(output.id) + "&index=" + index;
			}
			async setQuality(maxSize, maxFps) {
				try {
					await api("/quality", {
						maxSize,
						maxFps
					});
					if (this.state.serial != null) {
						this.stopStream();
						await this.attach(this.state.serial);
					}
				} catch (e) {
					this.setState({ error: String(e instanceof Error ? e.message : e).slice(0, 200) });
				}
			}
			tapOutline(x, y) {
				this.act({
					action: "tap",
					x,
					y,
					coordinateSpace: "physical"
				});
			}
			/** B22f：采样当前显示元素（canvas/img）的亮度与方差，判定 FLAG_SECURE 页面是否实际可见。
			*  黑帧：mean≈0 且 std≈0；内容帧：mean 或 std 显著非零。连续 2 次可见才判定（防单帧抖动）。 */
			sampleSecVisibility() {
				if (this.state.secure?.secure !== true || this.state.serial == null || document.hidden) {
					if (this.state.secCanvasVisible) this.setState({ secCanvasVisible: false });
					this.secVisStreak = 0;
					return;
				}
				const cv = this.canvasRef;
				const img = this.imgRef;
				const el = cv && cv.width > 0 ? cv : img && img.naturalWidth > 0 ? img : null;
				let mean = 0;
				let std = 0;
				if (el != null) try {
					const t = document.createElement("canvas");
					t.width = 24;
					t.height = 48;
					const g = t.getContext("2d");
					if (g != null) {
						g.drawImage(el, 0, 0, 24, 48);
						const d = g.getImageData(0, 0, 24, 48).data;
						const vals = [];
						for (let i = 0; i < d.length; i += 4) vals.push((d[i] + d[i + 1] + d[i + 2]) / 3);
						mean = vals.reduce((a, b) => a + b, 0) / vals.length;
						std = Math.sqrt(vals.reduce((a, b) => a + (b - mean) * (b - mean), 0) / vals.length);
					}
				} catch {}
				const visible = mean > 25 || std > 12;
				this.secVisStreak = visible ? this.secVisStreak + 1 : 0;
				const next = this.secVisStreak >= 2;
				if (next !== this.state.secCanvasVisible) this.setState({ secCanvasVisible: next });
			}
			async fetchOutline() {
				if (this.state.serial == null) return;
				try {
					const r = await api("/secure/outline", { serial: this.state.serial });
					this.setState({
						outline: r.nodes,
						secView: "outline"
					});
				} catch (e) {
					this.setState({ error: String(e instanceof Error ? e.message : e).slice(0, 220) });
					setTimeout(() => this.setState({ error: null }), 4e3);
				}
			}
			renderDialog() {
				const { modal, capture, captureBusy, directoryDraft, directoryError, preview, previewText, quality } = this.state;
				if (!modal) return null;
				const close = () => {
					this.directoryPicking?.abort();
					this.confirmCallback = null;
					this.setState({ modal: null });
				};
				const title = modal === "directory" ? "统一保存目录" : modal === "settings" ? "面板设置" : modal === "outputs" ? "最近保存" : modal === "preview" ? "保存预览" : this.state.confirmTitle;
				const locked = this.state.directoryPickerOpen || captureBusy || capture?.record?.status === "recording" || capture?.debug?.status === "recording";
				let body;
				if (modal === "directory") body = (0, react.createElement)("form", { onSubmit: (e) => {
					e.preventDefault();
					if (!locked) this.saveDirectory();
				} }, (0, react.createElement)("label", { htmlFor: "dap-directory-input" }, "电脑目录"), (0, react.createElement)("div", { className: "dap-input-line" }, (0, react.createElement)("input", {
					id: "dap-directory-input",
					autoFocus: true,
					disabled: locked,
					value: directoryDraft,
					autoComplete: "off",
					spellCheck: false,
					onChange: (e) => this.setState({ directoryDraft: e.target.value })
				}), (0, react.createElement)("button", {
					className: "dap-quiet",
					type: "button",
					disabled: locked,
					onClick: () => void this.browseDirectory()
				}, "选择")), directoryError ? (0, react.createElement)("div", {
					className: "dap-field-error",
					role: "alert"
				}, directoryError) : null, locked ? (0, react.createElement)("p", { style: { marginTop: 16 } }, this.state.directoryPickerOpen ? "请在系统窗口选择目录。" : "采集中，目录不可修改。") : null, (0, react.createElement)("div", { className: "dap-dialog-actions" }, (0, react.createElement)("button", {
					type: "button",
					className: "dap-quiet",
					onClick: close
				}, "取消"), (0, react.createElement)("button", {
					type: "submit",
					className: "dap-primary",
					disabled: locked
				}, "保存设置")));
				else if (modal === "settings") body = (0, react.createElement)("div", null, (0, react.createElement)("div", { className: "dap-setting-row" }, (0, react.createElement)("span", null, "画面质量"), (0, react.createElement)("select", {
					"aria-label": "画面质量",
					value: quality.maxFps >= 60 ? "clear" : "smooth",
					disabled: locked || this.state.busy || this.state.claimSessionId != null,
					onChange: (e) => void this.setQuality(e.target.value === "clear" ? 1920 : 1280, e.target.value === "clear" ? 60 : 30)
				}, (0, react.createElement)("option", { value: "smooth" }, "流畅 · 30 fps"), (0, react.createElement)("option", { value: "clear" }, "清晰 · 60 fps"))), (0, react.createElement)("div", { className: "dap-setting-row" }, (0, react.createElement)("span", null, "保存目录"), (0, react.createElement)("button", {
					className: "dap-quiet",
					onClick: () => this.openDirectory()
				}, "修改目录")));
				else if (modal === "outputs") body = (0, react.createElement)("div", { className: "dap-output-list" }, capture?.outputs.length ? capture.outputs.slice().reverse().map((output) => (0, react.createElement)("article", {
					className: "dap-output",
					key: output.id
				}, (0, react.createElement)("div", { className: "dap-output-top" }, icon(output.type === "screenshot" ? "camera" : output.type === "record" ? "video" : "debug"), (0, react.createElement)("b", null, output.type === "screenshot" ? "截图" : output.type === "record" ? "录屏" : "调试记录"), (0, react.createElement)("time", null, new Date(output.at).toLocaleTimeString("zh-CN", {
					hour12: false,
					hour: "2-digit",
					minute: "2-digit"
				}))), (0, react.createElement)("div", { className: "dap-output-files dap-path" }, output.files.join("\n")), output.error ? (0, react.createElement)("div", { className: "dap-field-error" }, output.error) : null, (0, react.createElement)("button", {
					className: "dap-output-preview",
					onClick: () => void this.previewOutput(output)
				}, "查看" + (output.type === "screenshot" ? "截图" : output.type === "record" ? "视频" : "视频与日志")))) : (0, react.createElement)("p", null, "暂无文件"));
				else if (modal === "preview") body = (0, react.createElement)("div", null, preview?.files.map((file, index) => {
					const src = preview ? this.fileUrl(preview, index) : "";
					return /\.png$/i.test(file) ? (0, react.createElement)("img", {
						key: file,
						src,
						alt: "已保存的设备截图",
						className: "dap-preview-media"
					}) : /\.mp4$/i.test(file) ? (0, react.createElement)("video", {
						key: file,
						src,
						controls: true,
						preload: "metadata",
						className: "dap-preview-media",
						"aria-label": "已保存的设备录屏"
					}) : null;
				}), previewText ? (0, react.createElement)("pre", { className: "dap-log-preview" }, previewText) : null, (0, react.createElement)("div", { className: "dap-path" }, preview?.files.join("\n")), preview?.files.map((file, index) => (0, react.createElement)("a", {
					key: file,
					href: this.fileUrl(preview, index),
					download: file.split(/[\\/]/).at(-1),
					className: "dap-output-preview"
				}, "下载 " + file.split(/[\\/]/).at(-1))));
				else body = (0, react.createElement)("div", null, (0, react.createElement)("p", null, this.state.confirmText), (0, react.createElement)("div", { className: "dap-dialog-actions" }, (0, react.createElement)("button", {
					className: "dap-quiet",
					onClick: close
				}, "取消"), (0, react.createElement)("button", {
					className: "dap-primary",
					onClick: () => {
						const fn = this.confirmCallback;
						this.confirmCallback = null;
						this.setState({ modal: null }, () => {
							fn?.();
						});
					}
				}, this.state.confirmLabel)));
				return (0, react.createElement)("dialog", {
					key: modal,
					className: "dap-dialog",
					ref: (el) => {
						this.dialogRef = el;
					},
					"aria-labelledby": "dap-dialog-title",
					onCancel: (e) => {
						e.preventDefault();
						e.stopPropagation();
						close();
					},
					onKeyDown: (e) => {
						if (e.key === "Escape") e.stopPropagation();
					}
				}, (0, react.createElement)("div", { className: "dap-dialog-head" }, (0, react.createElement)("h3", { id: "dap-dialog-title" }, title), modal === "confirm" ? null : (0, react.createElement)("button", {
					className: "dap-icon",
					"aria-label": "关闭" + title,
					onClick: close
				}, icon("close"))), (0, react.createElement)("div", { className: "dap-dialog-body" }, body));
			}
			render() {
				if (!this.state.open) return (0, react.createElement)("div", { style: { display: "none" } });
				const { devices, serial, busy, mode, error, streamError, quality, form, claimSessionId, capture, captureBusy, textOpen, deviceText, note } = this.state;
				const online = devices.filter((d) => d.state === "device"), selected = online.find((d) => d.serial === serial);
				const connected = serial != null && selected != null && mode != null;
				const unavailable = !connected || busy || claimSessionId != null || captureBusy;
				const record = capture?.record, debug = capture?.debug, job = record ?? debug, active = job?.status === "recording";
				const protectedPage = this.state.secure?.secure && this.state.secure.captureVisible !== true && !this.state.secCanvasVisible;
				const elapsed = (j) => {
					if (!j) return "";
					const sec = Math.floor(((j.stoppedAt ?? Date.now()) - j.startedAt) / 1e3);
					return String(Math.floor(sec / 60)).padStart(2, "0") + ":" + String(sec % 60).padStart(2, "0");
				};
				const captureLabel = (type) => {
					const j = type === "record" ? record : debug;
					return j ? captureBusy ? "保存中…" : j.status === "pending-save" ? "重试保存" : "停止" : type === "record" ? "录屏" : "调试";
				};
				const captureButton = (type) => {
					const j = type === "record" ? record : debug;
					const disabled = captureBusy || !!(type === "record" ? debug : record) || !j && (unavailable || type === "record" && this.state.secure?.secure);
					return (0, react.createElement)("button", {
						className: "dap-capture-btn dap-" + type + (j?.status === "recording" ? " active" : ""),
						disabled,
						"aria-label": j?.status === "recording" ? "停止" + (type === "record" ? "录屏" : "调试") : captureLabel(type),
						"data-dap-capture": type,
						onClick: () => this.toggleCapture(type)
					}, icon(j ? "stop" : type === "record" ? "video" : "debug"), (0, react.createElement)("b", null, captureLabel(type)), (0, react.createElement)("small", null, elapsed(j)));
				};
				const nav = (name, label, fn) => (0, react.createElement)("button", {
					className: "dap-btn2",
					disabled: unavailable,
					title: label,
					"aria-label": label,
					onClick: fn
				}, icon(name));
				const errMsg = error ?? streamError ?? job?.error;
				return (0, react_dom.createPortal)((0, react.createElement)("div", {
					className: "dap-pane " + (form === "dock" ? "dap-dock" : "dap-overlay"),
					"data-dap-version": "0.2.0",
					role: "complementary",
					"aria-label": "Android 设备面板",
					style: form === "dock" && this.state.dockRight > 0 ? { right: this.state.dockRight + "px" } : void 0
				}, (0, react.createElement)("header", { className: "dap-head" }, (0, react.createElement)("select", {
					className: "dap-select",
					"aria-label": "选择设备",
					disabled: !!job || captureBusy,
					value: serial ?? "",
					onChange: (e) => {
						const next = e.target.value;
						if (next && next !== serial) {
							this.stopStream();
							this.setState({
								serial: next,
								mode: null,
								streamError: null,
								error: null,
								secure: null,
								secView: "stream",
								secSteps: null,
								outline: null,
								streamSize: null
							});
							this.attach(next);
						}
					}
				}, online.length ? online.map((d) => (0, react.createElement)("option", {
					key: d.serial,
					value: d.serial
				}, d.name ?? d.model ?? d.serial)) : (0, react.createElement)("option", { value: "" }, "无在线设备")), (0, react.createElement)("button", {
					className: "dap-icon",
					disabled: !!job || captureBusy || claimSessionId != null || busy,
					title: "重新连接设备",
					"aria-label": "重新连接设备",
					onClick: () => {
						if (serial) this.attach(serial);
						else this.poll();
					}
				}, icon("refresh")), (0, react.createElement)("button", {
					className: "dap-icon",
					title: "面板设置",
					"aria-label": "面板设置",
					onClick: () => this.setState({ modal: "settings" })
				}, icon("settings")), (0, react.createElement)("button", {
					className: "dap-icon",
					title: form === "dock" ? "切换浮窗" : "恢复停靠",
					"aria-label": form === "dock" ? "切换浮窗" : "恢复停靠",
					onClick: () => this.toggleForm()
				}, icon("float")), (0, react.createElement)("button", {
					className: "dap-icon",
					title: "关闭面板",
					"aria-label": "关闭面板",
					onClick: () => this.setOpen(false)
				}, icon("close"))), (0, react.createElement)("section", { className: "dap-capture-zone" }, (0, react.createElement)("div", { className: "dap-directory-row" }, icon("folder"), (0, react.createElement)("div", {
					className: "dap-path",
					"data-dap-directory": true
				}, capture?.directory ?? "读取目录…"), (0, react.createElement)("button", {
					className: "dap-icon",
					title: "设置统一保存目录",
					"aria-label": "设置统一保存目录",
					onClick: () => this.openDirectory()
				}, icon("settings"))), (0, react.createElement)("div", { className: "dap-capture-buttons" }, (0, react.createElement)("button", {
					className: "dap-capture-btn dap-shot",
					disabled: unavailable || !capture || protectedPage,
					"data-dap-capture": "screenshot",
					onClick: () => {
						if (serial) this.captureAction("screenshot", { serial });
					}
				}, icon("camera"), (0, react.createElement)("b", null, "截图")), captureButton("record"), captureButton("debug"))), claimSessionId != null || busy ? (0, react.createElement)("div", { className: "dap-state-banner" }, icon("lock"), (0, react.createElement)("span", null, "智能体正在使用设备，操作已锁定。"), claimSessionId != null ? (0, react.createElement)("button", {
					className: "dap-quiet",
					onClick: () => this.confirmAction("接管设备", "接管会释放智能体的操作锁。原会话需要重新连接才能继续操作。", "释放锁并接管", () => this.forceRelease())
				}, "接管") : null) : null, (0, react.createElement)("div", {
					className: "dap-screen" + (active ? " capturing" : ""),
					ref: this.bindScreen,
					onPointerDown: this.onPointerDown,
					onPointerMove: this.onPointerMove,
					onPointerUp: this.onPointerUp,
					onPointerCancel: this.onPointerCancel,
					onLostPointerCapture: this.onPointerCancel
				}, this.state.secView === "outline" && this.state.outline != null ? (0, react.createElement)("div", { className: "dap-outline" }, (0, react.createElement)("div", { className: "dap-outline-hd" }, (0, react.createElement)("span", null, "受保护页面 · 控件树"), (0, react.createElement)("button", {
					className: "dap-quiet",
					onClick: () => this.setState({ secView: "stream" })
				}, "切回画面"), (0, react.createElement)("button", {
					className: "dap-quiet",
					disabled: unavailable,
					onClick: () => void this.fetchOutline()
				}, "刷新")), (0, react.createElement)("div", { className: "dap-outline-list" }, this.state.outline.length ? this.state.outline.map((node, index) => (0, react.createElement)("button", {
					key: index,
					className: "dap-outline-item",
					disabled: unavailable || !node.clickable,
					style: { paddingLeft: 6 + Math.min(node.depth, 10) * 12 },
					onClick: () => this.tapOutline(node.center[0], node.center[1])
				}, (0, react.createElement)("span", { className: "dap-ot" }, node.text || node.desc), (0, react.createElement)("span", { className: "dap-oc" }, node.cls.split(".").at(-1)))) : (0, react.createElement)("p", null, "无可见文本节点"))) : protectedPage ? (0, react.createElement)("div", { className: "dap-state" }, icon("lock"), (0, react.createElement)("h3", { className: "dap-state-txt" }, "应用保护了此页面"), (0, react.createElement)("p", { className: "dap-state-sub" }, "系统禁止截屏和录屏。可查看控件树继续操作，不自动获取 root 权限。"), (0, react.createElement)("button", {
					className: "dap-quiet",
					disabled: unavailable,
					onClick: () => void this.fetchOutline()
				}, "查看控件树")) : connected && mode === "poll" ? (0, react.createElement)("img", {
					ref: (el) => {
						this.imgRef = el;
						this.canvasRef = null;
					},
					src: "/_dsh/dsh-android-pane/frame?serial=" + encodeURIComponent(serial) + "&t=" + Date.now(),
					onLoad: () => this.fitScreen(),
					draggable: false,
					alt: "设备画面"
				}) : connected && mode === "h264" ? (0, react.createElement)("canvas", {
					width: this.state.streamSize?.w,
					height: this.state.streamSize?.h,
					ref: (el) => {
						this.canvasRef = el;
						this.imgRef = null;
					},
					style: {
						touchAction: "none",
						cursor: unavailable ? "not-allowed" : "grab"
					},
					"aria-label": "设备画面，可点击和拖动"
				}) : (0, react.createElement)("div", { className: "dap-state" }, icon("refresh"), (0, react.createElement)("h3", { className: "dap-state-txt" }, serial && selected ? "连接中…" : "设备已断开"), (0, react.createElement)("p", { className: "dap-state-sub" }, "连接 USB 设备并允许调试，或启动 Android 模拟器。"), (0, react.createElement)("button", {
					className: "dap-primary",
					disabled: claimSessionId != null || busy || captureBusy,
					onClick: () => {
						if (serial) this.attach(serial);
						else this.poll();
					}
				}, "重新连接"))), (0, react.createElement)("nav", {
					className: "dap-navigation",
					"aria-label": "设备操作"
				}, (0, react.createElement)("div", { className: "dap-nav-group" }, nav("back", "返回", () => {
					if (this.state.secView === "outline") this.setState({ secView: "stream" });
					else this.act({
						action: "key",
						key: "back"
					});
				}), nav("home", "主屏幕", () => void this.act({
					action: "key",
					key: "home"
				})), nav("recents", "最近任务", () => void this.act({
					action: "key",
					key: "recents"
				})), (0, react.createElement)("button", {
					className: "dap-btn2",
					disabled: unavailable,
					title: "输入文字",
					"aria-label": "输入文字",
					"aria-expanded": textOpen,
					onClick: () => this.setState({ textOpen: !textOpen })
				}, icon("keyboard"))), (0, react.createElement)("button", {
					className: "dap-btn2 dap-mute",
					disabled: unavailable,
					"aria-pressed": !!(serial && capture?.muted[serial]),
					title: serial && capture?.muted[serial] ? "恢复此前的设备媒体音量" : "设备媒体静音，不影响来电和闹钟",
					onClick: () => {
						if (serial) this.captureAction("mute", { serial });
					}
				}, icon(serial && capture?.muted[serial] ? "volume" : "mute"), (0, react.createElement)("span", null, serial && capture?.muted[serial] ? "已静音" : "静音")), (0, react.createElement)("button", {
					className: "dap-btn2",
					title: "最近保存",
					"aria-label": "最近保存",
					"aria-expanded": this.state.modal === "outputs",
					onClick: () => this.setState({ modal: "outputs" })
				}, icon("folder"), capture?.outputs.length ? (0, react.createElement)("span", null, capture.outputs.length) : null)), textOpen ? (0, react.createElement)("form", {
					className: "dap-text-entry",
					onSubmit: (e) => {
						e.preventDefault();
						if (!unavailable && deviceText.trim()) this.act({
							action: "text",
							text: deviceText
						});
					}
				}, (0, react.createElement)("input", {
					"aria-label": "发送到设备的文字",
					placeholder: "输入要发送到设备的文字",
					maxLength: 4e3,
					value: deviceText,
					autoFocus: true,
					disabled: unavailable,
					onChange: (e) => this.setState({ deviceText: e.target.value })
				}), (0, react.createElement)("button", {
					type: "submit",
					className: "dap-quiet",
					disabled: unavailable || !deviceText.trim()
				}, "发送")) : null, errMsg || note ? (0, react.createElement)("div", {
					className: "dap-toast" + (errMsg ? " error" : ""),
					role: errMsg ? "alert" : "status"
				}, icon(errMsg ? "alert" : "check"), (0, react.createElement)("p", null, errMsg ?? note), (0, react.createElement)("button", {
					className: "dap-icon",
					"aria-label": "关闭提示",
					onClick: () => this.setState({
						error: null,
						streamError: null,
						note: null
					})
				}, icon("close"))) : null, this.renderDialog()), document.body);
			}
		};
		/** 头部入口按钮：渐变胶囊 + 光泽扫过 + 按压缩放 + 设备呼吸灯 + 面板开启高亮态。 */
		function PaneSidebarButton() {
			const [open, setOpen] = (0, react.useState)(false);
			const [online, setOnline] = (0, react.useState)(0);
			(0, react.useEffect)(() => {
				const onState = (e) => {
					const d = e.detail;
					if (d == null) return;
					setOpen(!!d.open);
					setOnline(d.online ?? 0);
				};
				window.addEventListener("dsh-android-pane:state", onState);
				return () => window.removeEventListener("dsh-android-pane:state", onState);
			}, []);
			(0, react.useEffect)(() => {
				let tries = 0;
				let raf = 0;
				const verify = () => {
					const el = document.querySelector(".dap-btn");
					if (el == null) return;
					if (getComputedStyle(el).borderRadius === "999px") return;
					if (++tries > 3) {
						console.warn(`[${NS}] header button CSS not applying after ${tries - 1} forced remounts (expect ${CSS_VERSION})`);
						return;
					}
					forceRemountStyle(BTN_STYLE_ID, BTN_CSS);
					raf = requestAnimationFrame(verify);
				};
				raf = requestAnimationFrame(verify);
				return () => cancelAnimationFrame(raf);
			}, []);
			return (0, react.createElement)("button", {
				className: `dap-btn${open ? " dap-open" : ""}`,
				onClick: () => window.dispatchEvent(new CustomEvent("dsh-android-pane:toggle")),
				title: "Android 设备画面面板（点击开/关）",
				"aria-pressed": open ? "true" : "false"
			}, (0, react.createElement)("span", {
				className: "dap-ico",
				"aria-hidden": "true"
			}, (0, react.createElement)("svg", {
				viewBox: "0 0 24 24",
				fill: "none"
			}, (0, react.createElement)("defs", null, (0, react.createElement)("linearGradient", {
				id: "dap-grad",
				x1: "0",
				y1: "0",
				x2: "1",
				y2: "1"
			}, (0, react.createElement)("stop", {
				offset: "0",
				"stop-color": "#3ddc84"
			}), (0, react.createElement)("stop", {
				offset: "1",
				"stop-color": "#38bdf8"
			}))), (0, react.createElement)("path", {
				d: "M7.4 4.4 9.1 6.5 M16.6 4.4 14.9 6.5",
				stroke: "#3ddc84",
				"stroke-width": "1.5",
				"stroke-linecap": "round"
			}), (0, react.createElement)("path", {
				d: "M4.6 15.2 a7.4 7.4 0 0 1 14.8 0 Z",
				fill: "url(#dap-grad)"
			}), (0, react.createElement)("circle", {
				cx: "9.3",
				cy: "12.1",
				r: "0.95",
				fill: "#0d1420"
			}), (0, react.createElement)("circle", {
				cx: "14.7",
				cy: "12.1",
				r: "0.95",
				fill: "#0d1420"
			}), (0, react.createElement)("path", {
				className: "dap-wave w1",
				d: "M14.6 17.4 a4.6 4.6 0 0 1 4.6 4.6",
				stroke: "#38bdf8",
				"stroke-width": "1.6",
				"stroke-linecap": "round"
			}), (0, react.createElement)("path", {
				className: "dap-wave w2",
				d: "M14.6 19.8 a2.2 2.2 0 0 1 2.2 2.2",
				stroke: "#38bdf8",
				"stroke-width": "1.6",
				"stroke-linecap": "round"
			}), (0, react.createElement)("circle", {
				className: "dap-wave w3",
				cx: "21",
				cy: "22",
				r: "1.05",
				fill: "#38bdf8"
			}))), (0, react.createElement)("span", { className: "dap-label" }, "Android 面板"), online > 0 ? (0, react.createElement)("span", {
				className: "dap-dot",
				title: `${online} 台设备在线`
			}) : (0, react.createElement)("span", { className: "dap-dot off" }), (0, react.createElement)("span", {
				className: "dap-shine",
				"aria-hidden": "true"
			}));
		}
		const inject = ["slots"];
		function apply(ctx) {
			upsertStyle(BTN_STYLE_ID, BTN_CSS);
			upsertStyle(PANE_STYLE_ID, PANE_CSS);
			hostPickDirectory = async () => {
				const bridge = globalThis.__DSH_DIRECTORY_PICKER__;
				if (bridge != null && typeof bridge.pick === "function") return {
					handled: true,
					directory: await bridge.pick()
				};
				let ui;
				try {
					ui = ctx.uiWorkspace;
				} catch {
					ui = void 0;
				}
				if (ui?.pickDirectory == null) try {
					ui = ctx.get?.("uiWorkspace");
				} catch {
					ui = void 0;
				}
				if (ui?.pickDirectory != null) return {
					handled: true,
					directory: await ui.pickDirectory()
				};
				return { handled: false };
			};
			ctx.effect(() => {
				const heal = () => {
					let healed = false;
					if (!styleHealthy(BTN_STYLE_ID, BTN_CSS)) {
						upsertStyle(BTN_STYLE_ID, BTN_CSS);
						healed = true;
					}
					if (!styleHealthy(PANE_STYLE_ID, PANE_CSS)) {
						upsertStyle(PANE_STYLE_ID, PANE_CSS);
						healed = true;
					}
					if (healed) console.warn(`[${NS}] style tags removed/tampered externally — re-mounted (CSS ${CSS_VERSION})`);
				};
				const observer = new MutationObserver(heal);
				observer.observe(document.head, {
					childList: true,
					subtree: true
				});
				const timer = window.setInterval(heal, 5e3);
				return () => {
					window.clearInterval(timer);
					observer.disconnect();
					document.getElementById(BTN_STYLE_ID)?.remove();
					document.getElementById(PANE_STYLE_ID)?.remove();
				};
			}, `${NS}: css lifecycle（B24 标签托管 + 摘除自愈 + 5s 巡检）`);
			ctx.effect(() => ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: `${NS}:pane`,
				order: 90
			}, PaneWindow)), `${NS}: overlay/dock pane`);
			ctx.effect(() => ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
				name: "conversation.session.header.utilities",
				id: `${NS}:entry`,
				order: -1
			}, PaneSidebarButton)), `${NS}: header utilities entry（order 梯队升序勿撞值：billing -2 → 本插件 -1 → plan-board -0.5 → SLog 0 → delete 1；同值会退化成「谁最后 reload 谁靠右」乒乓换位）`);
		}
		//#endregion
		exports.PaneSidebarButton = PaneSidebarButton;
		exports.PaneWindow = PaneWindow;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map
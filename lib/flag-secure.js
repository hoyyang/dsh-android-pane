/**
 * FLAG_SECURE 识别与缓解（B22 增量）：
 *  - parseWindowDump：dumpsys window windows → 焦点窗口 + SECURE 位（权威数据源，真机 Android 17/HyperOS 实测格式）。
 *  - 缓解链步骤构造：纯函数，ADB 交互留在 PaneHub（可单测、可移除，lifecycle-hygiene）。
 * 无 root 事实（实测）：user 构建 adb root 不可用；像素被 SurfaceFlinger 层拦截（流/screencap 全黑）；
 * uiautomator 无障碍通道不受 FLAG_SECURE 影响 → 降级内容通道的理论依据。
 */
/** WindowManager.LayoutParams.FLAG_SECURE = 0x2000（frameworks/base/core/java/android/view/WindowManager.LayoutParams） */
export const FLAG_SECURE_BIT = 0x2000;
/** 解析 dumpsys window windows 全量输出。 */
export function parseWindowDump(dump) {
    let focusHash = null;
    // dumpsys window 有多个 section（先 null 后真实值，实测）——取第一个非 null
    const focusRe = /mCurrentFocus=Window\{([0-9a-fA-F]+) u0 ([^}]*)\}/g;
    for (const m of dump.matchAll(focusRe)) {
        focusHash = m[1];
        break;
    }
    const windows = [];
    let cur = null;
    for (const raw of dump.split('\n')) {
        const line = raw.replace(/\s+$/, '');
        const head = /Window #\d+ Window\{([0-9a-fA-F]+) u0 ([^}]*)\}:/.exec(line);
        if (head != null) {
            const title = head[2].trim();
            const slash = title.split('/')[0] ?? '';
            cur = {
                hash: head[1],
                title,
                pkg: /^[\w.$]+$/.test(slash) ? slash : null,
                secure: false,
                source: 'none',
            };
            windows.push(cur);
            continue;
        }
        if (cur == null)
            continue;
        // 现代 Android：fl=SYM1 SYM2 …（符号词元）；SECURE 为独立词元（LAYOUT_IN_SCREEN 等不含 SECURE 子串冲突）
        if (cur.source !== 'fl-token' && /\bfl=/.test(line)) {
            if (/\bSECURE\b/.test(line)) {
                cur.secure = true;
                cur.source = 'fl-token';
            }
            else if (cur.source === 'none') {
                cur.secure = false;
            }
            continue;
        }
        // 旧格式兜底：mFlags=0x…（bit 0x2000 = FLAG_SECURE）
        if (cur.source === 'none') {
            const mf = /\bmFlags=(0x[0-9a-fA-F]+)/.exec(line);
            if (mf != null) {
                const v = Number.parseInt(mf[1], 16);
                if (Number.isFinite(v) && (v & FLAG_SECURE_BIT) !== 0) {
                    cur.secure = true;
                    cur.source = 'mflags-bit';
                }
            }
        }
    }
    return { focusHash, windows };
}
/** 从全量 dump 提取「焦点窗口是否 FLAG_SECURE」。焦点窗缺 fl= 时回退：同包名任一窗口带 SECURE。 */
export function extractSecureState(dump) {
    const { focusHash, windows } = parseWindowDump(dump);
    const now = Date.now();
    if (focusHash == null) {
        // 锁屏/过渡态：mCurrentFocus=null → 按不安全处理（无内容可判）
        return { secure: false, pkg: null, activity: null, focusTitle: null, source: 'none', checkedAt: now };
    }
    const focus = windows.find((w) => w.hash === focusHash);
    if (focus == null) {
        return { secure: false, pkg: null, activity: null, focusTitle: null, source: 'none', checkedAt: now };
    }
    let secure = focus.secure;
    let source = focus.source;
    if (!secure) {
        // 焦点窗（如弹窗/子窗）无旗标时，主窗口可能带 SECURE——按包名回退
        const alt = windows.find((w) => w.pkg != null && w.pkg === focus.pkg && w.secure);
        if (alt != null) {
            secure = true;
            source = alt.source;
        }
    }
    const activity = focus.title.includes('/') ? focus.title.split('/').slice(1).join('/') || null : null;
    return { secure, pkg: focus.pkg, activity, focusTitle: focus.title, source, checkedAt: now };
}
export const HINT_DISABLE_FLAG_SECURE = '检测到 root 框架（Magisk/LSPosed）——像素级可见需安装并启用 DisableFlagSecure 模块' +
    '（Zygisk/LSPosed 模块，仓库: xposed-modules-repo/com.varuns2002.disable_flag_secure）。' +
    '模块按窗口层剥离 FLAG_SECURE；启用后需重启目标应用再点「尝试显示」复验。本插件绝不代装模块。';
//# sourceMappingURL=flag-secure.js.map
/**
 * FLAG_SECURE 识别与缓解（B22 增量）：
 *  - parseWindowDump：dumpsys window windows → 焦点窗口 + SECURE 位（权威数据源，真机 Android 17/HyperOS 实测格式）。
 *  - 缓解链步骤构造：纯函数，ADB 交互留在 PaneHub（可单测、可移除，lifecycle-hygiene）。
 * 无 root 事实（实测）：user 构建 adb root 不可用；像素被 SurfaceFlinger 层拦截（流/screencap 全黑）；
 * uiautomator 无障碍通道不受 FLAG_SECURE 影响 → 降级内容通道的理论依据。
 */
export interface SecureFocus {
    secure: boolean;
    pkg: string | null;
    activity: string | null;
    focusTitle: string | null;
    source: 'fl-token' | 'mflags-bit' | 'none';
    checkedAt: number;
    /** B22f：episode 内一次实证——本机截图通道能否看到此页面（可见则面板不提示黑屏横幅） */
    captureVisible?: boolean;
}
/** WindowManager.LayoutParams.FLAG_SECURE = 0x2000（frameworks/base/core/java/android/view/WindowManager.LayoutParams） */
export declare const FLAG_SECURE_BIT = 8192;
interface WinBlock {
    hash: string;
    title: string;
    pkg: string | null;
    secure: boolean;
    source: SecureFocus['source'];
}
/** 解析 dumpsys window windows 全量输出。 */
export declare function parseWindowDump(dump: string): {
    focusHash: string | null;
    windows: WinBlock[];
};
/** 从全量 dump 提取「焦点窗口是否 FLAG_SECURE」。焦点窗缺 fl= 时回退：同包名任一窗口带 SECURE。 */
export declare function extractSecureState(dump: string): SecureFocus;
export type StepStatus = 'ok' | 'failed' | 'skipped' | 'hint';
export interface MitigateStep {
    step: string;
    status: StepStatus;
    detail: string;
}
export interface MitigateResult {
    serial: string;
    pixelPossible: boolean;
    steps: MitigateStep[];
    checkedAt: number;
}
export declare const HINT_DISABLE_FLAG_SECURE: string;
export {};

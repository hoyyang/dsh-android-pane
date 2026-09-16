import type { PaneHub } from './pane-service.js';
export interface ToolCtx {
    agent?: {
        id: string;
    };
    signal?: AbortSignal;
}
export declare const TOOL_NAMES: readonly ["android_pane_devices", "android_pane_attach", "android_pane_act", "android_pane_screen", "android_pane_uidump", "android_pane_record", "android_pane_ui", "android_pane_debug", "android_pane_detach"];
export declare function registerPaneTools(tools: {
    register(tool: unknown): void;
}, hub: PaneHub): void;

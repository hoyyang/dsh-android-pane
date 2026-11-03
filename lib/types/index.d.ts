import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "dsh-android-pane";
export interface Config {
    adbPath: string;
    idleDetachMinutes: number;
    maxPerSession: number;
    globalMax: number;
    autoBootEmulator: boolean;
    flagSecureCheck: boolean;
    stateDir: string;
}
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    adbPath: z<string, string, "defined">;
    idleDetachMinutes: z<number, number, "defined">;
    maxPerSession: z<number, number, "defined">;
    globalMax: z<number, number, "defined">;
    autoBootEmulator: z<boolean, boolean, "defined">;
    flagSecureCheck: z<boolean, boolean, "defined">;
    stateDir: z<string, string, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    adbPath: z<string, string, "defined">;
    idleDetachMinutes: z<number, number, "defined">;
    maxPerSession: z<number, number, "defined">;
    globalMax: z<number, number, "defined">;
    autoBootEmulator: z<boolean, boolean, "defined">;
    flagSecureCheck: z<boolean, boolean, "defined">;
    stateDir: z<string, string, "defined">;
}>>, "plain">;
type HostCtx = Context & {
    webServer?: {
        register(route: {
            kind: 'exact' | 'prefix';
            path: string;
            handler: (req: unknown, res: unknown) => void | Promise<void>;
        }): () => void;
        port?: number;
    };
    tools?: {
        register(tool: unknown): void;
    };
    logger?: {
        info(msg: string): void;
        warn(msg: string): void;
        error(msg: string): void;
    };
};
export declare function apply(ctx: HostCtx, config?: Partial<Config>): void;
export {};

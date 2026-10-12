import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export type SandboxState = 'enabled' | 'disabled';

export interface ProbeResult { code: number | null; stderr: string; timedOut: boolean }

export interface SandboxProbeDeps {
    platform: NodeJS.Platform;
    run(executable: string, args: string[], timeoutMs: number): Promise<ProbeResult>;
    /** Nội dung đã trim, null nếu không đọc được. */
    readSysctl(path: string): string | null;
    makeTempDir(parent: string): string;
    removeDir(dir: string): void;
}

export const PROBE_TIMEOUT_MS = 20000;
const STDERR_KEEP_CHARS = 4000;

/** Các sysctl cho biết user namespace không dùng được: [đường dẫn, giá trị chặn]. */
const BLOCKING_SYSCTLS: Array<[string, string]> = [
    ['/proc/sys/kernel/apparmor_restrict_unprivileged_userns', '1'],
    ['/proc/sys/kernel/unprivileged_userns_clone', '0'],
    ['/proc/sys/user/max_user_namespaces', '0'],
];

/** Chạy engine một lần (headless, không --no-sandbox) để biết sandbox có dùng được không. */
export async function probeSandbox(enginePath: string, deps: SandboxProbeDeps): Promise<SandboxState> {
    if (deps.platform !== 'linux') return 'enabled';
    let dir: string | undefined;
    try {
        dir = deps.makeTempDir(path.dirname(enginePath));
        const args = ['--headless=new', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${dir}`, '--dump-dom', 'about:blank'];
        const result = await deps.run(enginePath, args, PROBE_TIMEOUT_MS);
        if (result.code === 0) return 'enabled';
        if (/No usable sandbox/i.test(result.stderr)) return 'disabled';
    } catch {
        // Không kết luận được: dùng sysctl bên dưới.
    } finally {
        if (dir !== undefined) deps.removeDir(dir);
    }
    const blocked = BLOCKING_SYSCTLS.some(([file, value]) => deps.readSysctl(file) === value);
    return blocked ? 'disabled' : 'enabled';
}

/** Cache kết quả dò theo đường dẫn engine; các lời gọi đồng thời dùng chung một lần dò. */
export class SandboxSupport {
    private readonly cache = new Map<string, Promise<SandboxState>>();

    constructor(private readonly deps: SandboxProbeDeps) {}

    get(enginePath: string): Promise<SandboxState> {
        let pending = this.cache.get(enginePath);
        if (!pending) {
            pending = probeSandbox(enginePath, this.deps);
            const attempt = pending;
            this.cache.set(enginePath, attempt);
            // Không cache lời hứa bị từ chối.
            attempt.catch(() => {
                if (this.cache.get(enginePath) === attempt) this.cache.delete(enginePath);
            });
        }
        return pending;
    }

    recheck(enginePath: string): Promise<SandboxState> {
        this.cache.delete(enginePath);
        return this.get(enginePath);
    }
}

export function runProcess(executable: string, args: string[], timeoutMs: number): Promise<ProbeResult> {
    return new Promise((resolve, reject) => {
        // detached: engine chạy trong process group riêng để diệt cả tiến trình con khi timeout.
        const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
        let stderr = '';
        let settled = false;
        const settle = (action: () => void): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            action();
        };
        const timer = setTimeout(() => {
            settle(() => {
                try {
                    process.kill(-child.pid!, 'SIGKILL');
                } catch {
                    child.kill('SIGKILL');
                }
                child.stderr?.destroy();
                resolve({ code: null, stderr, timedOut: true });
            });
        }, timeoutMs);
        child.stderr?.on('data', (chunk: Buffer) => {
            stderr = (stderr + chunk.toString()).slice(-STDERR_KEEP_CHARS);
        });
        child.on('error', (error) => settle(() => reject(error)));
        child.on('close', (code) => settle(() => resolve({ code, stderr, timedOut: false })));
    });
}

const nodeDeps: SandboxProbeDeps = {
    platform: process.platform,
    run: runProcess,
    readSysctl: (file) => {
        try { return fs.readFileSync(file, 'utf8').trim(); } catch { return null; }
    },
    makeTempDir: (parent) => fs.mkdtempSync(path.join(parent, '.sandbox-probe-')),
    removeDir: (dir) => {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* bỏ qua */ }
    },
};

let singleton: SandboxSupport | null = null;

export function getSandboxSupport(): SandboxSupport {
    if (!singleton) singleton = new SandboxSupport(nodeDeps);
    return singleton;
}

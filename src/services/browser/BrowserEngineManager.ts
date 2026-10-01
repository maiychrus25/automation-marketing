import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import axios from 'axios';
import { BROWSER_ENGINE, BrowserEngineConfig, BrowserEnginePackage } from '../../configs/browserEngine.config';

export interface EngineProgress {
    received: number;
    total: number;
}

export interface EngineStatus {
    supported: boolean;
    installed: boolean;
    version: string;
}

export interface EngineDeps {
    download: (url: string, destination: string, onProgress?: (progress: EngineProgress) => void) => Promise<void>;
    extract: (archive: string, directory: string) => Promise<void>;
}

const MARKER_FILE = 'installed.json';
export const DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;
const SOCKET_TIMEOUT_GRACE_MS = 5_000;
const STDERR_TAIL_CHARS = 500;

export async function downloadFile(
    url: string,
    destination: string,
    onProgress?: (progress: EngineProgress) => void,
    idleTimeoutMs: number = DOWNLOAD_IDLE_TIMEOUT_MS,
): Promise<void> {
    // axios applies this as a socket idle timeout (connect/headers and body); the grace lets our idle timer report first.
    const response = await axios.get(url, { responseType: 'stream', maxRedirects: 5, timeout: idleTimeoutMs + SOCKET_TIMEOUT_GRACE_MS });
    const total = Number(response.headers['content-length']) || 0;
    const source: Readable = response.data;
    const file = fs.createWriteStream(destination);
    let received = 0;
    let timer: NodeJS.Timeout | undefined;
    const armIdleTimer = () => {
        clearTimeout(timer);
        timer = setTimeout(() => source.destroy(new Error('Tải nhân trình duyệt bị ngắt: không nhận được dữ liệu')), idleTimeoutMs);
    };
    source.on('data', (chunk: Buffer) => {
        received += chunk.length;
        onProgress?.({ received, total });
        armIdleTimer();
    });
    armIdleTimer();
    try {
        // pipeline rejects on error or premature close, and destroys both streams.
        await pipeline(source, file);
    } finally {
        clearTimeout(timer);
        source.destroy();
        file.destroy();
        // Wait until the file handle is released so the caller can delete the archive on Windows.
        if (!file.closed) await new Promise<void>((resolve) => file.once('close', () => resolve()));
    }
}

/** Windows ships bsdtar in System32; a Git-for-Windows GNU tar earlier on PATH cannot read .zip. */
function tarCommand(): string {
    return process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
}

/** `tar` reads .tar.xz on Linux and .zip on Windows 10+ (bsdtar), so no archive dependency is needed. */
function extractArchive(archive: string, directory: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(tarCommand(), ['-xf', archive, '-C', directory], { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-STDERR_TAIL_CHARS); });
        child.once('error', reject);
        child.once('close', (code) => {
            if (code === 0) return resolve();
            const detail = stderr.trim();
            reject(new Error(`Giải nén thất bại (tar exit ${code})${detail ? `: ${detail}` : ''}`));
        });
    });
}

function sha256File(file: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        fs.createReadStream(file)
            .once('error', reject)
            .on('data', (chunk) => hash.update(chunk))
            .once('end', () => resolve(hash.digest('hex')));
    });
}

/** Locates, downloads and verifies the pinned antidetect Chromium build under <baseDir>/<version>/. */
export class BrowserEngineManager {
    private installing: Promise<void> | null = null;

    constructor(
        private readonly baseDir: string,
        private readonly platform: NodeJS.Platform = process.platform,
        private readonly deps: EngineDeps = { download: downloadFile, extract: extractArchive },
        private readonly config: BrowserEngineConfig = BROWSER_ENGINE,
    ) {}

    private get enginePackage(): BrowserEnginePackage | undefined {
        return this.config.packages[this.platform];
    }

    private get versionDir(): string {
        return path.join(this.baseDir, this.config.version);
    }

    public getStatus(): EngineStatus {
        return {
            supported: !!this.enginePackage,
            installed: this.getExecutablePath() !== null,
            version: this.config.version,
        };
    }

    /** Absolute path of the browser executable, or null when the engine is not fully installed. */
    public getExecutablePath(): string | null {
        const enginePackage = this.enginePackage;
        if (!enginePackage) return null;
        const executable = path.join(this.versionDir, enginePackage.executable);
        if (!fs.existsSync(path.join(this.versionDir, MARKER_FILE)) || !fs.existsSync(executable)) return null;
        return executable;
    }

    /** Concurrent callers share one installation. */
    public install(onProgress?: (progress: EngineProgress) => void): Promise<void> {
        if (!this.installing) {
            this.installing = this.doInstall(onProgress).finally(() => { this.installing = null; });
        }
        return this.installing;
    }

    private async doInstall(onProgress?: (progress: EngineProgress) => void): Promise<void> {
        const enginePackage = this.enginePackage;
        if (!enginePackage) throw new Error('Hệ điều hành này chưa được hỗ trợ');
        if (this.getExecutablePath()) return;

        // Wipe leftovers of an interrupted download or extraction.
        fs.rmSync(this.versionDir, { recursive: true, force: true });
        fs.mkdirSync(this.versionDir, { recursive: true });
        const archive = path.join(this.versionDir, 'engine.download');
        try {
            await this.deps.download(enginePackage.url, archive, onProgress);
            const actual = await sha256File(archive);
            if (actual !== enginePackage.sha256) {
                throw new Error('Tệp tải về không khớp mã kiểm tra SHA-256, đã hủy cài đặt');
            }
            await this.deps.extract(archive, this.versionDir);
            const executable = path.join(this.versionDir, enginePackage.executable);
            if (!fs.existsSync(executable)) throw new Error('Không tìm thấy tệp chạy của trình duyệt sau khi giải nén');
            if (this.platform !== 'win32') fs.chmodSync(executable, 0o755);
            fs.writeFileSync(
                path.join(this.versionDir, MARKER_FILE),
                JSON.stringify({ version: this.config.version, installedAt: Date.now() }),
            );
        } finally {
            fs.rmSync(archive, { force: true });
        }
    }
}

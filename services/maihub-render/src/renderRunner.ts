import { ChildProcess, execFile, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

export interface RunRenderOptions {
  dir: string;
  outFile: string;
  fps: number;
  quality: 'standard' | 'high';
  /** Lệnh HyperFrames, vd ['hyperframes'] hoặc [node, fake.js] trong test. */
  command: string[];
  timeoutMs: number;
  killGraceMs?: number;
  signal?: AbortSignal;
  env?: Record<string, string>;
  onProgress?: (percent: number) => void;
}
export interface RenderOutcome { status: 'done' | 'failed' | 'timeout' | 'cancelled'; error?: string }

const PROGRESS_RE = /@hf-progress (\{.*?\})/g;
const ENV_FIXED = { HYPERFRAMES_NO_TELEMETRY: '1', DO_NOT_TRACK: '1', HYPERFRAMES_SKIP_SKILLS: '1' };

/**
 * Chạy `hyperframes render` trong tiến trình con. Không dùng `--quiet` vì cờ này tắt các dòng
 * `@hf-progress {"code":...,"pct":N}` mà CLI in ra stdout; phần trăm lấy từ `pct` của các dòng đó.
 * Quá hạn -> timeout; huỷ -> cancelled; cả hai gửi SIGTERM cho cả nhóm tiến trình rồi SIGKILL sau `killGraceMs`.
 */
export function runRender(opts: RunRenderOptions): Promise<RenderOutcome> {
  const [bin, ...prefix] = opts.command;
  const variablesFile = path.join(opts.dir, 'variables.json');
  const args = [...prefix, 'render', opts.dir, '-o', opts.outFile,
    ...(fs.existsSync(variablesFile) ? ['--variables-file', variablesFile] : []),
    '--fps', String(opts.fps), '--quality', opts.quality, '--workers', '2'];

  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(bin, args, { cwd: opts.dir, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...opts.env, ...ENV_FIXED } });
    } catch (e) {
      return resolve({ status: 'failed', error: (e as Error).message });
    }
    let stopReason: 'timeout' | 'cancelled' | undefined;
    let lastLine = '';
    // HyperFrames in lỗi thật ở dòng tiến độ "Failed: …"; dòng cuối thường chỉ là gợi ý chung ("Try --docker …").
    let failedLine = '';
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const signalGroup = (sig: NodeJS.Signals) => {
      try { process.kill(-child.pid!, sig); } catch { /* nhóm đã thoát */ }
    };
    const stop = (reason: 'timeout' | 'cancelled') => {
      if (stopReason || settled) return;
      stopReason = reason;
      signalGroup('SIGTERM');
      killTimer = setTimeout(() => signalGroup('SIGKILL'), opts.killGraceMs ?? 5000);
    };
    const finish = (outcome: RenderOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      signalGroup('SIGKILL'); // dọn Chrome còn sót
      resolve(outcome);
    };
    const timer = setTimeout(() => stop('timeout'), opts.timeoutMs);
    const onAbort = () => stop('cancelled');
    if (opts.signal?.aborted) onAbort(); else opts.signal?.addEventListener('abort', onAbort);

    let buffer = '';
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/[\r\n]+/);
      buffer = lines.pop() ?? '';
      for (const line of lines) handleLine(line);
    };
    const handleLine = (line: string) => {
      const text = line.trim();
      if (!text) return;
      for (const m of text.matchAll(PROGRESS_RE)) {
        try {
          const pct = JSON.parse(m[1]).pct;
          if (typeof pct === 'number' && Number.isFinite(pct)) opts.onProgress?.(Math.min(100, Math.max(0, pct)));
        } catch { /* dòng dở dang */ }
      }
      const failed = /^[\s█░▓▒]*\d+%\s+Failed:\s*(.+)$/.exec(text);
      if (failed) failedLine = failed[1].slice(0, 300);
      if (!text.includes('@hf-progress') && !/^[\s█░▓▒]*\d+%/.test(text) && !/^Try --docker\b/.test(text)) lastLine = text.slice(0, 300);
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);
    child.on('error', (e) => finish({ status: 'failed', error: `Không chạy được HyperFrames: ${e.message}` }));
    child.on('close', (code) => {
      if (buffer) handleLine(buffer);
      if (stopReason) return finish({ status: stopReason, ...(stopReason === 'timeout' && { error: 'timeout' }) });
      if (code === 0) return finish({ status: 'done' });
      const reason = failedLine || lastLine;
      finish({ status: 'failed', error: `Render thất bại (mã ${code})${reason ? `: ${reason}` : ''}` });
    });
  });
}

export interface LintOptions { dir: string; command: string[]; env?: Record<string, string>; timeoutMs?: number }
const MAX_LINT_ERRORS = 3;

/**
 * `hyperframes lint <dir> --json` cho HTML tự viết. Có lỗi (severity "error") thì trả thông báo tiếng Việt kèm
 * tối đa 3 mã lỗi để bot sửa; không lỗi, hoặc lint không chạy được / đầu ra hỏng, thì trả null (không chặn render oan).
 */
export function lintHtml(opts: LintOptions): Promise<string | null> {
  const [bin, ...prefix] = opts.command;
  return new Promise((resolve) => {
    execFile(bin, [...prefix, 'lint', opts.dir, '--json'],
      { cwd: opts.dir, timeout: opts.timeoutMs ?? 60000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, ...opts.env, ...ENV_FIXED } },
      (_err, stdout) => {
        try {
          const report = JSON.parse(String(stdout));
          const errors = (Array.isArray(report?.findings) ? report.findings : [])
            .filter((f: any) => f && f.severity === 'error' && typeof f.code === 'string');
          if (errors.length === 0) return resolve(null);
          const list = errors.slice(0, MAX_LINT_ERRORS).map((f: any) => `${f.code} (${String(f.message ?? '').slice(0, 120)})`).join('; ');
          resolve(`HTML chưa đúng quy ước HyperFrames: ${list}. Xem phần video HTML trong maihub_guide.`);
        } catch {
          resolve(null);
        }
      });
  });
}

function run(cmd: string, args: string[], timeout = 60000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim().split('\n').pop()));
      else resolve(stdout);
    });
  });
}

export interface FinalizeOptions { videoFile: string; outDir: string; videoName?: string; thumbName?: string; ffmpegPath?: string; ffprobePath?: string }

/** Đọc thời lượng (ffprobe), tạo ảnh bìa ở khung giữa, rồi đặt video + ảnh bìa (mặc định video.mp4, thumb.jpg) vào `outDir` bằng tệp tạm + rename. */
export async function finalizeVideo(opts: FinalizeOptions): Promise<{ durationMs: number }> {
  const ffmpeg = opts.ffmpegPath ?? 'ffmpeg';
  const ffprobe = opts.ffprobePath ?? 'ffprobe';
  const seconds = Number((await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', opts.videoFile])).trim());
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('Video render ra không đọc được thời lượng');
  fs.mkdirSync(opts.outDir, { recursive: true });
  const videoName = opts.videoName ?? 'video.mp4';
  const thumbName = opts.thumbName ?? 'thumb.jpg';
  const thumbTmp = path.join(opts.outDir, `.${thumbName}.tmp`);
  const videoTmp = path.join(opts.outDir, `.${videoName}.tmp`);
  try {
    await run(ffmpeg, ['-y', '-v', 'error', '-ss', String(seconds / 2), '-i', opts.videoFile, '-frames:v', '1', '-q:v', '3', '-f', 'image2', thumbTmp]);
    fs.copyFileSync(opts.videoFile, videoTmp); // volume khác nhau: sao chép rồi rename
    fs.renameSync(videoTmp, path.join(opts.outDir, videoName));
    fs.renameSync(thumbTmp, path.join(opts.outDir, thumbName));
  } finally {
    fs.rmSync(thumbTmp, { force: true });
    fs.rmSync(videoTmp, { force: true });
  }
  return { durationMs: Math.round(seconds * 1000) };
}

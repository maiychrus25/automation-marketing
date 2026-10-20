import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { IncomingMessage, ServerResponse } from 'http';
import { pipeline } from 'stream';
import { LIMITS } from './limits';
import { Job, JobStore } from './jobStore';
import { verifyKey } from './keys';
import { ReceivedFile, UploadError, UploadLimits, receiveMultipart } from './multipart';
import { LimitError, Queue } from './queue';
import { NormalizedSpec, SpecError, validateJobSpec } from './spec';
import { TemplateDef, loadTemplates } from './templates';

const MAX_UPLOADS_PER_KEY = 2;
const MAX_UPLOADS_GLOBAL = 4;
/** Dưới mức trống này thì từ chối nhận việc mới (tránh đầy ổ làm hỏng mọi việc khác). */
const MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;

export interface MusicInfo { id: string; name: string; durationSec: number; license: string; source: string; file?: string }

/** Phần Orchestrator mà route cần (tránh phụ thuộc vòng với main-api). */
export interface JobCanceller { requestCancel(id: string): void }

export interface ApiDeps {
  keys: Map<string, string>;
  store: JobStore;
  queue: Queue;
  orchestrator: JobCanceller;
  templatesDir: string;
  music: MusicInfo[];
  /** Thư mục chứa tệp nhạc có sẵn (để nghe thử qua /v1/music/:id). */
  musicDir?: string;
  version: string;
  hyperframes: string;
  limits?: Partial<UploadLimits>;
  /** Số byte trống của ổ dữ liệu (thay được khi test). Mặc định đọc `fs.statfsSync` trên thư mục việc. */
  freeBytes?: () => number;
}

type ErrorStatus = 400 | 401 | 404 | 413 | 415 | 429 | 500 | 507;
const CODES = { 400: 'INVALID_SPEC', 401: 'UNAUTHORIZED', 404: 'NOT_FOUND', 413: 'TOO_LARGE', 415: 'UNSUPPORTED_FILE', 429: 'LIMIT_REACHED', 500: 'INTERNAL', 507: 'LIMIT_REACHED' } as const;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function sendError(res: ServerResponse, status: ErrorStatus, message: string, code: string = CODES[status]): void {
  sendJson(res, status, { error: { code, message } });
}

function jobView(job: Job, position: number | undefined): Record<string, unknown> {
  return {
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    ...(position !== undefined && { position }),
    ...(job.error !== undefined && { error: job.error }),
    ...(job.durationSec !== undefined && { durationSec: job.durationSec }),
    ...(job.sizeBytes !== undefined && { sizeBytes: job.sizeBytes }),
    createdAt: job.createdAt,
    ...(job.finishedAt !== undefined && { finishedAt: job.finishedAt }),
  };
}

/** Đặt tên chuẩn: mẫu -> imgN/audioN; HTML -> assetN. Trả bảng đổi tên (tên client -> tên mới). */
function renameFiles(dir: string, files: ReceivedFile[], spec: NormalizedSpec): Record<string, string> {
  const map: Record<string, string> = {};
  const counters: Record<string, number> = {};
  for (const f of files) {
    const prefix = spec.kind === 'html' ? 'asset' : f.kind === 'image' ? 'img' : f.kind === 'audio' ? 'audio' : 'asset';
    const n = (counters[prefix] = (counters[prefix] ?? 0) + 1);
    const name = `${prefix}${n}.${f.type}`;
    fs.renameSync(path.join(dir, f.stored), path.join(dir, name));
    map[f.original] = name;
  }
  return map;
}

function sendFile(req: IncomingMessage, res: ServerResponse, file: string, type: string): void {
  let size: number;
  try { size = fs.statSync(file).size; } catch { return sendError(res, 404, 'Tệp chưa sẵn sàng.'); }
  const unsatisfiable = (): void => {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` });
    res.end();
  };
  let start = 0;
  let end = size - 1;
  let status = 200;
  const range = req.headers.range;
  if (range?.startsWith('bytes=')) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m || (m[1] === '' && m[2] === '')) return unsatisfiable();
    if (m[1] === '') {
      const suffix = Number(m[2]);
      if (suffix === 0 || size === 0) return unsatisfiable();
      start = Math.max(0, size - suffix);
    } else {
      start = Number(m[1]);
      if (m[2] !== '') end = Math.min(end, Number(m[2]));
    }
    if (start >= size || start > end) return unsatisfiable();
    status = 206;
  }
  const headers: Record<string, string | number> = { 'Content-Type': type, 'Content-Length': size === 0 ? 0 : end - start + 1, 'Accept-Ranges': 'bytes' };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  res.writeHead(status, headers);
  if (size === 0) return void res.end();
  // pipeline huỷ luồng đọc (đóng fd) khi client ngắt giữa chừng
  pipeline(fs.createReadStream(file, { start, end }), res, () => undefined);
}

export function createRouter(deps: ApiDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { store, queue } = deps;
  const limits: UploadLimits = { ...LIMITS, ...deps.limits };
  const templates: TemplateDef[] = fs.existsSync(deps.templatesDir) ? loadTemplates(deps.templatesDir) : [];
  const musicIds = deps.music.map((m) => m.id);
  const freeBytes = deps.freeBytes ?? ((): number => {
    try {
      const st = fs.statfsSync(store.rootDir());
      return st.bavail * st.bsize;
    } catch {
      return Infinity; // không đọc được thì không chặn
    }
  });

  // Số lần tải lên đang diễn ra: tối đa MAX_UPLOADS_PER_KEY mỗi khoá và MAX_UPLOADS_GLOBAL toàn máy.
  const uploads = new Map<string, number>();
  let uploadsTotal = 0;

  async function createJob(req: IncomingMessage, res: ServerResponse, owner: string): Promise<void> {
    const type = req.headers['content-type'] ?? '';
    if (!/^multipart\/form-data/i.test(type)) return sendError(res, 400, 'Yêu cầu phải là multipart/form-data.');
    if (Number(req.headers['content-length'] ?? 0) > limits.maxTotalBytes + 1024 * 1024) {
      return rejectEarly(req, res, 'Yêu cầu quá lớn.');
    }
    if (freeBytes() < MIN_FREE_BYTES) return rejectEarly(req, res, 'Máy chủ render sắp hết dung lượng', 507);
    // kiểm giới hạn TRƯỚC khi đọc thân yêu cầu
    try {
      queue.checkLimits(owner);
    } catch (e) {
      if (e instanceof LimitError) return rejectEarly(req, res, e.message, 429);
      throw e;
    }
    if ((uploads.get(owner) ?? 0) >= MAX_UPLOADS_PER_KEY || uploadsTotal >= MAX_UPLOADS_GLOBAL) {
      return rejectEarly(req, res, 'Đang có quá nhiều lượt tải lên, vui lòng thử lại sau.', 429);
    }
    uploads.set(owner, (uploads.get(owner) ?? 0) + 1);
    uploadsTotal++;
    try {
      await receiveAndCreate(req, res, owner);
    } finally {
      const left = (uploads.get(owner) ?? 1) - 1;
      if (left > 0) uploads.set(owner, left); else uploads.delete(owner);
      uploadsTotal--;
    }
  }

  async function receiveAndCreate(req: IncomingMessage, res: ServerResponse, owner: string): Promise<void> {
    const id = randomUUID();
    const jobDir = store.jobDir(id);
    const inputDir = path.join(jobDir, 'input');
    fs.mkdirSync(inputDir, { recursive: true });
    try {
      const received = await receiveMultipart(req, inputDir, limits);
      let raw: unknown;
      try { raw = JSON.parse(received.spec ?? ''); } catch { throw new SpecError('Trường spec thiếu hoặc không phải JSON hợp lệ.'); }
      const names = received.files.map((f) => f.original);
      if (new Set(names).size !== names.length) throw new SpecError('Có hai tệp trùng tên.');
      const spec = validateJobSpec(raw, templates, received.files.map((f) => ({ name: f.original, kind: f.kind, size: f.size })), musicIds);
      const renamed = renameFiles(inputDir, received.files, spec);
      if (spec.kind === 'template') {
        spec.images = spec.images.map((n) => renamed[n]);
        if (spec.musicFile) spec.musicFile = renamed[spec.musicFile];
      }
      const job: Job = { id, owner, status: 'queued', progress: 0, spec, createdAt: Date.now() };
      store.create(job);
      queue.enqueue(job);
      sendJson(res, 201, { jobId: id, status: 'queued', position: queue.positionOf(id), files: renamed });
    } catch (e) {
      fs.rmSync(jobDir, { recursive: true, force: true });
      if (e instanceof UploadError) return rejectEarly(req, res, e.message, e.status, e.code);
      if (e instanceof SpecError) return sendError(res, 400, e.message);
      if (e instanceof LimitError) return sendError(res, 429, e.message);
      throw e;
    }
  }

  /** Báo lỗi khi phần thân chưa nhận hết: đóng kết nối sau khi trả lời để ngừng nhận. */
  function rejectEarly(req: IncomingMessage, res: ServerResponse, message: string, status: 400 | 413 | 415 | 429 | 500 | 507 = 413, code?: string): void {
    res.setHeader('Connection', 'close');
    sendError(res, status, message, code);
    req.resume();
    setTimeout(() => req.destroy(), 2000).unref();
  }

  function ownedJob(id: string, owner: string): Job | undefined {
    const job = store.get(id);
    return job && job.owner === owner ? job : undefined;
  }

  function cancelJob(res: ServerResponse, job: Job): void {
    const outcome = queue.cancel(job.id);
    if (outcome === 'removed') return sendJson(res, 200, { jobId: job.id, status: 'cancelled' });
    if (outcome === 'running') {
      deps.orchestrator.requestCancel(job.id);
      return sendJson(res, 202, { jobId: job.id, status: 'rendering' });
    }
    store.remove(job.id); // đã kết thúc: xoá hẳn việc và tệp
    sendJson(res, 200, { jobId: job.id, status: job.status, deleted: true });
  }

  return async (req, res) => {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = url.pathname;

    if (method === 'GET' && p === '/v1/health') {
      return sendJson(res, 200, { ok: true, version: deps.version, hyperframes: deps.hyperframes, queue: { length: queue.length } });
    }
    if (!p.startsWith('/v1/')) return sendError(res, 404, 'Không tìm thấy.');

    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    const owner = m ? verifyKey(m[1], deps.keys) : null;
    if (!owner) return sendError(res, 401, 'Thiếu hoặc sai khoá API.');

    if (method === 'GET' && p === '/v1/templates') return sendJson(res, 200, { templates, music: deps.music });
    const mm = method === 'GET' ? /^\/v1\/music\/([^/]+)$/.exec(p) : null;
    if (mm) {
      let id: string;
      try { id = decodeURIComponent(mm[1]); } catch { return sendError(res, 404, 'Không tìm thấy nhạc.'); }
      // chỉ nhận mã có trong manifest; tên tệp lấy từ manifest và phải là tên trơn
      const track = deps.music.find((t) => t.id === id);
      if (!track?.file || !deps.musicDir || track.file !== path.basename(track.file)) return sendError(res, 404, 'Không tìm thấy nhạc.');
      return sendFile(req, res, path.join(deps.musicDir, track.file), 'audio/mpeg');
    }
    if (method === 'POST' && p === '/v1/jobs') return createJob(req, res, owner);

    const jm = /^\/v1\/jobs\/([^/]+)(\/video|\/thumb)?$/.exec(p);
    if (jm) {
      let id: string;
      try { id = decodeURIComponent(jm[1]); } catch { return sendError(res, 404, 'Không tìm thấy việc.'); }
      const job = ownedJob(id, owner);
      if (!job) return sendError(res, 404, 'Không tìm thấy việc.');
      if (method === 'GET' && !jm[2]) return sendJson(res, 200, jobView(job, queue.positionOf(id)));
      if (method === 'GET' && job.status === 'done') {
        if (jm[2] === '/video') return sendFile(req, res, path.join(store.jobDir(id), 'output', 'video.mp4'), 'video/mp4');
        if (jm[2] === '/thumb') return sendFile(req, res, path.join(store.jobDir(id), 'output', 'thumb.jpg'), 'image/jpeg');
      }
      if (method === 'GET') return sendError(res, 404, 'Video chưa sẵn sàng.');
      if (method === 'DELETE' && !jm[2]) return cancelJob(res, job);
    }
    sendError(res, 404, 'Không tìm thấy.');
  };
}

import busboy from 'busboy';
import * as fs from 'fs';
import * as path from 'path';
import { IncomingMessage } from 'http';
import { FileKind, FileType, KIND_OF, sniff } from './fileTypes';
import { LIMITS } from './limits';

export class UploadError extends Error {
  constructor(readonly status: 400 | 413 | 415 | 500, readonly code: 'INVALID_SPEC' | 'TOO_LARGE' | 'UNSUPPORTED_FILE' | 'INTERNAL', message: string) {
    super(message);
    this.name = 'UploadError';
  }
}

/** Tệp đã nhận: `original` chỉ dùng làm khoá tra cứu trong spec, không bao giờ dùng trong đường dẫn. */
export interface ReceivedFile { original: string; stored: string; type: FileType; kind: FileKind; size: number }
export interface Received { spec: string | undefined; files: ReceivedFile[] }
export type UploadLimits = Pick<typeof LIMITS, 'maxImages' | 'maxMediaBytes' | 'maxAudioBytes' | 'maxTotalBytes'>;

const MB = 1024 * 1024;
const HEAD_BYTES = 64; // đủ cho sniff
const MAX_FILES = 25;
const MAX_SPEC_BYTES = 1024 * 1024;

/**
 * Nhận multipart: ghi tệp vào `destDir` với tên tạm `upload-N.<đuôi>` (đuôi theo nội dung đã đoán).
 * Giới hạn kiểm ngay khi đang nhận; vượt thì dừng, xoá mọi tệp đã ghi và ném `UploadError`.
 */
export function receiveMultipart(req: IncomingMessage, destDir: string, limits: UploadLimits = LIMITS): Promise<Received> {
  return new Promise((resolve, reject) => {
    let bb: busboy.Busboy;
    try {
      bb = busboy({
        headers: req.headers,
        limits: { files: MAX_FILES, fields: 4, fieldSize: MAX_SPEC_BYTES, fileSize: limits.maxMediaBytes, parts: MAX_FILES + 4 },
      });
    } catch {
      reject(new UploadError(400, 'INVALID_SPEC', 'Yêu cầu phải là multipart/form-data.'));
      return;
    }

    const files: ReceivedFile[] = [];
    const streams: fs.WriteStream[] = [];
    const pending: Promise<void>[] = [];
    let spec: string | undefined;
    let total = 0;
    let images = 0;
    let failed: UploadError | undefined;

    const abort = (err: UploadError): void => {
      if (failed) return;
      failed = err;
      req.unpipe(bb);
      for (const s of streams) s.destroy();
      bb.destroy();
      fs.rmSync(destDir, { recursive: true, force: true });
      reject(err);
    };

    bb.on('field', (name, value, info) => {
      if (info.valueTruncated) return abort(new UploadError(413, 'TOO_LARGE', 'Trường spec quá lớn.'));
      if (name === 'spec') spec = value;
    });

    bb.on('file', (_field, file, info) => {
      const original = info.filename ?? '';
      let head = Buffer.alloc(0);
      let ws: fs.WriteStream | undefined;
      let type: FileType | null = null;
      let kind: FileKind = 'image';
      let size = 0;
      let done: () => void = () => undefined;
      pending.push(new Promise<void>((r) => { done = r; }));

      const begin = (): boolean => {
        type = sniff(head);
        if (!type) {
          abort(new UploadError(415, 'UNSUPPORTED_FILE', `Tệp "${original}" không phải ảnh JPEG/PNG/WebP, nhạc MP3/M4A/WAV hoặc video MP4.`));
          return false;
        }
        kind = KIND_OF[type];
        if (kind === 'image' && ++images > limits.maxImages) {
          abort(new UploadError(413, 'TOO_LARGE', `Tối đa ${limits.maxImages} ảnh mỗi việc.`));
          return false;
        }
        const stored = `upload-${files.length + 1}.${type}`;
        files.push({ original, stored, type, kind, size: 0 });
        ws = fs.createWriteStream(path.join(destDir, stored));
        streams.push(ws);
        ws.on('error', (e) => { // đĩa đầy / mất thư mục: không để lỗi chưa bắt làm sập tiến trình
          console.error('[render] Lỗi ghi tệp tải lên:', (e as Error).message);
          abort(new UploadError(500, 'INTERNAL', 'Không lưu được tệp tải lên.'));
          done();
        });
        ws.write(head);
        return true;
      };

      file.on('data', (chunk: Buffer) => {
        if (failed) return;
        size += chunk.length;
        total += chunk.length;
        if (!ws) {
          head = Buffer.concat([head, chunk]);
          if (head.length < HEAD_BYTES) return;
          if (!begin()) return;
        } else if (!ws.write(chunk)) {
          file.pause();
          ws.once('drain', () => file.resume());
        }
        const cap = kind === 'audio' ? limits.maxAudioBytes : limits.maxMediaBytes;
        if (size > cap) abort(new UploadError(413, 'TOO_LARGE', `Tệp "${original}" quá lớn (tối đa ${cap / MB} MB).`));
        else if (total > limits.maxTotalBytes) abort(new UploadError(413, 'TOO_LARGE', `Tổng dung lượng vượt ${limits.maxTotalBytes / MB} MB.`));
      });

      file.on('end', () => {
        if (failed) return done();
        if (file.truncated) {
          abort(new UploadError(413, 'TOO_LARGE', `Tệp "${original}" quá lớn.`));
          return done();
        }
        if (!ws && !begin()) return done();
        const cap = kind === 'audio' ? limits.maxAudioBytes : limits.maxMediaBytes;
        if (size > cap) abort(new UploadError(413, 'TOO_LARGE', `Tệp "${original}" quá lớn (tối đa ${cap / MB} MB).`));
        else files[files.length - 1].size = size;
        ws!.end(() => done());
      });
      file.on('error', () => done());
    });

    bb.on('filesLimit', () => abort(new UploadError(413, 'TOO_LARGE', `Tối đa ${MAX_FILES} tệp mỗi việc.`)));
    bb.on('partsLimit', () => abort(new UploadError(400, 'INVALID_SPEC', 'Quá nhiều phần trong yêu cầu.')));
    bb.on('error', () => abort(new UploadError(400, 'INVALID_SPEC', 'Yêu cầu multipart không hợp lệ.')));
    req.on('error', () => abort(new UploadError(400, 'INVALID_SPEC', 'Kết nối bị lỗi khi đang gửi.')));
    req.on('aborted', () => abort(new UploadError(400, 'INVALID_SPEC', 'Kết nối bị ngắt khi đang gửi.')));
    bb.on('close', () => {
      if (failed) return;
      void Promise.all(pending).then(() => {
        if (!failed) resolve({ spec, files });
      });
    });
    req.pipe(bb);
  });
}

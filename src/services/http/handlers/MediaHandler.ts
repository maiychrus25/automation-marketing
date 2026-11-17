/**
 * MediaHandler - Serve media files từ Boss storage qua HTTP.
 * Employee dùng URL trực tiếp trong <img src> thay vì request binary.
 *
 * Routes:
 *   GET /api/media/{zaloId}/{date}/{filename}  → File gốc
 *   GET /api/media/thumb/{zaloId}/{date}/{filename} → Thumbnail
 *   GET /api/media/avatar/{zaloId}/{filename}  → Avatar
 */

import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import Logger from '../../../utils/Logger';
import FileStorageService from '../../file/FileStorageService';
import { isInside, mediaAccountOf } from '../bossFileAccess';

const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.zip': 'application/zip',
  '.rar': 'application/vnd.rar',
  '.webm': 'video/webm',
  '.tgs': 'application/x-tgsticker',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4',
};

function detectMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

type Candidate =
  | { kind: 'found'; resolved: string; stat: fs.Stats }
  | { kind: 'notFound' }
  | { kind: 'forbidden'; code: 'PATH_FORBIDDEN' | 'ACCOUNT_FORBIDDEN' };

/** Full check sequence for one relative path: realpath, inside-base, Telegram-avatar exception, account, regular file. */
function resolveCandidate(mediaPath: string, mediaBasePath: string, allowedAccounts: readonly string[] | undefined, allowErpTasks: boolean): Candidate {
  let resolved: string;
  try {
    resolved = fs.realpathSync(path.resolve(mediaBasePath, mediaPath));
  } catch {
    // Direct resolve failed — resolveAbsolutePath handles base dir migration (file saved under an old media directory).
    try {
      const altPath = FileStorageService.resolveAbsolutePath(path.join('media', mediaPath));
      if (!altPath) return { kind: 'notFound' };
      resolved = fs.realpathSync(altPath);
    } catch {
      return { kind: 'notFound' };
    }
  }

  const safeBase = fs.realpathSync(path.resolve(mediaBasePath));
  if (!isInside(safeBase, resolved)) return { kind: 'forbidden', code: 'PATH_FORBIDDEN' };
  // Employee request: the file must sit in the folder of an account they may use ("external/..." has none),
  // or in erp/tasks/ (task attachments) for an employee who holds the erp module.
  // Telegram avatars are shared by every account (<base>/_avatars/telegram/); the traversal check above already ran on the real path.
  const isTelegramAvatar = isInside(path.join(safeBase, '_avatars', 'telegram'), resolved);
  if (allowedAccounts && !isTelegramAvatar) {
    const account = mediaAccountOf(safeBase, resolved);
    const isTaskFile = allowErpTasks && isInside(path.join(safeBase, 'erp', 'tasks'), resolved);
    if (!isTaskFile && (!account || !allowedAccounts.includes(account))) return { kind: 'forbidden', code: 'ACCOUNT_FORBIDDEN' };
  }

  if (!fs.existsSync(resolved)) return { kind: 'notFound' };
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) return { kind: 'notFound' }; // a directory (or anything that is not a file) is never streamed
  return { kind: 'found', resolved, stat };
}

/**
 * Handle GET /api/media/* request.
 * Trả về file trực tiếp với Content-Type phù hợp.
 * Supports Range requests cho video.
 */
export function handleMediaRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  mediaBasePath: string,
  allowedAccounts?: readonly string[],
  allowErpTasks = false
): 'PATH_FORBIDDEN' | 'ACCOUNT_FORBIDDEN' | void {
  const url = req.url || '';

  try {
    // Parse URL: /api/media/{zaloId}/{date}/{filename}
    //             /api/media/thumb/{zaloId}/{date}/{filename}
    //             /api/media/avatar/{zaloId}/{filename}
    // Candidates in order: the decoded path (when decoding works and differs), then the raw one (files stored under a
    // percent-encoded name, apps that send unencoded names). A security refusal ends the request; only "not found" moves on.
    const rawPath = url.replace('/api/media/', '');
    const candidates = [rawPath];
    try {
      const decoded = decodeURIComponent(rawPath);
      if (decoded !== rawPath) candidates.unshift(decoded);
    } catch { /* malformed escape: raw candidate only */ }

    let resolved = '';
    let stat: fs.Stats | undefined;
    for (const mediaPath of candidates) {
      if (mediaPath.includes('\0')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Bad request' }));
        return;
      }
      const outcome = resolveCandidate(mediaPath, mediaBasePath, allowedAccounts, allowErpTasks);
      if (outcome.kind === 'forbidden') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Forbidden' }));
        return outcome.code;
      }
      if (outcome.kind === 'found') {
        resolved = outcome.resolved;
        stat = outcome.stat;
        break;
      }
    }
    if (!stat) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'File not found' }));
      return;
    }
    const mime = detectMime(resolved);
    const isImage = mime.startsWith('image/');
    const maxAge = url.includes('/avatar/') ? 604800 : 86400; // Avatar: 7 ngày, còn lại: 1 ngày

    // Handle Range requests (cho video)
    const range = req.headers.range;
    if (range && !isImage) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': mime,
        'Cache-Control': `private, max-age=${maxAge}`,
      });

      const stream = fs.createReadStream(resolved, { start, end });
      stream.on('error', () => res.destroy());
      stream.pipe(res);
      return;
    }

    // Normal request
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stat.size,
      'Cache-Control': `private, max-age=${maxAge}`,
      'ETag': `"${stat.mtimeMs}"`,
      'Accept-Ranges': 'bytes',
    });

    const stream = fs.createReadStream(resolved);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  } catch (err: any) {
    Logger.error(`[MediaHandler] Error: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
  }
}

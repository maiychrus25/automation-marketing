/**
 * Convert absolute local file path → local-media:// URL or boss REST URL.
 *
 * - Standalone/Boss mode: dùng local-media:// (Electron custom protocol)
 * - Employee mode: dùng boss /api/media/ URL
 *
 * Usage:
 *   <img src={toLocalMediaUrl(filePath, zaloId)} />
 */

import { useEmployeeStore } from '../store/employeeStore';
import { useAccountStore } from '../store/accountStore';
import { isTelegramChannel } from './employeeAccounts';

function getBossBaseUrl(): string {
  try {
    return useEmployeeStore.getState().bossUrl || '';
  } catch {
    return '';
  }
}

// Thư mục tệp của boss mà /api/<tên>/ phục vụ (cùng quy ước với toBossMediaUrl bên dưới).
const BOSS_MEDIA_PATH = /(?:^|\/)(media|_uploads|avatar)\/(.+)/;

/** local-media://… hoặc media://local/… → đường dẫn tệp; dạng khác → null. */
function pathOfLocalScheme(url: string): string | null {
  if (url.startsWith('local-media://')) return url.slice('local-media://'.length);
  if (url.startsWith('media://local/')) return url.slice('media://local/'.length);
  return null;
}

/**
 * Employee: tệp Telegram do boss ghi (avatar chung `_avatars/telegram/`, hoặc thư mục `<mã tài khoản Telegram>/` như sticker)
 * → URL media của boss. Phần sau `/media/` CUỐI CÙNG phải đúng hai dạng đó; còn lại (kể cả tệp trên máy nhân viên) → null.
 * Có đoạn `..` → null; mỗi đoạn được mã hoá để `#`, `?`, `%`, dấu cách trong tên tệp không làm hỏng URL.
 */
export function bossTelegramMediaUrl(schemePath: string, bossUrl: string, telegramAccountIds: ReadonlySet<string>): string | null {
  if (!bossUrl) return null;
  const segments = schemePath.replace(/\\/g, '/').split('/');
  if (segments.includes('..')) return null;
  const rest = segments.slice(segments.lastIndexOf('media') + 1);
  if (segments.lastIndexOf('media') < 0 || rest.length < 2 || rest.some((seg) => seg === '')) return null;
  const isAvatar = rest[0] === '_avatars' && rest[1] === 'telegram' && rest.length >= 3;
  if (!isAvatar && !telegramAccountIds.has(rest[0])) return null;
  return `${bossUrl}/api/media/${rest.map(encodeURIComponent).join('/')}`;
}

// Memoised on the account list reference: the store replaces the array when accounts change.
let idsCache: { source: unknown; ids: Set<string> } | null = null;

function getTelegramAccountIds(): Set<string> {
  try {
    const accounts = useAccountStore.getState().accounts;
    if (idsCache?.source !== accounts) idsCache = { source: accounts, ids: new Set(accounts.filter((a) => isTelegramChannel(a.channel)).map((a) => a.zalo_id)) };
    return idsCache.ids;
  } catch {
    return new Set();
  }
}

const encodePath = (p: string): string => p.split('/').map(encodeURIComponent).join('/');

export function toLocalMediaUrl(filePath: string, zaloId?: string): string {
  if (!filePath) return '';

  // data:/blob: values are already usable URLs in every mode.
  if (filePath.startsWith('data:') || filePath.startsWith('blob:')) return filePath;

  // Employee: avatar/sticker Telegram do boss ghi (local-media:// của máy boss) không có trên máy này
  const schemePath = getMode() === 'employee' ? pathOfLocalScheme(filePath) : null;
  if (schemePath !== null) {
    const bossMediaUrl = bossTelegramMediaUrl(schemePath, getBossBaseUrl(), getTelegramAccountIds());
    if (bossMediaUrl) return bossMediaUrl;
  }

  // Already a proper URL → return as-is
  if (filePath.startsWith('http://') || filePath.startsWith('https://') || filePath.startsWith('local-media://')) {
    return filePath;
  }

  // media://local/ prefix (legacy Telegram avatar format) → strip prefix and convert
  if (filePath.startsWith('media://local/')) {
    const rawPath = filePath.replace('media://local/', '');
    const normalized = rawPath.replace(/\\/g, '/');
    const withSlash = normalized.startsWith('/') ? normalized : '/' + normalized;
    return 'local-media://' + withSlash;
  }

  const mode = getMode();
  if (mode === 'employee') {
    // Employee: convert boss local path → boss REST URL
    const bossUrl = getBossBaseUrl();
    if (!bossUrl) return filePath;
    return toBossMediaUrl(filePath, bossUrl, zaloId);
  }

  // Standalone/Boss: local-media:// protocol (current behavior)
  return toDiskMediaUrl(filePath);
}

/** A file on THIS machine (e.g. just picked in the poster on an employee machine): always the local-media:// scheme, whatever the mode. */
export function toDiskMediaUrl(filePath: string): string {
  const stripped = filePath.replace(/^file:\/\/\//, '').replace(/^file:\/\//, '');
  const normalized = stripped.replace(/\\/g, '/');
  const withSlash = normalized.startsWith('/') ? normalized : '/' + normalized;
  return 'local-media://' + withSlash;
}

/**
 * Convert boss filesystem path → boss REST media URL
 * Input:  /home/boss/media/zaloId/2024/06/27/abc.jpg
 *         D:\media\zaloId\2024\06\27\abc.jpg
 * Output: https://boss/api/media/zaloId/2024/06/27/abc.jpg
 */
function toBossMediaUrl(localPath: string, bossUrl: string, zaloId?: string): string {
  try {
    // Normalize path separators
    let normalized = localPath.replace(/\\/g, '/');

    // Try to extract relative path after the media base directory
    // Patterns: /media/zaloId/... or D:\media\zaloId\...
    const mediaMatch = normalized.match(BOSS_MEDIA_PATH);
    if (mediaMatch) {
      return `${bossUrl}/api/${mediaMatch[1]}/${encodePath(mediaMatch[2])}`;
    }

    // Fallback: use as-is with media prefix
    // Extract filename from path
    const filename = normalized.split('/').pop() || 'file';
    if (zaloId) {
      return `${bossUrl}/api/media/${encodeURIComponent(zaloId)}/misc/${encodeURIComponent(filename)}`;
    }

    // Last resort: construct from the full path (may not work on boss)
    return `${bossUrl}/api/media/external/${encodeURIComponent(normalized)}`;
  } catch {
    return localPath;
  }
}

function getMode(): string {
  try {
    return useEmployeeStore.getState().mode;
  } catch {
    return 'standalone';
  }
}

/**
 * Check if a path is a local file path (not a remote URL)
 */
export function isLocalPath(path: string): boolean {
  if (!path) return false;
  return !path.startsWith('http://') && !path.startsWith('https://') && !path.startsWith('data:');
}

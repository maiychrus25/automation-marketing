/**
 * Kho mật khẩu của hệ điều hành (macOS Keychain, Windows DPAPI, Linux keyring) mà electron.safeStorage dựa vào có thể
 * chưa đọc được lúc app mở: máy đang khóa màn hình, hoặc người dùng chưa cấp quyền. Khi đó cookie và khoá đã lưu ở dạng
 * mã hoá không giải mã được. Kết nối tài khoản trong lúc đó chỉ sinh lỗi sai lệch ("cookie không hợp lệ, hãy đăng nhập
 * lại") và đánh dấu tài khoản là đã ngắt, nên phần tự kết nối lúc khởi động phải chờ kho mở.
 */
import { safeStorage } from 'electron';
import DatabaseService from '../database/DatabaseService';
import Logger from '../../utils/Logger';

export const SECRET_STORE_LOCKED_MESSAGE =
  'MaiHub chưa đọc được kho mật khẩu của máy (máy đang khóa hoặc chưa cấp quyền Chuỗi khóa). '
  + 'Hãy mở khóa máy rồi mở lại MaiHub; bạn không cần đăng nhập lại tài khoản.';

const RECHECK_MS = 5_000;

export function isSecretStoreAvailable(): boolean {
  try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
}

/**
 * Máy này đã từng lưu dữ liệu ở dạng mã hoá chưa: một khoá cài đặt `enc:…`, hoặc cookie Zalo không phải JSON thường.
 * Chưa từng (ví dụ Linux không có keyring, mọi thứ lưu dạng thường) thì không có gì để chờ.
 */
export function secretStoreWasUsed(): boolean {
  const db = DatabaseService.getInstance();
  if (db.queryOne<any>(`SELECT 1 AS used FROM app_settings WHERE value LIKE 'enc:%' LIMIT 1`)) return true;
  return !!db.queryOne<any>(
    `SELECT 1 AS used FROM accounts
      WHERE (channel = 'zalo' OR channel IS NULL) AND cookies IS NOT NULL AND cookies != ''
        AND substr(ltrim(cookies), 1, 1) NOT IN ('[', '{') LIMIT 1`);
}

/**
 * Một giá trị đã lưu (cookie Zalo) hiện không đọc được: nó ở dạng mã hoá mà kho mật khẩu chưa mở.
 * Giá trị dạng thường (JSON, token `số:chữ` của bot Telegram, rỗng) luôn đọc được.
 */
export function isStoredSecretUnreadable(value: string, canDecrypt: () => boolean = isSecretStoreAvailable): boolean {
  const trimmed = String(value ?? '').trimStart();
  if (!trimmed || trimmed.startsWith('[') || trimmed.startsWith('{') || /^\d+:[A-Za-z0-9_-]+$/.test(trimmed)) return false;
  return !canDecrypt();
}

/**
 * Chạy `run` đúng một lần khi kho mật khẩu đọc được: ngay lập tức nếu đã đọc được hoặc máy chưa từng dùng mã hoá,
 * không thì kiểm tra lại mỗi 5 giây cho tới khi mở. Trả về hàm huỷ việc chờ.
 */
export function whenSecretStoreReady(
  run: () => void,
  deps: { isAvailable?: () => boolean; isNeeded?: () => boolean } = {},
): () => void {
  const isAvailable = deps.isAvailable ?? isSecretStoreAvailable;
  let needed = false;
  // Không kiểm tra được thì coi như không cần chờ: không bao giờ chặn việc khởi động vì chính phép kiểm tra này.
  try { needed = !isAvailable() && (deps.isNeeded ?? secretStoreWasUsed)(); } catch { needed = false; }
  if (!needed) { run(); return () => {}; }

  Logger.warn('[SecretStore] Chưa đọc được kho mật khẩu của máy (máy đang khóa hoặc chưa cấp quyền): hoãn tự kết nối tài khoản cho tới khi mở được');
  const timer = setInterval(() => {
    if (!isAvailable()) return;
    clearInterval(timer);
    Logger.log('[SecretStore] Kho mật khẩu đã mở: bắt đầu tự kết nối tài khoản');
    run();
  }, RECHECK_MS);
  return () => clearInterval(timer);
}

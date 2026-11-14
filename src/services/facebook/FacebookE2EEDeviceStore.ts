/**
 * Lưu trạng thái thiết bị E2EE Facebook (chuỗi JSON chứa KHOÁ RIÊNG) vào settings của DB boss,
 * mã hoá bằng safeStorage qua SecureSettingsService. Chuỗi này không bao giờ được ghi log.
 * Ý tưởng lấy từ babyvibe/deplao-builder @2162f07 (MIT) FacebookE2EEStateStore, đơn giản hoá thành SQLite settings.
 */
import { safeStorage } from 'electron';
import { secureGet, secureSet, secureDelete, SettingsDb } from '../secure/SecureSettingsService';
import Logger from '../../utils/Logger';

export const DEVICE_SAVE_DEBOUNCE_MS = 1_000;

export const fbE2EEDeviceKey = (accountId: string): string => `fb_e2ee_device_${accountId}`;

export interface E2EEDeviceStoreDeps {
  runOnBossDb?: (fn: (db: SettingsDb) => void) => void;
  get?: typeof secureGet;
  set?: typeof secureSet;
  remove?: typeof secureDelete;
  canEncrypt?: () => boolean;
}

export class FacebookE2EEDeviceStore {
  private pending: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly key: string;
  private readonly runOnBossDb: (fn: (db: SettingsDb) => void) => void;
  private readonly get: typeof secureGet;
  private readonly set: typeof secureSet;
  private readonly remove: typeof secureDelete;
  private readonly canEncrypt: () => boolean;
  private warnedNoEncryption = false;

  constructor(private readonly accountId: string, deps: E2EEDeviceStoreDeps = {}) {
    this.key = fbE2EEDeviceKey(accountId);
    // EventBroadcaster nạp muộn để tránh vòng import.
    this.runOnBossDb = deps.runOnBossDb ?? (fn => require('../event/EventBroadcaster').default.runOnBossDb(fn));
    this.get = deps.get ?? secureGet;
    this.set = deps.set ?? secureSet;
    this.remove = deps.remove ?? secureDelete;
    this.canEncrypt = deps.canEncrypt ?? (() => safeStorage.isEncryptionAvailable());
  }

  load(): string | null {
    let value: string | null = null;
    try {
      this.runOnBossDb(db => { value = this.get(this.key, db); });
    } catch (err: any) {
      Logger.warn(`[FacebookE2EEDeviceStore:${this.accountId}] load failed: ${err?.message}`);
      return null;
    }
    return value || null;
  }

  save(deviceData: string): void {
    if (typeof deviceData !== 'string' || !deviceData) return;
    this.pending = deviceData;
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, DEVICE_SAVE_DEBOUNCE_MS);
  }

  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const value = this.pending;
    this.pending = null;
    if (value === null) return;
    // Bảng settings được đồng bộ sang máy nhân viên: không có keychain thì không lưu (secureSet sẽ ghi chữ thường);
    // khi đó app đăng ký thiết bị mới mỗi lần mở như trước.
    if (!this.canEncrypt()) {
      if (!this.warnedNoEncryption) {
        this.warnedNoEncryption = true;
        Logger.warn(`[FacebookE2EEDeviceStore:${this.accountId}] safeStorage unavailable - E2EE device is not persisted`);
      }
      return;
    }
    try {
      this.runOnBossDb(db => this.set(this.key, value, db));
    } catch (err: any) {
      Logger.warn(`[FacebookE2EEDeviceStore:${this.accountId}] save failed: ${err?.message}`);
    }
  }

  clear(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.pending = null;
    try {
      this.runOnBossDb(db => this.remove(this.key, db));
    } catch (err: any) {
      Logger.warn(`[FacebookE2EEDeviceStore:${this.accountId}] clear failed: ${err?.message}`);
    }
  }
}

/** Dùng khi xoá tài khoản: bỏ trạng thái thiết bị đã lưu cùng lúc với cookie. */
export function clearFbE2EEDeviceState(accountId: string): void {
  new FacebookE2EEDeviceStore(accountId).clear();
}

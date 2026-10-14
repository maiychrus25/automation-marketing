import { DEFAULT_CONTROL_PORT } from './ControlApiServer';
import { parseAllowList } from './controlSecurity';

/** Khoá trong `app_settings` của workspace (cấu hình Control API là theo workspace). */
export const CONTROL_CONFIG_SETTING_KEY = 'control_api_config';
export const MIN_CONTROL_PORT = 1024;
export const MAX_CONTROL_PORT = 65535;
export const FIREWALL_RULE_NAME = 'MaiHub Control API';

export interface ControlConfig { enabled: boolean; port: number; allowList: string[] }

export const DEFAULT_CONTROL_CONFIG: ControlConfig = { enabled: false, port: DEFAULT_CONTROL_PORT, allowList: [] };

/** Lỗi kiểm tra cấu hình; `invalid` là các mục IP sai để UI tô đỏ. */
export class ControlConfigError extends Error {
    constructor(message: string, public readonly invalid: string[] = []) {
        super(message);
        this.name = 'ControlConfigError';
    }
}

/** Đọc cấu hình đã lưu; JSON hỏng hoặc trường sai kiểu thì rơi về mặc định (API tắt). */
export function parseStoredConfig(raw: string | null): ControlConfig {
    if (!raw) return { ...DEFAULT_CONTROL_CONFIG, allowList: [] };
    try {
        const v = JSON.parse(raw);
        const port = Number.isInteger(v?.port) && v.port >= MIN_CONTROL_PORT && v.port <= MAX_CONTROL_PORT ? v.port : DEFAULT_CONTROL_PORT;
        const allowList = Array.isArray(v?.allowList) ? parseAllowList(v.allowList.filter((e: unknown) => typeof e === 'string').join(',')).entries : [];
        return { enabled: v?.enabled === true && allowList.length > 0, port, allowList };
    } catch {
        return { ...DEFAULT_CONTROL_CONFIG, allowList: [] };
    }
}

/** Kiểm tra đầu vào `controlApi:setConfig`. `allowList` là mảng hoặc chuỗi (phân cách phẩy/khoảng trắng). Bật mà danh sách rỗng bị từ chối. */
export function validateConfigInput(input: any): ControlConfig {
    const port = Number(input?.port);
    if (!Number.isInteger(port) || port < MIN_CONTROL_PORT || port > MAX_CONTROL_PORT) {
        throw new ControlConfigError(`Cổng phải là số nguyên từ ${MIN_CONTROL_PORT} đến ${MAX_CONTROL_PORT}`);
    }
    const text = Array.isArray(input?.allowList) ? input.allowList.map(String).join(',') : typeof input?.allowList === 'string' ? input.allowList : '';
    const { entries, invalid } = parseAllowList(text);
    if (invalid.length) throw new ControlConfigError(`Địa chỉ IP không hợp lệ: ${invalid.join(', ')}`, invalid);
    const enabled = input?.enabled === true;
    if (enabled && entries.length === 0) throw new ControlConfigError('Phải nhập ít nhất một địa chỉ IP được phép trước khi bật');
    return { enabled, port, allowList: [...new Set(entries)] };
}

/** Lệnh cho Windows; chuỗi để người dùng tự chạy trong PowerShell quản trị, app không chạy hộ. Dòng đầu xoá luật cũ cùng tên (đổi cổng/IP không để lại luật thừa); báo "No rules match" lần đầu là bình thường. */
export function buildFirewallCommand(config: Pick<ControlConfig, 'port' | 'allowList'>): string {
    if (config.allowList.length === 0) throw new ControlConfigError('Chưa có địa chỉ IP nào trong danh sách được phép');
    return `netsh advfirewall firewall delete rule name="${FIREWALL_RULE_NAME}"\nnetsh advfirewall firewall add rule name="${FIREWALL_RULE_NAME}" dir=in action=allow protocol=TCP localport=${config.port} remoteip=${config.allowList.join(',')}`;
}

export interface AppVersionSources {
    /** `app.getVersion()` */
    reported: string;
    /** Các đường dẫn package.json thử lần lượt (gốc repo khi chạy dev, rồi thư mục app đóng gói). */
    packageJsonPaths: string[];
    readFile(file: string): string;
}

/** `app.getVersion()` trả '0.0' khi chạy dev (`electron .` từ dist-electron): lúc đó đọc `version` trong package.json đầu tiên đọc được. */
export function resolveAppVersion(src: AppVersionSources): string {
    if (src.reported !== '0.0') return src.reported;
    for (const file of src.packageJsonPaths) {
        try {
            const version = JSON.parse(src.readFile(file)).version;
            if (typeof version === 'string' && version) return version;
        } catch { /* thử đường dẫn kế tiếp */ }
    }
    return src.reported;
}

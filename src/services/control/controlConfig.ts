import type { NetworkInterfaceInfo } from 'os';
import { DEFAULT_CONTROL_PORT } from './ControlApiServer';
import { parseAllowList } from './controlSecurity';

/** Khoá trong `app_settings` của workspace (cấu hình Control API là theo workspace). */
export const CONTROL_CONFIG_SETTING_KEY = 'control_api_config';
export const MIN_CONTROL_PORT = 1024;
export const MAX_CONTROL_PORT = 65535;
export const FIREWALL_RULE_NAME = 'MaiHub Control API';

/** `publicHost`: địa chỉ bot dùng để tới MaiHub (IP công khai hoặc tên miền); null = chưa đặt. */
export interface ControlConfig { enabled: boolean; port: number; allowList: string[]; publicHost: string | null }

export const DEFAULT_CONTROL_CONFIG: ControlConfig = { enabled: false, port: DEFAULT_CONTROL_PORT, allowList: [], publicHost: null };

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
        let publicHost: string | null = null;
        if (typeof v?.publicHost === 'string') {
            try { publicHost = validatePublicHost(v.publicHost); } catch { /* giá trị hỏng thì coi như chưa đặt */ }
        }
        return { enabled: v?.enabled === true && allowList.length > 0, port, allowList, publicHost };
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
    const hostText = typeof input?.publicHost === 'string' ? input.publicHost.trim() : '';
    return { enabled, port, allowList: [...new Set(entries)], publicHost: hostText ? validatePublicHost(hostText) : null };
}

function isPublicIpv4(ip: string): boolean {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
    if (!m) return false;
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || a === 127 || a === 0) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    return true;
}

/** IPv4 công khai đầu tiên của máy; bỏ internal và các dải private/CGNAT/link-local/loopback. null nếu không có. */
export function detectPublicIpv4(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string | null {
    for (const list of Object.values(interfaces)) {
        for (const info of list ?? []) {
            if (info.family === 'IPv4' && !info.internal && isPublicIpv4(info.address)) return info.address;
        }
    }
    return null;
}

/** `publicHost` là IPv4 hoặc tên miền (`[a-z0-9.-]`, tối đa 253 ký tự); trả về dạng đã chuẩn hoá chữ thường. */
export function validatePublicHost(host: string): string {
    const value = String(host ?? '').trim().toLowerCase();
    const ok = value.length > 0 && value.length <= 253 && /^[a-z0-9.-]+$/.test(value) && !value.startsWith('.') && !value.endsWith('.') && !value.includes('..');
    if (!ok) throw new ControlConfigError('Địa chỉ công khai phải là IPv4 hoặc tên miền hợp lệ');
    return value;
}

/** validateConfigInput đặt publicHost = null khi thiếu khoá: thiếu thì giữ địa chỉ đã nhớ; có khoá (kể cả null/rỗng) thì dùng giá trị gửi lên. */
export function withStoredPublicHost(input: any, stored: string | null): any {
    const base = input && typeof input === 'object' ? input : {};
    return 'publicHost' in base ? base : { ...base, publicHost: stored };
}

/** `botIp` của ghép nối: đúng một IPv4 đơn (không CIDR, không IPv6, không nhiều địa chỉ). */
export function parseBotIp(text: unknown): string {
    const { entries, invalid } = parseAllowList(typeof text === 'string' ? text : '');
    const ip = entries[0];
    if (invalid.length || entries.length !== 1 || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
        throw new ControlConfigError('Địa chỉ IP của bot phải là đúng một IPv4 (không dùng dải CIDR)');
    }
    return ip;
}

/** Mã ghép nối: `mhp1.` + base64url (không padding) của JSON `{u,f,t,n}`. Không chứa API key. */
export function buildPairingCode(input: { url: string; fingerprint: string; ticket: string; name: string }): string {
    const json = JSON.stringify({ u: input.url, f: input.fingerprint, t: input.ticket, n: input.name });
    return `mhp1.${Buffer.from(json, 'utf8').toString('base64url')}`;
}

/** Lệnh cài một dòng để chạy bằng root trên VPS bot (spec §2.4). Mã base64url không chứa `'` nên bọc nháy đơn là an toàn. */
export function buildInstallCommand(input: { host: string; port: number; sha256: string; code: string }): string {
    return `curl -fsSk https://${input.host}:${input.port}/v1/bridge.py -o /root/maihub_bridge.py && echo "${input.sha256}  /root/maihub_bridge.py" | sha256sum -c - && python3 -I /root/maihub_bridge.py pair '${input.code}' --install`;
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

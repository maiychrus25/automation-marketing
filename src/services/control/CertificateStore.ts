import * as fs from 'fs';
import * as path from 'path';
import { X509Certificate, createHash } from 'crypto';
import type { ControlCertificate } from './certificate';

/** Mã hoá khoá riêng (Electron safeStorage); tách ra để test không cần Electron. */
export interface SecretCipher {
    isAvailable(): boolean;
    encrypt(plain: string): Buffer;
    decrypt(data: Buffer): string;
}

const CERT_FILE = 'cert.pem';
const KEY_ENC_FILE = 'key.enc';
const KEY_PLAIN_FILE = 'key.pem';
export const PLAIN_KEY_WARNING = 'Máy này không có kho khoá hệ điều hành, khoá riêng của chứng chỉ được lưu dạng tệp (quyền 0600).';

export function fingerprintOf(certPem: string): string {
    return createHash('sha256').update(new X509Certificate(certPem).raw).digest('hex');
}

/** Chứng chỉ + khoá riêng trong `dir` (userData/control-api). Khoá mã hoá khi có cipher, nếu không thì tệp 0600 kèm cảnh báo. */
export class CertificateStore {
    private warningText: string | null = null;

    constructor(
        private readonly dir: string,
        private readonly cipher: SecretCipher,
        private readonly create: () => Promise<ControlCertificate>,
    ) {}

    get warning(): string | null { return this.warningText; }

    /** Dấu vân tay của chứng chỉ đã lưu, null nếu chưa có. */
    fingerprint(): string | null {
        try { return fingerprintOf(fs.readFileSync(path.join(this.dir, CERT_FILE), 'utf8')); } catch { return null; }
    }

    load(): { key: string; cert: string } | null {
        try {
            const cert = fs.readFileSync(path.join(this.dir, CERT_FILE), 'utf8');
            const encPath = path.join(this.dir, KEY_ENC_FILE);
            if (fs.existsSync(encPath)) {
                this.warningText = null;
                return { cert, key: this.cipher.decrypt(fs.readFileSync(encPath)) };
            }
            const key = fs.readFileSync(path.join(this.dir, KEY_PLAIN_FILE), 'utf8');
            this.warningText = PLAIN_KEY_WARNING;
            return { cert, key };
        } catch {
            return null; // thiếu hoặc không giải mã được: coi như chưa có, ensure() sẽ tạo lại
        }
    }

    async ensure(): Promise<{ key: string; cert: string }> {
        return this.load() ?? this.regenerate();
    }

    /** Tạo chứng chỉ mới (dấu vân tay đổi) và ghi đè bản cũ. */
    async regenerate(): Promise<{ key: string; cert: string }> {
        const made = await this.create();
        fs.mkdirSync(this.dir, { recursive: true });
        fs.writeFileSync(path.join(this.dir, CERT_FILE), made.cert, { mode: 0o644 });
        if (this.cipher.isAvailable()) {
            fs.writeFileSync(path.join(this.dir, KEY_ENC_FILE), this.cipher.encrypt(made.key), { mode: 0o600 });
            fs.rmSync(path.join(this.dir, KEY_PLAIN_FILE), { force: true });
            this.warningText = null;
        } else {
            fs.writeFileSync(path.join(this.dir, KEY_PLAIN_FILE), made.key, { mode: 0o600 });
            fs.rmSync(path.join(this.dir, KEY_ENC_FILE), { force: true });
            this.warningText = PLAIN_KEY_WARNING;
        }
        return { key: made.key, cert: made.cert };
    }
}

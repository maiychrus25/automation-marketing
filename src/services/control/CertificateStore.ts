import * as fs from 'fs';
import * as path from 'path';
import { X509Certificate, createHash } from 'crypto';
import type { ControlCertificate } from './certificate';

/** Mã hoá khoá riêng (Electron safeStorage); tách ra để test không cần Electron. */
export interface SecretCipher {
    isAvailable(): boolean;
    encrypt(plain: string): Buffer;
    decrypt(data: Buffer): string;
    /** true khi kho khoá hệ điều hành chỉ là văn bản thường (Linux `basic_text`). */
    isWeak?(): boolean;
}

const CERT_FILE = 'cert.pem';
const KEY_ENC_FILE = 'key.enc';
const KEY_PLAIN_FILE = 'key.pem';
export const PLAIN_KEY_WARNING = 'Máy này không có kho khoá hệ điều hành, khoá riêng của chứng chỉ được lưu dạng tệp (quyền 0600).';

export const WEAK_KEY_WARNING = 'Kho khoá của hệ điều hành chỉ là basic_text nên khoá riêng của chứng chỉ chỉ được che, không được bảo vệ thật sự.';

/** Có tệp khoá mã hoá nhưng không giải mã được; KHÔNG tự tạo lại chứng chỉ (sẽ làm mọi bridge đã ghim dấu vân tay mất kết nối). */
export class CertificateKeyUnreadableError extends Error {
    constructor() {
        super('Không giải mã được khoá chứng chỉ; tạo lại chứng chỉ trong Cài đặt');
        this.name = 'CertificateKeyUnreadableError';
    }
}

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

    /** null khi chưa có chứng chỉ/khoá; ném CertificateKeyUnreadableError khi khoá mã hoá có mà không giải mã được. */
    load(): { key: string; cert: string } | null {
        let cert: string;
        try { cert = fs.readFileSync(path.join(this.dir, CERT_FILE), 'utf8'); } catch { return null; }
        const encPath = path.join(this.dir, KEY_ENC_FILE);
        if (fs.existsSync(encPath)) {
            let key: string;
            try { key = this.cipher.decrypt(fs.readFileSync(encPath)); } catch { throw new CertificateKeyUnreadableError(); }
            this.warningText = this.cipher.isWeak?.() ? WEAK_KEY_WARNING : null;
            return { cert, key };
        }
        try {
            const key = fs.readFileSync(path.join(this.dir, KEY_PLAIN_FILE), 'utf8');
            this.warningText = PLAIN_KEY_WARNING;
            return { cert, key };
        } catch {
            return null;
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
            this.warningText = this.cipher.isWeak?.() ? WEAK_KEY_WARNING : null;
        } else {
            fs.writeFileSync(path.join(this.dir, KEY_PLAIN_FILE), made.key, { mode: 0o600 });
            fs.rmSync(path.join(this.dir, KEY_ENC_FILE), { force: true });
            this.warningText = PLAIN_KEY_WARNING;
        }
        return { key: made.key, cert: made.cert };
    }
}

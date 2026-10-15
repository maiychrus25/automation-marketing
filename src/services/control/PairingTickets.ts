import { createHash, randomBytes as nodeRandomBytes } from 'crypto';
import { normalizeIp } from './controlSecurity';

/** Vé sống 15 phút, dùng một lần, tối đa 5 vé còn hiệu lực (mỗi IP bot một vé). */
export const PAIRING_TTL_MS = 900_000;
export const MAX_PENDING_TICKETS = 5;

interface TicketRecord { name: string; botIp: string; expiresAt: number; createdAt: number }

const hashTicket = (ticket: string): string => createHash('sha256').update(ticket).digest('hex');

/** Vé ghép nối chỉ lưu trong bộ nhớ (SHA-256 của vé); khởi động lại app thì mọi vé mất hiệu lực. */
export class PairingTickets {
    private readonly records = new Map<string, TicketRecord>();

    constructor(
        private readonly now: () => number = Date.now,
        private readonly randomBytes: (n: number) => Buffer = nodeRandomBytes,
    ) {}

    create(name: string, botIp: string): { ticket: string; expiresAt: number } {
        const ip = normalizeIp(botIp);
        this.prune();
        this.cancel(ip);
        while (this.records.size >= MAX_PENDING_TICKETS) {
            let oldest: string | null = null;
            for (const [hash, rec] of this.records) {
                if (oldest === null || rec.createdAt < this.records.get(oldest)!.createdAt) oldest = hash;
            }
            this.records.delete(oldest!);
        }
        const ticket = this.randomBytes(32).toString('base64url');
        const createdAt = this.now();
        const expiresAt = createdAt + PAIRING_TTL_MS;
        this.records.set(hashTicket(ticket), { name, botIp: ip, expiresAt, createdAt });
        return { ticket, expiresAt };
    }

    /** Đúng vé + đúng IP thì đánh dấu đã dùng và trả thông tin; sai IP không làm mất vé. */
    consume(ticket: string, ip: string): { name: string; botIp: string } | null {
        this.prune();
        const hash = hashTicket(ticket);
        const rec = this.records.get(hash);
        if (!rec || rec.botIp !== normalizeIp(ip)) return null;
        this.records.delete(hash);
        return { name: rec.name, botIp: rec.botIp };
    }

    cancel(botIp: string): void {
        const ip = normalizeIp(botIp);
        for (const [hash, rec] of this.records) if (rec.botIp === ip) this.records.delete(hash);
    }

    /** Bỏ mọi vé đang chờ (đổi workspace: vé tạo ở workspace cũ không được tạo khoá ở workspace mới). */
    clear(): void {
        this.records.clear();
    }

    pending(): { name: string; botIp: string; expiresAt: number }[] {
        this.prune();
        return [...this.records.values()].map(({ name, botIp, expiresAt }) => ({ name, botIp, expiresAt }));
    }

    private prune(): void {
        const t = this.now();
        for (const [hash, rec] of this.records) if (rec.expiresAt <= t) this.records.delete(hash);
    }
}

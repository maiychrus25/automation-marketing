import { X509Certificate, createHash } from 'crypto';

const TEN_YEARS_MS = 10 * 365 * 86_400_000;

export interface ControlCertificate {
    key: string;
    cert: string;
    /** SHA-256 của chứng chỉ DER, hex chữ thường, không dấu hai chấm (64 ký tự). Bridge ghim đúng định dạng này. */
    fingerprintSha256: string;
}

/** Chứng chỉ tự ký RSA-2048, CN `maihub-control`, hạn 10 năm. */
export async function createCertificate(): Promise<ControlCertificate> {
    // Nạp muộn: selfsigned kéo theo @peculiar/x509 + reflect-metadata, không nên nạp khi app khởi động mà API đang tắt.
    const { generate } = await import('selfsigned');
    const notBeforeDate = new Date();
    const pems = await generate([{ name: 'commonName', value: 'maihub-control' }], {
        keySize: 2048,
        algorithm: 'sha256',
        notBeforeDate,
        notAfterDate: new Date(notBeforeDate.getTime() + TEN_YEARS_MS),
    });
    const fingerprintSha256 = createHash('sha256').update(new X509Certificate(pems.cert).raw).digest('hex');
    return { key: pems.private, cert: pems.cert, fingerprintSha256 };
}

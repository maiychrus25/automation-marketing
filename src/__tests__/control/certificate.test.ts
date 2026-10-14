import { X509Certificate, createHash } from 'crypto';
import { createCertificate } from '../../services/control/certificate';

describe('createCertificate', () => {
  it('returns RSA-2048 self-signed cert, CN maihub-control, ~10y, lowercase hex sha256 fingerprint', async () => {
    const { key, cert, fingerprintSha256 } = await createCertificate();
    expect(key).toContain('PRIVATE KEY');
    const x = new X509Certificate(cert);
    expect(x.subject).toContain('CN=maihub-control');
    expect(x.publicKey.asymmetricKeyDetails?.modulusLength).toBe(2048);
    const years = (new Date(x.validTo).getTime() - new Date(x.validFrom).getTime()) / (365 * 86_400_000);
    expect(years).toBeGreaterThan(9.9);
    expect(years).toBeLessThan(10.1);
    expect(fingerprintSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintSha256).toBe(createHash('sha256').update(x.raw).digest('hex'));
  });
});

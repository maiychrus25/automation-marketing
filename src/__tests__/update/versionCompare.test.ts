import { isNewerVersion } from '../../services/update/versionCompare';

describe('isNewerVersion', () => {
    test('bản trên GitHub mới hơn theo patch, minor, major', () => {
        expect(isNewerVersion('26.10.1', '26.10.0')).toBe(true);
        expect(isNewerVersion('26.11.0', '26.10.9')).toBe(true);
        expect(isNewerVersion('27.0.0', '26.99.99')).toBe(true);
    });

    test('so theo số, không theo chữ (26.10.0 mới hơn 26.9.0)', () => {
        expect(isNewerVersion('26.10.0', '26.9.0')).toBe(true);
        expect(isNewerVersion('26.9.0', '26.10.0')).toBe(false);
    });

    test('bằng nhau hoặc cũ hơn thì không phải bản mới', () => {
        expect(isNewerVersion('26.10.0', '26.10.0')).toBe(false);
        expect(isNewerVersion('26.8.5', '26.10.0')).toBe(false);
    });

    test('chấp nhận tiền tố v của thẻ GitHub', () => {
        expect(isNewerVersion('v26.11.0', '26.10.0')).toBe(true);
        expect(isNewerVersion('v26.10.0', 'v26.10.0')).toBe(false);
    });

    test('chuỗi không phải phiên bản thì không bao giờ coi là mới', () => {
        expect(isNewerVersion('', '26.10.0')).toBe(false);
        expect(isNewerVersion('latest', '26.10.0')).toBe(false);
        expect(isNewerVersion('26.11', '26.10.0')).toBe(false);
        expect(isNewerVersion('26.11.0-beta.1', '26.10.0')).toBe(false);
    });
});

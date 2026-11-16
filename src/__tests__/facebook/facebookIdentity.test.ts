import * as fs from 'fs';
import * as path from 'path';
import { FB_SEC_CH_UA, FB_SEC_CH_UA_PLATFORM, FB_USER_AGENT } from '../../services/facebook/facebookIdentity';
import { fbHeaders } from '../../services/facebook/FacebookSession';
import { buildHeaders } from '../../services/facebook/FacebookUtils';

const DIR = path.resolve(__dirname, '../../services/facebook');

describe('one browser identity for every Facebook request', () => {
  // Một phiên đăng nhập (cookie) thuộc về một trình duyệt. Trước 26.40.0 app gửi cùng cookie với ít nhất ba danh tính khác nhau
  // (Chrome 140 và 131 trên Windows ở phần TypeScript, Chrome 141 trên Linux ở bridge Go).
  test('theIdentityIsTheOneTheGoBridgeUses', () => {
    expect(FB_USER_AGENT).toBe('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36');
    expect(FB_SEC_CH_UA).toBe('"Chromium";v="141", "Google Chrome";v="141", "Not-A.Brand";v="99"');
    expect(FB_SEC_CH_UA_PLATFORM).toBe('"Linux"');
  });

  test('theSharedHeaderBuildersUseIt', () => {
    expect(fbHeaders('c=1')).toMatchObject({ 'user-agent': FB_USER_AGENT, 'sec-ch-ua': FB_SEC_CH_UA, 'sec-ch-ua-platform': FB_SEC_CH_UA_PLATFORM });
    expect(buildHeaders('c=1')).toMatchObject({ 'User-Agent': FB_USER_AGENT, 'sec-ch-ua': FB_SEC_CH_UA, 'sec-ch-ua-platform': FB_SEC_CH_UA_PLATFORM });
  });

  // Chặn việc một tệp tự viết lại chuỗi trình duyệt riêng.
  test('noOtherFileInTheFacebookServiceSpellsOutABrowserIdentity', () => {
    const offenders = fs.readdirSync(DIR)
      .filter(f => f.endsWith('.ts') && f !== 'facebookIdentity.ts')
      .filter(f => /Mozilla\/5\.0|sec-ch-ua'?:\s*'"|Chrome\/\d+/.test(fs.readFileSync(path.join(DIR, f), 'utf8')));
    expect(offenders).toEqual([]);
  });
});

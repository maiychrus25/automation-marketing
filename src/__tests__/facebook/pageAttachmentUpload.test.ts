jest.mock('axios');
jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));

import axios from 'axios';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Logger from '../../utils/Logger';
import { uploadPageAttachment } from '../../services/facebook/FacebookAttachment';

// Mọi id, mã phiên và cookie ở đây đều giả.
const SESSION = { pageId: '1000000000003955', userId: '100000000008724', cookieHeader: 'c_user=100000000008724; xs=SECRETXS', agent: 'AGENT', fbDtsg: 'DTSG:SECRET', lsd: 'LSD-SECRET', jazoest: '25999' };
const answer = (metadata: string) => ({ status: 200, data: `for (;;);{"__ar":1,"payload":{"metadata":{"0":${metadata}},"uploadID":"upload_1024"}}` });
const post = axios.post as jest.Mock;
const logged = () => (['log', 'warn', 'error'] as const).flatMap(k => (Logger[k] as jest.Mock).mock.calls).map(c => String(c[0])).join('\n');

describe('uploadPageAttachment', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maihub-page-upload-'));
  const image = path.join(dir, 'anh thu.png');
  beforeAll(() => fs.writeFileSync(image, Buffer.from([1, 2, 3, 4, 5])));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  beforeEach(() => { post.mockReset(); (['log', 'warn', 'error'] as const).forEach(k => (Logger[k] as jest.Mock).mockClear()); });

  // Đúng yêu cầu Business Suite gửi (bản ghi 16/11/2026): mọi tham số nằm trên địa chỉ, thân chỉ có một phần là tệp.
  test('postsTheFileToTheBusinessUploadHostOnBehalfOfThePage', async () => {
    post.mockResolvedValue(answer('{"image_id":1234567890123456,"filename":"x.png","filetype":"image/png","src":"https://x.test/a.png","fbid":1234567890123456}'));
    await expect(uploadPageAttachment(SESSION, image)).resolves.toEqual({ attachmentId: '1234567890123456', attachmentType: 'image/png' });

    const [url, body, config] = post.mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://upload-business.facebook.com/ajax/mercury/upload.php');
    expect(Object.fromEntries(parsed.searchParams)).toMatchObject({
      request_user_id: SESSION.pageId, __user: SESSION.userId, __aaid: '0', __a: '1', __comet_req: '11', fb_dtsg: SESSION.fbDtsg, jazoest: '25999', lsd: SESSION.lsd,
    });
    expect(config.headers).toMatchObject({ Cookie: SESSION.cookieHeader, Origin: 'https://business.facebook.com', Referer: 'https://business.facebook.com/', 'sec-fetch-site': 'same-site' });
    expect(config.headers['Content-Type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(config.httpsAgent).toBe('AGENT');
    const text = (body as Buffer).toString('latin1');
    expect(text.match(/; name="/g)).toHaveLength(1); // một phần duy nhất: tệp
    expect(text).toMatch(/name="upload_\d+"; filename="anh thu\.png"\r\nContent-Type: image\/png\r\n\r\n\x01\x02\x03\x04\x05\r\n--/);
    expect(logged()).not.toMatch(/SECRET/);
  });

  // Mã đính kèm là số 16 chữ số trong JSON: đọc qua kiểu number của JS sẽ sai chữ số cuối.
  test('anIdBeyondDoublePrecisionIsKeptExact', async () => {
    post.mockResolvedValue(answer('{"file_id":9999999999999999,"filename":"a.xml","filetype":"text/xml"}'));
    expect((await uploadPageAttachment(SESSION, image))?.attachmentId).toBe('9999999999999999');
  });

  test('videoAudioAndGifIdsAreReadBeforeTheGenericOne', async () => {
    for (const key of ['video_id', 'audio_id', 'gif_id']) {
      post.mockResolvedValue(answer(`{"fbid":111,"${key}":2222222222222222,"filename":"a","filetype":"x/y"}`));
      expect((await uploadPageAttachment(SESSION, image))?.attachmentId).toBe('2222222222222222');
    }
    post.mockResolvedValue(answer('{"fbid":3333333333333333}'));
    expect((await uploadPageAttachment(SESSION, image))?.attachmentId).toBe('3333333333333333');
  });

  test('eachUploadUsesItsOwnPartName', async () => {
    post.mockResolvedValue(answer('{"file_id":1}'));
    await uploadPageAttachment(SESSION, image);
    await uploadPageAttachment(SESSION, image);
    const names = post.mock.calls.map(c => /name="(upload_\d+)"/.exec((c[1] as Buffer).toString('latin1'))![1]);
    expect(new Set(names).size).toBe(2);
  });

  test('anErrorAnswerANetworkFailureOrAMissingFileGivesNull', async () => {
    post.mockResolvedValue({ status: 200, data: 'for (;;);{"__ar":1,"error":1357004,"errorSummary":"SECRET summary","payload":null}' });
    await expect(uploadPageAttachment(SESSION, image)).resolves.toBeNull();
    post.mockRejectedValue(new Error('socket hang up'));
    await expect(uploadPageAttachment(SESSION, image)).resolves.toBeNull();
    post.mockReset();
    await expect(uploadPageAttachment(SESSION, path.join(dir, 'missing.png'))).resolves.toBeNull();
    expect(post).not.toHaveBeenCalled();
    expect(logged()).toContain('1357004');
    expect(logged()).not.toMatch(/SECRET/);
  });
});

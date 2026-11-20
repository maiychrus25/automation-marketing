import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ThreadType } from 'zca-js';
import ZaloService from '../../services/zalo/ZaloService';

const ffmpeg: string = require('ffmpeg-static');

/** A short synthetic recording in the format the chat window records (webm/opus). */
function makeWebmRecording(dir: string): string {
  const file = path.join(dir, 'paste_1_x.webm');
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'libopus', file]);
  return file;
}

const isAdtsAac = (file: string) => { const b = fs.readFileSync(file); return b.length > 2 && b[0] === 0xff && (b[1] & 0xf0) === 0xf0; };

describe('ZaloService.uploadVoiceFile', () => {
  let dir: string;
  let uploaded: { path: string; aac: boolean; exists: boolean }[];
  let service: any;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-upload-'));
    uploaded = [];
    service = new ZaloService({ cookies: 'c', imei: 'i', userAgent: 'u' } as any);
    service.api = {
      uploadAttachment: jest.fn(async (paths: string[]) => {
        uploaded.push({ path: paths[0], aac: fs.existsSync(paths[0]) && isAdtsAac(paths[0]), exists: fs.existsSync(paths[0]) });
        return [{ fileUrl: 'https://example.invalid/voice.aac' }];
      }),
    };
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('aWebmRecordingIsUploadedAsAacBecauseZaloPlaysVoiceAsAac', async () => {
    const res = await service.uploadVoiceFile(makeWebmRecording(dir), 'u1', ThreadType.User);
    expect(res).toEqual({ fileUrl: 'https://example.invalid/voice.aac' });
    expect(uploaded).toHaveLength(1);
    expect(path.extname(uploaded[0].path)).toBe('.aac');
    expect(uploaded[0].aac).toBe(true);
  });

  test('theConvertedCopyAndItsFolderAreRemovedAfterTheUpload', async () => {
    await service.uploadVoiceFile(makeWebmRecording(dir), 'u1', ThreadType.User);
    expect(fs.existsSync(uploaded[0].path)).toBe(false);
    expect(fs.existsSync(path.dirname(uploaded[0].path))).toBe(false);
  });

  test('theConversionNeverWritesNextToTheRecording', async () => {
    const rec = makeWebmRecording(dir);
    const neighbour = path.join(dir, 'paste_1_x.aac');
    fs.writeFileSync(neighbour, 'keep me');
    await service.uploadVoiceFile(rec, 'u1', ThreadType.User);
    expect(path.dirname(uploaded[0].path)).not.toBe(dir);
    expect(fs.readFileSync(neighbour, 'utf8')).toBe('keep me');
    expect(fs.readdirSync(dir).sort()).toEqual(['paste_1_x.aac', 'paste_1_x.webm']);
  });

  test('theConvertedCopyIsRemovedWhenTheUploadFails', async () => {
    service.api.uploadAttachment = jest.fn(async (paths: string[]) => { uploaded.push({ path: paths[0], aac: true, exists: true }); throw new Error('network'); });
    await expect(service.uploadVoiceFile(makeWebmRecording(dir), 'u1', ThreadType.User)).rejects.toThrow('network');
    expect(fs.existsSync(path.dirname(uploaded[0].path))).toBe(false);
  });

  test('anAacFileIsUploadedAsItIs', async () => {
    const file = path.join(dir, 'already.aac');
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'aac', '-f', 'adts', file]);
    await service.uploadVoiceFile(file, 'u1', ThreadType.User);
    expect(uploaded[0].path).toBe(file);
    expect(fs.existsSync(file)).toBe(true);
  });

  test('aRecordingThatCannotBeConvertedFailsWithAClearMessageAndUploadsNothing', async () => {
    const bad = path.join(dir, 'broken.webm');
    fs.writeFileSync(bad, 'not audio');
    await expect(service.uploadVoiceFile(bad, 'u1', ThreadType.User)).rejects.toThrow('Không chuyển được đoạn ghi âm sang định dạng của Zalo');
    expect(uploaded).toHaveLength(0);
  });
});

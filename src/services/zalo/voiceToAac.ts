// Tin thoại Zalo là âm thanh AAC (zca-js gửi đường dẫn tệp ở trường `m4aUrl`; tin thoại nhận về đều là .aac).
// Cửa sổ chat ghi âm ra webm/opus, nên phải chuyển sang AAC trước khi tải lên.
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import Logger from '../../utils/Logger';

const execFileAsync = promisify(execFile);
const TRANSCODE_TIMEOUT_MS = 60000;

/** ffmpeg đi kèm ứng dụng (ffmpeg-static, được giải nén ra ngoài app.asar). */
function ffmpegBinary(): string {
  const p: string = require('ffmpeg-static');
  return p.includes('app.asar') && !p.includes('app.asar.unpacked') ? p.replace('app.asar', 'app.asar.unpacked') : p;
}

/**
 * Trả tệp AAC để tải lên và hàm dọn dẹp (gọi sau khi dùng xong, kể cả khi tải lên lỗi).
 * Bản chuyển đổi nằm trong một thư mục tạm riêng, không bao giờ ghi cạnh bản ghi âm.
 * Lỗi chuyển đổi ném Error có câu tiếng Việt cho người dùng và không để lại tệp nào.
 */
export async function voiceFileForZalo(inputPath: string): Promise<{ path: string; cleanup: () => void }> {
  if (path.extname(inputPath).toLowerCase() === '.aac') return { path: inputPath, cleanup: () => {} };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maihub-voice-'));
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  const output = path.join(dir, 'voice.aac');
  try {
    // -protocol_whitelist file: chỉ đọc tệp cục bộ đã cho, không theo danh sách phát hay đường dẫn khác bên trong tệp.
    await execFileAsync(ffmpegBinary(), [
      '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file', '-i', inputPath,
      '-vn', '-ac', '1', '-ar', '44100', '-c:a', 'aac', '-b:a', '64k', '-f', 'adts', output,
    ], { timeout: TRANSCODE_TIMEOUT_MS });
  } catch (err: any) {
    cleanup();
    Logger.warn(`[voiceToAac] ffmpeg failed (code=${err?.code ?? '?'} killed=${!!err?.killed})`);
    throw new Error('Không chuyển được đoạn ghi âm sang định dạng của Zalo');
  }
  return { path: output, cleanup };
}

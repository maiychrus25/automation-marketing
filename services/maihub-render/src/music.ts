import { execFile } from 'child_process';

const FADE_SEC = 1;

/** Lặp hoặc cắt nhạc theo `durationSec`, fade 1 giây đầu và cuối, ra M4A (AAC). */
export function prepareMusic(src: string, durationSec: number, out: string, ffmpegPath = 'ffmpeg'): Promise<void> {
  const fade = Math.min(FADE_SEC, durationSec / 2);
  const filter = `afade=t=in:st=0:d=${fade},afade=t=out:st=${Math.max(0, durationSec - fade)}:d=${fade}`;
  const args = ['-y', '-v', 'error', '-stream_loop', '-1', '-i', src, '-t', String(durationSec), '-vn', '-af', filter, '-c:a', 'aac', '-b:a', '160k', out];
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { timeout: 120000 }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`FFmpeg không xử lý được nhạc: ${(stderr || err.message).trim().split('\n').pop()}`));
      else resolve();
    });
  });
}

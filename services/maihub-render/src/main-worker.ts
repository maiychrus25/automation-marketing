import os from 'os';
import path from 'path';
import { RenderWorker } from './worker';

const sharedDir = process.env.SHARED_DIR ?? '/shared';
const root = path.resolve(__dirname, '..');

const worker = new RenderWorker({
  sharedDir,
  templatesDir: process.env.TEMPLATES_DIR ?? path.join(root, 'templates'),
  musicDir: process.env.MUSIC_DIR ?? path.join(root, 'music'),
  tmpRoot: process.env.WORK_DIR ?? path.join(os.tmpdir(), 'render'),
  hyperframesCmd: (process.env.HYPERFRAMES_CMD ?? 'hyperframes').split(' ').filter(Boolean),
  ffmpegPath: process.env.FFMPEG_PATH,
  ffprobePath: process.env.FFPROBE_PATH,
});
worker.start();
console.log(`[worker] Sẵn sàng, theo dõi ${sharedDir}/current`);
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => { worker.stop(); process.exit(0); });

const MB = 1024 * 1024;

/** Giới hạn theo spec §3. */
export const LIMITS = {
  maxDurationSec: 120,
  maxImages: 20,
  maxMediaBytes: 20 * MB, // ảnh hoặc video nguồn
  maxAudioBytes: 15 * MB,
  maxTotalBytes: 200 * MB,
  maxHtmlBytes: 512 * 1024,
  renderTimeoutMs: 15 * 60 * 1000,
  maxQueue: 20,
  maxPendingPerKey: 5,
  maxJobsPerHourPerKey: 30,
  retentionDays: 7,
  fpsOptions: [24, 30] as readonly number[],
  defaultFps: 30,
} as const;

export type Aspect = '9:16' | '1:1' | '16:9';

/** Khổ video [rộng, cao]. */
export const ASPECTS: Record<Aspect, readonly [number, number]> = {
  '9:16': [1080, 1920],
  '1:1': [1080, 1080],
  '16:9': [1920, 1080],
};

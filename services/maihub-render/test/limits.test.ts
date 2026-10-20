import { ASPECTS, LIMITS } from '../src/limits';

describe('limits', () => {
  it('khổ video theo spec', () => {
    expect(ASPECTS['9:16']).toEqual([1080, 1920]);
    expect(ASPECTS['1:1']).toEqual([1080, 1080]);
    expect(ASPECTS['16:9']).toEqual([1920, 1080]);
  });

  it('giới hạn theo spec §3', () => {
    expect(LIMITS.maxDurationSec).toBe(120);
    expect(LIMITS.maxImages).toBe(20);
    expect(LIMITS.maxMediaBytes).toBe(20 * 1024 * 1024);
    expect(LIMITS.maxAudioBytes).toBe(15 * 1024 * 1024);
    expect(LIMITS.maxTotalBytes).toBe(200 * 1024 * 1024);
    expect(LIMITS.maxHtmlBytes).toBe(512 * 1024);
    expect(LIMITS.renderTimeoutMs).toBe(15 * 60 * 1000);
    expect(LIMITS.maxQueue).toBe(20);
    expect(LIMITS.maxPendingPerKey).toBe(5);
    expect(LIMITS.maxJobsPerHourPerKey).toBe(30);
    expect(LIMITS.retentionDays).toBe(7);
    expect(LIMITS.fpsOptions).toEqual([24, 30]);
  });
});

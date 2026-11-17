import { posterRelayEvent, posterEventRunId } from '../../services/http/posterRelayEvents';
import { POSTER_RELAY_CHANNELS } from '../../services/socket/relayAudience';
import { isTelegramRelayPayload } from '../../services/http/telegramRelayEvents';

const MODULE = { kind: 'module', module: 'fb_poster' };

describe('posterRelayEvent', () => {
  it('log goes to its profile with the payload as is', () => {
    const data = { runId: 'r1', profileId: 'p1', level: 'info', message: 'xin chào', at: 1 };
    expect(posterRelayEvent('facebookPoster:log', data)).toEqual({ audience: { kind: 'profiles', ids: ['p1'] }, data });
  });

  it('progress goes to every profile of the run', () => {
    const data = { runId: 'r1', done: 1, total: 3, profiles: [{ profileId: 'p1', done: 1, total: 2 }, { profileId: 'p2', done: 0, total: 1 }] };
    expect(posterRelayEvent('facebookPoster:progress', data)).toEqual({ audience: { kind: 'profiles', ids: ['p1', 'p2'] }, data });
  });

  it('runFinished is reduced to runId and status', () => {
    expect(posterRelayEvent('facebookPoster:runFinished', { runId: 'r1', status: 'done', secret: 'x' })).toEqual({ audience: MODULE, data: { runId: 'r1', status: 'done' } });
  });

  it('schedulesChanged and loginStateChanged carry nothing', () => {
    expect(posterRelayEvent('facebookPoster:schedulesChanged', undefined)).toEqual({ audience: MODULE, data: undefined });
    const states = [{ profileId: 'p1', state: 'logged_in', name: 'Tên hồ sơ' }];
    expect(posterRelayEvent('facebookPoster:loginStateChanged', states)).toEqual({ audience: MODULE, data: [] });
  });

  it('leadsFound keeps only the auto flag: no samples, ids or counts', () => {
    const data = { count: 4, samples: [{ authorName: 'A', text: 'mua', postUrl: 'u' }], auto: true, leadIds: [1, 2], campaignIds: ['c1'] };
    const out = posterRelayEvent('facebookPoster:leadsFound', data)!;
    expect(out).toEqual({ audience: MODULE, data: { count: 0, samples: [], auto: true, leadIds: [], campaignIds: [] } });
    expect(JSON.stringify(out.data)).not.toContain('mua');
    expect((posterRelayEvent('facebookPoster:leadsFound', { auto: 'yes' })!.data as any).auto).toBe(false);
  });

  it.each(['facebookPoster:trackProgress', 'facebookPoster:commentCollectProgress', 'facebookPoster:loginCheckProgress'])('%s keeps numeric keys and jobId only', (channel) => {
    const out = posterRelayEvent(channel, { jobId: 'j1', done: 2, total: 5, label: 'Bình luận của khách', profileName: 'Hồ sơ A', nan: NaN });
    expect(out).toEqual({ audience: MODULE, data: { jobId: 'j1', done: 2, total: 5 } });
  });

  it('loginCheckProgress null (check finished) is relayed so the progress bar can clear', () => {
    expect(posterRelayEvent('facebookPoster:loginCheckProgress', null)).toEqual({ audience: MODULE, data: null });
  });

  it.each(['facebookPoster:trackFinished', 'facebookPoster:commentCollectFinished'])('%s is reduced to jobId, auto, cancelled', (channel) => {
    const out = posterRelayEvent(channel, { jobId: 'j1', auto: true, cancelled: false, posts: 9, errors: 2, text: 'bình luận' });
    expect(out).toEqual({ audience: MODULE, data: { jobId: 'j1', auto: true, cancelled: false } });
  });

  it.each(['facebookPoster:scheduleMissed', 'browserProfile:statusChanged', 'browserProfile:engineProgress', 'engagement.changed', 'autonomy.changed', 'facebookPoster:nope'])('%s is not relayed', (channel) => {
    expect(posterRelayEvent(channel, { profileId: 'p1', runId: 'r1' })).toBeNull();
  });

  it('a payload of an unexpected shape is not relayed', () => {
    for (const bad of [null, undefined, 'x', 7, [], {}]) {
      expect(posterRelayEvent('facebookPoster:log', bad)).toBeNull();
      expect(posterRelayEvent('facebookPoster:progress', bad)).toBeNull();
    }
    expect(posterRelayEvent('facebookPoster:log', { runId: 'r1', profileId: '' })).toBeNull();
    expect(posterRelayEvent('facebookPoster:progress', { runId: 'r1', profiles: [] })).toBeNull();
    expect(posterRelayEvent('facebookPoster:progress', { runId: 'r1', profiles: [{ profileId: 'p1' }, { done: 1 }] })).toBeNull();
    expect(posterRelayEvent('facebookPoster:runFinished', { status: 'done' })).toBeNull();
    for (const channel of ['facebookPoster:trackProgress', 'facebookPoster:trackFinished', 'facebookPoster:commentCollectProgress', 'facebookPoster:commentCollectFinished', 'facebookPoster:leadsFound']) {
      expect(posterRelayEvent(channel, 'x')).toBeNull();
    }
  });

  it('every channel of the relay list is handled', () => {
    const samples: Record<string, unknown> = {
      'facebookPoster:log': { runId: 'r', profileId: 'p' }, 'facebookPoster:progress': { runId: 'r', profiles: [{ profileId: 'p' }] },
      'facebookPoster:runFinished': { runId: 'r', status: 'done' }, 'facebookPoster:schedulesChanged': undefined, 'facebookPoster:loginStateChanged': [],
      'facebookPoster:loginCheckProgress': { done: 1, total: 2 }, 'facebookPoster:leadsFound': {}, 'facebookPoster:trackProgress': {},
      'facebookPoster:trackFinished': {}, 'facebookPoster:commentCollectProgress': {}, 'facebookPoster:commentCollectFinished': {},
    };
    expect(Object.keys(samples).sort()).toEqual([...POSTER_RELAY_CHANNELS].sort());
    for (const c of POSTER_RELAY_CHANNELS) expect(posterRelayEvent(c, samples[c])).not.toBeNull();
  });
});

describe('employee main process', () => {
  it('no poster payload is mistaken for a Telegram payload (which skips the generic forward path)', () => {
    const payloads = [{ runId: 'r', profileId: 'p', message: 'x' }, { runId: 'r', profiles: [{ profileId: 'p' }] }, { jobId: 'j', done: 1 }, { runId: 'r', status: 'done' }];
    for (const data of payloads) expect(isTelegramRelayPayload(data, new Set(['p', 'r', 'j']))).toBe(false);
  });
});

describe('posterEventRunId', () => {
  it('reads the run of log, progress and runFinished only', () => {
    expect(posterEventRunId('facebookPoster:log', { runId: 'r1' })).toBe('r1');
    expect(posterEventRunId('facebookPoster:progress', { runId: 'r2' })).toBe('r2');
    expect(posterEventRunId('facebookPoster:runFinished', { runId: 'r3' })).toBe('r3');
    expect(posterEventRunId('facebookPoster:trackProgress', { runId: 'r4' })).toBeNull();
    expect(posterEventRunId('facebookPoster:log', { runId: '' })).toBeNull();
    expect(posterEventRunId('facebookPoster:log', null)).toBeNull();
  });
});

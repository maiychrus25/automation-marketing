import { memoryDb } from '../facebookPoster/helpers';
import { ControlStore, CONTROL_SCHEMA_SQL } from '../../services/control/ControlStore';
import { IdempotencyCache } from '../../services/control/IdempotencyCache';

function make(now = () => 1000) {
  const db = memoryDb();
  db.exec(CONTROL_SCHEMA_SQL);
  const store = new ControlStore(db);
  return { store, cache: new IdempotencyCache(store, now) };
}

describe('IdempotencyCache', () => {
  it('without idem key always runs fn', async () => {
    const { cache } = make();
    const fn = jest.fn(async () => 1);
    await cache.run('k', undefined, fn); await cache.run('k', undefined, fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });
  it('concurrent same key shares one call', async () => {
    const { cache } = make();
    let release!: () => void;
    const fn = jest.fn(() => new Promise<{ v: number }>((r) => { release = () => r({ v: 7 }); }));
    const p1 = cache.run('k', 'i', fn); const p2 = cache.run('k', 'i', fn);
    release();
    expect(await p1).toEqual({ v: 7 }); expect(await p2).toEqual({ v: 7 });
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it('replays persisted result within 24h, reruns after', async () => {
    let t = 1000;
    const { cache } = make(() => t);
    const fn = jest.fn(async () => ({ n: fn.mock.calls.length }));
    expect(await cache.run('k', 'i', fn)).toEqual({ n: 1 });
    expect(await cache.run('k', 'i', fn)).toEqual({ n: 1 });
    expect(await cache.run('other', 'i', fn)).toEqual({ n: 2 });
    t += 24 * 3600_000 + 1;
    expect(await cache.run('k', 'i', fn)).toEqual({ n: 3 });
  });
  it('failure stores nothing and clears in-flight', async () => {
    const { cache, store } = make();
    const bad = jest.fn(async () => { throw new Error('boom'); });
    await expect(cache.run('k', 'i', bad)).rejects.toThrow('boom');
    expect(store.getIdempotent('k', 'i')).toBeNull();
    expect(await cache.run('k', 'i', async () => 'ok')).toBe('ok');
  });
  it('undefined result is stored and not re-run', async () => {
    const { cache } = make();
    const fn = jest.fn(async () => undefined);
    expect(await cache.run('k', 'i', fn)).toBeUndefined();
    expect(await cache.run('k', 'i', fn)).toBeNull();
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it('non-serializable result still resolves', async () => {
    const { cache } = make();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await cache.run('k', 'i', async () => BigInt(5))).toBe(BigInt(5));
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

import Logger from '../../utils/Logger';
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
    await cache.run('k', 'm', undefined, fn); await cache.run('k', 'm', undefined, fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });
  it('concurrent same key shares one call', async () => {
    const { cache } = make();
    let release!: () => void;
    const fn = jest.fn(() => new Promise<{ v: number }>((r) => { release = () => r({ v: 7 }); }));
    const p1 = cache.run('k', 'm', 'i', fn); const p2 = cache.run('k', 'm', 'i', fn);
    release();
    expect(await p1).toEqual({ v: 7 }); expect(await p2).toEqual({ v: 7 });
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it('replays persisted result within 24h, reruns after', async () => {
    let t = 1000;
    const { cache } = make(() => t);
    const fn = jest.fn(async () => ({ n: fn.mock.calls.length }));
    expect(await cache.run('k', 'm', 'i', fn)).toEqual({ n: 1 });
    expect(await cache.run('k', 'm', 'i', fn)).toEqual({ n: 1 });
    expect(await cache.run('other', 'm', 'i', fn)).toEqual({ n: 2 });
    t += 24 * 3600_000 + 1;
    expect(await cache.run('k', 'm', 'i', fn)).toEqual({ n: 3 });
  });
  it('rejects reuse of an idempotency key by another method (persisted and in flight)', async () => {
    const { cache } = make();
    const fn = jest.fn(async () => 1);
    await cache.run('k', 'drafts.create', 'i', fn);
    await expect(cache.run('k', 'runs.cancel', 'i', fn)).rejects.toMatchObject({ code: 'INVALID_PARAMS', details: { field: 'idempotencyKey' } });
    expect(await cache.run('k', 'drafts.create', 'i', fn)).toBe(1);
    expect(fn).toHaveBeenCalledTimes(1);
    let release!: () => void;
    const slow = cache.run('k', 'a', 'j', () => new Promise<number>((r) => { release = () => r(2); }));
    await expect(cache.run('k', 'b', 'j', fn)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    release();
    expect(await slow).toBe(2);
  });
  it('treats legacy rows without a method as matching, and a different method after 24h as fresh', async () => {
    let t = 1000;
    const { cache, store } = make(() => t);
    store.putIdempotent('k', 'old', '', '5', t);
    expect(await cache.run('k', 'any', 'old', async () => 9)).toBe(5);
    await cache.run('k', 'a', 'i', async () => 1);
    t += 24 * 3600_000 + 1;
    expect(await cache.run('k', 'b', 'i', async () => 2)).toBe(2);
  });
  it('failure stores nothing and clears in-flight', async () => {
    const { cache, store } = make();
    const bad = jest.fn(async () => { throw new Error('boom'); });
    await expect(cache.run('k', 'm', 'i', bad)).rejects.toThrow('boom');
    expect(store.getIdempotent('k', 'i')).toBeNull();
    expect(await cache.run('k', 'm', 'i', async () => 'ok')).toBe('ok');
  });
  it('undefined result is stored and not re-run', async () => {
    const { cache } = make();
    const fn = jest.fn(async () => undefined);
    expect(await cache.run('k', 'm', 'i', fn)).toBeUndefined();
    expect(await cache.run('k', 'm', 'i', fn)).toBeNull();
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it('non-serializable result still resolves', async () => {
    const { cache } = make();
    const warn = jest.spyOn(Logger, 'warn').mockImplementation(() => {});
    expect(await cache.run('k', 'm', 'i', async () => BigInt(5))).toBe(BigInt(5));
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('IdempotencyCache scoped fingerprints', () => {
  it('sameIdempotencyKeyDifferentPayloadConflicts for saved and pending results', async () => {
    const { cache } = make();
    const run = cache.run.bind(cache) as any;
    expect(await run('k', 'm', 'i', async () => 1, 'hash-a')).toBe(1);
    await expect(run('k', 'm', 'i', async () => 2, 'hash-b')).rejects.toMatchObject({ code: 'CONFLICT' });
    let release!: (v: number) => void;
    const first = run('k', 'm', 'pending', () => new Promise<number>((r) => { release = r; }), 'hash-a');
    await expect(run('k', 'm', 'pending', async () => 2, 'hash-b')).rejects.toMatchObject({ code: 'CONFLICT' });
    release(7);
    expect(await first).toBe(7);
  });
  it('never replays a legacy row lacking fingerprint for a scoped request', async () => {
    const { store, cache } = make();
    store.putIdempotent('k', 'old', 'm', '123', 1000);
    await expect((cache.run as any)('k', 'm', 'old', async () => 2, 'scoped')).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await cache.run('k', 'm', 'old', async () => 2)).toBe(123);
  });
});

describe('IdempotencyCache durable replay',()=>{
  it('returns validated durable result and never falls back after a replay rejection',async()=>{
    const {cache,store}=make();await cache.run('key','optimize','saved',async()=>({id:'cached'}),'hash');
    expect(await cache.run('key','optimize','saved',async()=>({id:'unexpected'}),'hash',()=>{},async()=>({id:'durable'}))).toEqual({id:'durable'});
    await expect(cache.run('key','optimize','saved',async()=>({id:'unexpected'}),'hash',()=>{},async()=>{throw new Error('source pruned');})).rejects.toThrow('source pruned');
    expect(store.getIdempotent('key','saved')!.result).toBe('{"id":"cached"}');
    for(const [method,hash] of [['other','hash'],['optimize','different']]){
      await expect(cache.run('key',method,'saved',async()=>0,hash,()=>{},async()=>{throw new Error('must not replay collision');})).rejects.toMatchObject({code:'CONFLICT'});
    }
  });
  it('rechecks current authorization after the awaited durable replay',async()=>{
    const {cache}=make();await cache.run('key','optimize','saved',async()=>7,'hash');
    let current=true;const guard=()=>{if(!current)throw new Error('revoked during replay');};
    await expect(cache.run('key','optimize','saved',async()=>8,'hash',guard,async()=>{queueMicrotask(()=>current=false);return 7;})).rejects.toThrow('revoked during replay');
  });
});

describe('IdempotencyCache authorization lifetime', () => {
  it('guards the fn completion-to-cache continuation gap before accessing storage', async () => {
    const { cache, store } = make();
    let current = true;
    const assertCurrent = () => { if (!current) throw new Error('workspace switched'); };
    const pending = (cache.run as any)('k', 'm', 'gap', async () => {
      // Runs after the operation returned, before the cache continuation resumes.
      queueMicrotask(() => { current = false; });
      return { secret: true };
    }, 'hash', assertCurrent);
    await expect(pending).rejects.toThrow('workspace switched');
    expect(store.getIdempotent('k', 'gap')).toBeNull();
  });
  it('revalidates each in-flight waiter rather than inheriting the first callers permission', async () => {
    const { cache, store } = make();
    let release!: (v: number) => void;
    const run = cache.run.bind(cache) as any;
    const first = run('k', 'm', 'wait', () => new Promise<number>((r) => { release = r; }), 'hash', () => {});
    let waiterCurrent = true;
    const second = run('k', 'm', 'wait', async () => 9, 'hash', () => { if (!waiterCurrent) throw new Error('revoked waiter'); });
    waiterCurrent = false;
    release(7);
    expect(await first).toBe(7);
    await expect(second).rejects.toThrow('revoked waiter');
    expect(store.getIdempotent('k', 'wait')?.result).toBe('7');
  });
  it('guards before saved result lookup and fresh execution', async () => {
    const { cache, store } = make();
    const get = jest.spyOn(store, 'getIdempotent');
    const fn = jest.fn(async () => 1);
    for (const idem of ['saved', undefined]) {
      await expect((cache.run as any)('k', 'm', idem, fn, 'hash', () => { throw new Error('stale'); })).rejects.toThrow('stale');
    }
    expect(get).not.toHaveBeenCalled();
    expect(fn).not.toHaveBeenCalled();
  });
});

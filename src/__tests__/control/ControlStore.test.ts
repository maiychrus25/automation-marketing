import { memoryDb } from '../facebookPoster/helpers';
import { ControlStore, CONTROL_SCHEMA_SQL } from '../../services/control/ControlStore';
import { hashKey } from '../../services/control/controlSecurity';

const DAY = 86_400_000;
function make() {
  const db = memoryDb();
  db.exec(CONTROL_SCHEMA_SQL);
  return { db, store: new ControlStore(db) };
}
const audit = (at: number) => ({ at, keyName: 'k', ip: '1.1.1.1', method: 'm', paramsSummary: '{}', ok: true, errorCode: null, durationMs: 5 });

describe('ControlStore keys', () => {
  it('createKey returns raw key once; only hash stored', () => {
    const { db, store } = make();
    const k = store.createKey('bot');
    expect(k.key).toMatch(/^mh_/);
    const raw = db.query<any>('SELECT * FROM control_keys');
    expect(raw[0].key_hash).toBe(hashKey(k.key));
    expect(JSON.stringify(raw)).not.toContain(k.key);
    expect(JSON.stringify(store.listKeys())).not.toContain('hash');
    expect(store.listKeys()[0]).toMatchObject({ id: k.id, name: 'bot', revokedAt: null });
  });
  it('findActiveKeyByHash, touchKey, revokeKey', () => {
    const { store } = make();
    const k = store.createKey('bot');
    expect(store.findActiveKeyByHash(hashKey(k.key))).toEqual({ id: k.id, name: 'bot' });
    expect(store.findActiveKeyByHash(hashKey('mh_nope'))).toBeNull();
    store.touchKey(k.id, 1234);
    expect(store.listKeys()[0].lastUsedAt).toBe(1234);
    expect(store.revokeKey(k.id)).toBe(true);
    expect(store.revokeKey(k.id)).toBe(false);
    expect(store.revokeKey('missing')).toBe(false);
    expect(store.findActiveKeyByHash(hashKey(k.key))).toBeNull();
    expect(store.listKeys()[0].revokedAt).not.toBeNull();
  });
});

describe('ControlStore audit/events/idempotency', () => {
  it('audit lists newest first with limit', () => {
    const { store } = make();
    store.addAudit(audit(1)); store.addAudit(audit(2)); store.addAudit(audit(3));
    expect(store.listAudit(2).map((a) => a.at)).toEqual([3, 2]);
    expect(store.listAudit(1)[0].ok).toBe(true);
  });
  it('events get increasing seq and listEventsAfter pages', () => {
    const { store } = make();
    const a = store.addEvent('x', { n: 1 });
    const b = store.addEvent('y', { n: 2 });
    expect(b).toBeGreaterThan(a);
    expect(store.listEventsAfter(0, 10).map((e) => e.type)).toEqual(['x', 'y']);
    expect(store.listEventsAfter(a, 10)).toEqual([{ seq: b, type: 'y', payload: { n: 2 }, createdAt: expect.any(Number) }]);
    expect(store.listEventsAfter(0, 1)).toHaveLength(1);
  });
  it('idempotency get/put', () => {
    const { store } = make();
    expect(store.getIdempotent('k', 'i')).toBeNull();
    store.putIdempotent('k', 'i', '{"a":1}', 100);
    expect(store.getIdempotent('k', 'i')).toEqual({ result: '{"a":1}', createdAt: 100 });
  });
  it('pruneOld applies retention windows and 5000 cap', () => {
    const { db, store } = make();
    const now = 100 * DAY;
    store.addAudit(audit(now - 31 * DAY)); store.addAudit(audit(now - 29 * DAY));
    db.run('INSERT INTO control_events (type, payload, created_at) VALUES (?,?,?)', ['old', '{}', now - 8 * DAY]);
    db.run('INSERT INTO control_events (type, payload, created_at) VALUES (?,?,?)', ['new', '{}', now - 6 * DAY]);
    store.putIdempotent('k', 'old', '1', now - 25 * 3600_000);
    store.putIdempotent('k', 'new', '1', now - 23 * 3600_000);
    store.pruneOld(now);
    expect(store.listAudit(10)).toHaveLength(1);
    expect(store.listEventsAfter(0, 10).map((e) => e.type)).toEqual(['new']);
    expect(store.getIdempotent('k', 'old')).toBeNull();
    expect(store.getIdempotent('k', 'new')).not.toBeNull();
    db.transaction(() => { for (let i = 0; i < 5100; i++) db.run('INSERT INTO control_events (type, payload, created_at) VALUES (?,?,?)', ['e', '{}', now]); });
    store.pruneOld(now);
    const rows = store.listEventsAfter(0, 10000);
    expect(rows).toHaveLength(5000);
    expect(rows[rows.length - 1].seq).toBeGreaterThan(5100);
  });
});

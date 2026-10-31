import { memoryDb } from '../facebookPoster/helpers';
import { ControlStore, CONTROL_MIGRATIONS, CONTROL_SCHEMA_SQL } from '../../services/control/ControlStore';
import { hashKey } from '../../services/control/controlSecurity';

const DAY = 86_400_000;
function make() {
  const db = memoryDb();
  db.exec(CONTROL_SCHEMA_SQL);
  return { db, store: new ControlStore(db) };
}
const audit = (at: number) => ({ at, keyName: 'k', ip: '1.1.1.1', method: 'm', paramsSummary: '{}', ok: true, errorCode: null, durationMs: 5 });

describe('ControlStore keys', () => {
  it('active ID reader never exposes key material and fails closed on corrupt or revoked policies', () => {
    const {db, store} = make();
    expect(typeof (store as any).findActiveKeyById).toBe('function');
    const policy = {kind:'page_runner' as const, workspaceId:'workspace', assignments:[{pageId:'page', profileIds:['profile']}]};
    const key = store.createKey('Scoped', policy);
    expect((store as any).findActiveKeyById(key.id)).toEqual({id:key.id, policy});
    db.run('UPDATE control_keys SET policy_json = ? WHERE id = ?', ['{}', key.id]);
    expect((store as any).findActiveKeyById(key.id)).toBeNull();
    const legacy = store.createKey('Legacy'); expect((store as any).findActiveKeyById(legacy.id)).toEqual({id:legacy.id});
    store.revokeKey(legacy.id); expect((store as any).findActiveKeyById(legacy.id)).toBeNull();
    expect((store as any).findActiveKeyById('missing')).toBeNull();
  });
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
  it('lastEventSeq is 0 when empty and the newest seq afterwards', () => {
    const { store } = make();
    expect(store.lastEventSeq()).toBe(0);
    store.addEvent('x', {}); store.addEvent('y', {});
    const last = store.addEvent('z', {});
    expect(store.lastEventSeq()).toBe(last);
  });
  it('idempotency get/put', () => {
    const { store } = make();
    expect(store.getIdempotent('k', 'i')).toBeNull();
    store.putIdempotent('k', 'i', 'drafts.create', '{"a":1}', 100);
    expect(store.getIdempotent('k', 'i')).toEqual({ result: '{"a":1}', createdAt: 100, method: 'drafts.create' });
  });
  it('idempotency keeps the method, replaces on re-put, and the ALTER migration is idempotent on an old table', () => {
    const { db, store } = make();
    store.putIdempotent('k', 'i', 'a', '1', 1);
    store.putIdempotent('k', 'i', 'b', '2', 2);
    expect(store.getIdempotent('k', 'i')).toEqual({ result: '2', createdAt: 2, method: 'b' });
    const old = memoryDb();
    old.exec("CREATE TABLE control_idempotency (key_id TEXT NOT NULL, idem_key TEXT NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (key_id, idem_key))");
    old.run("INSERT INTO control_idempotency VALUES ('k','i','7',5)");
    old.exec("CREATE TABLE control_keys (id TEXT PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER)");
    for (const sql of CONTROL_MIGRATIONS) old.exec(sql);
    expect(new ControlStore(old).getIdempotent('k', 'i')).toEqual({ result: '7', createdAt: 5, method: '' });
    expect(() => old.exec(CONTROL_MIGRATIONS[0])).toThrow();
    void db;
  });
  it('pruneOld applies retention windows and 5000 cap', () => {
    const { db, store } = make();
    const now = 100 * DAY;
    store.addAudit(audit(now - 31 * DAY)); store.addAudit(audit(now - 29 * DAY));
    db.run('INSERT INTO control_events (type, payload, created_at) VALUES (?,?,?)', ['old', '{}', now - 8 * DAY]);
    db.run('INSERT INTO control_events (type, payload, created_at) VALUES (?,?,?)', ['new', '{}', now - 6 * DAY]);
    store.putIdempotent('k', 'old', 'm', '1', now - 25 * 3600_000);
    store.putIdempotent('k', 'new', 'm', '1', now - 23 * 3600_000);
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

describe('ControlStore scoped policies', () => {
  const policy = () => ({ kind: 'page_runner', workspaceId: 'ws1', assignments: [{ pageId: 'page1', profileIds: ['p1'] }] });
  it('persists a detached scoped policy without changing the legacy key response', () => {
    const { db, store } = make();
    const input = policy();
    const key = (store.createKey as any)('same name', input);
    input.assignments[0].profileIds.push('other');
    expect(store.findActiveKeyByHash(hashKey(key.key))).toEqual({ id: key.id, name: 'same name', policy: policy() });
    expect(store.listKeys()[0]).toMatchObject({ policy: policy() });
    expect(JSON.stringify(db.query('SELECT * FROM control_keys'))).not.toContain(key.key);
  });
  it.each([
    { ...policy(), workspaceId: '' },
    { ...policy(), assignments: [] },
    { ...policy(), assignments: [{ pageId: 'page1', profileIds: [] }] },
    { ...policy(), assignments: [{ pageId: 'page1', profileIds: ['p1', 'p1'] }] },
    { ...policy(), assignments: [{ pageId: 'page1', profileIds: ['p1'] }, { pageId: 'page2', profileIds: ['p1'] }] },
    { ...policy(), ownerChatId: '1', ownerSenderId: '2' },
    { ...policy(), keyId: 'forged' },
    { ...policy(), kind: 'page_receiver', ownerChatId: '-100', ownerSenderId: 123 },
    { ...policy(), kind: 'page_receiver', ownerChatId: '-100', ownerSenderId: '1.2' },
  ])('rejects invalid policy before inserting a key: %j', (bad) => {
    const { store } = make();
    expect(() => (store.createKey as any)('bad', bad)).toThrow();
    expect(store.listKeys()).toEqual([]);
  });
  it('retains exact large Telegram IDs and fails closed on malformed stored policies', () => {
    const { db, store } = make();
    const input = { ...policy(), kind: 'page_receiver', ownerChatId: '-1009007199254740993123', ownerSenderId: '9007199254740993123' };
    const key = (store.createKey as any)('receiver', input);
    expect(store.findActiveKeyByHash(hashKey(key.key))).toMatchObject({ policy: input });
    for (const value of ['{', '{}', 'null', '"legacy"']) {
      db.run('UPDATE control_keys SET policy_json = ? WHERE id = ?', [value, key.id]);
      expect(store.findActiveKeyByHash(hashKey(key.key))).toBeNull();
    }
  });
});

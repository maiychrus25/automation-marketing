import { parseThreadListPage } from '../../services/facebook/FacebookThreadManager';

const node = (i: number, ts: number) => ({
  thread_key: { thread_fbid: String(1000 + i) }, name: `T${i}`, all_participants: { edges: [] },
  updated_time_precise: String(ts),
});
const wrap = (nodes: any[]) => JSON.stringify({ o0: { data: { viewer: { message_threads: { nodes } } } } });

describe('parseThreadListPage', () => {
  test('fullPageGivesNextBeforeAndActivity', () => {
    const nodes = Array.from({ length: 50 }, (_, i) => node(i, 2_000_000 - i * 10));
    const page = parseThreadListPage(wrap(nodes), 'acc', '1', 50);
    expect(page.threads).toHaveLength(50);
    expect(page.nextBefore).toBe(2_000_000 - 49 * 10 - 1);
    expect(page.threads[0].lastActivityMs).toBe(2_000_000);
    expect(page.threads[3].lastActivityMs).toBe(2_000_000 - 30);
    expect(page.error).toBeUndefined();
  });
  test('shortPageEnds', () => {
    const page = parseThreadListPage(wrap([node(0, 5), node(1, 4), node(2, 3)]), 'acc', '1', 50);
    expect(page.threads).toHaveLength(3);
    expect(page.nextBefore).toBeNull();
  });
  test('graphqlErrorReturned', () => {
    const page = parseThreadListPage(JSON.stringify({ o0: { error: { summary: 'Rate limited' } } }), 'acc', '1', 50);
    expect(page).toEqual({ threads: [], nextBefore: null, error: 'Rate limited' });
  });
  test('brokenJsonReturnsErrorWithoutThrowing', () => {
    const page = parseThreadListPage('{not json', 'acc', '1', 50);
    expect(page.threads).toEqual([]);
    expect(page.nextBefore).toBeNull();
    expect(typeof page.error).toBe('string');
  });
  test('fullPageWithLastNodeMissingTimestampUsesOldestOther', () => {
    const nodes = Array.from({ length: 3 }, (_, i) => node(i, 900 - i * 100));
    delete (nodes[2] as any).updated_time_precise;
    const page = parseThreadListPage(wrap(nodes), 'acc', '1', 3);
    expect(page.nextBefore).toBe(800 - 1);
  });
  test('fullPageWithNoTimestampsEnds', () => {
    const nodes = Array.from({ length: 2 }, (_, i) => ({ ...node(i, 1), updated_time_precise: undefined }));
    expect(parseThreadListPage(wrap(nodes), 'acc', '1', 2).nextBefore).toBeNull();
  });
});

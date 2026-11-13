import { parseThreadNodes } from '../../services/facebook/FacebookThreadManager';

const actor = (id: string, name: string, img?: string) => ({
  node: { messaging_actor: { id, name, big_image_src: img ? { uri: img } : undefined } },
});
const run = (node: any, self = '100') => parseThreadNodes(
  JSON.stringify({ o0: { data: { viewer: { message_threads: { nodes: [node] } } } } }), 'acc', self,
)[0];
const group = (over: any = {}) => ({ thread_key: { thread_fbid: '900' }, all_participants: { edges: [] }, ...over });
const direct = (over: any = {}) => ({ thread_key: { other_user_id: '200' }, all_participants: { edges: [] }, ...over });

describe('parseThreadNodes names and avatars', () => {
  test('unnamedGroupWithNoOthers', () => {
    expect(run(group({ all_participants: { edges: [actor('100', 'Tôi')] } })).name).toBe('Nhóm không tên');
  });
  test('unnamedDirectWithoutOther', () => {
    expect(run(direct()).name).toBe('Không có tên');
  });
  test('directUsesOtherParticipantEvenWhenSelfListedFirst', () => {
    const t = run(direct({ all_participants: { edges: [actor('100', 'Tôi', 'self.jpg'), actor('200', 'Người A', 'a.jpg')] } }));
    expect(t.name).toBe('Người A');
    expect(t.metadata?.avatar_url).toBe('a.jpg');
  });
  test('directNeverFallsBackToSelf', () => {
    const t = run(direct({ name: 'Tên nút', image: { uri: 'thread.jpg' }, all_participants: { edges: [actor('100', 'Tôi', 'self.jpg')] } }));
    expect(t.name).toBe('Tên nút');
    expect(t.metadata?.avatar_url).toBe('thread.jpg');
  });
  test('directMissingOtherAvatarUsesThreadImage', () => {
    const t = run(direct({ image: { uri: 'thread.jpg' }, all_participants: { edges: [actor('200', 'Người A')] } }));
    expect(t.name).toBe('Người A');
    expect(t.metadata?.avatar_url).toBe('thread.jpg');
  });
  test('numericParticipantIdsCompareAsStrings', () => {
    const edges = [{ node: { messaging_actor: { id: 100, name: 'Tôi' } } }, actor('200', 'Người A')];
    expect(run(direct({ all_participants: { edges } }), '100').name).toBe('Người A');
  });
});

describe('parseThreadNodes unread count', () => {
  test.each([
    [{ unread_count: 3 }, 3],
    [{ unreadCount: 2 }, 2],
    [{}, 0],
    [{ unread_count: -4 }, 0],
    [{ unread_count: 'abc' }, 0],
    [{ unread_count: 2.9 }, 2],
  ])('%j -> %d', (over, expected) => {
    expect(run(group(over)).unread_count).toBe(expected);
  });
});

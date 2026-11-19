import { parseExportChat } from '../../../services/facebook/e2eeExport/exportParser';

const T = 1_700_000_000_000;
const base = { participants: ['Alice Example', 'Bob Example'], threadName: 'Alice Example' };

describe('parseExportChat', () => {
  it('parses a valid chat and sorts messages by timestamp', () => {
    const chat = parseExportChat(JSON.stringify({
      ...base,
      messages: [
        { senderName: 'Bob Example', text: 'hello-2', timestamp: T + 2000, type: 'text', isUnsent: false },
        { senderName: 'Alice Example', text: 'hello-1', timestamp: T + 1000, type: 'text', isUnsent: false,
          reactions: [{ actor: 'Bob Example', reaction: '❤' }, { actor: 5 }] },
        { senderName: 'Alice Example', timestamp: T + 3000, type: 'media', media: [{ uri: 'media/a.jpg' }, { nope: 1 }], isUnsent: true },
      ],
    }))!;
    expect(chat.participants).toEqual(['Alice Example', 'Bob Example']);
    expect(chat.messages.map(m => m.text)).toEqual(['hello-1', 'hello-2', '']);
    expect(chat.messages[0].reactions).toEqual([{ actor: 'Bob Example', reaction: '❤' }]);
    expect(chat.messages[2]).toMatchObject({ isUnsent: true, media: ['media/a.jpg'] });
    expect(chat.malformedSkipped).toBe(0);
  });

  it('ignores unknown fields and tolerates optional ones missing', () => {
    const chat = parseExportChat(JSON.stringify({ messages: [{ senderName: 'Alice Example', text: 'hello-1', timestamp: T, extra: { x: 1 } }], other: 1 }))!;
    expect(chat.messages).toHaveLength(1);
    expect(chat.participants).toEqual([]);
    expect(chat.threadName).toBe('');
  });

  it('skips malformed messages and counts them', () => {
    const chat = parseExportChat(JSON.stringify({
      ...base,
      messages: [
        null, 'x', { senderName: 'Alice Example', text: 'no-timestamp' }, { senderName: 'Alice Example', text: 'bad', timestamp: 'soon' },
        { senderName: 5, text: 'no-sender', timestamp: T + 7 }, { senderName: 'Alice Example', text: '', timestamp: T + 9 },
        { senderName: 'Alice Example', text: 'ok', timestamp: T + 10 },
      ],
    }))!;
    expect(chat.messages.map(m => m.text)).toEqual(['ok']);
    expect(chat.malformedSkipped).toBe(6);
  });

  it('treats timestamps that are not integers between 2004 and tomorrow as malformed', () => {
    const at = (timestamp: number) => ({ senderName: 'Alice Example', text: 'x', timestamp });
    const chat = parseExportChat(JSON.stringify({ ...base, messages: [at(T), at(T + 0.5), at(1_000_000), at(Date.now() + 2 * 86_400_000), at(1_072_915_199_999)] }))!;
    expect(chat.messages).toHaveLength(1);
    expect(chat.malformedSkipped).toBe(4);
  });

  it.each([['not json'], ['[]'], ['null'], ['"x"'], [JSON.stringify({ participants: [], messages: 'nope' })], [JSON.stringify({ participants: [] })]])(
    'rejects wrong top level %s', (text) => { expect(parseExportChat(text)).toBeNull(); });
});

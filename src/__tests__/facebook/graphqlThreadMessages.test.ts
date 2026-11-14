import { parseGraphQLMessageNode } from '../../services/facebook/FacebookThreadManager';

const base = (over: any = {}) => ({
  message_id: 'mid.$1', timestamp_precise: '1700000000000',
  message_sender: { id: '200', name: 'Người A' }, ...over,
});

describe('parseGraphQLMessageNode', () => {
  test('textMessage', () => {
    const m = parseGraphQLMessageNode(base({ message: undefined, body: 'xin chào' }));
    expect(m).toMatchObject({
      id: 'mid.$1', body: 'xin chào', isAdmin: false, timestampMs: 1700000000000,
      timestamp: 1700000000000, senderId: '200', senderName: 'Người A', isUnsent: false, attachments: [],
    });
  });
  test('bodyAsObject', () => {
    expect(parseGraphQLMessageNode(base({ body: { text: 'hi' } })).body).toBe('hi');
  });
  test('image', () => {
    const a = parseGraphQLMessageNode(base({
      blob_attachments: [{ __typename: 'MessageImage', attachment_fbid: 'a1', large_preview: { uri: 'img.jpg' } }],
    })).attachments[0];
    expect(a).toMatchObject({ id: 'a1', type: 'image', url: 'img.jpg' });
  });
  test('videoUsesPlayableUrl', () => {
    const a = parseGraphQLMessageNode(base({
      blob_attachments: [{ __typename: 'MessageVideo', attachment_fbid: 'v1', playable_url: 'v.mp4', large_preview: { uri: 'thumb.jpg' } }],
    })).attachments[0];
    expect(a).toMatchObject({ type: 'video', url: 'v.mp4' });
  });
  test('audioUsesPlayableUrl', () => {
    const a = parseGraphQLMessageNode(base({
      blob_attachments: [{ __typename: 'MessageAudio', attachment_fbid: 'au1', playable_url: 'a.mp4' }],
    })).attachments[0];
    expect(a).toMatchObject({ type: 'audio', url: 'a.mp4' });
  });
  test('gifUsesAnimatedImage', () => {
    const a = parseGraphQLMessageNode(base({
      blob_attachments: [{ __typename: 'MessageAnimatedImage', attachment_fbid: 'g1', animated_image: { uri: 'g.gif' }, preview: { uri: 'p.jpg' } }],
    })).attachments[0];
    expect(a).toMatchObject({ type: 'gif', url: 'g.gif' });
  });
  test('fileKeepsMetadata', () => {
    const a = parseGraphQLMessageNode(base({
      blob_attachments: [{ __typename: 'MessageFile', attachment_fbid: 'f1', url: 'f.pdf', filename: 'f.pdf', filesize: 12, content_type: 'application/pdf' }],
    })).attachments[0];
    expect(a).toMatchObject({ type: 'file', url: 'f.pdf', name: 'f.pdf', fileSize: 12, mimeType: 'application/pdf' });
  });
  test('sticker', () => {
    const a = parseGraphQLMessageNode(base({ sticker: { id: 's1', url: 's.png' } })).attachments[0];
    expect(a).toMatchObject({ id: 's1', type: 'sticker', url: 's.png' });
  });
  test('systemMessageUsesSnippet', () => {
    const m = parseGraphQLMessageNode(base({ __typename: 'ThreadNameMessage_AdminText', snippet: 'A đổi tên nhóm' }));
    expect(m.isAdmin).toBe(true);
    expect(m.body).toBe('A đổi tên nhóm');
  });
  test('unsent', () => {
    expect(parseGraphQLMessageNode(base({ message_type: 'unsent' })).isUnsent).toBe(true);
  });
  test('reply', () => {
    const m = parseGraphQLMessageNode(base({ replied_to_message: { message_id: 'mid.$0', message_sender: { id: '300' } } }));
    expect(m.replyToMessageId).toBe('mid.$0');
    expect(m.replyToSenderId).toBe('300');
  });
  test('reactions', () => {
    const m = parseGraphQLMessageNode(base({ reactions: { nodes: [{ user: { id: '5' }, reaction: '👍' }] } }));
    expect(m.reactions).toEqual([{ userId: '5', emoji: '👍' }]);
  });
  test('sharedCardBecomesText', () => {
    const m = parseGraphQLMessageNode(base({
      extensible_attachment: { story_attachment: { title: 'Sản phẩm X', description: { text: 'Mô tả' } } },
    }));
    expect(m.body).toBe('Sản phẩm X\nMô tả');
  });
  test('sharedCardDoesNotOverrideBody', () => {
    const m = parseGraphQLMessageNode(base({ body: 'xem này', extensible_attachment: { story_attachment: { title: 'T' } } }));
    expect(m.body).toBe('xem này');
  });
  test('sparseNodeDoesNotThrow', () => {
    expect(() => parseGraphQLMessageNode({})).not.toThrow();
    expect(() => parseGraphQLMessageNode(null)).not.toThrow();
    const m = parseGraphQLMessageNode({});
    expect(m.attachments).toEqual([]);
    expect(m.body).toBeNull();
  });
  test('malformedArraysDoNotThrow', () => {
    expect(parseGraphQLMessageNode({ blob_attachments: [null] }).attachments).toEqual([]);
    expect(parseGraphQLMessageNode({ blob_attachments: {} }).attachments).toEqual([]);
    expect(parseGraphQLMessageNode({ reactions: { nodes: [null] } }).reactions).toEqual([]);
  });
});

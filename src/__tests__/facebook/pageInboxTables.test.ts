import { LsCall, LsValue } from '../../services/facebook/lightspeedDecoder';
import { readInboxBatch } from '../../services/facebook/pageInboxTables';

const PEER = '100000000005141';
const PAGE = '1000000000003955';
const TS = '1700000000000';

/** Một lời gọi thủ tục với các trường đặt theo số thứ tự, phần còn lại để trống. */
const call = (name: string, fields: Record<number, LsValue>): LsCall => {
  const args: LsValue[] = Array(Math.max(...Object.keys(fields).map(Number)) + 1).fill(null);
  for (const [i, v] of Object.entries(fields)) args[Number(i)] = v;
  return { name, args };
};
const message = (name: string, id: string, extra: Record<number, LsValue> = {}) =>
  call(name, { 0: 'hello', 3: PEER, 5: TS, 8: id, 10: PEER, 12: false, 17: false, ...extra });
const blob = (messageId: string, type: number, extra: Record<number, LsValue> = {}) =>
  call('insertBlobAttachment', { 0: 'f.bin', 1: '2048', 3: 'https://x.test/play', 8: 'https://x.test/preview', 14: '640', 15: '480', 22: '4000', 27: PEER, 29: String(type), 30: 'application/x', 32: messageId, 34: `fb-${type}`, ...extra });

describe('readInboxBatch', () => {
  test('aLiveTextMessage', () => {
    const { messages } = readInboxBatch([message('insertMessage', 'mid.$a')]);
    expect(messages).toEqual([{
      id: 'mid.$a', threadId: PEER, senderId: PEER, text: 'hello', timestampMs: 1700000000000,
      attachments: [], isHistory: false, isAdminMsg: false, isUnsent: false,
    }]);
  });

  test.each(['upsertMessage', 'deleteThenInsertMessage'])('%s_isHistory', (name) => {
    expect(readInboxBatch([message(name, 'mid.$a')]).messages[0].isHistory).toBe(true);
  });

  test.each([
    [2, 'image', 'https://x.test/preview'], [8, 'image', 'https://x.test/preview'],
    [3, 'gif', 'https://x.test/play'],
    [4, 'video', 'https://x.test/play'], [9, 'video', 'https://x.test/play'],
    [5, 'audio', 'https://x.test/play'], [12, 'audio', 'https://x.test/play'],
    [6, 'file', 'https://x.test/play'], [77, 'file', 'https://x.test/play'],
  ])('blobAttachmentType_%i_is_%s', (code, type, url) => {
    const { messages } = readInboxBatch([message('insertMessage', 'mid.$a', { 0: null }), blob('mid.$a', code)]);
    expect(messages[0].text).toBe('');
    expect(messages[0].attachments).toEqual([expect.objectContaining({ type, url, fileName: 'f.bin', mimeType: 'application/x', fileSize: 2048 })]);
  });

  test('imageCarriesItsSizeAndVideoItsDuration', () => {
    const { messages } = readInboxBatch([message('insertMessage', 'mid.$a'), blob('mid.$a', 2), blob('mid.$a', 4)]);
    expect(messages[0].attachments[0]).toMatchObject({ width: 640, height: 480 });
    expect(messages[0].attachments[1]).toMatchObject({ type: 'video', duration: 4 });
  });

  test('aFileWithoutAPlayableUrlFallsBackToThePreview', () => {
    const { messages } = readInboxBatch([message('insertMessage', 'mid.$a'), blob('mid.$a', 6, { 3: null }), blob('mid.$a', 3, { 3: null, 34: 'gif-1' })]);
    expect(messages[0].attachments.map(a => a.url)).toEqual(['https://x.test/preview', 'https://x.test/preview']);
  });

  test('aSticker', () => {
    const sticker = call('insertStickerAttachment', { 4: 'https://x.test/sticker.png', 9: '120', 10: '120', 14: PEER, 18: 'mid.$a', 19: '369239263222822' });
    const { messages } = readInboxBatch([message('insertMessage', 'mid.$a', { 0: null, 11: '369239263222822' }), sticker]);
    expect(messages[0].attachments).toEqual([{ type: 'sticker', url: 'https://x.test/sticker.png', width: 120, height: 120 }]);
  });

  // Facebook đôi khi gửi lặp cùng một đính kèm; một tin nhiều ảnh thì giữ đủ và đúng thứ tự.
  test('severalAttachmentsKeepOrderAndRepeatsAreDropped', () => {
    const { messages } = readInboxBatch([
      message('insertMessage', 'mid.$a'), message('insertMessage', 'mid.$b'),
      blob('mid.$a', 2, { 34: 'one', 0: '1.jpg' }), blob('mid.$a', 2, { 34: 'one', 0: '1.jpg' }), blob('mid.$a', 2, { 34: 'two', 0: '2.jpg' }),
      blob('mid.$b', 6, { 34: 'three', 0: 'doc.pdf' }),
      blob('mid.$zzz', 2, { 34: 'orphan' }),
    ]);
    expect(messages.map(m => m.attachments.map(a => a.fileName))).toEqual([['1.jpg', '2.jpg'], ['doc.pdf']]);
  });

  test('aSharedLinkBecomesALinkAttachment', () => {
    const xma = call('insertXmaAttachment', { 25: PEER, 30: 'mid.$a', 57: 'https://x.test/page', 58: 'A title' });
    expect(readInboxBatch([message('insertMessage', 'mid.$a'), xma]).messages[0].attachments).toEqual([{ type: 'link', url: 'https://x.test/page', fileName: 'A title' }]);
  });

  // Đường lưu tin cũ bỏ đính kèm loại liên kết (coi như địa chỉ đã nằm trong chữ): thẻ liên kết không chữ phải có chữ là địa chỉ.
  test('aLinkCardWithoutTextUsesItsAddressAsTheText', () => {
    const xma = call('insertXmaAttachment', { 25: PEER, 30: 'mid.$a', 57: 'https://x.test/page', 58: 'A title' });
    expect(readInboxBatch([message('upsertMessage', 'mid.$a', { 0: null }), xma]).messages[0].text).toBe('https://x.test/page');
    expect(readInboxBatch([message('upsertMessage', 'mid.$a'), xma]).messages[0].text).toBe('hello');
  });

  test('aReplyAnAdminMessageAndAnUnsentMessage', () => {
    const { messages } = readInboxBatch([
      message('insertMessage', 'mid.$a', { 23: 'mid.$orig', 27: 'quoted', 29: PAGE }),
      message('insertMessage', 'mid.$b', { 12: true }),
      message('upsertMessage', 'mid.$c', { 17: true }),
    ]);
    expect(messages[0].replyTo).toEqual({ messageId: 'mid.$orig', senderId: PAGE, text: 'quoted' });
    expect(messages[1].isAdminMsg).toBe(true);
    expect(messages[2].isUnsent).toBe(true);
  });

  test('threadKeysBeyondTheSafeIntegerRangeStayExact', () => {
    const big = '9007199254740993123';
    const batch = readInboxBatch([message('insertMessage', 'mid.$a', { 3: big }), call('insertNewMessageRange', { 0: big, 3: 'mid.$a', 5: TS, 7: true })]);
    expect(batch.messages[0].threadId).toBe(big);
    expect(batch.ranges).toEqual([{ threadId: big, hasMoreBefore: true, minTimestampMs: 1700000000000, minMessageId: 'mid.$a' }]);
  });

  test('messagesMissingAnIdOrAThreadAreDropped', () => {
    const { messages } = readInboxBatch([
      message('insertMessage', 'mid.$ok'), message('insertMessage', '', {}), message('insertMessage', 'mid.$nothread', { 3: null }),
      message('insertMessage', 'mid.$badthread', { 3: 'abc' }), { name: 'insertMessage', args: [] },
    ]);
    expect(messages.map(m => m.id)).toEqual(['mid.$ok']);
  });

  test('theEndOfHistoryIsARangeWithNothingMoreBefore', () => {
    expect(readInboxBatch([call('updateExistingMessageRange', { 0: PEER, 1: TS, 2: true })]).ranges)
      .toEqual([{ threadId: PEER, hasMoreBefore: false, minTimestampMs: 0, minMessageId: '', endOfHistoryAt: 1700000000000 }]);
  });

  test('reactionsReadReceiptsAndTyping', () => {
    const batch = readInboxBatch([
      call('upsertReaction', { 0: PEER, 1: TS, 2: 'mid.$a', 3: PEER, 4: '❤' }),
      call('deleteReaction', { 0: PEER, 1: 'mid.$a', 2: PEER }),
      call('updateReadReceipt', { 0: TS, 1: PEER, 2: PEER, 3: TS }),
      call('updateDeliveryReceipt', { 0: '1700000000555', 1: PEER, 2: PEER }),
      call('updateDeliveryReceipt', { 0: null, 1: PEER, 2: PEER }),
      call('updateTypingIndicator', { 0: PEER, 1: PEER, 2: true }),
    ]);
    expect(batch.reactions).toEqual([
      { threadId: PEER, messageId: 'mid.$a', actorId: PEER, emoji: '❤' },
      { threadId: PEER, messageId: 'mid.$a', actorId: PEER, emoji: '' },
    ]);
    expect(batch.readReceipts).toEqual([{ threadId: PEER, contactId: PEER, watermarkMs: 1700000000000 }]);
    expect(batch.deliveryReceipts).toEqual([{ threadId: PEER, contactId: PEER, watermarkMs: 1700000000555 }]); // mốc trống bị bỏ
    expect(batch.typing).toEqual([{ threadId: PEER, senderId: PEER, isTyping: true }]);
  });

  test('threadsAndContacts', () => {
    const batch = readInboxBatch([
      call('deleteThenInsertThread', { 0: TS, 2: 'last words', 3: null, 4: null, 7: PEER, 89: '3' }),
      call('verifyContactRowExists', { 0: PEER, 2: 'https://x.test/a.jpg', 3: 'Khách A' }),
      call('deleteThenInsertContact', { 0: PAGE, 2: null, 3: 'Trang B' }),
      call('verifyContactRowExists', { 0: null, 3: 'no id' }),
    ]);
    expect(batch.threads).toEqual([{ id: PEER, name: '', pictureUrl: '', snippet: 'last words', lastActivityMs: 1700000000000, unreadCount: 3 }]);
    expect(batch.contacts).toEqual([{ id: PEER, name: 'Khách A', pictureUrl: 'https://x.test/a.jpg' }, { id: PAGE, name: 'Trang B', pictureUrl: '' }]);
  });

  test('theCursorIsTakenOnlyFromThePageMailbox', () => {
    const first = (db: string, next: string) => call('executeFirstBlockForSyncTransactionV4', { 0: db, 1: '7000000000000000001', 3: next, 5: '2' });
    expect(readInboxBatch([first('2', 'CONTACTS')])).toMatchObject({ cursor: null, syncStatus: null });
    expect(readInboxBatch([first('2', 'CONTACTS'), first('205', 'MAILBOX')])).toMatchObject({ cursor: 'MAILBOX', syncStatus: '2' });
    expect(readInboxBatch([first('1', 'PERSONAL')], 1).cursor).toBe('PERSONAL');
  });

  // Facebook xác nhận một tin đã gửi bằng cách đổi mã tạm (otid) của nó thành mã tin thật.
  test('aSentMessageIsConfirmedByItsRealId', () => {
    const batch = readInboxBatch([
      { name: 'replaceOptimsiticMessage', args: ['7000000000000000042', 'mid.$real'] },
      { name: 'replaceOptimsiticMessage', args: ['7000000000000000043', null] },
      { name: 'replaceOptimsiticMessage', args: [] },
    ]);
    expect(batch.sent).toEqual([{ otid: '7000000000000000042', messageId: 'mid.$real' }]);
    expect(readInboxBatch([]).sent).toEqual([]);
  });

  test('callCountsAreKeptForTheLogAndUnknownProceduresAreHarmless', () => {
    const batch = readInboxBatch([message('insertMessage', 'mid.$a'), { name: 'someFutureProcedure', args: ['x'] }, { name: 'someFutureProcedure', args: [] }]);
    expect(batch.calls).toEqual({ insertMessage: 1, someFutureProcedure: 2 });
    expect(batch.messages).toHaveLength(1);
  });
});

import {
  isFbSyncRunning, isFbSyncTerminal, fbSyncProgress, fbSyncNotes, isFbSyncWaiting, reduceFbSyncStatus, fbImportResultText, fbImportTone,
} from '../../ui/lib/chat/fbHistorySyncView';
import { emptyFbHistorySyncStatus, type FbHistorySyncStage, type FbHistorySyncStatus } from '../../services/facebook/facebookHistory';

const make = (over: Partial<FbHistorySyncStatus> = {}): FbHistorySyncStatus =>
  ({ ...emptyFbHistorySyncStatus('fb1'), startedAt: 100, ...over });

describe('stage helpers', () => {
  const stages: FbHistorySyncStage[] = ['idle', 'listing', 'syncing', 'completed', 'failed', 'cancelled'];
  it('running only while listing/syncing', () => {
    expect(stages.filter(s => isFbSyncRunning(make({ stage: s })))).toEqual(['listing', 'syncing']);
    expect(isFbSyncRunning(null)).toBe(false);
    expect(isFbSyncRunning(undefined)).toBe(false);
  });
  it('terminal only for completed/failed/cancelled', () => {
    expect(stages.filter(s => isFbSyncTerminal(make({ stage: s })))).toEqual(['completed', 'failed', 'cancelled']);
    expect(isFbSyncTerminal(null)).toBe(false);
  });
});

describe('fbSyncProgress', () => {
  it('0 when total is 0 or while listing', () => {
    expect(fbSyncProgress(make({ stage: 'syncing', threadsTotal: 0 }))).toBe(0);
    expect(fbSyncProgress(make({ stage: 'listing', threadsTotal: 10, threadsDone: 5 }))).toBe(0);
  });
  it('50 for 5 of 10', () => {
    expect(fbSyncProgress(make({ stage: 'syncing', threadsTotal: 10, threadsDone: 5 }))).toBe(50);
  });
  it('100 when completed, clamped', () => {
    expect(fbSyncProgress(make({ stage: 'completed', threadsTotal: 0 }))).toBe(100);
    expect(fbSyncProgress(make({ stage: 'syncing', threadsTotal: 2, threadsDone: 9 }))).toBe(100);
  });
});

describe('fbSyncNotes', () => {
  it('empty when both counters are 0', () => {
    expect(fbSyncNotes(make())).toEqual([]);
  });
  it('lists non-zero counters', () => {
    expect(fbSyncNotes(make({ skippedE2EE: 3, failedThreads: 2 }))).toEqual([
      '3 hội thoại mã hoá đầu cuối được bỏ qua', '2 hội thoại không tải được',
    ]);
    expect(fbSyncNotes(make({ failedThreads: 1 }))).toEqual(['1 hội thoại không tải được']);
  });
});

describe('isFbSyncWaiting', () => {
  it('waiting only when running and pausedUntil is in the future', () => {
    expect(isFbSyncWaiting(make({ stage: 'syncing', pausedUntil: 2000 }), 1000)).toBe(true);
    expect(isFbSyncWaiting(make({ stage: 'syncing', pausedUntil: 1000 }), 1000)).toBe(false);
    expect(isFbSyncWaiting(make({ stage: 'syncing' }), 1000)).toBe(false);
    expect(isFbSyncWaiting(make({ stage: 'completed', pausedUntil: 2000 }), 1000)).toBe(false);
  });
});

describe('reduceFbSyncStatus', () => {
  it('takes the first event for the account', () => {
    const next = make({ stage: 'listing' });
    expect(reduceFbSyncStatus(null, next, 'fb1')).toBe(next);
  });
  it('ignores other accounts', () => {
    const prev = make({ stage: 'syncing' });
    expect(reduceFbSyncStatus(prev, make({ accountId: 'fb2', startedAt: 999 }), 'fb1')).toBe(prev);
    expect(reduceFbSyncStatus(null, make({ accountId: 'fb2' }), 'fb1')).toBeNull();
  });
  it('ignores stale runs (older startedAt)', () => {
    const prev = make({ stage: 'syncing', startedAt: 200 });
    expect(reduceFbSyncStatus(prev, make({ stage: 'completed', startedAt: 100 }), 'fb1')).toBe(prev);
  });
  it('accepts same or newer startedAt', () => {
    const prev = make({ stage: 'syncing', startedAt: 200 });
    const same = make({ stage: 'completed', startedAt: 200 });
    const newer = make({ stage: 'listing', startedAt: 300 });
    expect(reduceFbSyncStatus(prev, same, 'fb1')).toBe(same);
    expect(reduceFbSyncStatus(prev, newer, 'fb1')).toBe(newer);
  });
  it('keeps a terminal status when a non-terminal one with the same startedAt arrives late', () => {
    for (const stage of ['completed', 'failed', 'cancelled'] as const) {
      const prev = make({ stage, startedAt: 200 });
      expect(reduceFbSyncStatus(prev, make({ stage: 'syncing', startedAt: 200 }), 'fb1')).toBe(prev);
    }
  });
  it('a newer run replaces a terminal status', () => {
    const prev = make({ stage: 'completed', startedAt: 200 });
    const next = make({ stage: 'listing', startedAt: 300 });
    expect(reduceFbSyncStatus(prev, next, 'fb1')).toBe(next);
  });
});

describe('fbImportResultText', () => {
  const summary = { chatsInFile: 3, chatsMatched: 2, chatsUnmatched: 0, messagesInFile: 10, imported: 8, alreadyPresent: 0, withoutSenderId: 0, mediaImported: 0, mediaSkipped: 0, malformedSkipped: 0 };
  it('reports what was imported', () => {
    expect(fbImportResultText({ success: true, summary })).toBe('Đã nhập 8 tin vào 2 hội thoại.');
  });
  it('appends each non-zero count', () => {
    expect(fbImportResultText({ success: true, summary: { ...summary, alreadyPresent: 4, chatsUnmatched: 1, withoutSenderId: 2, mediaSkipped: 3 } })).toBe(
      'Đã nhập 8 tin vào 2 hội thoại. 4 tin đã có sẵn. 1 hội thoại trong tệp không ghép được với hội thoại nào trên máy. 2 tin nhóm chỉ có tên người gửi. 3 tệp đính kèm không nhập được.');
  });
  it('says nothing new when everything was already there', () => {
    expect(fbImportResultText({ success: true, summary: { ...summary, imported: 0, alreadyPresent: 5 } })).toBe('Không có tin mới: 5 tin trong tệp đã có sẵn.');
  });
  it('reports a wrong format when there are no chats', () => {
    expect(fbImportResultText({ success: true, summary: { ...summary, chatsInFile: 0, chatsMatched: 0 } })).toBe('Tệp không đúng định dạng bản sao lưu đoạn chat của Facebook.');
  });
  it('maps failures by code', () => {
    expect(fbImportResultText({ success: false, code: 'LIMIT', error: 'FILE_TOO_LARGE' })).toBe('Tệp quá lớn để nhập.');
    expect(fbImportResultText({ success: false, code: 'IMPORT_IN_PROGRESS', error: 'IMPORT_IN_PROGRESS' })).toBe('Đang nhập một tệp khác cho tài khoản này.');
    expect(fbImportResultText({ success: false, code: 'FAILED', error: 'IMPORT_FAILED' })).toBe('Không nhập được tệp. Thử lại sau.');
    expect(fbImportResultText(undefined)).toBe('Không nhập được tệp. Thử lại sau.');
  });
});

describe('fbSyncNotes import hint', () => {
  const status: any = { skippedE2EE: 2, failedThreads: 0 };
  it('appends the import hint to the encrypted-chat note only when asked', () => {
    expect(fbSyncNotes(status)).toEqual(['2 hội thoại mã hoá đầu cuối được bỏ qua']);
    expect(fbSyncNotes(status, true)).toEqual(['2 hội thoại mã hoá đầu cuối được bỏ qua. Dùng "Nhập từ tệp Facebook (.zip)" để lấy tin cũ của các hội thoại này.']);
  });
});

describe('fbImportTone', () => {
  const summary = { chatsInFile: 2, chatsMatched: 1, chatsUnmatched: 1, messagesInFile: 5, imported: 3, alreadyPresent: 0, withoutSenderId: 0, mediaImported: 0, mediaSkipped: 0, malformedSkipped: 0 };
  it('is green only when something was imported, neutral when nothing new, red on errors', () => {
    expect(fbImportTone({ success: true, summary })).toBe('success');
    expect(fbImportTone({ success: true, summary: { ...summary, imported: 0, alreadyPresent: 4 } })).toBe('neutral');
    expect(fbImportTone({ success: true, summary: { ...summary, chatsInFile: 0, imported: 0 } })).toBe('error');
    expect(fbImportTone({ success: false, code: 'FAILED' })).toBe('error');
    expect(fbImportTone(undefined)).toBe('error');
  });
});

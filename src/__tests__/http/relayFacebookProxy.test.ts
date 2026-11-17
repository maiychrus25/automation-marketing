import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { startRelay, RelayHarness } from './relayHarness';

const account = (id: string): any => ({ zalo_id: id, full_name: id, avatar_url: '', phone: '', is_business: 0, is_active: 1, channel: 'facebook' });

describe('boss runs an employee Page inbox commands (fb:*) with the account checks and records the sender', () => {
  let relay: RelayHarness;
  let mediaRoot: string;
  const send = async (channel: string, params: any, who = 'emp-1') => {
    const res = await fetch(relay.url + '/api/proxy/action', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${relay.tokenFor(who)}` },
      body: JSON.stringify({ channel, params }),
    });
    return (await res.json()) as any;
  };
  const sentRows = () => relay.db.logEmployeeAction.mock.calls.map((c: any[]) => c[0]).filter((a: any) => a.action === 'sent');

  async function start(modules = ['chat']) {
    relay = await startRelay({
      employees: [{ id: 'emp-1', assigned: ['page-1', 'fb-personal'], modules }, { id: 'emp-2', assigned: ['page-1'], modules: [] }, { id: 'emp-3', assigned: ['page-1', 'page-2'], modules: ['chat'] }],
      accounts: [account('page-1'), account('page-2'), account('fb-personal')],
      fbAccounts: [
        { id: 'uuid-personal', facebook_id: 'fb-personal', parent_facebook_id: null },
        { id: 'uuid-page-1', facebook_id: 'page-1', parent_facebook_id: 'fb-personal' },
        { id: 'uuid-page-2', facebook_id: 'page-2', parent_facebook_id: 'fb-personal' },
      ],
      mediaRoot,
    });
  }

  beforeAll(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fbproxy-'));
  });
  beforeEach(async () => { await start(); });
  afterEach(() => relay.close());
  afterAll(() => fs.rmSync(mediaRoot, { recursive: true, force: true }));

  test('runsTheHandlerOnceWithFromRelayAndReturnsItsResultUnchanged', async () => {
    const handler = relay.registerIpcHandler('fb:sendMessage');
    handler.mockResolvedValue({ success: true, messageId: 'mid.1' });
    const out = await send('fb:sendMessage', { accountId: 'page-1', threadId: 't1', body: 'x' });
    expect(out).toEqual({ success: true, messageId: 'mid.1' });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][1]).toMatchObject({ accountId: 'page-1', threadId: 't1', body: 'x', _fromRelay: true });
  });

  test('refusesAPersonalAccountAnInternalUuidAndAMissingAccountId', async () => {
    const handler = relay.registerIpcHandler('fb:sendMessage');
    // fb-personal is (wrongly) assigned, but the relay filters it out of the usable list.
    expect((await send('fb:sendMessage', { accountId: 'fb-personal', threadId: 't1', body: 'x' })).success).toBe(false);
    expect((await send('fb:sendMessage', { accountId: 'uuid-page-1', threadId: 't1', body: 'x' })).success).toBe(false);
    const missing = await send('fb:sendMessage', { threadId: 't1', body: 'x' });
    expect(missing.success).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  test('doesNotPickTheFirstAssignedAccountWhenAccountIdIsMissing', async () => {
    const handler = relay.registerIpcHandler('fb:getThreads');
    await send('fb:getThreads', {});
    await send('fb:getThreads', { zaloId: 'page-1' }); // another key does not stand in for accountId
    expect(handler).not.toHaveBeenCalled();
  });

  test('refusesAnEmployeeWithoutTheChatModule', async () => {
    const handler = relay.registerIpcHandler('fb:getThreads');
    expect((await send('fb:getThreads', { accountId: 'page-1' }, 'emp-2')).success).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  test.each(['fb:updateCookie', 'fb:removeAccount', 'fb:historySync:start', 'fb:sendTyping', 'fb:scanGetTabs', 'fb:notClassified'])
  ('never reaches the handler of %s', async (channel) => {
    const handler = relay.registerIpcHandler(channel);
    expect((await send(channel, { accountId: 'page-1' })).success).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  test('refusesAFileOutsideTheMediaFolderAndRunsAFileInsideThePageFolder', async () => {
    const handler = relay.registerIpcHandler('fb:sendAttachment');
    expect((await send('fb:sendAttachment', { accountId: 'page-1', threadId: 't1', filePath: '/etc/hosts' })).success).toBe(false);
    expect(handler).not.toHaveBeenCalled();
    const dir = path.join(mediaRoot, 'page-1', '2026-01-01');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'a.png');
    fs.writeFileSync(file, 'x');
    handler.mockResolvedValue({ success: true, messageId: 'mid.2' });
    expect((await send('fb:sendAttachment', { accountId: 'page-1', threadId: 't1', filePath: file })).success).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('recordsWhichEmployeeSentAMessage', async () => {
    relay.registerIpcHandler('fb:sendMessage').mockResolvedValue({ success: true, messageId: 'mid.1' });
    await send('fb:sendMessage', { accountId: 'page-1', threadId: 't1', body: 'x' });
    expect(relay.db.setMessageHandledByEmployeeFlexible).toHaveBeenCalledWith('page-1', 'mid.1', 'emp-1');
    expect(sentRows()).toHaveLength(1);
    expect(sentRows()[0]).toMatchObject({ employee_id: 'emp-1', zalo_id: 'page-1', thread_id: 't1', msg_id: 'mid.1' });
    const evt = relay.published.filter((p) => p.channel === 'relay:messageSentByEmployee');
    expect(evt).toHaveLength(1);
    expect(evt[0].audience).toEqual({ kind: 'accounts', ids: ['page-1'] });
    expect(evt[0].data).toMatchObject({ zaloId: 'page-1', threadId: 't1', msgId: 'mid.1', employee_id: 'emp-1' });
  });

  test('tagsExactlyTheReturnedIdsOfAMultiFileSendAndNeverQueriesByThread', async () => {
    relay.registerIpcHandler('fb:sendAttachments').mockResolvedValue({ success: true, uploadedCount: 3, totalCount: 3, messageIds: ['m1', 'm2', 'm3'] });
    relay.db.query.mockClear();
    const out = await send('fb:sendAttachments', { accountId: 'page-1', threadId: 't1', filePaths: [] });
    expect(out.success).toBe(true);
    expect(relay.db.setMessageHandledByEmployeeFlexible.mock.calls).toEqual([['page-1', 'm1', 'emp-1'], ['page-1', 'm2', 'emp-1'], ['page-1', 'm3', 'emp-1']]);
    expect(relay.db.setMessageHandledByEmployee).not.toHaveBeenCalled();
    expect(relay.db.query.mock.calls.filter((c: any[]) => /handled_by_employee IS NULL/.test(c[0]))).toEqual([]);
    expect(relay.published.filter((p) => p.channel === 'relay:messageSentByEmployee').map((p) => p.data.msgId)).toEqual(['m1', 'm2', 'm3']);
  });

  test('aSuccessfulSendWithNoIdIsCountedButNothingIsTaggedOrAnnounced', async () => {
    relay.registerIpcHandler('fb:sendAttachments').mockResolvedValue({ success: true, uploadedCount: 2, totalCount: 2 });
    relay.db.query.mockClear();
    await send('fb:sendAttachments', { accountId: 'page-1', threadId: 't1', filePaths: [] });
    expect(sentRows()).toHaveLength(1);
    expect(sentRows()[0]).toMatchObject({ employee_id: 'emp-1', zalo_id: 'page-1', thread_id: 't1', msg_id: '' });
    expect(relay.db.setMessageHandledByEmployee).not.toHaveBeenCalled();
    expect(relay.db.setMessageHandledByEmployeeFlexible).not.toHaveBeenCalled();
    expect(relay.db.query.mock.calls.filter((c: any[]) => /handled_by_employee IS NULL/.test(c[0]))).toEqual([]);
    expect(relay.published.filter((p) => p.channel === 'relay:messageSentByEmployee')).toHaveLength(0);
  });

  test.each(['page-1,page-2', ' page-1', 'page-1 '])('refusesAnAccountIdTheHandlerWouldReadDifferently: "%s"', async (accountId) => {
    relay.registerIpcHandler('fb:sendMessage');
    const handler = relay.registerIpcHandler('fb:getThreads');
    // page-2 is assigned too so the access check alone would let the comma form through
    expect((await send('fb:getThreads', { accountId }, 'emp-3')).success).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  test('recordsNothingWhenTheSendFailedOrTheCommandIsNotASend', async () => {
    relay.registerIpcHandler('fb:sendMessage').mockResolvedValue({ success: false, error: 'boom' });
    relay.registerIpcHandler('fb:addReaction').mockResolvedValue({ success: true });
    await send('fb:sendMessage', { accountId: 'page-1', threadId: 't1', body: 'x' });
    await send('fb:addReaction', { accountId: 'page-1', threadId: 't1', messageId: 'm' });
    expect(sentRows()).toHaveLength(0);
    expect(relay.db.setMessageHandledByEmployee).not.toHaveBeenCalled();
    expect(relay.db.setMessageHandledByEmployeeFlexible).not.toHaveBeenCalled();
    expect(relay.published.filter((p) => p.channel === 'relay:messageSentByEmployee')).toHaveLength(0);
  });
});

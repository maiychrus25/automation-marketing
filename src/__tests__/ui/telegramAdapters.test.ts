// IPC la ban gia; store va adapter la ma that.
const tgUser = { sendMessage: jest.fn(), startListener: jest.fn(), stopListener: jest.fn(), isConnected: jest.fn(), sendTopicMessage: jest.fn() };
const tgBot = { sendMessage: jest.fn(), startBot: jest.fn(), stopBot: jest.fn(), getActiveBots: jest.fn(), isBotPolling: jest.fn() };
jest.mock('../../ui/lib/ipc', () => ({ __esModule: true, default: { telegramUser: tgUser, telegram: tgBot, login: { getAccounts: jest.fn() } } }));

import { TelegramUserAdapter } from '../../ui/lib/adapters/TelegramUserAdapter';
import { TelegramBotAdapter } from '../../ui/lib/adapters/TelegramBotAdapter';
import { useEmployeeStore } from '../../ui/store/employeeStore';
import { useAccountStore } from '../../ui/store/accountStore';

const BOSS_ONLY = { success: false, error: 'Thao tác này chỉ thực hiện được trên máy Boss', code: 'BOSS_ONLY' };
const setAccounts = (...rows: any[]) => useAccountStore.setState({ accounts: rows } as any);

beforeEach(() => {
  for (const fn of [...Object.values(tgUser), ...Object.values(tgBot)]) fn.mockReset();
  useEmployeeStore.getState().reset();
  setAccounts();
});

describe('on an employee machine', () => {
  beforeEach(() => useEmployeeStore.getState().setMode('employee'));

  it('user checkHealth answers from the snapshot and never calls IPC', async () => {
    setAccounts({ zalo_id: 'a', listenerActive: true }, { zalo_id: 'b', listenerActive: false });
    const adapter = new TelegramUserAdapter();
    expect(await adapter.checkHealth({ accountId: 'a' } as any)).toEqual({ success: true, alive: true });
    expect(await adapter.checkHealth({ accountId: 'b' } as any)).toEqual({ success: true, alive: false });
    expect(await adapter.checkHealth({ accountId: 'missing' } as any)).toEqual({ success: true, alive: false });
    expect(tgUser.isConnected).not.toHaveBeenCalled();
  });
  it('bot checkHealth answers from the snapshot and never calls IPC', async () => {
    setAccounts({ zalo_id: 'a', listenerActive: true });
    const adapter = new TelegramBotAdapter();
    expect(await adapter.checkHealth({ accountId: 'a' } as any)).toEqual({ success: true, alive: true });
    expect(tgBot.getActiveBots).not.toHaveBeenCalled();
    expect(tgBot.isBotPolling).not.toHaveBeenCalled();
  });
  it('connect and disconnect refuse with BOSS_ONLY without IPC', async () => {
    const user = new TelegramUserAdapter();
    const bot = new TelegramBotAdapter();
    expect(await user.connectAccount({ accountId: 'a' } as any)).toEqual(BOSS_ONLY);
    expect(await user.disconnectAccount({ accountId: 'a' } as any)).toEqual(BOSS_ONLY);
    expect(await bot.connectAccount({ accountId: 'a' } as any)).toEqual(BOSS_ONLY);
    expect(await bot.disconnectAccount({ accountId: 'a' } as any)).toEqual(BOSS_ONLY);
    for (const fn of [tgUser.startListener, tgUser.stopListener, tgBot.startBot, tgBot.stopBot]) expect(fn).not.toHaveBeenCalled();
  });
});

describe('on a boss machine nothing changes', () => {
  it('adapters pass a code through unchanged and add none when absent', async () => {
    tgUser.sendMessage.mockResolvedValueOnce({ success: false, error: 'x', code: 'TIMEOUT' }).mockResolvedValueOnce({ success: false, error: 'x' });
    const user = new TelegramUserAdapter();
    expect(await user.sendMessage({ accountId: 'a', threadId: 't', body: 'hi' } as any)).toMatchObject({ code: 'TIMEOUT' });
    expect((await user.sendMessage({ accountId: 'a', threadId: 't', body: 'hi' } as any)).code).toBeUndefined();
    tgBot.sendMessage.mockResolvedValueOnce({ success: false, error: 'x', code: 'NOT_CONNECTED' }).mockResolvedValueOnce({ success: true, messageId: 'm' });
    const bot = new TelegramBotAdapter();
    expect(await bot.sendMessage({ accountId: 'a', threadId: 't', body: 'hi' } as any)).toMatchObject({ code: 'NOT_CONNECTED' });
    expect((await bot.sendMessage({ accountId: 'a', threadId: 't', body: 'hi' } as any)).code).toBeUndefined();
  });
  it('user checkHealth and connect still use IPC', async () => {
    tgUser.isConnected.mockResolvedValue({ success: true, connected: true });
    tgUser.startListener.mockResolvedValue({ success: true });
    const adapter = new TelegramUserAdapter();
    expect(await adapter.checkHealth({ accountId: 'a' } as any)).toEqual({ success: true, alive: true });
    expect(await adapter.connectAccount({ accountId: 'a', auth: { stringSession: 's' } } as any)).toEqual({ success: true, error: undefined });
    expect(tgUser.startListener).toHaveBeenCalledTimes(1);
  });
  it('bot checkHealth still asks IPC', async () => {
    tgBot.getActiveBots.mockResolvedValue({ bots: [{ accountId: 'a' }] });
    tgBot.isBotPolling.mockResolvedValue({ polling: false });
    expect(await new TelegramBotAdapter().checkHealth({ accountId: 'a' } as any)).toEqual({ success: true, alive: false });
  });
});

describe('send results keep the boss error code for the retry queue', () => {
  it.each([['TIMEOUT'], ['NOT_CONNECTED'], ['BOSS_ONLY'], ['UPLOAD_FAILED']])('user sendMessage passes %s', async (code) => {
    tgUser.sendMessage.mockResolvedValue({ success: false, error: 'x', code });
    const res = await new TelegramUserAdapter().sendMessage({ accountId: 'a', threadId: 't', body: 'hi' } as any);
    expect(res).toMatchObject({ success: false, code });
  });
  it('user sendTopicMessage and bot sendMessage pass the code too', async () => {
    tgUser.sendTopicMessage.mockResolvedValue({ success: false, error: 'x', code: 'TIMEOUT' });
    tgBot.sendMessage.mockResolvedValue({ success: false, error: 'x', code: 'TIMEOUT' });
    expect(await new TelegramUserAdapter().sendTopicMessage({ accountId: 'a', threadId: 't', topicId: '1', text: 'hi' })).toMatchObject({ code: 'TIMEOUT' });
    expect(await new TelegramBotAdapter().sendMessage({ accountId: 'a', threadId: 't', body: 'hi' } as any)).toMatchObject({ code: 'TIMEOUT' });
  });
  it('a send with no code stays without one', async () => {
    tgUser.sendMessage.mockResolvedValue({ success: true, messageId: 'm1' });
    expect(await new TelegramUserAdapter().sendMessage({ accountId: 'a', threadId: 't', body: 'hi' } as any)).toEqual({ success: true, msgId: 'm1', messageId: 'm1', error: undefined, code: undefined });
  });
});

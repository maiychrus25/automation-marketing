import * as fs from 'fs';
import * as path from 'path';
import {
  RELAYED_EVENT_CHANNELS,
  EMPLOYEE_CONTROL_CHANNELS,
  RENDERER_DORMANT_CHANNELS,
} from '../../services/socket/relayChannels';

const forwarded = (): readonly string[] => [...RELAYED_EVENT_CHANNELS, ...EMPLOYEE_CONTROL_CHANNELS];
const relayed = (): readonly string[] => RELAYED_EVENT_CHANNELS;

describe('relay channel lists', () => {
  it('has no duplicates', () => {
    expect(new Set(RELAYED_EVENT_CHANNELS).size).toBe(RELAYED_EVENT_CHANNELS.length);
    expect(new Set(forwarded()).size).toBe(forwarded().length);
  });

  it('every channel the boss relays is forwarded by the employee', () => {
    const missing = relayed().filter((c) => !forwarded().includes(c));
    expect(missing).toEqual([]);
  });

  it.each([
    'db:unreadChanged', 'db:conversationDeleted', 'db:contactProfileUpdated', 'crm:tagChanged',
    'library:itemAdded', 'library:itemUpdated', 'library:itemDeleted', 'erp:event:employeeProfileDeleted',
  ])('%s is forwarded by the employee', (channel) => {
    expect(forwarded()).toContain(channel);
  });

  it('employee control channels are not relayed events', () => {
    expect(EMPLOYEE_CONTROL_CHANNELS.filter((c) => RELAYED_EVENT_CHANNELS.includes(c))).toEqual([]);
    expect(forwarded()).not.toContain('employee:resync');
  });

  it('every relayed channel is in preload validChannels or marked dormant', () => {
    const preload = fs.readFileSync(path.join(__dirname, '../../../electron/preload.ts'), 'utf8');
    const block = preload.slice(preload.indexOf('const validChannels = ['));
    const listed = block.slice(0, block.indexOf('];'));
    const offenders = RELAYED_EVENT_CHANNELS.filter(
      (c) => !listed.includes(`'${c}'`) && !RENDERER_DORMANT_CHANNELS.has(c),
    );
    expect(offenders).toEqual([]);
  });

  it('dormant channels are all relayed or control channels', () => {
    for (const c of RENDERER_DORMANT_CHANNELS) {
      expect([...RELAYED_EVENT_CHANNELS, ...EMPLOYEE_CONTROL_CHANNELS]).toContain(c);
    }
  });

  it.each([
    'event:telegramReaction', 'event:messageEdited', 'event:messagesDeleted', 'event:forumTopicsChanged',
    'event:telegramEntityHydrated', 'event:groupMemberAvatar', 'event:telegramSync', 'event:userPresence',
  ])('Telegram event %s is relayed, forwarded and in preload validChannels', (channel) => {
    const preload = fs.readFileSync(path.join(__dirname, '../../../electron/preload.ts'), 'utf8');
    const block = preload.slice(preload.indexOf('const validChannels = ['));
    expect(block.slice(0, block.indexOf('];'))).toContain(`'${channel}'`);
    expect(relayed()).toContain(channel);
    expect(forwarded()).toContain(channel);
    expect(RENDERER_DORMANT_CHANNELS.has(channel)).toBe(false);
  });

  it.each([
    'facebookPoster:log', 'facebookPoster:progress', 'facebookPoster:runFinished', 'facebookPoster:schedulesChanged', 'facebookPoster:loginStateChanged',
    'facebookPoster:loginCheckProgress', 'facebookPoster:leadsFound', 'facebookPoster:trackProgress', 'facebookPoster:trackFinished',
    'facebookPoster:commentCollectProgress', 'facebookPoster:commentCollectFinished',
  ])('poster event %s is relayed, forwarded and in preload validChannels', (channel) => {
    const preload = fs.readFileSync(path.join(__dirname, '../../../electron/preload.ts'), 'utf8');
    const block = preload.slice(preload.indexOf('const validChannels = ['));
    expect(block.slice(0, block.indexOf('];'))).toContain(`'${channel}'`);
    expect(relayed()).toContain(channel);
    expect(forwarded()).toContain(channel);
    expect(RENDERER_DORMANT_CHANNELS.has(channel)).toBe(false);
  });

  it.each(['facebookPoster:scheduleMissed', 'browserProfile:statusChanged', 'browserProfile:engineProgress'])('%s stays on the boss', (channel) => {
    expect(relayed()).not.toContain(channel);
  });

  it('no employee persistence branch matches a poster channel', () => {
    const client = fs.readFileSync(path.join(__dirname, '../../services/http/HttpClientService.ts'), 'utf8');
    expect(client).not.toMatch(/facebookPoster:/);
  });
});

import { filterConversationsInMemory } from '../../ui/lib/conversationFilter';

const c = (o: any) => ({ contact_id: 'x', unread_count: 0, ...o });
const LIST = [
  c({ contact_id: '100', display_name: 'Nguyễn Văn An', alias: 'Anh An', phone: '0901111222', channel: 'zalo', unread_count: 2 }),
  c({ contact_id: '200', display_name: 'Trần Bình', alias: '', phone: '0903333444', channel: 'telegram_user' }),
  c({ contact_id: '300', display_name: 'Lê Cường', alias: 'Boss Cuong', phone: '', channel: 'telegram_user', unread_count: 1 }),
];
const ids = (l: any[]) => l.map((x) => x.contact_id);

describe('filterConversationsInMemory (same meaning as DatabaseService.getContactsFiltered)', () => {
  it('returns the same contacts when no filter is active', () => {
    expect(filterConversationsInMemory(LIST, {})).toEqual(LIST);
    expect(filterConversationsInMemory(LIST, { search: '', channel: 'all', unreadOnly: false })).toEqual(LIST);
  });
  it('searches the display name as a case-insensitive substring', () => {
    expect(ids(filterConversationsInMemory(LIST, { search: 'bình' }))).toEqual(['200']);
    expect(ids(filterConversationsInMemory(LIST, { search: 'NGUYỄN văn' }))).toEqual(['100']);
  });
  it('does not fold accents (the database query does not)', () => {
    expect(filterConversationsInMemory(LIST, { search: 'binh' })).toEqual([]);
  });
  it('searches the alias, phone and contact id', () => {
    expect(ids(filterConversationsInMemory(LIST, { search: 'boss cuong' }))).toEqual(['300']);
    expect(ids(filterConversationsInMemory(LIST, { search: '03333' }))).toEqual(['200']);
    expect(ids(filterConversationsInMemory(LIST, { search: '100' }))).toEqual(['100']);
  });
  it('returns an empty list when nothing matches', () => {
    expect(filterConversationsInMemory(LIST, { search: 'zzz' })).toEqual([]);
  });
  it('keeps only unread conversations with unreadOnly', () => {
    expect(ids(filterConversationsInMemory(LIST, { unreadOnly: true }))).toEqual(['100', '300']);
  });
  it('keeps only the exact channel, and "all" means no channel filter', () => {
    expect(ids(filterConversationsInMemory(LIST, { channel: 'telegram_user' }))).toEqual(['200', '300']);
    expect(ids(filterConversationsInMemory(LIST, { channel: 'all' }))).toHaveLength(3);
  });
  it('treats a missing channel as zalo (the column default)', () => {
    const list = [{ contact_id: 'z' }, { contact_id: 'f', channel: 'facebook' }];
    expect(ids(filterConversationsInMemory(list, { channel: 'zalo' }))).toEqual(['z']);
    expect(ids(filterConversationsInMemory(list, { channel: 'facebook' }))).toEqual(['f']);
  });
  it('combines search, unread and channel (AND) and keeps the order', () => {
    expect(ids(filterConversationsInMemory(LIST, { channel: 'telegram_user', unreadOnly: true }))).toEqual(['300']);
    expect(ids(filterConversationsInMemory(LIST, { search: 'an', unreadOnly: true, channel: 'zalo' }))).toEqual(['100']);
    expect(ids(filterConversationsInMemory(LIST, { search: 'n', unreadOnly: true }))).toEqual(['100', '300']);
  });
  it('does not throw on contacts with missing fields', () => {
    const odd: any[] = [{ contact_id: 'a' }, { contact_id: 'b', display_name: null, alias: null, phone: null, unread_count: null }, {}];
    expect(() => filterConversationsInMemory(odd, { search: 'a', unreadOnly: true, channel: 'zalo' })).not.toThrow();
    expect(ids(filterConversationsInMemory(odd, { search: 'b' }))).toEqual(['b']);
  });
  it('does not mutate its input', () => {
    const copy = [...LIST];
    filterConversationsInMemory(LIST, { search: 'an' });
    expect(LIST).toEqual(copy);
  });
});

import { importedActionRefusal } from '../../ui/lib/chat/importedMessageGuard';

describe('importedActionRefusal', () => {
  it('refuses imported rows with the refusal text', () => {
    expect(importedActionRefusal({ msg_id: 'e2ee-export.0123456789abcdef0123456789abcdef' })).toBe('Tin nhập từ tệp sao lưu không hỗ trợ thao tác này.');
  });
  it('leaves ordinary and missing ids alone', () => {
    for (const msg of [{ msg_id: 'mid.$abc' }, { msg_id: '123456' }, { msg_id: 'tg_1' }, {}, null, undefined]) expect(importedActionRefusal(msg as any)).toBeNull();
  });
});

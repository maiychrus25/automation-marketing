import { importedSenderId, importedSenderName, isImportedSenderId } from '../../services/facebook/e2eeExport/importedMessage';
import { canLookUpSender, senderDisplayName, showsSenderLabel } from '../../ui/lib/chat/importedSenderView';

const base = { isSent: false, isEcard: false, threadType: 0, senderId: 'e2ee-name:Cara Example', showTime: true, displayName: 'Cara Example' };

describe('importedSenderView', () => {
  it('shows the name from the sender id without any lookup', () => {
    expect(senderDisplayName('e2ee-name:Cara Example', '12345')).toBe('Cara Example');
    expect(senderDisplayName('12345', 'Alice Example')).toBe('Alice Example');
    expect(senderDisplayName(undefined, 'x')).toBe('x');
  });
  it('shows the sender label for imported senders even though thread_type is 0', () => {
    expect(showsSenderLabel(base)).toBe(true);
    expect(showsSenderLabel({ ...base, showTime: false })).toBe(false);
    expect(showsSenderLabel({ ...base, isSent: true })).toBe(false);
  });
  it('keeps the old rule for other rows', () => {
    expect(showsSenderLabel({ ...base, senderId: '123', displayName: 'Alice Example' })).toBe(false);
    expect(showsSenderLabel({ ...base, senderId: '123', displayName: 'Alice Example', threadType: 1 })).toBe(true);
    expect(showsSenderLabel({ ...base, senderId: '123', displayName: '123', threadType: 1 })).toBe(false);
  });
  it('keys every guard on the prefix, including the bare prefix and an empty name', () => {
    expect(canLookUpSender('e2ee-name:')).toBe(false);
    expect(senderDisplayName('e2ee-name:', 'x')).toBe('Không rõ người gửi');
    expect(showsSenderLabel({ ...base, senderId: 'e2ee-name:', displayName: 'Không rõ người gửi' })).toBe(true);
    expect(importedSenderId('')).toBe('e2ee-name:Không rõ người gửi');
    expect(importedSenderId('   \n ')).toBe('e2ee-name:Không rõ người gửi');
    expect(importedSenderName('e2ee-name:')).toBe('');
    expect(isImportedSenderId('e2ee-name:')).toBe(true);
  });
  it('never looks up or opens a profile for imported senders', () => {
    expect(canLookUpSender('e2ee-name:Cara Example')).toBe(false);
    expect(canLookUpSender('100200300')).toBe(true);
  });
});

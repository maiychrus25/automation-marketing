// Dấu nhận biết tin nhập từ tệp sao lưu Facebook. Thuần (không Node API) để cả tiến trình chính lẫn giao diện dùng chung.
export const IMPORTED_MESSAGE_ID_PREFIX = 'e2ee-export.';
export const IMPORTED_SENDER_PREFIX = 'e2ee-name:';
export const IMPORTED_ACTION_ERROR = 'Tin nhập từ tệp sao lưu không hỗ trợ thao tác này.';
const MAX_NAME_CHARS = 80;

export const isImportedMessageId = (id: unknown): boolean => typeof id === 'string' && id.startsWith(IMPORTED_MESSAGE_ID_PREFIX);

export const UNKNOWN_SENDER_LABEL = 'Không rõ người gửi';
export const isImportedSenderId = (id: unknown): boolean => typeof id === 'string' && id.startsWith(IMPORTED_SENDER_PREFIX);

/** Mã người gửi riêng của MaiHub cho tên không gắn được mã Facebook (không bao giờ là mã Facebook thật). Tên rỗng thành "Không rõ người gửi". */
export const importedSenderId = (name: string): string =>
  IMPORTED_SENDER_PREFIX + (name.normalize('NFC').trim().replace(/\s+/g, ' ').slice(0, MAX_NAME_CHARS) || UNKNOWN_SENDER_LABEL);

/** Tên trong mã người gửi nhập từ tệp; '' nếu không phải mã đó (hoặc mã trần không có tên). */
export const importedSenderName = (senderId: unknown): string =>
  isImportedSenderId(senderId) ? (senderId as string).slice(IMPORTED_SENDER_PREFIX.length) : '';

/** Nhãn hiển thị của mã nhập từ tệp (kể cả mã trần); '' nếu không phải mã đó. Mọi kiểm tra dựa vào TIỀN TỐ, không dựa vào tên. */
export const importedSenderLabel = (senderId: unknown): string => (isImportedSenderId(senderId) ? importedSenderName(senderId) || UNKNOWN_SENDER_LABEL : '');

/** Mã tin mà thao tác của kênh IPC Facebook sẽ gửi cho Facebook/bridge (để từ chối nếu là tin nhập). */
export function messageIdsInFbAction(channel: string, p: any): unknown[] {
  switch (channel) {
    case 'fb:unsendMessage': case 'fb:addReaction': case 'fb:editMessage': case 'fb:forwardMessage': case 'fb:pinMessage': case 'fb:unpinMessage':
      return [p?.messageId];
    case 'fb:sendMessage': return [p?.options?.replyToMessageId];
    case 'fb:sendAttachment': case 'fb:sendAttachments': return [p?.replyToMessageId];
    case 'fb:sendE2EEMessage': return [p?.replyToId];
    default: return [];
  }
}
export const touchesImportedMessage = (channel: string, p: any): boolean => messageIdsInFbAction(channel, p).some(isImportedMessageId);

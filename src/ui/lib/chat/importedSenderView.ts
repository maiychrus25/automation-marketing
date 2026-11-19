// Quyết định hiển thị cho tin nhập từ tệp sao lưu Facebook mà người gửi chỉ có tên (mã `e2ee-name:…`). Thuần, có test.
import { importedSenderLabel, isImportedSenderId } from '../../../services/facebook/e2eeExport/importedMessage';

/** Tên hiển thị: tên trong mã nhập từ tệp được ưu tiên, không tra cứu gì. */
export const senderDisplayName = (senderId: unknown, resolved: string): string => importedSenderLabel(senderId) || resolved;

/** Nhãn tên người gửi: nhóm (thread_type 1) hoặc người gửi nhập từ tệp (thread_type của tin Facebook luôn là 0). */
export function showsSenderLabel(o: { isSent: boolean; isEcard: boolean; threadType: unknown; senderId: unknown; showTime: boolean; displayName: string }): boolean {
  const imported = isImportedSenderId(o.senderId);
  return !o.isSent && !o.isEcard && (o.threadType === 1 || imported) && o.showTime && !!o.displayName && (imported || o.displayName !== o.senderId);
}

/** false cho người gửi nhập từ tệp: không bao giờ hỏi thông tin người dùng, không mở hồ sơ. */
export const canLookUpSender = (senderId: unknown): boolean => !isImportedSenderId(senderId);

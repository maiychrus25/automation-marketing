// Tin nhập từ tệp sao lưu Facebook không có mã tin Facebook: thao tác theo mã tin bị từ chối ngay ở giao diện (không đổi trạng thái cục bộ).
import { IMPORTED_ACTION_ERROR, isImportedMessageId } from '../../../services/facebook/e2eeExport/importedMessage';

/** Câu từ chối nếu `msg` là tin nhập từ tệp, ngược lại null (tin thường không đổi hành vi). */
export const importedActionRefusal = (msg: { msg_id?: unknown } | null | undefined): string | null =>
  isImportedMessageId(msg?.msg_id) ? IMPORTED_ACTION_ERROR : null;

/**
 * relayChannels - Một danh sách kênh sự kiện chung cho boss (relay) và nhân viên (chuyển tiếp). Thuần, không I/O.
 * Thêm một kênh relay mới ở đây là cả hai phía đều nhận được; không giữ hai danh sách riêng.
 */
import { FACEBOOK_RELAY_CHANNELS, POSTER_RELAY_CHANNELS } from './relayAudience';

/** Mọi kênh boss đẩy tới nhân viên. */
export const RELAYED_EVENT_CHANNELS: readonly string[] = [
  'event:message',
  'event:reaction',
  'event:groupEvent',
  'event:groupInfoUpdate',
  'event:pollVote',
  'event:pinsUpdated',
  'event:connected',
  'event:disconnected',
  'event:friendRequest',
  'event:friendAccepted',
  'event:typing',
  'event:seen',
  'event:receipt',
  'event:undo',
  'event:delete',
  'event:reminder',
  'event:localPath',
  'event:listenerDead',
  // ─── Telegram (mang zaloId = mã tài khoản Telegram; userPresence là tạm thời, không đệm) ───
  'event:telegramReaction',
  'event:messageEdited',
  'event:messagesDeleted',
  'event:forumTopicsChanged',
  'event:telegramEntityHydrated',
  'event:groupMemberAvatar',
  'event:telegramSync',
  'event:userPresence',
  ...FACEBOOK_RELAY_CHANNELS,
  // ─── Facebook Poster (payload rút gọn theo posterRelayEvents) ───
  ...POSTER_RELAY_CHANNELS,
  // ─── ERP ───
  'erp:event:projectCreated',
  'erp:event:projectUpdated',
  'erp:event:projectDeleted',
  'erp:event:taskCreated',
  'erp:event:taskUpdated',
  'erp:event:taskDeleted',
  'erp:event:commentAdded',
  'erp:event:calendarEventCreated',
  'erp:event:calendarEventUpdated',
  'erp:event:calendarEventDeleted',
  'erp:event:reminder',
  'erp:event:noteCreated',
  'erp:event:noteUpdated',
  'erp:event:noteDeleted',
  'erp:event:notification',
  'erp:event:leaveCreated',
  'erp:event:leaveDecided',
  'erp:event:attendanceUpdated',
  'erp:event:noteShared',
  'erp:event:departmentUpdated',
  'erp:event:employeeProfileUpdated',
  'erp:event:employeeProfileDeleted',
  // ─── CRM / Settings ───
  'db:localLabelChanged',
  'db:localLabelThreadChanged',
  'db:pinnedMessageChanged',
  'db:localQuickMessageChanged',
  'crm:campaignChanged',
  'crm:noteChanged',
  'db:pinnedConversationChanged',
  'db:contactFlagsChanged',
  'db:contactAliasChanged',
  'db:unreadChanged',
  'db:conversationDeleted',
  'db:contactProfileUpdated',
  'crm:tagChanged',
  'event:friendRequestSent',
  // ─── Library ───
  'library:itemAdded',
  'library:itemUpdated',
  'library:itemDeleted',
  'event:friendRequestRemoved',
  'crm:queueUpdate',
  'crm:queueStatus',
  'crm:campaignDone',
  'workflow:executed',
  'integration:payment',
  'integration:webhook',
];

/** Kênh điều khiển chỉ có ở phía nhân viên, nằm trong danh sách chuyển tiếp nhưng boss không relay. */
export const EMPLOYEE_CONTROL_CHANNELS: readonly string[] = ['relay:messageSentByEmployee'];

/**
 * Kênh được chuyển tiếp nhưng giao diện chưa bật listener nào cho chúng trên máy nhân viên ("ngủ").
 * Một số đã nằm trong `validChannels` của preload; riêng ba kênh `fb:on*` phải GIỮ NGOÀI preload
 * khi chưa có kiểm thử cho phần xử lý ở giao diện: bật chúng tạo hội thoại ma.
 */
export const RENDERER_DORMANT_CHANNELS: ReadonlySet<string> = new Set([
  'fb:onSeen',
  'fb:onContactUpdate',
  'fb:onThreadInfoUpdate',
  'db:conversationDeleted',
  'db:contactProfileUpdated',
  'crm:tagChanged',
  'library:itemAdded',
  'library:itemUpdated',
  'library:itemDeleted',
  'erp:event:employeeProfileDeleted',
]);

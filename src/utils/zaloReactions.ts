// Mã cảm xúc Zalo ↔ emoji hiển thị. Dùng chung cho chiều gửi (giao diện) và chiều nhận (main + giao diện),
// để cảm xúc hiện tạm khi bấm và cảm xúc Zalo gửi lại là cùng một emoji. Mã lấy từ `Reactions` của zca-js 2.1.2.

/** Mã Zalo (rIcon) → emoji hiển thị. */
export const ZALO_REACTION_ICON_TO_EMOJI: Record<string, string> = {
  '/-heart': '❤️', '/-strong': '👍', ':>': '😆', ':o': '😮',
  ':-((': '😢', ':-h': '😡', ':-*': '😘', ":')": '😂',
  '/-shit': '💩', '/-rose': '🌹', '/-break': '💔', '/-weak': '👎',
  ';xx': '😍', ';-/': '😕', ';-)': '😉', '/-fade': '🥱',
  '_()_': '🙏', '/-no': '🙅', '/-ok': '👌', '/-v': '✌️',
  '/-thanks': '🙏', '/-punch': '👊', ':-bye': '👋', ':((': '😭',
  ':))': '😁', '$-)': '🤑', ';-d': '😁', '/-loveu': '🫶', 'x-)': '😎', '/-bd': '🎂',
};

/** Tên khoá `Reactions` của zca-js → mã Zalo, chỉ các khoá giao diện gửi. */
export const ZALO_REACTION_KEY_TO_ICON: Record<string, string> = {
  HEART: '/-heart', LIKE: '/-strong', HAHA: ':>', WOW: ':o', CRY: ':-((', ANGRY: ':-h', KISS: ':-*',
  TEARS_OF_JOY: ":')", SHIT: '/-shit', ROSE: '/-rose', BROKEN_HEART: '/-break', DISLIKE: '/-weak',
  LOVE: ';xx', OK: '/-ok', PEACE: '/-v', PRAY: '_()_', WINK: ';-)', CONFUSED: ';-/', BIG_SMILE: ';-d',
  PUNCH: '/-punch', BYE: ':-bye', LOVE_YOU: '/-loveu', VERY_SAD: ':((', COOL: 'x-)', BIRTHDAY: '/-bd',
};

/** Emoji người dùng chọn → khoá `Reactions`. Có cả bí danh (😄, 😯) mà các bảng chọn cũ dùng. */
const EMOJI_TO_KEY: Record<string, string> = {
  '❤️': 'HEART', '👍': 'LIKE', '😆': 'HAHA', '😄': 'HAHA', '😮': 'WOW', '😯': 'WOW', '😢': 'CRY', '😡': 'ANGRY',
  '😘': 'KISS', '😂': 'TEARS_OF_JOY', '💩': 'SHIT', '🌹': 'ROSE', '💔': 'BROKEN_HEART',
  '👎': 'DISLIKE', '😍': 'LOVE', '👌': 'OK', '✌️': 'PEACE', '🙏': 'PRAY',
  '😉': 'WINK', '😕': 'CONFUSED', '😁': 'BIG_SMILE', '👊': 'PUNCH', '👋': 'BYE',
  '🫶': 'LOVE_YOU', '😭': 'VERY_SAD', '😎': 'COOL', '🎂': 'BIRTHDAY',
};

export function zaloReactionIconToEmoji(icon: string): string {
  return ZALO_REACTION_ICON_TO_EMOJI[icon] || icon;
}

/** Khoá gửi cho Zalo và emoji sẽ hiện (đúng emoji Zalo gửi lại); null nếu Zalo không có cảm xúc này. */
export function zaloReactionForEmoji(emoji: string): { key: string; icon: string; emoji: string } | null {
  const key = EMOJI_TO_KEY[emoji];
  const icon = key ? ZALO_REACTION_KEY_TO_ICON[key] : undefined;
  return key && icon ? { key, icon, emoji: zaloReactionIconToEmoji(icon) } : null;
}

/**
 * Khi Zalo gửi về một cảm xúc: có cập nhật cửa sổ chat không, có ghi DB không.
 * - Chỉ bỏ qua cửa sổ khi chính cửa sổ này vừa gửi cảm xúc đó và vẫn đang hiện nó (đã hiện tạm lúc bấm).
 *   Cảm xúc thả từ điện thoại, từ máy khác, hay bị mất khỏi cửa sổ do đổi hội thoại trước khi Zalo gửi về thì vẫn hiện.
 * - Gỡ cảm xúc (emoji rỗng) luôn áp dụng: gỡ hai lần vẫn là gỡ.
 * - Chỉ cửa sổ của máy Boss ghi DB của Boss; trên máy nhân viên, DB cục bộ do tiến trình main ghi một lần (HttpClientService).
 */
export function zaloReactionEchoPlan(o: { sentHere: boolean; windowShowsIt: boolean; emoji: string; employeeMode: boolean }): { updateWindow: boolean; persist: boolean } {
  return { updateWindow: !o.emoji || !(o.sentHere && o.windowShowsIt), persist: !o.employeeMode };
}

/**
 * Lúc bấm thả cảm xúc, có ghi DB ngay không.
 * Zalo luôn gửi lại cảm xúc của chính mình và lần gửi lại đó được ghi → ghi lúc bấm nữa là đếm hai lần.
 * Telegram trên máy nhân viên chờ kết quả lệnh rồi mới ghi (giữ như cũ).
 */
export function persistsReactionBeforeEcho(channel: string | undefined | null, employeeMode: boolean): boolean {
  if (!channel || channel === 'zalo') return false;
  if (employeeMode && (channel === 'telegram_user' || channel === 'telegram_bot')) return false;
  return true;
}

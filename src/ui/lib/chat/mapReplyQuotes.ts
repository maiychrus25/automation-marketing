/** Gắn quote_data cho tin trả lời (reply_to_id) từ chính lô tin vừa tải, để preview trích dẫn hiển thị. Dùng chung cho ChatWindow và tải lại sau gián đoạn. */
export function mapReplyQuotes(messages: any[]): { mapped: any[]; missingLookup: Array<{ msgId: string; replyToId: string }> } {
  const msgLookup = new Map<string, { content: string; type: string }>();
  for (const m of messages) {
    msgLookup.set(m.msg_id, { content: m.content || '', type: m.msg_type || 'text' });
  }
  const missingLookup: Array<{ msgId: string; replyToId: string }> = [];
  const mapped = messages.map((m: any) => {
    if (m.channel !== 'telegram_user' && m.reply_to_id && !m.quote_data) {
      const orig = msgLookup.get(m.reply_to_id);
      if (orig) {
        return { ...m, quote_data: JSON.stringify({ msgId: m.reply_to_id, msg: orig.content || '', senderId: '', msgType: orig.type || 'text' }) };
      }
      missingLookup.push({ msgId: m.msg_id, replyToId: m.reply_to_id });
      return m;
    }
    return m;
  });
  return { mapped, missingLookup };
}

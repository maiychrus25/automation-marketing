/** Áp nội dung mới lên một tin. markEdited=false (điền tin rỗng, không phải sửa thật): đổi nội dung, giữ nguyên is_edited/edit_history. Trả null nếu nội dung không đổi. */
export function applyMessageEdit<T extends { content?: any; edit_history?: any }>(
  current: T, newText: string, editCount: number, timestampMs: number, markEdited: boolean = true
): T | null {
  if (current.content === newText) return null;
  if (!markEdited) return { ...current, content: newText };

  let historyArr: Array<{ oldBody: string; editedAt: number; editCount: number }> = [];
  if (current.edit_history) {
    try { historyArr = JSON.parse(current.edit_history); } catch { historyArr = []; }
  }
  if (current.content) {
    historyArr.push({ oldBody: current.content, editedAt: timestampMs, editCount });
  }
  return { ...current, content: newText, is_edited: 1, edit_history: JSON.stringify(historyArr) };
}

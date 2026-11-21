const STATUS_TEXT: Record<string, string> = {
  opening: 'Đang mở trình duyệt…',
  waiting: 'Hãy đăng nhập Facebook trong cửa sổ trình duyệt vừa mở',
  wrong_account: 'Đang đăng nhập tài khoản Facebook khác. Hãy đăng xuất rồi đăng nhập đúng tài khoản này.',
  check_failed: 'Chưa dùng được phiên này',
  saving: 'Đang lưu cookie…',
};

export function browserLoginStatusText(status: string, detail?: string): string {
  const text = STATUS_TEXT[status] ?? '';
  return status === 'check_failed' && detail ? `${text}: ${detail}` : text;
}

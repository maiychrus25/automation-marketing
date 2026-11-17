/**
 * Bảng bên phải của khung chat (thông tin hội thoại, bảng tin nhóm, tích hợp, AI): đứng thành cột riêng cạnh tin nhắn
 * khi vùng chat đủ rộng, chỉ nổi đè lên mép phải khi vùng chat hẹp. Trước đây bảng luôn nổi đè, che mất tin của chính
 * mình (tin canh lề phải) mỗi khi mở bảng.
 */

/** Vùng chat (tin nhắn + bảng) phải rộng ít nhất chừng này thì bảng mới đứng thành cột: bảng rộng nhất 330 px + 360 px cho tin nhắn. */
export const DOCK_RIGHT_PANEL_MIN_AREA_WIDTH = 690;

export function shouldDockRightPanel(chatAreaWidth: number): boolean {
  return chatAreaWidth >= DOCK_RIGHT_PANEL_MIN_AREA_WIDTH;
}

export function rightPanelClassName(docked: boolean): string {
  return docked
    ? 'relative h-full flex-shrink-0 overflow-hidden'
    : 'absolute inset-y-0 right-0 z-40 max-w-[92vw] overflow-hidden';
}

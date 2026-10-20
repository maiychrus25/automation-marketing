import type { VideoStatus } from '../../../models/video';

export type VideoTone = 'success' | 'warning' | 'info' | 'danger' | 'muted';

export interface TemplateVariable { type: 'string' | 'color' | 'number'; label: string; maxLength?: number; min?: number; max?: number; default: unknown }
export interface VideoTemplate {
  id: string; name: string; description: string; aspects: string[];
  durationSec: { min: number; max: number; default: number };
  imageSlots: { min: number; max: number };
  variables: Record<string, TemplateVariable>;
}
export interface VideoFormValues { name: string; aspect: string; variables: Record<string, unknown>; imagePaths: string[]; musicPath?: string }

const STATUS_CHIP: Record<VideoStatus, { label: string; tone: VideoTone }> = {
  uploading: { label: 'Đang tải lên', tone: 'info' },
  queued: { label: 'Đang chờ', tone: 'warning' },
  rendering: { label: 'Đang render', tone: 'info' },
  done: { label: 'Hoàn tất', tone: 'success' },
  failed: { label: 'Lỗi', tone: 'danger' },
  cancelled: { label: 'Đã huỷ', tone: 'muted' },
};
export const VIDEO_TONE_CLASS: Record<VideoTone, string> = {
  success: 'text-green-400 border-green-500/30',
  warning: 'text-orange-400 border-orange-500/30',
  info: 'text-blue-400 border-blue-500/30',
  danger: 'text-red-400 border-red-500/30',
  muted: 'text-gray-400 border-gray-600',
};

export const videoStatusChip = (status: VideoStatus) => STATUS_CHIP[status] ?? { label: status, tone: 'muted' as VideoTone };
/** Việc còn chạy (có thể huỷ, cần cập nhật tiến độ). */
export const isActiveStatus = (status: VideoStatus) => status === 'uploading' || status === 'queued' || status === 'rendering';

export function formatDuration(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec)) return '—';
  const whole = Math.floor(sec);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function defaultVariables(template: VideoTemplate): Record<string, unknown> {
  return Object.fromEntries(Object.entries(template.variables).map(([key, v]) => [key, v.default]));
}

const extensionOf = (path: string) => (path.split(/[\\/]/).pop() ?? '').split('.').slice(1).pop()?.toLowerCase() ?? '';
export const VIDEO_IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'];
export const VIDEO_MUSIC_EXTENSIONS = ['mp3', 'm4a', 'wav'];
const MAX_NAME = 100;

/** Trả về map lỗi theo ô (rỗng khi hợp lệ). Khoá: name, aspect, images, music, var:<tên biến>. */
export function validateVideoForm(template: VideoTemplate, form: VideoFormValues): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!form.name.trim()) errors.name = 'Nhập tên video.';
  else if (form.name.trim().length > MAX_NAME) errors.name = `Tên video tối đa ${MAX_NAME} ký tự.`;
  if (!template.aspects.includes(form.aspect)) errors.aspect = 'Mẫu này không hỗ trợ khổ đã chọn.';

  const { min, max } = template.imageSlots;
  if (form.imagePaths.length < min) errors.images = `Cần ít nhất ${min} ảnh.`;
  else if (form.imagePaths.length > max) errors.images = `Tối đa ${max} ảnh.`;
  else if (form.imagePaths.some((p) => !VIDEO_IMAGE_EXTENSIONS.includes(extensionOf(p)))) errors.images = 'Chỉ dùng ảnh JPEG, PNG hoặc WebP.';

  for (const [key, def] of Object.entries(template.variables)) {
    const value = form.variables[key];
    let message = '';
    if (def.type === 'string') {
      const text = typeof value === 'string' ? value.trim() : '';
      if (!text) message = `Nhập ${def.label.toLowerCase()}.`;
      else if (def.maxLength !== undefined && text.length > def.maxLength) message = `${def.label} tối đa ${def.maxLength} ký tự.`;
    } else if (def.type === 'color') {
      if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) message = `${def.label} phải có dạng #rrggbb.`;
    } else if (typeof value !== 'number' || !Number.isFinite(value)) {
      message = `Nhập số cho ${def.label.toLowerCase()}.`;
    } else if ((def.min !== undefined && value < def.min) || (def.max !== undefined && value > def.max)) {
      message = `${def.label} phải từ ${def.min ?? '−∞'} đến ${def.max ?? '∞'}.`;
    }
    if (message) errors[`var:${key}`] = message;
  }

  if (form.musicPath && !VIDEO_MUSIC_EXTENSIONS.includes(extensionOf(form.musicPath))) errors.music = 'Nhạc phải là MP3, M4A hoặc WAV.';
  return errors;
}

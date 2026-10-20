export type FileType = 'jpg' | 'png' | 'webp' | 'mp3' | 'm4a' | 'wav' | 'mp4';
export type FileKind = 'image' | 'audio' | 'video';

export const KIND_OF: Record<FileType, FileKind> = {
  jpg: 'image',
  png: 'image',
  webp: 'image',
  mp3: 'audio',
  m4a: 'audio',
  wav: 'audio',
  mp4: 'video',
};

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const startsWith = (b: Buffer, sig: number[], at = 0): boolean => sig.every((v, i) => b[at + i] === v);
const ascii = (b: Buffer, from: number, to: number): string => b.subarray(from, to).toString('latin1');

/** Nhận dạng loại tệp theo chữ ký nội dung (đọc tối đa 64 byte đầu). */
export function sniff(buf: Buffer): FileType | null {
  const b = buf.subarray(0, 64);
  if (b.length < 3) return null;
  if (startsWith(b, [0xff, 0xd8, 0xff])) return 'jpg'; // kiểm trước MP3 vì cùng bắt đầu bằng 0xFF
  if (startsWith(b, PNG)) return 'png';
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF') {
    const form = ascii(b, 8, 12);
    if (form === 'WEBP') return 'webp';
    if (form === 'WAVE') return 'wav';
    return null;
  }
  if (ascii(b, 0, 3) === 'ID3') return 'mp3';
  // Khung MP3: 11 bit đầu bằng 1, phiên bản khác 01 (dành riêng), layer khác 00 (dành riêng)
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && ((b[1] >> 3) & 3) !== 1 && ((b[1] >> 1) & 3) !== 0) return 'mp3';
  if (b.length >= 12 && ascii(b, 4, 8) === 'ftyp') {
    const brand = ascii(b, 8, 12);
    return brand === 'M4A ' || brand === 'M4B ' ? 'm4a' : 'mp4';
  }
  return null;
}

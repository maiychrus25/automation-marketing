import { videoStatusChip, isActiveStatus, formatDuration, formatBytes, defaultVariables, validateVideoForm, type VideoTemplate } from '../../ui/features/facebookPoster/videoFormat';

const template: VideoTemplate = {
  id: 'promo', name: 'Khuyến mãi', description: '', aspects: ['9:16', '1:1'],
  durationSec: { min: 5, max: 60, default: 15 },
  imageSlots: { min: 2, max: 4 },
  variables: {
    title: { type: 'string', label: 'Tiêu đề', maxLength: 10, default: 'Giảm giá' },
    color: { type: 'color', label: 'Màu', default: '#ff0000' },
    secs: { type: 'number', label: 'Số giây', default: 10 },
  },
};
const good = { name: 'Video 1', aspect: '9:16', variables: { title: 'Tết', color: '#00ff00', secs: 10 }, imagePaths: ['/a.jpg', '/b.png'] };

describe('videoFormat', () => {
  test('status chip and active flag', () => {
    expect(videoStatusChip('done')).toEqual({ label: 'Hoàn tất', tone: 'success' });
    expect(videoStatusChip('failed').tone).toBe('danger');
    expect(videoStatusChip('rendering').label).toBe('Đang render');
    expect(videoStatusChip('queued').label).toBe('Đang chờ');
    expect(isActiveStatus('uploading')).toBe(true);
    expect(isActiveStatus('queued')).toBe(true);
    expect(isActiveStatus('rendering')).toBe(true);
    expect(isActiveStatus('done')).toBe(false);
    expect(isActiveStatus('cancelled')).toBe(false);
  });
  test('duration and size text', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(9.4)).toBe('0:09');
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
  test('defaults come from the template', () => {
    expect(defaultVariables(template)).toEqual({ title: 'Giảm giá', color: '#ff0000', secs: 10 });
  });
  test('valid form has no errors', () => {
    expect(validateVideoForm(template, good)).toEqual({});
  });
  test('name is required and at most 100 characters', () => {
    expect(validateVideoForm(template, { ...good, name: '  ' }).name).toBeTruthy();
    expect(validateVideoForm(template, { ...good, name: 'x'.repeat(101) }).name).toBeTruthy();
    expect(validateVideoForm(template, { ...good, name: 'x'.repeat(100) }).name).toBeUndefined();
  });
  test('aspect must be supported', () => {
    expect(validateVideoForm(template, { ...good, aspect: '16:9' }).aspect).toBeTruthy();
  });
  test('images respect slot range and allowed types', () => {
    expect(validateVideoForm(template, { ...good, imagePaths: ['/a.jpg'] }).images).toMatch(/2/);
    expect(validateVideoForm(template, { ...good, imagePaths: ['/1.jpg', '/2.jpg', '/3.jpg', '/4.jpg', '/5.jpg'] }).images).toMatch(/4/);
    expect(validateVideoForm(template, { ...good, imagePaths: ['/a.jpg', '/b.gif'] }).images).toBeTruthy();
    expect(validateVideoForm(template, { ...good, imagePaths: ['/a.JPG', '/b.webp'] }).images).toBeUndefined();
  });
  test('string variables are required and capped by maxLength', () => {
    expect(validateVideoForm(template, { ...good, variables: { ...good.variables, title: ' ' } })['var:title']).toBeTruthy();
    expect(validateVideoForm(template, { ...good, variables: { ...good.variables, title: 'x'.repeat(11) } })['var:title']).toBeTruthy();
  });
  test('color must be #rrggbb', () => {
    expect(validateVideoForm(template, { ...good, variables: { ...good.variables, color: 'red' } })['var:color']).toBeTruthy();
    expect(validateVideoForm(template, { ...good, variables: { ...good.variables, color: '#fff' } })['var:color']).toBeTruthy();
    expect(validateVideoForm(template, { ...good, variables: { ...good.variables, color: '#AbCdEf' } })['var:color']).toBeUndefined();
  });
  test('number must be finite', () => {
    expect(validateVideoForm(template, { ...good, variables: { ...good.variables, secs: '' } })['var:secs']).toBeTruthy();
    expect(validateVideoForm(template, { ...good, variables: { ...good.variables, secs: Number.NaN } })['var:secs']).toBeTruthy();
  });
  test('uploaded music must be mp3, m4a or wav', () => {
    expect(validateVideoForm(template, { ...good, musicPath: '/m.ogg' }).music).toBeTruthy();
    expect(validateVideoForm(template, { ...good, musicPath: '/m.MP3' }).music).toBeUndefined();
  });
});

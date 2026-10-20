import { KIND_OF, sniff } from '../src/fileTypes';

const pad = (...b: number[]) => Buffer.concat([Buffer.from(b), Buffer.alloc(64)]);
const ascii = (s: string) => Buffer.from(s, 'latin1');

describe('sniff', () => {
  it('JPEG', () => expect(sniff(pad(0xff, 0xd8, 0xff, 0xe0))).toBe('jpg'));
  it('PNG', () => expect(sniff(pad(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe('png'));
  it('WebP', () => {
    expect(sniff(Buffer.concat([ascii('RIFF'), Buffer.alloc(4), ascii('WEBPVP8 ')]))).toBe('webp');
  });
  it('WAV', () => {
    expect(sniff(Buffer.concat([ascii('RIFF'), Buffer.alloc(4), ascii('WAVEfmt ')]))).toBe('wav');
  });
  it('RIFF khác (AVI) bị từ chối', () => {
    expect(sniff(Buffer.concat([ascii('RIFF'), Buffer.alloc(4), ascii('AVI LIST')]))).toBeNull();
  });
  it('MP3 có ID3', () => expect(sniff(Buffer.concat([ascii('ID3'), Buffer.alloc(20)]))).toBe('mp3'));
  it('MP3 frame sync', () => {
    expect(sniff(pad(0xff, 0xfb, 0x90, 0x00))).toBe('mp3');
    expect(sniff(pad(0xff, 0xf3, 0x90, 0x00))).toBe('mp3');
  });
  it('frame sync sai phiên bản/layer bị từ chối', () => {
    expect(sniff(pad(0xff, 0xe8, 0x90, 0x00))).toBeNull(); // phiên bản dành riêng
    expect(sniff(pad(0xff, 0xf9, 0x90, 0x00))).toBeNull(); // layer dành riêng
  });
  it('MP4 (isom, mp42)', () => {
    expect(sniff(Buffer.concat([Buffer.alloc(4), ascii('ftypisom'), Buffer.alloc(8)]))).toBe('mp4');
    expect(sniff(Buffer.concat([Buffer.alloc(4), ascii('ftypmp42'), Buffer.alloc(8)]))).toBe('mp4');
  });
  it('M4A / M4B', () => {
    expect(sniff(Buffer.concat([Buffer.alloc(4), ascii('ftypM4A '), Buffer.alloc(8)]))).toBe('m4a');
    expect(sniff(Buffer.concat([Buffer.alloc(4), ascii('ftypM4B '), Buffer.alloc(8)]))).toBe('m4a');
  });
  it('tệp thực thi / văn bản / rỗng / quá ngắn', () => {
    expect(sniff(Buffer.concat([ascii('MZ'), Buffer.alloc(60)]))).toBeNull();
    expect(sniff(Buffer.concat([Buffer.from([0x7f]), ascii('ELF'), Buffer.alloc(60)]))).toBeNull();
    expect(sniff(ascii('<?php echo 1;'))).toBeNull();
    expect(sniff(Buffer.alloc(0))).toBeNull();
    expect(sniff(Buffer.from([0xff]))).toBeNull();
    expect(sniff(Buffer.from([0xff, 0xd8]))).toBeNull();
  });
  it('KIND_OF', () => {
    expect(KIND_OF.jpg).toBe('image');
    expect(KIND_OF.png).toBe('image');
    expect(KIND_OF.webp).toBe('image');
    expect(KIND_OF.mp3).toBe('audio');
    expect(KIND_OF.m4a).toBe('audio');
    expect(KIND_OF.wav).toBe('audio');
    expect(KIND_OF.mp4).toBe('video');
  });
});

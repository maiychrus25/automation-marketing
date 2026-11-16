/**
 * FacebookAttachment.ts
 * Port từ Python _messaging/_attachments.py
 * Upload file đính kèm lên Facebook
 *
 * Lưu ý: Sử dụng manual multipart body để tránh lỗi 0KB do form-data
 * npm package không tương thích với môi trường Electron Node.js.
 */

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as mime from 'mime-types';
import { FBSessionData, FBAttachmentUploadResult } from './FacebookTypes';
import { strBase } from './FacebookUtils';
import Logger from '../../utils/Logger';
import { FB_SEC_CH_UA, FB_SEC_CH_UA_PLATFORM, FB_USER_AGENT } from './facebookIdentity';
import type { PageWebSession } from './pageInboxProtocol';

const UPLOAD_URL = 'https://upload.facebook.com/ajax/mercury/upload.php';
const PAGE_UPLOAD_URL = 'https://upload-business.facebook.com/ajax/mercury/upload.php';

let _uploadReqCounter = 0;
/** Business Suite đặt tên phần tệp là upload_1024, upload_1025, … */
let _pageUploadCounter = 1023;

/** Loại tệp theo đuôi, có sửa cho bản ghi âm WebM/OGG. */
function uploadMimeType(filePath: string, fileSize: number): string {
  const mimeType = (mime.lookup(filePath) || 'application/octet-stream') as string;
  // WebM audio recordings (từ MediaRecorder) có mimeType audio/webm nhưng
  // mime.lookup(filePath) chỉ dùng extension → trả về video/webm cho file .webm.
  // Heuristic: nếu file < 5MB và extension là .webm hoặc .ogg, coi như audio.
  if ((mimeType === 'video/webm' || mimeType === 'video/ogg') && fileSize < 5 * 1024 * 1024) {
    return mimeType === 'video/webm' ? 'audio/webm' : 'audio/ogg';
  }
  return mimeType;
}

/**
 * Build a single multipart field (text value)
 */
function buildTextPart(boundary: string, name: string, value: string): Buffer {
  return Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
    `${value}\r\n`
  );
}

/**
 * Build a single multipart field (file value)
 */
function buildFilePart(boundary: string, name: string, filename: string, contentType: string, data: Buffer): Buffer {
  // Không dùng Content-Transfer-Encoding - header này không chuẩn trong
  // multipart/form-data và gây lỗi parser của Facebook (file về 0KB).
  const header = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`
  );
  const footer = Buffer.from(`\r\n`);
  return Buffer.concat([header, data, footer]);
}

/**
 * Build closing boundary
 */
function buildClosingBoundary(boundary: string): Buffer {
  return Buffer.from(`--${boundary}--\r\n`);
}

/**
 * Upload file đính kèm lên Facebook
 * Trả về attachmentId để dùng khi send message
 */
export async function uploadAttachment(
  dataFB: FBSessionData,
  filePath: string,
  httpsAgent?: any
): Promise<FBAttachmentUploadResult | null> {
  if (!fs.existsSync(filePath)) {
    Logger.error(`[FacebookAttachment] File not found: ${filePath}`);
    return null;
  }

  _uploadReqCounter += 1;
  const reqId = strBase(_uploadReqCounter, 36);
  const userAgent = FB_USER_AGENT;
  const fileName = path.basename(filePath);
  const fileBuffer = fs.readFileSync(filePath);

  const fileSize = fileBuffer.length;
  const mimeType = uploadMimeType(filePath, fileSize);

  Logger.log(`[FacebookAttachment] Uploading: ${fileName} (${fileSize} bytes, ${mimeType})`);

  // Build multipart body manually - reliable across all Node.js versions
  const boundary = `----WebKitFormBoundary${Math.random().toString(36).slice(2, 12)}`;
  const parts: Buffer[] = [
    buildTextPart(boundary, 'voice_clip', 'false'),
    buildTextPart(boundary, '__a', '1'),
    buildTextPart(boundary, '__req', reqId),
    buildTextPart(boundary, 'fb_dtsg', dataFB.fb_dtsg),
    buildFilePart(boundary, 'upload_0', fileName, mimeType, fileBuffer),
    buildClosingBoundary(boundary),
  ];
  const bodyBuffer = Buffer.concat(parts);

  try {
    const response = await axios.post(UPLOAD_URL, bodyBuffer, {
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(bodyBuffer.length),
        'Referer': 'https://www.facebook.com',
        'Accept': 'text/html',
        'User-Agent': userAgent,
        'Cookie': dataFB.cookieFacebook,
      },
      timeout: 60000,
      maxBodyLength: 100 * 1024 * 1024, // 100MB max
      maxContentLength: 100 * 1024 * 1024, // 100MB max
      ...(httpsAgent ? { httpsAgent } : {}),
    });

    let resultText = response.data as string;
    if (typeof resultText === 'string') {
      resultText = resultText.replace(/for\s*\(;;\);/, '').trim();
    }

    let parsed: any;
    try {
      parsed = typeof resultText === 'string' ? JSON.parse(resultText) : resultText;
    } catch {
      Logger.error(`[FacebookAttachment] Upload failed: cannot parse response - ${String(resultText).slice(0, 200)}`);
      return null;
    }

    const payload = parsed?.payload;

    if (!payload) {
      Logger.error(`[FacebookAttachment] Upload failed: no payload. Response: ${JSON.stringify(parsed).slice(0, 300)}`);
      return null;
    }

    // Parse metadata - FB sometimes returns array, sometimes object keyed by "0"
    let metadata: any = null;
    if (payload?.metadata) {
      if (Array.isArray(payload.metadata)) {
        metadata = payload.metadata[0] || null;
      } else if (typeof payload.metadata === 'object') {
        metadata = payload.metadata['0'] || Object.values(payload.metadata)[0] || null;
      }
    }

    // Fallback: some responses embed attachment directly in payload (no metadata wrapper)
    if (!metadata && payload.attachmentFbid) {
      metadata = { 0: payload.attachmentFbid, 1: null, 2: mimeType, 3: null };
    }

    if (!metadata) {
      Logger.error(`[FacebookAttachment] Upload failed: no metadata. Payload keys: ${Object.keys(payload || {}).join(',')}`);
      return null;
    }

    // Extract attachment info from metadata
    // Quan trọng: dùng local mimeType thay vì values[2] từ FB response,
    // vì FB có thể trả về type sai (ví dụ audio/webm → video/mp4).
    const values = Array.isArray(metadata) ? metadata : Object.values(metadata);
    const attachmentId = values[0];
    const attachmentUrl = (values[3] as string | undefined) || undefined;

    Logger.log(`[FacebookAttachment] Uploaded: ${fileName} (${fileSize} bytes) → id=${attachmentId} type=${mimeType}`);

    return {
      attachmentId: attachmentId as string | number,
      attachmentUrl,
      attachmentType: mimeType,
    };
  } catch (err: any) {
    Logger.error(`[FacebookAttachment] uploadAttachment error: ${err.message}`);
    return null;
  }
}

/**
 * Tải một tệp lên để gửi đứng tên Page, theo đúng yêu cầu của Business Suite (bản ghi 16/11/2026): đăng nhập bằng cookie
 * tài khoản cá nhân, `request_user_id` là id Page, mọi tham số nằm trên địa chỉ và thân chỉ có một phần là tệp.
 * Trả mã đính kèm để gửi qua hộp thư Page; null nếu tải lên không thành. Log không chứa cookie, mã phiên hay nội dung trả về.
 */
export async function uploadPageAttachment(session: PageWebSession, filePath: string): Promise<FBAttachmentUploadResult | null> {
  if (!fs.existsSync(filePath)) {
    Logger.error('[FacebookAttachment] Page upload: file not found');
    return null;
  }
  const fileBuffer = fs.readFileSync(filePath);
  const mimeType = uploadMimeType(filePath, fileBuffer.length);
  _uploadReqCounter += 1;
  _pageUploadCounter += 1;
  const boundary = `----WebKitFormBoundary${Math.random().toString(36).slice(2, 12)}`;
  const body = Buffer.concat([
    buildFilePart(boundary, `upload_${_pageUploadCounter}`, path.basename(filePath), mimeType, fileBuffer),
    buildClosingBoundary(boundary),
  ]);
  const query = new URLSearchParams({
    request_user_id: session.pageId, __aaid: '0', __user: session.userId, __a: '1', __req: strBase(_uploadReqCounter, 36), __comet_req: '11',
    fb_dtsg: session.fbDtsg, jazoest: session.jazoest, ...(session.lsd ? { lsd: session.lsd } : {}),
  });

  try {
    const response = await axios.post(`${PAGE_UPLOAD_URL}?${query}`, body, {
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(body.length),
        'Accept': '*/*',
        'Origin': 'https://business.facebook.com',
        'Referer': 'https://business.facebook.com/',
        'sec-ch-ua': FB_SEC_CH_UA,
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': FB_SEC_CH_UA_PLATFORM,
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-site',
        'User-Agent': FB_USER_AGENT,
        'Cookie': session.cookieHeader,
      },
      timeout: 120000,
      maxBodyLength: 100 * 1024 * 1024,
      maxContentLength: 100 * 1024 * 1024,
      responseType: 'text',
      transformResponse: [(data: unknown) => data], // giữ nguyên chữ: mã đính kèm 16 chữ số vượt độ chính xác của JSON.parse
      validateStatus: () => true,
      ...(session.agent ? { httpsAgent: session.agent } : {}),
    });
    const text = typeof response.data === 'string' ? response.data : '';
    // Mã theo loại tệp (ảnh, ảnh động, video, ghi âm, tệp) được ưu tiên; `fbid` chỉ là dự phòng.
    const id = /"(?:image_id|gif_id|video_id|audio_id|file_id)":"?(\d+)/.exec(text)?.[1] ?? /"fbid":"?(\d+)/.exec(text)?.[1];
    if (!id) {
      Logger.error(`[FacebookAttachment] Page upload failed: status=${response.status} error=${/"error":(\d+)/.exec(text)?.[1] ?? 'none'} len=${text.length}`);
      return null;
    }
    Logger.log(`[FacebookAttachment] Page upload done: ${fileBuffer.length} bytes, ${mimeType}`);
    return { attachmentId: id, attachmentType: mimeType };
  } catch (err: any) {
    Logger.error(`[FacebookAttachment] Page upload error: ${err.message}`);
    return null;
  }
}

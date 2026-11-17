import type { RelayAudience } from '../socket/relayAudience';

/**
 * posterRelayEvents - Sự kiện Facebook Poster nào tới nhân viên, tới ai và gửi gì. Thuần, không I/O.
 * Mặc định đóng: kênh lạ hoặc payload sai dạng thì không chuyển. `log` và `progress` đi nguyên payload (chỉ tới nhân viên được gán đủ
 * các hồ sơ của sự kiện); các kênh còn lại chỉ mang bản rút gọn (không mẫu bình luận, tên hồ sơ, mã khách tiềm năng): nhân viên tự tải lại
 * qua lệnh đã được kiểm quyền.
 * Việc loại các lượt chạy của Page (chỉ boss) cần đọc cơ sở dữ liệu nên do relay làm sau hàm này.
 */

export interface PosterRelayEvent { audience: RelayAudience; data: unknown }

const MODULE: RelayAudience = { kind: 'module', module: 'fb_poster' };

const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** `jobId` và mọi khoá có giá trị số hữu hạn; không có chữ nào khác đi qua. */
function numbersAndJobId(data: Record<string, any>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if ((key === 'jobId' && typeof value === 'string') || (typeof value === 'number' && Number.isFinite(value))) out[key] = value;
  }
  return out;
}

/** Mã lượt chạy của nhật ký, tiến độ và kết thúc lượt; null khi sự kiện không thuộc một lượt. */
export function posterEventRunId(channel: string, data: unknown): string | null {
  if (channel !== 'facebookPoster:log' && channel !== 'facebookPoster:progress' && channel !== 'facebookPoster:runFinished') return null;
  return isObject(data) && text(data.runId) ? data.runId : null;
}

export function posterRelayEvent(channel: string, data: unknown): PosterRelayEvent | null {
  switch (channel) {
    case 'facebookPoster:log':
      return isObject(data) && text(data.profileId) ? { audience: { kind: 'profiles', ids: [data.profileId] }, data } : null;
    case 'facebookPoster:progress': {
      if (!isObject(data) || !Array.isArray(data.profiles) || data.profiles.length === 0) return null;
      const ids = data.profiles.map((p: unknown) => (isObject(p) ? p.profileId : null));
      return ids.every(text) ? { audience: { kind: 'profiles', ids: [...new Set<string>(ids)] }, data } : null;
    }
    case 'facebookPoster:runFinished':
      return isObject(data) && text(data.runId) ? { audience: MODULE, data: { runId: data.runId, status: typeof data.status === 'string' ? data.status : undefined } } : null;
    case 'facebookPoster:schedulesChanged':
      return { audience: MODULE, data: undefined };
    case 'facebookPoster:loginStateChanged':
      return { audience: MODULE, data: [] }; // giao diện tự tải lại qua lệnh đã lọc theo hồ sơ
    case 'facebookPoster:leadsFound':
      return isObject(data) ? { audience: MODULE, data: { count: 0, samples: [], auto: data.auto === true, leadIds: [], campaignIds: [] } } : null;
    case 'facebookPoster:loginCheckProgress':
      // null là "kiểm tra xong": nhân viên cần nó để tắt thanh tiến độ.
      return data === null ? { audience: MODULE, data: null } : isObject(data) ? { audience: MODULE, data: numbersAndJobId(data) } : null;
    case 'facebookPoster:trackProgress':
    case 'facebookPoster:commentCollectProgress':
      return isObject(data) ? { audience: MODULE, data: numbersAndJobId(data) } : null;
    case 'facebookPoster:trackFinished':
    case 'facebookPoster:commentCollectFinished':
      return isObject(data) ? { audience: MODULE, data: { jobId: typeof data.jobId === 'string' ? data.jobId : undefined, auto: data.auto === true, cancelled: data.cancelled === true } } : null;
    default:
      return null;
  }
}

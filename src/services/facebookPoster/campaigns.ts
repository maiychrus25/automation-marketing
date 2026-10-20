import type { CampaignStatus, FbPosterCampaign } from '../../models/facebookPoster';

const MAX_NAME = 100;
const MAX_GOAL = 1000;
const STATUSES: CampaignStatus[] = ['active', 'paused', 'archived'];

/** Lý do lịch của chiến dịch không được tự chạy lúc `t`; `null` = chạy được. */
export function campaignBlockReason(c: FbPosterCampaign, t: number): string | null {
    if (c.status === 'paused') return 'Chiến dịch đang tạm dừng';
    if (c.status === 'archived') return 'Chiến dịch đã lưu trữ';
    if ((c.startAt !== null && t < c.startAt) || (c.endAt !== null && t > c.endAt)) return 'Ngoài thời gian chiến dịch';
    return null;
}

export const isCampaignRunnable = (c: FbPosterCampaign, t: number): boolean => campaignBlockReason(c, t) === null;

export interface CampaignInput { name: string; goal: string; startAt: number | null; endAt: number | null; status: CampaignStatus }

function readTime(v: unknown, fallback: number | null, label: string): number | null {
    if (v === undefined) return fallback;
    if (v === null) return null;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error(`${label} không hợp lệ`);
    return v;
}

/** Kiểm tra dữ liệu tạo/sửa chiến dịch; trường vắng giữ giá trị của `existing`. Ném lỗi tiếng Việt. */
export function validateCampaignInput(
    input: Record<string, unknown>,
    opts: { existing?: FbPosterCampaign; findByName: (name: string) => FbPosterCampaign | null },
): CampaignInput {
    const { existing } = opts;
    const rawName = input.name === undefined ? existing?.name : input.name;
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (!name) throw new Error('Tên chiến dịch không được để trống');
    if (name.length > MAX_NAME) throw new Error(`Tên chiến dịch tối đa ${MAX_NAME} ký tự`);
    const dup = opts.findByName(name);
    if (dup && dup.id !== existing?.id) throw new Error('Tên chiến dịch đã tồn tại');

    const rawGoal = input.goal === undefined ? (existing?.goal ?? '') : input.goal;
    if (typeof rawGoal !== 'string') throw new Error('Mục tiêu không hợp lệ');
    if (rawGoal.length > MAX_GOAL) throw new Error(`Mục tiêu tối đa ${MAX_GOAL} ký tự`);

    const status = input.status === undefined ? (existing?.status ?? 'active') : input.status;
    if (!STATUSES.includes(status as CampaignStatus)) throw new Error('Trạng thái chiến dịch không hợp lệ');

    const startAt = readTime(input.startAt, existing?.startAt ?? null, 'Ngày bắt đầu');
    const endAt = readTime(input.endAt, existing?.endAt ?? null, 'Ngày kết thúc');
    if (startAt !== null && endAt !== null && startAt > endAt) throw new Error('Ngày bắt đầu phải trước ngày kết thúc');

    return { name, goal: rawGoal, startAt, endAt, status: status as CampaignStatus };
}

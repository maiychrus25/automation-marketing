import Logger from '../../utils/Logger';
import { errorText } from './controlSecurity';
import { BUSY_ERROR, ENGINE_MISSING_ERROR } from '../facebookPoster/FacebookPosterService';
import { SCAN_NOT_FOUND_ERROR, UnknownProfilesError } from '../research/researchOperationsLogic';
import { RenderError } from '../video/RenderClient';

/** Mã lỗi cố định của giao thức (spec §3.2). */
export type ControlErrorCode =
    | 'UNAUTHORIZED' | 'FORBIDDEN_IP' | 'RATE_LIMITED' | 'INVALID_PARAMS' | 'NOT_FOUND'
    | 'CONFIRMATION_REQUIRED' | 'BUSY' | 'ENGINE_MISSING' | 'LIMIT_REACHED'
    | 'PAYLOAD_TOO_LARGE' | 'UNKNOWN_METHOD' | 'INTERNAL';

export class ControlError extends Error {
    constructor(public readonly code: ControlErrorCode, message: string, public readonly details?: Record<string, unknown>) {
        super(message);
        this.name = 'ControlError';
    }
}

const INTERNAL_MESSAGE = 'Lỗi nội bộ của MaiHub, thử lại sau';
const NOT_FOUND_MESSAGES = ['Không tìm thấy bản nháp', 'Không tìm thấy lịch', 'Không tìm thấy lần chạy', 'Không tìm thấy chiến dịch', 'Không tìm thấy khách', SCAN_NOT_FOUND_ERROR];

/** Trùng `WORKSPACE_SWITCHING_ERROR` của facebookPosterIpc/researchIpc (có test đối chiếu); không import để tránh kéo Electron vào đây. */
const WORKSPACE_SWITCHING_MESSAGE = 'Đang đổi workspace, thử lại sau';

/** Lỗi máy chủ render -> mã giao thức có sẵn (spec video §6.5); thông báo của RenderClient đã tiếng Việt và không chứa khoá API. */
function fromRenderError(err: RenderError): ControlError {
    switch (err.code) {
        case 'limit': return new ControlError('LIMIT_REACHED', err.message);
        case 'not_found': return new ControlError('NOT_FOUND', err.message);
        case 'unconfigured':
        case 'invalid': return new ControlError('INVALID_PARAMS', err.message);
        default: return new ControlError('INTERNAL', err.message);
    }
}

/**
 * Đổi lỗi ném ra từ posterOperations thành mã giao thức. Chỉ `new Error(msg)` thuần (lỗi kiểm tra có thông báo tiếng Việt)
 * mới thành INVALID_PARAMS; mọi lỗi khác (TypeError, lỗi SQLite/hệ thống tệp…) là INTERNAL, không lộ thông báo gốc.
 */
export function toControlError(err: unknown): ControlError {
    if (err instanceof ControlError) return err;
    // Lớp con của Error nên phải xử lý trước nhánh "chỉ Error thuần".
    if (err instanceof UnknownProfilesError) return new ControlError('NOT_FOUND', err.message, { missing: err.missing });
    if (err instanceof RenderError) return fromRenderError(err);
    const plain = err instanceof Error && err.constructor === Error && typeof (err as { code?: unknown }).code !== 'string';
    if (!plain) return new ControlError('INTERNAL', INTERNAL_MESSAGE);
    const message = (err as Error).message;
    if (message.includes(BUSY_ERROR) || message === WORKSPACE_SWITCHING_MESSAGE) return new ControlError('BUSY', message);
    if (message === ENGINE_MISSING_ERROR) return new ControlError('ENGINE_MISSING', message);
    if (/Tối đa \d+ lịch/.test(message)) return new ControlError('LIMIT_REACHED', message);
    if (NOT_FOUND_MESSAGES.includes(message)) return new ControlError('NOT_FOUND', message);
    return new ControlError('INVALID_PARAMS', message);
}

/** `signal` huỷ khi client ngắt kết nối (dùng cho long-poll). */
export interface ControlContext { keyName?: string; signal?: AbortSignal }
export type ControlParams = Record<string, any>;

export interface ControlMethod {
    name: string;
    description: string;
    destructive: boolean | ((params: ControlParams) => boolean);
    /** Mô tả cho /v1/describe khi `destructive` là hàm: điều kiện tham số khiến thao tác cần xác nhận. */
    destructiveWhen?: ControlParams;
    paramsSchema: object;
    resultSchema: object;
    run(params: ControlParams, ctx: ControlContext): Promise<unknown>;
}

/** Chỉ các thao tác ControlMethods dùng; khớp `posterOperations` (không có pickMedia/exportRunCsv/takeMissed). */
export interface PosterPort {
    start(params: any): any;
    scheduleList(params?: any): any;
    scheduleUpdate(params: any): any;
    scheduleDelete(params: any): any;
    draftSave(params: any): any;
    draftGet(params: any): any;
    draftApprove(params: any): any;
    cancel(params?: any): any;
    current(params?: any): any;
    listGroups(params: any): any;
    listRuns(params: any): any;
    getRun(params: any): any;
}

/** Các thao tác Nghiên cứu chủ đề; nguồn gốc lượt quét (`api`) do nơi dựng port gắn vào. */
export interface ResearchPort {
    search(params: any): any;
    scanGroupFeeds(params: any): any;
    list(params?: any): any;
    get(params: any): any;
    cancel(): any;
}

/** Các thao tác theo dõi bài đăng (`trackingOperations`); kiểm tra tham số nằm ở đó. */
export interface TrackingPort {
    track(params: any): any;
    status(): any;
    cancel(): any;
    list(params?: any): any;
    stats(params: any): any;
    groupScores(params?: any): any;
    bestTimes(params?: any): any;
    getConfig(): any;
    setConfig(params: any): any;
}

/** Các thao tác chiến dịch (`campaignOperations`); kiểm tra tham số nằm ở đó. */
export interface CampaignPort {
    list(params?: any): any;
    get(params: any): any;
    create(params: any): any;
    update(params: any): any;
    delete(params: any): any;
}

/** Video Studio (`videoOperations`); kiểm tra tham số nằm ở đó. */
export interface VideoPort {
    templates(): any;
    render(params: any): any;
    status(params: any): any;
    list(params?: any): any;
    cancel(params: any): any;
}

/** Khách tiềm năng và thu bình luận (`leadOperations`); kiểm tra tham số nằm ở đó. */
export interface LeadPort {
    list(params?: any): any;
    update(params: any): any;
    getConfig(): any;
    setConfig(params: any): any;
    collect(params?: any): any;
    comments(params?: any): any;
}

export interface ControlEventRow { seq: number; type: string; payload: unknown; createdAt: number }

export interface ControlMethodDeps {
    poster: PosterPort;
    research: ResearchPort;
    tracking: TrackingPort;
    campaigns: CampaignPort;
    leads: LeadPort;
    videos: VideoPort;
    listProfiles(): unknown | Promise<unknown>;
    /** Bắt đầu kiểm tra đăng nhập nền (null = mọi profile). Ném BUSY_ERROR khi đang có việc. */
    checkLogins(profileIds: string[] | null): { checkId: string; profileIds: string[] };
    systemStatus(): unknown | Promise<unknown>;
    /** Đổi mediaId đã tải lên thành đường dẫn tệp; mediaId lạ thì ném lỗi hoặc trả thiếu phần tử. */
    resolveMedia(mediaIds: string[]): string[];
    events: {
        listEventsAfter(seq: number, limit: number): ControlEventRow[];
        waitForEvent(afterSeq: number, timeoutMs: number, signal?: AbortSignal): Promise<void>;
        /** Workspace đang mở: `seq` là của DB workspace nên bot phải về `after = 0` khi giá trị này đổi. */
        workspaceId(): string | null;
    };
}

export const EVENTS_PAGE_LIMIT = 100;
export const EVENTS_MAX_TIMEOUT_SEC = 25;

const CONFIRM_MESSAGE = 'Thao tác này cần người dùng xác nhận. Hãy hỏi người dùng, nếu họ đồng ý thì gọi lại với confirm: true.';

const str = (description: string) => ({ type: 'string', description });
const int = (description: string, extra: object = {}) => ({ type: 'integer', description, ...extra });
const obj = (properties: Record<string, object>, required: string[] = []) =>
    ({ type: 'object', properties, ...(required.length ? { required } : {}) });
const confirmProp = { type: 'boolean', description: 'Phải là true để xác nhận sau khi đã hỏi người dùng' };
const anyResult = { type: 'object', description: 'Kết quả của thao tác' };

const profilesProp = {
    type: 'array', description: 'Profile và danh sách đích (link nhóm hoặc mã nhóm) của từng profile',
    items: obj({
        profileId: str('Mã profile'),
        targets: { type: 'array', items: { type: 'string' }, description: 'Link hoặc mã nhóm; bỏ trống khi mode = page' },
    }, ['profileId']),
};
const mediaIdsProp = { type: 'array', items: { type: 'string' }, description: 'Mã tệp đã tải lên qua /v1/media' };
const draftFields: Record<string, object> = {
    name: { type: 'string', maxLength: 100, description: 'Tên nháp (mặc định lấy 40 ký tự đầu của nội dung)' },
    plannedAt: { type: ['integer', 'null'], description: 'Giờ dự kiến đăng (mili giây epoch); null để bỏ' },
    mode: { type: 'string', enum: ['group', 'page'], description: 'Đăng vào nhóm hoặc trang' },
    text: str('Nội dung bài'),
    mediaIds: mediaIdsProp,
    comment: str('Bình luận đầu tiên (tuỳ chọn)'),
    commentDelayMin: int('Bình luận sau bao nhiêu phút kể từ lúc bài lên (0–60)', { minimum: 0, maximum: 60 }),
    profiles: profilesProp,
    minDelaySec: int('Nghỉ tối thiểu giữa hai đích (giây, 0–86400)', { minimum: 0, maximum: 86400 }),
    maxDelaySec: int('Nghỉ tối đa giữa hai đích (giây, 0–86400)', { minimum: 0, maximum: 86400 }),
    concurrency: int('Số profile chạy song song (1–10)', { minimum: 1, maximum: 10 }),
    staggerMinSec: int('Giãn cách khởi động tối thiểu giữa các profile (giây, 0–3600)', { minimum: 0, maximum: 3600 }),
    staggerMaxSec: int('Giãn cách khởi động tối đa giữa các profile (giây, 0–3600)', { minimum: 0, maximum: 3600 }),
    variants: { type: 'array', items: { type: 'string' }, minItems: 0, maxItems: 4, description: 'Biến thể nội dung B…E (1–4 chuỗi, khác text và khác nhau); các đích lần lượt nhận A, B, …; [] = bỏ biến thể (drafts.update); bỏ trống = giữ nguyên' },
    campaignId: { type: ['string', 'null'], description: 'Mã chiến dịch; null để bỏ gắn; bỏ trống = giữ nguyên' },
};
// Các trường nằm trong params của bản nháp (phần còn lại — name/plannedAt/campaignId/mediaIds — xử lý riêng).
const DRAFT_PARAM_KEYS = ['mode', 'text', 'comment', 'commentDelayMin', 'profiles', 'minDelaySec', 'maxDelaySec', 'concurrency', 'staggerMinSec', 'staggerMaxSec', 'variants'];

const timingProps = {
    runAt: int('Giờ chạy một lần (mili giây epoch, sau hiện tại ít nhất 1 phút)'),
    days: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 6 }, description: 'Ngày trong tuần cho lịch lặp (0 = Chủ nhật … 6 = Thứ bảy)' },
    time: str('Giờ trong ngày cho lịch lặp, dạng HH:MM'),
};

function requireString(params: ControlParams, field: string): string {
    const value = params[field];
    if (typeof value !== 'string' || !value) throw new ControlError('INVALID_PARAMS', `Thiếu tham số ${field}`, { field });
    return value;
}

function pick(params: ControlParams, keys: string[]): ControlParams {
    const out: ControlParams = {};
    for (const key of keys) if (params[key] !== undefined) out[key] = params[key];
    return out;
}

function readMediaPaths(deps: ControlMethodDeps, mediaIds: unknown): string[] {
    if (!Array.isArray(mediaIds) || !mediaIds.every((id) => typeof id === 'string')) {
        throw new ControlError('INVALID_PARAMS', 'mediaIds phải là danh sách chuỗi', { field: 'mediaIds' });
    }
    let paths: string[];
    try {
        paths = deps.resolveMedia(mediaIds);
    } catch (err) {
        if (err instanceof ControlError) throw err;
        throw new ControlError('INVALID_PARAMS', err instanceof Error ? err.message : 'mediaId không hợp lệ', { field: 'mediaIds' });
    }
    if (paths.length !== mediaIds.length || paths.some((p) => typeof p !== 'string' || !p)) {
        throw new ControlError('INVALID_PARAMS', 'Có mediaId không tồn tại hoặc đã hết hạn', { field: 'mediaIds' });
    }
    return paths;
}

const page = (items: unknown[], params: ControlParams) => {
    const limit = Number.isInteger(params.limit) && params.limit >= 1 ? Math.min(params.limit, 200) : 50;
    const offset = Number.isInteger(params.offset) && params.offset >= 0 ? params.offset : 0;
    return { total: items.length, items: items.slice(offset, offset + limit) };
};

export function createControlMethods(deps: ControlMethodDeps): ControlMethod[] {
    const { poster } = deps;
    const noParams = obj({});
    const idOnly = obj({ id: str('Mã') }, ['id']);

    const methods: ControlMethod[] = [
        {
            name: 'system.status', description: 'Tình trạng app: phiên bản, workspace, nhân trình duyệt, scheduler, việc đang chạy.',
            destructive: false, paramsSchema: noParams, resultSchema: anyResult,
            run: async () => deps.systemStatus(),
        },
        {
            name: 'profiles.list', description: 'Danh sách profile: mã, tên, nhóm, trạng thái mở, ngày quét nhóm gần nhất, trạng thái đăng nhập Facebook đã lưu (loginState, loginCheckedAt, loginError).',
            destructive: false, paramsSchema: noParams,
            resultSchema: obj({ profiles: { type: 'array', items: { type: 'object' }, description: 'Danh sách profile' } }, ['profiles']),
            run: async () => ({ profiles: await deps.listProfiles() }),
        },
        {
            name: 'profiles.groups', description: 'Nhóm đã quét của các profile (url, tên).',
            destructive: false, paramsSchema: obj({ profileIds: { type: 'array', items: { type: 'string' }, description: 'Mã các profile' } }, ['profileIds']),
            resultSchema: anyResult,
            run: async (p) => poster.listGroups({ profileIds: p.profileIds }),
        },
        {
            name: 'profiles.scanGroups',
            description: 'Bắt đầu quét nhóm cho các profile (như nút trong app). BUSY nếu đang có việc chạy. Không gửi concurrency/stagger thì dùng mặc định của app (song song 3, giãn cách 30–90 giây).',
            destructive: false,
            paramsSchema: obj({
                profileIds: { type: 'array', items: { type: 'string' }, description: 'Mã các profile cần quét' },
                concurrency: draftFields.concurrency, staggerMinSec: draftFields.staggerMinSec, staggerMaxSec: draftFields.staggerMaxSec,
            }, ['profileIds']),
            resultSchema: anyResult,
            run: async (p) => poster.start({ kind: 'scan_groups', params: pick(p, ['profileIds', 'concurrency', 'staggerMinSec', 'staggerMaxSec']) }),
        },
        {
            name: 'profiles.check',
            description: 'Kiểm tra đăng nhập Facebook của các profile (chạy nền, từng profile một; kết quả qua sự kiện profiles.checkFinished). Bỏ trống profileIds để kiểm tra mọi profile. BUSY nếu đang có việc chạy.',
            destructive: false,
            paramsSchema: obj({
                profileIds: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 50, description: 'Mã các profile (1–50); bỏ trống = mọi profile; mảng rỗng bị từ chối' },
            }),
            resultSchema: obj({ checkId: str('Mã lượt kiểm tra'), profileIds: { type: 'array', items: { type: 'string' }, description: 'Các profile sẽ được kiểm tra' } }, ['checkId', 'profileIds']),
            run: async (p) => {
                const raw = p.profileIds;
                if (raw === undefined || raw === null) return deps.checkLogins(null);
                if (!Array.isArray(raw) || raw.length === 0 || raw.length > 50 || raw.some((id) => typeof id !== 'string' || !id)) {
                    throw new ControlError('INVALID_PARAMS', 'profileIds phải là danh sách 1–50 mã (chuỗi không rỗng); bỏ trống tham số này để kiểm tra mọi profile', { field: 'profileIds' });
                }
                const ids = [...new Set(raw as string[])];
                const known = new Set(((await deps.listProfiles()) as { id: string }[]).map((x) => x.id));
                const missing = ids.filter((id) => !known.has(id));
                if (missing.length) throw new ControlError('NOT_FOUND', 'Có profile không tồn tại', { missing });
                return deps.checkLogins(ids);
            },
        },
        {
            name: 'drafts.list', description: 'Danh sách bản nháp.',
            destructive: false,
            paramsSchema: obj({ limit: int('Tối đa bao nhiêu dòng (1–200, mặc định 50)'), offset: int('Bỏ qua bao nhiêu dòng đầu', { minimum: 0 }) }),
            resultSchema: obj({ total: int('Tổng số nháp'), items: { type: 'array', items: { type: 'object' }, description: 'Các nháp trong trang' } }, ['total', 'items']),
            run: async (p) => {
                const { schedules } = await poster.scheduleList();
                return page((schedules as any[]).filter((s) => s.draft), p);
            },
        },
        {
            name: 'drafts.get', description: 'Xem một bản nháp kèm tệp đính kèm.',
            destructive: false, paramsSchema: idOnly, resultSchema: anyResult,
            run: async (p) => poster.draftGet({ id: p.id }),
        },
        {
            name: 'drafts.create', description: 'Tạo bản nháp (cùng kiểm tra với "Lưu nháp" trong app). Chỉ bắt buộc mode và text.',
            destructive: false,
            paramsSchema: obj(draftFields, ['mode', 'text']),
            resultSchema: anyResult,
            run: async (p) => poster.draftSave({
                name: p.name,
                plannedAt: p.plannedAt,
                ...pick(p, ['campaignId']),
                params: { ...pick(p, DRAFT_PARAM_KEYS), mediaPaths: p.mediaIds === undefined ? [] : readMediaPaths(deps, p.mediaIds) },
            }),
        },
        {
            name: 'drafts.update', description: 'Sửa bản nháp: chỉ cần gửi id và các trường muốn đổi; trường không gửi giữ nguyên. Gửi mediaIds sẽ thay toàn bộ tệp đính kèm.',
            destructive: false,
            paramsSchema: obj({ id: str('Mã bản nháp'), ...draftFields }, ['id']),
            resultSchema: anyResult,
            run: async (p) => {
                const id = requireString(p, 'id');
                const current = await poster.draftGet({ id });
                const mediaPaths = p.mediaIds === undefined
                    ? (current.media as { path: string }[]).map((m) => m.path)
                    : readMediaPaths(deps, p.mediaIds);
                return poster.draftSave({
                    id,
                    name: p.name ?? current.draft.name,
                    plannedAt: p.plannedAt,
                    ...pick(p, ['campaignId']),
                    params: { ...current.draft.params, ...pick(p, DRAFT_PARAM_KEYS), mediaPaths },
                });
            },
        },
        {
            name: 'drafts.delete', description: 'Xoá một bản nháp (không xoá được lịch thật). Cần confirm: true.',
            destructive: true,
            paramsSchema: obj({ id: str('Mã bản nháp'), confirm: confirmProp }, ['id', 'confirm']),
            resultSchema: obj({ deleted: { type: 'boolean' } }, ['deleted']),
            run: async (p) => {
                const id = requireString(p, 'id');
                await poster.draftGet({ id }); // chỉ cho xoá bản nháp: không phải nháp thì ném "Không tìm thấy bản nháp"
                await poster.scheduleDelete({ id });
                return { deleted: true };
            },
        },
        {
            name: 'drafts.approve',
            description: 'Duyệt bản nháp thành lịch thật. when = "now" là đăng ngay (cần confirm: true); hoặc {kind:"once", runAt} / {kind:"recurring", days, time}.',
            destructive: (p) => p.when === 'now',
            destructiveWhen: { when: 'now' },
            paramsSchema: obj({
                id: str('Mã bản nháp'),
                when: {
                    description: '"now" (đăng ngay) hoặc đối tượng lịch {kind: "once" + runAt | "recurring" + days + time}',
                    anyOf: [
                        { type: 'string', enum: ['now'] },
                        { type: 'object', required: ['kind'], properties: { kind: { type: 'string', enum: ['once', 'recurring'] }, ...timingProps } },
                    ],
                },
                campaignId: draftFields.campaignId,
                confirm: confirmProp,
            }, ['id', 'when']),
            resultSchema: anyResult,
            run: async (p) => {
                const id = requireString(p, 'id');
                if (p.when === 'now') return poster.draftApprove({ id, when: 'now', ...pick(p, ['campaignId']) });
                if (!p.when || typeof p.when !== 'object') {
                    throw new ControlError('INVALID_PARAMS', 'when phải là "now" hoặc đối tượng lịch', { field: 'when' });
                }
                return poster.draftApprove({ id, when: 'schedule', kind: p.when.kind, runAt: p.when.runAt, days: p.when.days, time: p.when.time, ...pick(p, ['campaignId']) });
            },
        },
        {
            name: 'schedules.list', description: 'Danh sách lịch đăng (không gồm bản nháp), kèm queuedIds đang chờ chạy.',
            destructive: false, paramsSchema: obj({ campaignId: str("Chỉ lịch của chiến dịch này; '' = lịch không thuộc chiến dịch") }), resultSchema: obj({ schedules: { type: 'array', items: { type: 'object' }, description: 'Các lịch' }, queuedIds: { type: 'array', items: { type: 'string' }, description: 'Lịch đang chờ chạy' } }, ['schedules', 'queuedIds']),
            run: async (p) => {
                const { schedules, queuedIds } = await poster.scheduleList(pick(p, ['campaignId']));
                return { schedules: (schedules as any[]).filter((s) => !s.draft), queuedIds };
            },
        },
        {
            name: 'schedules.update', description: 'Sửa lịch: tên, bật/tắt, giờ (cùng quy tắc với app). runAt chỉ dùng cho lịch một lần; days/time chỉ dùng cho lịch lặp.',
            destructive: false,
            paramsSchema: obj({ id: str('Mã lịch'), name: str('Tên mới'), enabled: { type: 'boolean', description: 'Bật hoặc tắt lịch' }, campaignId: draftFields.campaignId, ...timingProps }, ['id']),
            resultSchema: anyResult,
            run: async (p) => poster.scheduleUpdate(pick(p, ['id', 'name', 'enabled', 'runAt', 'days', 'time', 'campaignId'])),
        },
        {
            name: 'schedules.delete', description: 'Xoá một lịch; từ chối khi lịch đang chạy. Cần confirm: true.',
            destructive: true,
            paramsSchema: obj({ id: str('Mã lịch'), confirm: confirmProp }, ['id', 'confirm']),
            resultSchema: obj({ deleted: { type: 'boolean' } }, ['deleted']),
            run: async (p) => {
                const id = requireString(p, 'id');
                const { schedules } = await poster.scheduleList();
                if (!(schedules as { id: string }[]).some((s) => s.id === id)) throw new ControlError('NOT_FOUND', 'Không tìm thấy lịch');
                await poster.scheduleDelete({ id });
                return { deleted: true };
            },
        },
        {
            name: 'runs.current', description: 'Việc đang chạy và tiến độ.',
            destructive: false, paramsSchema: noParams, resultSchema: anyResult,
            run: async () => poster.current(),
        },
        {
            name: 'runs.list', description: 'Lịch sử các lần chạy.',
            destructive: false,
            paramsSchema: obj({
                limit: int('Tối đa bao nhiêu dòng (1–200, mặc định 50)'),
                offset: int('Bỏ qua bao nhiêu dòng đầu', { minimum: 0 }),
                kind: { type: 'string', enum: ['post', 'join', 'scan_groups', 'collect_comments'], description: 'Lọc theo loại việc' },
            }),
            resultSchema: anyResult,
            run: async (p) => poster.listRuns(pick(p, ['limit', 'offset', 'kind'])),
        },
        {
            name: 'runs.get', description: 'Chi tiết một lần chạy: kết quả từng đích (kèm variant đã đăng), link bài, trạng thái bình luận; run có campaignId.',
            destructive: false, paramsSchema: obj({ runId: str('Mã lần chạy') }, ['runId']), resultSchema: anyResult,
            run: async (p) => poster.getRun({ runId: p.runId }),
        },
        {
            name: 'runs.cancel', description: 'Dừng việc đang chạy. Cần confirm: true.',
            destructive: true, paramsSchema: obj({ confirm: confirmProp }, ['confirm']), resultSchema: obj({ cancelled: { type: 'boolean' } }, ['cancelled']),
            run: async () => {
                await poster.cancel();
                return { cancelled: true };
            },
        },
        {
            name: 'events.wait',
            description: 'Long-poll sự kiện: trả ngay các sự kiện có seq > after, hoặc chờ tới khi có, tối đa timeoutSec (≤ 25 giây).',
            destructive: false,
            paramsSchema: obj({
                after: int('Số thứ tự sự kiện cuối đã nhận (0 để lấy từ đầu)', { minimum: 0 }),
                timeoutSec: int('Chờ tối đa bao nhiêu giây (0–25)', { minimum: 0, maximum: EVENTS_MAX_TIMEOUT_SEC }),
            }, ['after']),
            resultSchema: obj({ events: { type: 'array', items: obj({ seq: int('Số thứ tự'), type: str('Loại sự kiện'), payload: { type: 'object' }, createdAt: int('Thời điểm (mili giây epoch)') }, ['seq', 'type']), description: 'Sự kiện có seq > after (tối đa 100)' }, workspaceId: { type: ['string', 'null'], description: 'Workspace đang mở; đổi giá trị này thì đặt lại after = 0' } }, ['events', 'workspaceId']),
            run: async (p, ctx) => {
                if (!Number.isInteger(p.after) || p.after < 0) {
                    throw new ControlError('INVALID_PARAMS', 'after phải là số nguyên ≥ 0', { field: 'after' });
                }
                const timeoutSec = Math.min(EVENTS_MAX_TIMEOUT_SEC, Math.max(0, Number.isFinite(p.timeoutSec) ? p.timeoutSec : 0));
                let events = deps.events.listEventsAfter(p.after, EVENTS_PAGE_LIMIT);
                if (!events.length && timeoutSec > 0) {
                    await deps.events.waitForEvent(p.after, timeoutSec * 1000, ctx.signal);
                    events = deps.events.listEventsAfter(p.after, EVENTS_PAGE_LIMIT);
                }
                return { events, workspaceId: deps.events.workspaceId() };
            },
        },
        {
            name: 'research.search',
            description: 'Quét Facebook theo từ khoá để chọn chủ đề nội dung (chỉ đọc, không đăng hay bấm gì). Chạy nền, trả scanId ngay; xong sẽ có sự kiện research.finished, rồi gọi research.get để lấy kết quả. MaiHub tự xoay vòng các profile đủ điều kiện (đăng nhập tốt, không đang mở, không đang đăng bài, chưa chạm trần ngày; mỗi profile tối đa 50 mục rồi đổi profile); bỏ trống profileIds để dùng mọi profile. Mỗi mục có tên, mã và link người đăng, engagement (thích + bình luận + chia sẻ) và engagementRate (engagement / số thành viên nhóm, null nếu chưa biết). BUSY nếu đang có lượt quét khác.',
            destructive: false,
            paramsSchema: obj({
                source: { type: 'string', enum: ['posts', 'groups', 'pages'], description: 'Quét bài viết, nhóm hoặc trang' },
                query: { type: 'string', minLength: 1, maxLength: 100, description: 'Từ khoá (1–100 ký tự)' },
                recent: { type: 'boolean', description: 'Chỉ bài gần đây (chỉ dùng với source = posts)' },
                year: int('Chỉ bài trong năm này (chỉ với source = posts; từ 2010 tới năm hiện tại)', { minimum: 2010 }),
                limit: int('Số mục tối đa (1–500, mặc định 200)', { minimum: 1, maximum: 500 }),
                profileIds: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 50, description: 'Chỉ dùng các profile này (1–50 mã); bỏ trống = mọi profile; mảng rỗng bị từ chối; mã lạ → NOT_FOUND kèm details.missing' },
            }, ['source', 'query']),
            resultSchema: obj({ scanId: str('Mã lượt quét') }, ['scanId']),
            run: async (p) => deps.research.search(p),
        },
        {
            name: 'research.scanGroupFeeds',
            description: 'Đọc bài mới trong các nhóm (chỉ đọc). Chạy nền, trả scanId; xong có sự kiện research.finished, lấy kết quả bằng research.get. Xoay vòng profile như research.search. Bỏ trống groupUrls = 20 nhóm được quét gần nhất của các profile đủ điều kiện. Mỗi mục có tên, mã, link người đăng, engagement và engagementRate. BUSY nếu đang có lượt quét khác.',
            destructive: false,
            paramsSchema: obj({
                groupUrls: { type: 'array', items: { type: 'string' }, maxItems: 20, description: 'Link nhóm (tối đa 20)' },
                sinceDays: int('Chỉ lấy bài trong bấy nhiêu ngày gần đây (1–30, mặc định 7)', { minimum: 1, maximum: 30 }),
                limitPerGroup: int('Số bài tối đa mỗi nhóm (1–100, mặc định 30)', { minimum: 1, maximum: 100 }),
                profileIds: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 50, description: 'Chỉ dùng các profile này (1–50 mã); bỏ trống = mọi profile; mã lạ → NOT_FOUND kèm details.missing' },
            }),
            resultSchema: obj({ scanId: str('Mã lượt quét') }, ['scanId']),
            run: async (p) => deps.research.scanGroupFeeds(p),
        },
        {
            name: 'research.list',
            description: 'Danh sách các lượt quét Nghiên cứu (mới nhất trước). Dữ liệu giữ 180 ngày.',
            destructive: false,
            paramsSchema: obj({
                limit: int('Tối đa bao nhiêu dòng (1–200)', { minimum: 1, maximum: 200 }),
                offset: int('Bỏ qua bao nhiêu dòng đầu', { minimum: 0 }),
                source: { type: 'string', enum: ['posts', 'groups', 'pages', 'group_feed'], description: 'Lọc theo nguồn' },
            }),
            resultSchema: obj({ total: int('Tổng số lượt quét'), scans: { type: 'array', items: { type: 'object' }, description: 'Các lượt quét trong trang' } }, ['total', 'scans']),
            run: async (p) => deps.research.list(pick(p, ['limit', 'offset', 'source'])),
        },
        {
            name: 'research.get',
            description: 'Xem một lượt quét và các mục đã thu (tên, mã, link người đăng; reactions/comments/shares; engagement; engagementRate). NOT_FOUND nếu scanId lạ.',
            destructive: false,
            paramsSchema: obj({
                scanId: str('Mã lượt quét'),
                sort: { type: 'string', enum: ['engagement', 'recent', 'members'], description: 'Sắp xếp (mặc định engagement)' },
                limit: int('Tối đa bao nhiêu mục (1–500)', { minimum: 1, maximum: 500 }),
                offset: int('Bỏ qua bao nhiêu mục đầu', { minimum: 0 }),
            }, ['scanId']),
            resultSchema: obj({ scan: { type: 'object', description: 'Thông tin lượt quét' }, total: int('Tổng số mục'), items: { type: 'array', items: { type: 'object' }, description: 'Các mục trong trang' } }, ['scan', 'total', 'items']),
            run: async (p) => deps.research.get(pick(p, ['scanId', 'sort', 'limit', 'offset'])),
        },
        {
            name: 'research.cancel',
            description: 'Huỷ lượt quét Nghiên cứu đang chạy (nếu có); dừng ngay cả khi đang nghỉ giữa trang.',
            destructive: false,
            paramsSchema: obj({}),
            resultSchema: obj({ cancelled: { type: 'boolean', description: 'true nếu có lượt quét bị huỷ' } }, ['cancelled']),
            run: async () => deps.research.cancel(),
        },
        {
            name: 'posts.track',
            description: 'Lấy link và đo tương tác các bài đã đăng nhóm bằng cách đọc bảng tin nhóm (chỉ đọc). Chạy nền, trả jobId ngay; xong có sự kiện posts.trackFinished, xem tiến độ bằng posts.trackStatus. MaiHub cũng tự chạy định kỳ. BUSY nếu đang đăng, đang kiểm tra đăng nhập hoặc đang theo dõi; profileIds lạ → NOT_FOUND kèm details.missing.',
            destructive: false,
            paramsSchema: obj({
                sinceDays: int('Chỉ xét bài đăng trong bấy nhiêu ngày gần đây (1–14, mặc định 3)', { minimum: 1, maximum: 14 }),
                groupUrls: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 30, description: 'Chỉ các nhóm này (1–30 link)' },
                profileIds: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 50, description: 'Chỉ các profile này; bỏ trống = mọi profile' },
            }),
            resultSchema: obj({ jobId: str('Mã lượt theo dõi'), pairs: { type: 'array', items: { type: 'object' }, description: 'Các cặp { profileId, groupUrl } sẽ đọc' } }, ['jobId', 'pairs']),
            run: async (p) => deps.tracking.track(pick(p, ['sinceDays', 'groupUrls', 'profileIds'])),
        },
        {
            name: 'posts.trackStatus',
            description: 'Trạng thái lượt theo dõi bài đăng: đang chạy không, tiến độ và kết quả lần gần nhất (kể cả lỗi từng nhóm).',
            destructive: false,
            paramsSchema: obj({}),
            resultSchema: obj({
                running: { type: 'boolean' }, jobId: { type: ['string', 'null'] },
                progress: { type: 'object', description: '{ done, total }' }, last: { type: ['object', 'null'], description: 'Kết quả lần gần nhất' },
            }, ['running', 'jobId', 'progress', 'last']),
            run: async () => deps.tracking.status(),
        },
        {
            name: 'posts.trackCancel',
            description: 'Huỷ lượt theo dõi bài đăng đang chạy (nếu có); dừng sau trang đang đọc.',
            destructive: false,
            paramsSchema: obj({}),
            resultSchema: obj({ cancelled: { type: 'boolean', description: 'true nếu có lượt bị huỷ' } }, ['cancelled']),
            run: async () => deps.tracking.cancel(),
        },
        {
            name: 'posts.list',
            description: 'Các bài đã đăng nhóm đang được theo dõi, kèm link, trạng thái link (known/pending_approval/missing/not_found) và lần đo mới nhất. Mặc định 30 ngày gần nhất.',
            destructive: false,
            paramsSchema: obj({
                from: int('Từ thời điểm (epoch ms)', { minimum: 0 }),
                to: int('Đến thời điểm (epoch ms)', { minimum: 0 }),
                linkStatus: { type: 'string', enum: ['known', 'missing', 'pending_approval', 'not_found'], description: 'Lọc theo trạng thái link' },
                groupUrl: str('Lọc theo link nhóm'),
                profileId: str('Lọc theo profile'),
                campaignId: str("Lọc theo chiến dịch; '' = bài không thuộc chiến dịch"),
                scheduleId: str('Lọc theo lịch'),
                limit: int('Tối đa bao nhiêu dòng (1–500)', { minimum: 1, maximum: 500 }),
                offset: int('Bỏ qua bao nhiêu dòng đầu', { minimum: 0 }),
            }),
            resultSchema: obj({ total: int('Tổng số dòng khớp'), rows: { type: 'array', items: { type: 'object' }, description: 'Các dòng trong trang' } }, ['total', 'rows']),
            run: async (p) => deps.tracking.list(pick(p, ['from', 'to', 'linkStatus', 'groupUrl', 'profileId', 'campaignId', 'scheduleId', 'limit', 'offset'])),
        },
        {
            name: 'posts.stats',
            description: 'Báo cáo hiệu quả bài đăng nhóm theo nhóm / profile / lịch / ngày / từng bài / chiến dịch / biến thể: số bài, số có link, chờ duyệt, nghi bị xoá, reactions/comments/shares (lần đo mới nhất), tương tác trung bình và tỉ lệ so với số thành viên nhóm (null nếu chưa biết).',
            destructive: false,
            paramsSchema: obj({
                groupBy: { type: 'string', enum: ['group', 'profile', 'schedule', 'day', 'post', 'campaign', 'variant', 'hour', 'weekday'], description: 'Gom theo (hour: giờ máy "00"–"23"; weekday: "1"–"7" = Thứ 2 … Chủ nhật; variant: so sánh biến thể trong cùng một lịch; dòng có insufficient = chưa đủ 5 bài đo)' },
                campaignId: str("Lọc theo chiến dịch; '' = bài không thuộc chiến dịch"),
                scheduleId: str('Lọc theo lịch'),
                from: int('Từ thời điểm (epoch ms; mặc định 30 ngày trước)', { minimum: 0 }),
                to: int('Đến thời điểm (epoch ms)', { minimum: 0 }),
                limit: int('Tối đa bao nhiêu dòng (1–500)', { minimum: 1, maximum: 500 }),
            }, ['groupBy']),
            resultSchema: obj({ rows: { type: 'array', items: { type: 'object' }, description: 'Các dòng báo cáo' } }, ['rows']),
            run: async (p) => deps.tracking.stats(pick(p, ['groupBy', 'from', 'to', 'limit', 'campaignId', 'scheduleId'])),
        },
        {
            name: 'posts.groupScores',
            description: 'Điểm từng nhóm (0–100) từ kết quả đăng và số đo tương tác, kèm nhãn good/fair/poor và lý do tiếng Việt. Nhóm dưới 3 lượt đăng có score null, grade insufficient và xếp cuối. Mặc định 30 ngày gần nhất.',
            destructive: false,
            paramsSchema: obj({
                from: int('Từ thời điểm (epoch ms; mặc định 30 ngày trước)', { minimum: 0 }),
                to: int('Đến thời điểm (epoch ms)', { minimum: 0 }),
                campaignId: str("Lọc theo chiến dịch; '' = bài không thuộc chiến dịch"),
            }),
            resultSchema: obj({ groups: { type: 'array', items: { type: 'object' }, description: '{ groupUrl, label, score, grade, attempted, posted, failed, held, removed, withLink, measured, engagement, reasons }, sắp score giảm dần' } }, ['groups']),
            run: async (p) => deps.tracking.groupScores(pick(p, ['from', 'to', 'campaignId'])),
        },
        {
            name: 'posts.bestTimes',
            description: 'Gợi ý giờ và thứ đăng hiệu quả nhất (tối đa 3 giờ, 2 thứ; theo giờ máy) từ các khung có ít nhất 5 bài đã đo. insufficient = true khi chưa đủ dữ liệu. Mặc định 60 ngày gần nhất.',
            destructive: false,
            paramsSchema: obj({
                from: int('Từ thời điểm (epoch ms; mặc định 60 ngày trước)', { minimum: 0 }),
                to: int('Đến thời điểm (epoch ms)', { minimum: 0 }),
                groupUrl: str('Chỉ tính một nhóm'),
                campaignId: str("Lọc theo chiến dịch; '' = bài không thuộc chiến dịch"),
            }),
            resultSchema: obj({
                hours: { type: 'array', items: { type: 'object' }, description: '{ key, label, avgEngagement, measured }' },
                weekdays: { type: 'array', items: { type: 'object' }, description: '{ key, label, avgEngagement, measured }' },
                insufficient: { type: 'boolean' },
            }, ['hours', 'weekdays', 'insufficient']),
            run: async (p) => deps.tracking.bestTimes(pick(p, ['from', 'to', 'groupUrl', 'campaignId'])),
        },
        {
            name: 'posts.trackConfig',
            description: 'Đọc hoặc lưu cấu hình tự động lấy link và đo tương tác. Không truyền config = chỉ đọc; có config = lưu rồi trả cấu hình mới. Cấu hình: autoEnabled (boolean), linkRetryMinutes và statsAtMinutes (mỗi mảng 1–10 số tăng dần, 5–20160 phút).',
            destructive: false,
            paramsSchema: obj({
                config: {
                    type: 'object',
                    properties: {
                        autoEnabled: { type: 'boolean' },
                        linkRetryMinutes: { type: 'array', items: { type: 'integer', minimum: 5, maximum: 20160 }, minItems: 1, maxItems: 10 },
                        statsAtMinutes: { type: 'array', items: { type: 'integer', minimum: 5, maximum: 20160 }, minItems: 1, maxItems: 10 },
                    },
                    description: 'Cấu hình cần lưu; bỏ trống để chỉ đọc',
                },
            }),
            resultSchema: obj({ config: { type: 'object', description: 'Cấu hình hiện hành' } }, ['config']),
            run: async (p) => (p.config === undefined ? deps.tracking.getConfig() : deps.tracking.setConfig(p.config)),
        },
        {
            name: 'campaigns.list',
            description: 'Danh sách chiến dịch (mặc định mọi trạng thái trừ archived), kèm số lịch / bài nháp, runnable và summary hiệu quả.',
            destructive: false,
            paramsSchema: obj({ status: { type: 'string', enum: ['active', 'paused', 'archived'], description: 'Chỉ chiến dịch ở trạng thái này' } }),
            resultSchema: obj({ campaigns: { type: 'array', items: { type: 'object' }, description: 'Các chiến dịch' } }, ['campaigns']),
            run: async (p) => deps.campaigns.list(pick(p, ['status'])),
        },
        {
            name: 'campaigns.get', description: 'Xem một chiến dịch kèm danh sách lịch / bài nháp của nó. NOT_FOUND nếu id lạ.',
            destructive: false, paramsSchema: idOnly, resultSchema: obj({ campaign: { type: 'object', description: 'Chiến dịch kèm schedules' } }, ['campaign']),
            run: async (p) => deps.campaigns.get(pick(p, ['id'])),
        },
        {
            name: 'campaigns.create', description: 'Tạo chiến dịch (tên 1–100 ký tự, không trùng; mục tiêu ≤ 1000 ký tự; startAt/endAt là mili giây epoch, startAt ≤ endAt).',
            destructive: false,
            paramsSchema: obj({
                name: { type: 'string', minLength: 1, maxLength: 100, description: 'Tên chiến dịch' },
                goal: { type: 'string', maxLength: 1000, description: 'Mục tiêu (tuỳ chọn)' },
                startAt: { type: ['integer', 'null'], description: 'Bắt đầu (mili giây epoch)' },
                endAt: { type: ['integer', 'null'], description: 'Kết thúc (mili giây epoch)' },
            }, ['name']),
            resultSchema: obj({ campaign: { type: 'object', description: 'Chiến dịch vừa tạo' } }, ['campaign']),
            run: async (p) => deps.campaigns.create(pick(p, ['name', 'goal', 'startAt', 'endAt'])),
        },
        {
            name: 'campaigns.update', description: 'Sửa chiến dịch: chỉ gửi id và các trường muốn đổi. status = paused thì lịch của chiến dịch không chạy; startAt/endAt = null để bỏ giới hạn.',
            destructive: false,
            paramsSchema: obj({
                id: str('Mã chiến dịch'),
                name: { type: 'string', minLength: 1, maxLength: 100, description: 'Tên mới' },
                goal: { type: 'string', maxLength: 1000, description: 'Mục tiêu mới' },
                status: { type: 'string', enum: ['active', 'paused', 'archived'], description: 'Trạng thái mới' },
                startAt: { type: ['integer', 'null'], description: 'Bắt đầu (mili giây epoch); null để bỏ' },
                endAt: { type: ['integer', 'null'], description: 'Kết thúc (mili giây epoch); null để bỏ' },
            }, ['id']),
            resultSchema: obj({ campaign: { type: 'object', description: 'Chiến dịch sau khi sửa' } }, ['campaign']),
            run: async (p) => deps.campaigns.update(pick(p, ['id', 'name', 'goal', 'status', 'startAt', 'endAt'])),
        },
        {
            name: 'campaigns.delete', description: 'Xoá một chiến dịch; INVALID_PARAMS nếu còn lịch / bài nháp. Cần confirm: true.',
            destructive: true,
            paramsSchema: obj({ id: str('Mã chiến dịch'), confirm: confirmProp }, ['id', 'confirm']),
            resultSchema: obj({ deleted: { type: 'boolean' } }, ['deleted']),
            run: async (p) => deps.campaigns.delete(pick(p, ['id'])),
        },
        {
            name: 'comments.collect',
            description: 'Thu bình luận của các bài đã đăng (chỉ đọc, không bình luận hay nhắn tin). Chạy nền, trả jobId ngay; bình luận mới khớp từ khoá thành khách và phát sự kiện leads.found. postUrls bỏ trống = các bài đến hạn thu. BUSY nếu đang đăng, kiểm tra đăng nhập hoặc đang thu.',
            destructive: false,
            paramsSchema: obj({ postUrls: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, maxItems: 50, description: 'Chỉ các bài này (1–50 link; mỗi lượt xử lý tối đa 10 bài)' } }),
            resultSchema: obj({ jobId: str('Mã lượt thu'), posts: int('Số bài sẽ thu') }, ['jobId', 'posts']),
            run: async (p) => deps.leads.collect(pick(p, ['postUrls'])),
        },
        {
            name: 'comments.list',
            description: 'Các bình luận đã thu, mới nhất trước.',
            destructive: false,
            paramsSchema: obj({
                postUrl: str('Chỉ một bài'),
                since: int('Chỉ bình luận thu từ thời điểm này (epoch ms)', { minimum: 0 }),
                limit: int('Tối đa bao nhiêu dòng (1–500)', { minimum: 1, maximum: 500 }),
                offset: int('Bỏ qua bao nhiêu dòng đầu', { minimum: 0 }),
            }),
            resultSchema: obj({ total: int('Tổng số dòng khớp'), comments: { type: 'array', items: { type: 'object' }, description: 'Các bình luận trong trang' } }, ['total', 'comments']),
            run: async (p) => deps.leads.comments(pick(p, ['postUrl', 'since', 'limit', 'offset'])),
        },
        {
            name: 'leads.list',
            description: 'Khách tiềm năng phát hiện từ bình luận (khớp từ khoá, số điện thoại hoặc AI), mới nhất trước.',
            destructive: false,
            paramsSchema: obj({
                status: { type: 'string', enum: ['new', 'contacted', 'won', 'ignored'], description: 'Lọc theo trạng thái' },
                campaignId: str("Lọc theo chiến dịch; '' = bài không thuộc chiến dịch"),
                from: int('Từ thời điểm (epoch ms)', { minimum: 0 }),
                to: int('Đến thời điểm (epoch ms)', { minimum: 0 }),
                search: str('Tìm trong tên và nội dung bình luận'),
                limit: int('Tối đa bao nhiêu dòng (1–500)', { minimum: 1, maximum: 500 }),
                offset: int('Bỏ qua bao nhiêu dòng đầu', { minimum: 0 }),
            }),
            resultSchema: obj({ total: int('Tổng số dòng khớp'), leads: { type: 'array', items: { type: 'object' }, description: 'Các khách trong trang' } }, ['total', 'leads']),
            run: async (p) => deps.leads.list(pick(p, ['status', 'campaignId', 'from', 'to', 'search', 'limit', 'offset'])),
        },
        {
            name: 'leads.update',
            description: 'Đổi trạng thái và/hoặc ghi chú của một khách (cần ít nhất một trong hai). NOT_FOUND nếu id lạ.',
            destructive: false,
            paramsSchema: obj({
                id: int('Mã khách', { minimum: 1 }),
                status: { type: 'string', enum: ['new', 'contacted', 'won', 'ignored'] },
                note: { type: 'string', maxLength: 1000, description: 'Ghi chú (≤ 1000 ký tự)' },
            }, ['id']),
            resultSchema: obj({ lead: { type: 'object', description: 'Khách sau khi cập nhật' } }, ['lead']),
            run: async (p) => deps.leads.update(pick(p, ['id', 'status', 'note'])),
        },
        {
            name: 'leads.config',
            description: 'Đọc hoặc lưu cấu hình phát hiện khách và tự thu bình luận. Không truyền config = chỉ đọc; có config = lưu rồi trả cấu hình mới. Cấu hình: autoCollect (boolean), collectAtMinutes (1–10 số tăng dần, 30–20160 phút), keywords (1–100 mục, mỗi mục 1–40 ký tự), detectPhone (boolean), aiEnabled (boolean), aiMinScore (0–100).',
            destructive: false,
            paramsSchema: obj({
                config: {
                    type: 'object',
                    properties: {
                        autoCollect: { type: 'boolean' },
                        collectAtMinutes: { type: 'array', items: { type: 'integer', minimum: 30, maximum: 20160 }, minItems: 1, maxItems: 10 },
                        keywords: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 40 }, minItems: 1, maxItems: 100 },
                        detectPhone: { type: 'boolean' },
                        aiEnabled: { type: 'boolean' },
                        aiMinScore: { type: 'integer', minimum: 0, maximum: 100 },
                    },
                    description: 'Cấu hình cần lưu; bỏ trống để chỉ đọc',
                },
            }),
            resultSchema: obj({ config: { type: 'object', description: 'Cấu hình hiện hành' } }, ['config']),
            run: async (p) => (p.config === undefined ? deps.leads.getConfig() : deps.leads.setConfig(p.config)),
        },
        {
            name: 'videos.templates',
            description: 'Danh sách mẫu video và nhạc có sẵn của máy chủ render (mỗi mẫu có khổ hỗ trợ, số ảnh, các biến chữ/giá/màu và giới hạn độ dài). Gọi trước videos.render. INVALID_PARAMS nếu chưa cấu hình máy chủ render; INTERNAL nếu không kết nối được.',
            destructive: false,
            paramsSchema: obj({}),
            resultSchema: obj({ templates: { type: 'array', items: { type: 'object' } }, music: { type: 'array', items: { type: 'object' } } }, ['templates', 'music']),
            run: async () => deps.videos.templates(),
        },
        {
            name: 'videos.render',
            description: 'Tạo video bằng máy chủ render. Cần name và đúng MỘT trong hai kiểu. Kiểu mẫu: templateId, aspect (9:16 / 1:1 / 16:9), variables, imageIds (mã tệp /v1/media, ≤ 20 ảnh theo thứ tự), nhạc tuỳ chọn bằng musicId (nhạc có sẵn) hoặc musicMediaId (mã tệp /v1/media), không dùng cả hai. Kiểu HTML: html, width, height, assetIds (mã tệp /v1/media, trong HTML gọi theo tên asset1.<đuôi>, asset2.<đuôi>… theo thứ tự). Chạy nền, trả videoId ngay; xong có sự kiện videos.finished kèm mediaId để dùng ngay trong drafts.create.mediaIds (hết hạn sau 24 giờ). LIMIT_REACHED nếu hàng đợi máy chủ đầy hoặc quá hạn mức; INVALID_PARAMS nếu chưa cấu hình máy chủ render hoặc sai tham số.',
            destructive: false,
            paramsSchema: obj({
                name: { type: 'string', minLength: 1, maxLength: 100, description: 'Tên video (1–100 ký tự)' },
                templateId: str('Mã mẫu (kiểu mẫu)'),
                aspect: { type: 'string', enum: ['9:16', '1:1', '16:9'], description: 'Khổ video (kiểu mẫu)' },
                variables: { type: 'object', description: 'Giá trị các biến của mẫu (kiểu mẫu)' },
                imageIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20, description: 'Mã tệp ảnh đã tải lên qua /v1/media, đúng thứ tự (kiểu mẫu)' },
                musicId: { type: ['string', 'null'], description: 'Mã nhạc có sẵn; null = không nhạc' },
                musicMediaId: str('Mã tệp nhạc đã tải lên qua /v1/media (thay cho musicId)'),
                html: str('HTML tự viết (kiểu HTML, ≤ 512 KB)'),
                width: int('Rộng (kiểu HTML)', { minimum: 1 }),
                height: int('Cao (kiểu HTML)', { minimum: 1 }),
                assetIds: { type: 'array', items: { type: 'string' }, maxItems: 20, description: 'Mã tệp đi kèm HTML đã tải lên qua /v1/media (kiểu HTML)' },
                fps: { type: 'integer', enum: [24, 30], description: 'Số khung hình/giây (mặc định 30)' },
                quality: { type: 'string', enum: ['standard', 'high'], description: 'Chất lượng (mặc định standard)' },
            }, ['name']),
            resultSchema: obj({ videoId: str('Mã video'), status: str('Trạng thái ban đầu (queued)') }, ['videoId', 'status']),
            run: async (p) => deps.videos.render(pick(p, ['name', 'templateId', 'aspect', 'variables', 'imageIds', 'musicId', 'musicMediaId', 'html', 'width', 'height', 'assetIds', 'fps', 'quality'])),
        },
        {
            name: 'videos.status',
            description: 'Xem một video: trạng thái (queued / rendering / done / failed / cancelled), tiến độ 0–1, lỗi, thời lượng, dung lượng. NOT_FOUND nếu videoId lạ.',
            destructive: false,
            paramsSchema: obj({ videoId: str('Mã video') }, ['videoId']),
            resultSchema: obj({ video: { type: 'object', description: 'Thông tin video (không có đường dẫn trên máy)' } }, ['video']),
            run: async (p) => deps.videos.status(pick(p, ['videoId'])),
        },
        {
            name: 'videos.list',
            description: 'Danh sách video, mới nhất trước; lọc theo status, phân trang bằng limit (1–100, mặc định 50) và offset.',
            destructive: false,
            paramsSchema: obj({
                status: { type: 'string', enum: ['uploading', 'queued', 'rendering', 'done', 'failed', 'cancelled'] },
                limit: int('Số dòng (1–100)', { minimum: 1, maximum: 100 }),
                offset: int('Bỏ qua bấy nhiêu dòng đầu', { minimum: 0 }),
            }),
            resultSchema: obj({ total: int('Tổng số video khớp'), videos: { type: 'array', items: { type: 'object' } } }, ['total', 'videos']),
            run: async (p) => deps.videos.list(pick(p, ['status', 'limit', 'offset'])),
        },
        {
            name: 'videos.cancel',
            description: 'Huỷ video đang chờ hoặc đang render. cancelled = false nếu video không còn ở trạng thái huỷ được. NOT_FOUND nếu videoId lạ.',
            destructive: false,
            paramsSchema: obj({ videoId: str('Mã video') }, ['videoId']),
            resultSchema: obj({ cancelled: { type: 'boolean' } }, ['cancelled']),
            run: async (p) => deps.videos.cancel(pick(p, ['videoId'])),
        },
    ];

    // Bọc chung: kiểm xác nhận trước khi chạm deps, và đổi lỗi sang mã giao thức.
    return methods.map((method) => ({
        ...method,
        run: async (params, ctx) => {
            const p = params && typeof params === 'object' ? params : {};
            const destructive = typeof method.destructive === 'function' ? method.destructive(p) : method.destructive;
            if (destructive && p.confirm !== true) throw new ControlError('CONFIRMATION_REQUIRED', CONFIRM_MESSAGE);
            try {
                return await method.run(p, ctx);
            } catch (err) {
                const mapped = toControlError(err);
                // Lỗi nội bộ không lộ ra client nên phải để lại dấu vết để chẩn đoán.
                if (mapped.code === 'INTERNAL' && !(err instanceof ControlError)) { Logger.error(`[control] ${method.name} lỗi nội bộ:`, errorText(err)); }
                throw mapped;
            }
        },
    }));
}

export function describe(methods: ControlMethod[]) {
    return {
        protocol: 1 as const,
        methods: methods.map((m) => ({
            name: m.name,
            description: m.description,
            destructive: m.destructive !== false,
            ...(m.destructiveWhen ? { destructiveWhen: m.destructiveWhen } : {}),
            paramsSchema: m.paramsSchema,
            resultSchema: m.resultSchema,
        })),
    };
}

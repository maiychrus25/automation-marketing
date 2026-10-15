import Logger from '../../utils/Logger';
import { errorText } from './controlSecurity';
import { BUSY_ERROR, ENGINE_MISSING_ERROR } from '../facebookPoster/FacebookPosterService';

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
const NOT_FOUND_MESSAGES = ['Không tìm thấy bản nháp', 'Không tìm thấy lịch', 'Không tìm thấy lần chạy'];

/**
 * Đổi lỗi ném ra từ posterOperations thành mã giao thức. Chỉ `new Error(msg)` thuần (lỗi kiểm tra có thông báo tiếng Việt)
 * mới thành INVALID_PARAMS; mọi lỗi khác (TypeError, lỗi SQLite/hệ thống tệp…) là INTERNAL, không lộ thông báo gốc.
 */
export function toControlError(err: unknown): ControlError {
    if (err instanceof ControlError) return err;
    const plain = err instanceof Error && err.constructor === Error && typeof (err as { code?: unknown }).code !== 'string';
    if (!plain) return new ControlError('INTERNAL', INTERNAL_MESSAGE);
    const message = (err as Error).message;
    if (message.includes(BUSY_ERROR)) return new ControlError('BUSY', message);
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

export interface ControlEventRow { seq: number; type: string; payload: unknown; createdAt: number }

export interface ControlMethodDeps {
    poster: PosterPort;
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
};
// Các trường nằm trong params của bản nháp (phần còn lại — name/plannedAt/mediaIds — xử lý riêng).
const DRAFT_PARAM_KEYS = ['mode', 'text', 'comment', 'commentDelayMin', 'profiles', 'minDelaySec', 'maxDelaySec', 'concurrency', 'staggerMinSec', 'staggerMaxSec'];

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
                profileIds: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 50, description: 'Mã các profile (tối đa 50); bỏ trống = mọi profile' },
            }),
            resultSchema: obj({ checkId: str('Mã lượt kiểm tra'), profileIds: { type: 'array', items: { type: 'string' }, description: 'Các profile sẽ được kiểm tra' } }, ['checkId', 'profileIds']),
            run: async (p) => {
                const raw = p.profileIds;
                if (raw === undefined || raw === null) return deps.checkLogins(null);
                if (!Array.isArray(raw) || raw.length > 50 || raw.some((id) => typeof id !== 'string' || !id)) {
                    throw new ControlError('INVALID_PARAMS', 'profileIds phải là danh sách tối đa 50 mã (chuỗi không rỗng)', { field: 'profileIds' });
                }
                const ids = [...new Set(raw as string[])];
                if (!ids.length) return deps.checkLogins(null);
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
                confirm: confirmProp,
            }, ['id', 'when']),
            resultSchema: anyResult,
            run: async (p) => {
                const id = requireString(p, 'id');
                if (p.when === 'now') return poster.draftApprove({ id, when: 'now' });
                if (!p.when || typeof p.when !== 'object') {
                    throw new ControlError('INVALID_PARAMS', 'when phải là "now" hoặc đối tượng lịch', { field: 'when' });
                }
                return poster.draftApprove({ id, when: 'schedule', kind: p.when.kind, runAt: p.when.runAt, days: p.when.days, time: p.when.time });
            },
        },
        {
            name: 'schedules.list', description: 'Danh sách lịch đăng (không gồm bản nháp), kèm queuedIds đang chờ chạy.',
            destructive: false, paramsSchema: noParams, resultSchema: obj({ schedules: { type: 'array', items: { type: 'object' }, description: 'Các lịch' }, queuedIds: { type: 'array', items: { type: 'string' }, description: 'Lịch đang chờ chạy' } }, ['schedules', 'queuedIds']),
            run: async () => {
                const { schedules, queuedIds } = await poster.scheduleList();
                return { schedules: (schedules as any[]).filter((s) => !s.draft), queuedIds };
            },
        },
        {
            name: 'schedules.update', description: 'Sửa lịch: tên, bật/tắt, giờ (cùng quy tắc với app). runAt chỉ dùng cho lịch một lần; days/time chỉ dùng cho lịch lặp.',
            destructive: false,
            paramsSchema: obj({ id: str('Mã lịch'), name: str('Tên mới'), enabled: { type: 'boolean', description: 'Bật hoặc tắt lịch' }, ...timingProps }, ['id']),
            resultSchema: anyResult,
            run: async (p) => poster.scheduleUpdate(pick(p, ['id', 'name', 'enabled', 'runAt', 'days', 'time'])),
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
            name: 'runs.get', description: 'Chi tiết một lần chạy: kết quả từng đích, link bài, trạng thái bình luận.',
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

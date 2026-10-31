import { createHash, randomUUID } from 'crypto';
import type { PageContext, PageDraftInput, PageDraftProjection, PageResearchInput, PageResourceRef, PageWork, WorkLease } from '../../models/pageOperations';
import { FacebookPosterStore, type SqlDatabase } from '../facebookPoster/FacebookPosterStore';
import { validateDraft, type DraftDeps } from '../facebookPoster/drafts';
import type { ResearchService, ReservedResearchScan } from '../research/ResearchService';
import type { ResearchStore } from '../research/ResearchStore';
import type { VideoOperations } from '../video/videoOperations';
import type { InboxMediaStore } from '../control/InboxMediaStore';
import { DailyBriefStore, type LocalClock } from './DailyBriefStore';
import { PageWorkStore, PageWorkError } from './PageWorkStore';
import { PageCampaignStore } from './PageCampaignStore';

export interface PageWorkOperationsDeps {
    /** All local stores, including research, must be primed on this connection before construction. */
    db: SqlDatabase;
    context(workId: string): PageContext;
    assertCurrent(): void;
    /** Trusted live actor reader; must guard its own awaits and use the shared browser slot. */
    assertActor(context: PageContext, assertCurrent: () => void): Promise<void>;
    now(): number;
    clock?: LocalClock;
    draft: Omit<DraftDeps, 'store' | 'newId'>;
    research: Pick<ResearchService, 'reserveSearch' | 'reserveGroupFeeds' | 'cancelOwned' | 'whenIdle' | 'status'>;
    researchStore: Pick<ResearchStore, 'getScan'>;
    video: Pick<VideoOperations, 'status' | 'openFile'>;
    media: InboxMediaStore;
}

type LiveMediaAdoption = { context: PageContext; stepKey: string; claimedAt: number | null; status: PageWork['status'] };
// Only live intent identity is shared, never a principal, guard, Promise or result.
const liveMediaAdoptions = new WeakMap<SqlDatabase, Map<string, LiveMediaAdoption>>();
const livePreparations = new WeakMap<SqlDatabase, Map<string, number>>();

/** Read-only safe-point check on the captured shared handle; not authorization or success evidence. */
export function assertPagePreparationIdle(db: SqlDatabase, workId: string): void {
    if (isPagePreparationActive(db, workId))
        throw new PageWorkError('CONFLICT', 'Công việc đang chuẩn bị, hãy chờ kết thúc trước khi xác nhận');
}

function isPagePreparationActive(db: SqlDatabase, workId: string): boolean {
    return !!(livePreparations.get(db)?.get(workId) || liveMediaAdoptions.get(db)?.has(workId));
}

function trackPreparation(db: SqlDatabase, workId: string): () => void {
    const active = livePreparations.get(db) ?? new Map<string, number>();
    livePreparations.set(db, active);
    active.set(workId, (active.get(workId) ?? 0) + 1);
    return () => {
        const remaining = active.get(workId)! - 1;
        if (remaining) active.set(workId, remaining);
        else active.delete(workId);
    };
}

const fail = (code: 'INVALID_PARAMS' | 'CONFLICT' | 'NEEDS_REVIEW' | 'NOT_FOUND', message: string): never => {
    throw new PageWorkError(code, message);
};
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const terminal = (work: PageWork) => ['completed', 'cancelled', 'failed'].includes(work.status);
function fields(input: unknown, allowed: string[]): void {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k)))
        fail('INVALID_PARAMS', 'Tham số không hợp lệ');
}
function strings(input: unknown): asserts input is string[] {
    if (!Array.isArray(input) || input.some(v => typeof v !== 'string' || !v.trim()))
        fail('INVALID_PARAMS', 'Danh sách không hợp lệ');
}

/** Main-process capability, never expose this object or attachVideo directly to a runner. */
export function createPageWorkOperations(deps: PageWorkOperationsDeps) {
    // Construct both stores here: draft row and finishStep cannot accidentally use different connections.
    const works = new PageWorkStore(deps.db, deps.clock);
    const poster = new FacebookPosterStore(deps.db);
    const briefs = new DailyBriefStore(deps.db, deps.clock);
    const adoptions = liveMediaAdoptions.get(deps.db) ?? new Map<string, LiveMediaAdoption>();
    liveMediaAdoptions.set(deps.db, adoptions);
    function current(workId: string) {
        deps.assertCurrent();
        const context = { ...deps.context(workId) };
        const work = works.get(workId);
        if (!work || work.workspaceId !== context.workspaceId || work.pageId !== context.pageId || work.profileId !== context.profileId)
            fail('NOT_FOUND', 'Không tìm thấy công việc Page');
        deps.assertCurrent();
        return { work: work!, context };
    }
    function guard(workId: string, captured: PageContext, lease?: WorkLease) {
        const { context } = current(workId);
        if (Object.keys(captured).some(k => context[k as keyof PageContext] !== captured[k as keyof PageContext]))
            fail('CONFLICT', 'Ngữ cảnh Page đã thay đổi');
        if (lease) works.assertLease(lease, deps.now());
    }
    function owned(workId: string, resource: PageResourceRef) {
        const { work } = current(workId);
        const owner = works.getResourceOwner(resource);
        if (!owner || owner.workId !== workId || owner.workspaceId !== work.workspaceId || owner.pageId !== work.pageId)
            fail('NOT_FOUND', 'Không tìm thấy tài nguyên của công việc');
    }
    function campaignReference(workId: string, campaignId: string): void {
        const {context} = current(workId);
        const exists = deps.db.queryOne<{n:number}>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='page_campaign_links'");
        if (!exists) fail('CONFLICT', 'Không đọc được liên kết chiến dịch');
        const link = exists.n ? new PageCampaignStore(deps.db).getLink(campaignId) : null;
        if (!link) {owned(workId, {kind:'campaign', id:campaignId}); return;}
        if (link.deletedAt !== null || link.workspaceId !== context.workspaceId || link.pageId !== context.pageId || link.profileId !== context.profileId)
            fail('NOT_FOUND', 'Không tìm thấy chiến dịch của Page');
    }
    function review(workId: string): PageWork {
        current(workId);
        return works.stopPreparation(workId, 'needs_review', deps.now());
    }
    function replay(workId: string, stepKey: string, requestHash: string) {
        const step = works.getStep(workId, stepKey);
        if (!step) return null;
        if (step.requestHash !== requestHash) fail('CONFLICT', 'Nội dung bước công việc đã thay đổi');
        if (step.status !== 'succeeded' || !step.resourceKind || !step.resourceId) {
            review(workId);
            fail('NEEDS_REVIEW', 'Bước trước chưa rõ kết quả, cần đối soát');
        }
        owned(workId, { kind: step.resourceKind!, id: step.resourceId! });
        return step;
    }
    function checkDraft(workId: string, id: string, allowPromoted = false) {
        owned(workId, { kind: 'draft', id });
        const { context } = current(workId);
        const draft = poster.getSchedule(id);
        const profiles = draft?.params.profiles as { profileId: string; targets: string[] }[] | undefined;
        if (!draft || (!draft.draft && !allowPromoted) || draft.params.mode !== 'page' || profiles?.length !== 1 || profiles[0].profileId !== context.profileId
            || profiles[0].targets.length !== 1 || profiles[0].targets[0] !== 'https://www.facebook.com/')
            fail('CONFLICT', 'Cấu hình bản nháp đã thay đổi');
        if (draft!.campaignId) campaignReference(workId, draft!.campaignId);
        if (draft!.params.campaignId !== undefined && draft!.params.campaignId !== null) {
            if (typeof draft!.params.campaignId !== 'string') fail('CONFLICT', 'Chiến dịch bản nháp không hợp lệ');
            campaignReference(workId, draft!.params.campaignId as string);
        }
        const mediaIds = draft!.params.mediaIds ?? [];
        strings(mediaIds);
        for (const id of mediaIds) owned(workId, { kind: 'media', id });
        return draft!;
    }
    const operations = {
        async saveDraft(lease: WorkLease, draftIndex: number, input: PageDraftInput): Promise<{ draftId: string; revision: number }> {
            const { context } = current(lease.workId);
            fields(input, ['id', 'expectedRevision', 'name', 'plannedAt', 'text', 'variants', 'mediaIds', 'comment', 'campaignId']);
            if (typeof input.text !== 'string' || !input.text.trim() || (input.name !== undefined && typeof input.name !== 'string')
                || (input.comment !== undefined && typeof input.comment !== 'string')
                || (input.campaignId !== undefined && input.campaignId !== null && (typeof input.campaignId !== 'string' || !input.campaignId))
                || (input.plannedAt !== undefined && input.plannedAt !== null && !Number.isSafeInteger(input.plannedAt)))
                fail('INVALID_PARAMS', 'Nội dung bản nháp không hợp lệ');
            const editing = input.id !== undefined;
            if (editing ? typeof input.id !== 'string' || !input.id || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision! < 1
                : input.expectedRevision !== undefined) fail('INVALID_PARAMS', 'Phiên bản bản nháp không hợp lệ');
            const brief = briefs.getBrief(context.profileId);
            if (!Number.isSafeInteger(draftIndex) || draftIndex < 0 || !brief || draftIndex >= brief.draftsPerDay)
                fail('INVALID_PARAMS', 'Vị trí bản nháp không hợp lệ');
            const mediaIds = input.mediaIds === undefined ? [] : input.mediaIds;
            strings(mediaIds);
            if (input.campaignId) campaignReference(lease.workId, input.campaignId);
            for (const id of mediaIds) owned(lease.workId, { kind: 'media', id });
            if (editing) {
                owned(lease.workId, { kind: 'draft', id: input.id! });
                const original = works.getStep(lease.workId, `draft:${draftIndex}`);
                if (original?.status !== 'succeeded' || original.resourceId !== input.id) fail('CONFLICT', 'Vị trí bản nháp không khớp');
            }
            const key = `draft:${draftIndex}${editing ? `:revision:${input.expectedRevision! + 1}` : ''}`;
            const requestHash = hash({ id: input.id, expectedRevision: input.expectedRevision, name: input.name, plannedAt: input.plannedAt,
                text: input.text, variants: input.variants, mediaIds, comment: input.comment ?? '', campaignId: input.campaignId });
            const previous = replay(lease.workId, key, requestHash);
            if (previous) {
                if (previous.resourceKind !== 'draft' || !previous.resultRevision) fail('NEEDS_REVIEW', 'Thiếu phiên bản kết quả gốc');
                return { draftId: previous.resourceId!, revision: previous.resultRevision };
            }
            guard(lease.workId, context, lease);
            const checkRevision = () => {
                if (editing && checkDraft(lease.workId, input.id!).revision !== input.expectedRevision)
                    fail('CONFLICT', 'Bản nháp đã thay đổi, vui lòng tải lại');
            };
            checkRevision();
            const actorSettled = trackPreparation(deps.db, lease.workId);
            try { await deps.assertActor(context, () => guard(lease.workId, context, lease)); }
            finally { actorSettled(); }
            guard(lease.workId, context, lease);
            // Another request may have committed while the live actor check was awaiting.
            const raced = replay(lease.workId, key, requestHash);
            if (raced) {
                if (!raced.resultRevision) fail('NEEDS_REVIEW', 'Thiếu phiên bản kết quả gốc');
                return { draftId: raced.resourceId!, revision: raced.resultRevision };
            }
            checkRevision();
            const mediaPaths = deps.media.resolve(mediaIds);
            const id = input.id ?? randomUUID();
            const draftDeps = { ...deps.draft, store: poster, newId: () => id };
            const draftInput = {
                ...(editing ? { id, expectedRevision: input.expectedRevision } : {}), name: input.name, plannedAt: input.plannedAt,
                campaignId: input.campaignId, params: { mode: 'page', text: input.text, variants: input.variants, comment: input.comment,
                    profiles: [{ profileId: context.profileId, targets: ['https://www.facebook.com/'] }],
                    mediaIds, mediaPaths },
            };
            const prepare = validateDraft(draftDeps, draftInput);
            works.beginStep(lease, key, requestHash, deps.now(), { kind: 'draft', id });
            const prepared = prepare();
            try {
                works.transaction(() => {
                    guard(lease.workId, context, lease);
                    prepared.commit();
                    if (input.campaignId) {
                        campaignReference(lease.workId, input.campaignId);
                        deps.db.run('UPDATE page_work_items SET campaign_id = ? WHERE id = ? AND (campaign_id IS NULL OR campaign_id = ?)',
                            [input.campaignId, lease.workId, input.campaignId]);
                        if (deps.db.queryOne<{n:number}>('SELECT changes() AS n')?.n !== 1) fail('CONFLICT', 'Công việc đã tham chiếu chiến dịch khác');
                    }
                    works.finishStep(lease, key, { kind: 'draft', id }, deps.now(), prepared.revision);
                });
                return { draftId: id, revision: prepared.revision };
            } catch (error) { prepared.cleanup(); throw error; }
        },
        getDraft(workId: string, draftId: string): PageDraftProjection {
            owned(workId, { kind: 'draft', id: draftId });
            if (!poster.getSchedule(draftId)) return { id: draftId, status: 'removed' };
            const draft = checkDraft(workId, draftId, true);
            if (!draft.draft) return { id: draftId, status: 'promoted' };
            return { id: draft.id, revision: draft.revision, name: draft.name, plannedAt: draft.runAt,
                text: String(draft.params.text), ...(draft.params.variants ? {variants: draft.params.variants as string[]} : {}), comment: String(draft.params.comment ?? ''),
                mediaIds: (draft.params.mediaIds ?? []) as string[], campaignId: draft.campaignId };
        },
        async research(lease: WorkLease, input: PageResearchInput): Promise<{ scanId: string }> {
            const researchSettled = trackPreparation(deps.db, lease.workId);
            try {
                const { context } = current(lease.workId);
                fields(input, input?.kind === 'search' ? ['kind', 'keywords'] : ['kind', 'groupIds']);
                if (!['search', 'group_feed'].includes(input.kind)) fail('INVALID_PARAMS', 'Loại nghiên cứu không hợp lệ');
                const values = input.kind === 'search' ? input.keywords : input.groupIds;
                strings(values);
                if (!values.length) fail('INVALID_PARAMS', 'Thiếu nguồn nghiên cứu');
                if (input.kind === 'group_feed' && input.groupIds.some(id => !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)))
                    fail('INVALID_PARAMS', 'Mã nhóm không hợp lệ');
                const requestHash = hash([input.kind, values]);
                const previous = replay(lease.workId, 'research', requestHash);
                if (previous) return { scanId: previous.resourceId! };
                guard(lease.workId, context, lease);
                const scanId = randomUUID();
                let reservation: ReservedResearchScan | undefined;
                try {
                    works.transaction(() => {
                        guard(lease.workId, context, lease);
                        works.beginStep(lease, 'research', requestHash, deps.now(), { kind: 'research', id: scanId });
                        const ownership = { scanId, pageId: context.pageId, profileId: context.profileId,
                            assertCurrent: () => guard(lease.workId, context, lease) };
                        reservation = input.kind === 'search'
                            ? deps.research.reserveSearch({ source: 'posts', query: input.keywords.join(' '), origin: 'api' }, ownership)
                            : deps.research.reserveGroupFeeds({ groupUrls: input.groupIds.map(id => `https://www.facebook.com/groups/${id}/`), origin: 'api' }, ownership);
                        works.finishStep(lease, 'research', { kind: 'research', id: scanId }, deps.now());
                    });
                } catch (error) {
                    if (reservation) { deps.research.cancelOwned(scanId); await deps.research.whenIdle(); }
                    throw error;
                }
                try {
                    guard(lease.workId, context, lease);
                    reservation!.start();
                } catch (error) {
                    deps.research.cancelOwned(scanId);
                    await deps.research.whenIdle();
                    throw error;
                }
                await deps.research.whenIdle();
                guard(lease.workId, context, lease);
                const scan = deps.researchStore.getScan(scanId);
                if (!scan || scan.status !== 'done') { review(lease.workId); fail('NEEDS_REVIEW', 'Nghiên cứu cần kiểm tra'); }
                return { scanId };
            } finally { researchSettled(); }
        },
        async attachVideo(workId: string, videoId: string): Promise<void> {
            const { context, work } = current(workId);
            if (terminal(work) || work.status === 'needs_review') fail('CONFLICT', 'Công việc không còn chuẩn bị');
            // This method is exclusively the trusted customer-request/owner adapter, not a runner method.
            deps.video.status({ videoId }, 'bot');
            guard(workId, context);
            works.linkResource(workId, { kind: 'video', id: videoId });
        },
        async reconcile(workId: string): Promise<PageWork> {
            let { work, context } = current(workId);
            if (terminal(work) || work.status === 'needs_review' || isPagePreparationActive(deps.db, workId)) return work;
            work = works.reconcileExpiredLease(workId, deps.now());
            if (work.status === 'needs_review') return work;
            if (work.step) {
                const step = works.getStep(workId, work.step);
                if (step && step.status !== 'succeeded') {
                    const active = adoptions.get(workId);
                    if (step.status === 'intent' && step.resourceKind === 'media' && active?.stepKey === step.stepKey
                        && active.claimedAt === work.claimedAt && active.status === work.status
                        && Object.keys(context).every(key => context[key as keyof PageContext] === active.context[key as keyof PageContext]))
                        return current(workId).work;
                    return review(workId);
                }
            }
            for (const id of work.draftIds) {
                owned(workId, { kind: 'draft', id });
                if (!poster.getSchedule(id)) return review(workId);
            }
            if (work.researchId) {
                owned(workId, { kind: 'research', id: work.researchId });
                const scan = deps.researchStore.getScan(work.researchId);
                if (!scan || (scan.status !== 'done' && (scan.status !== 'running' || deps.research.status().scanId !== scan.id))) return review(workId);
            }
            if (!work.videoId) return current(workId).work;
            owned(workId, { kind: 'video', id: work.videoId });
            let status: string;
            try { status = deps.video.status({ videoId: work.videoId }, 'bot').video.status; }
            catch { return review(workId); }
            guard(workId, context);
            if (['failed', 'cancelled'].includes(status)) return review(workId);
            if (status !== 'done') {
                if (work.status === 'running') works.transition({ workId, claimedAt: work.claimedAt! }, 'waiting', { waitFor: 'video' }, deps.now());
                return current(workId).work;
            }
            const checkPreparation = () => {
                guard(workId, context);
                const live = works.get(workId)!;
                if (live.status !== work.status || live.claimedAt !== work.claimedAt) fail('CONFLICT', 'Lượt chuẩn bị đã thay đổi');
            };
            const linked = works.getVideoMediaIds(workId, work.videoId);
            let available = false;
            for (const id of linked) {
                owned(workId, { kind: 'media', id });
                try { deps.media.resolve([id]); available = true; } catch { /* Expired inbox media can be adopted again. */ }
            }
            if (!available) {
                let savedId: string | undefined;
                let linkStarted = false;
                let stream: Awaited<ReturnType<VideoOperations['openFile']>>['stream'] | undefined;
                const stepKey = `video-media:${randomUUID()}`;
                checkPreparation();
                works.beginMediaAdoption(workId, work.videoId, stepKey, deps.now());
                const adoption = { context, stepKey, claimedAt: work.claimedAt, status: work.status };
                adoptions.set(workId, adoption);
                try {
                    checkPreparation();
                    const opened = await deps.video.openFile({ videoId: work.videoId, kind: 'video' });
                    stream = opened.stream;
                    checkPreparation();
                    const saved = await deps.media.save('video.mp4', 'video/mp4', stream);
                    savedId = saved.mediaId;
                    checkPreparation();
                    linkStarted = true;
                    works.finishMediaAdoption(workId, work.videoId, stepKey, savedId, deps.now());
                } catch (error) {
                    // Before linking this UUID is exclusively our attempt, even after a workspace switch.
                    if (savedId && !linkStarted) deps.media.remove(savedId);
                    checkPreparation();
                    if (savedId && linkStarted && !works.getResourceOwner({ kind: 'media', id: savedId })) deps.media.remove(savedId);
                    return review(workId);
                } finally {
                    try { stream?.destroy(); }
                    finally { if (adoptions.get(workId) === adoption) adoptions.delete(workId); }
                }
            }
            guard(workId, context);
            if (works.get(workId)!.status === 'waiting') works.reconcileVideo(workId, work.videoId, 'completed', deps.now());
            return current(workId).work;
        },
        async cancelOwned(workId: string): Promise<void> {
            const { work, context } = current(workId);
            if (terminal(work)) return;
            if (work.researchId) {
                owned(workId, { kind: 'research', id: work.researchId });
                if (deps.research.cancelOwned(work.researchId)) await deps.research.whenIdle();
                guard(workId, context);
            }
            // AHV has no remote cancellation: stop local preparation only, never independent schedules.
            works.stopPreparation(workId, 'cancelled', deps.now());
        },
    };
    return operations;
}

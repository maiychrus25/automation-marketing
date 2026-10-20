// Lọc khách tiềm năng từ bình luận mới: từ khoá / số điện thoại, rồi (tuỳ chọn) AI chấm điểm.
// Không bao giờ ném lỗi ra ngoài: lỗi AI rơi về từ khoá, lỗi ghi chỉ log. Spec mục 6.2 và 6.4.
import type { FbPosterComment, FbPosterLead } from '../../models/facebookPoster';
import type { FacebookPosterStore } from './FacebookPosterStore';
import { matchLead, type LeadConfig } from './leadRules';
import type { LeadClassifier, LeadVerdict } from './leadAi';

const AI_BATCH_SIZE = 20;
const MAX_SAMPLES = 3;

export interface LeadDetectorDeps {
    store: Pick<FacebookPosterStore, 'trackingByPostUrls' | 'createLeads'>;
    readConfig: () => LeadConfig;
    /** Chưa có thì coi như AI không dùng được. */
    classify?: LeadClassifier;
    emit: (type: 'leads.found', payload: { count: number; samples: { authorName: string; text: string; postUrl: string }[]; auto: boolean }) => void;
    now?: () => number;
    log: (message: string) => void;
}

/** Trạng thái AI dùng chung cho cả một lượt thu: sau một lần AI lỗi / hết hạn thì các bài còn lại không gọi AI nữa. */
export interface LeadAiState { failed: boolean }
export interface LeadProcessOptions {
    auto: boolean;
    /** Mặc định true. Lượt thu nhiều bài truyền false rồi tự gom và phát một sự kiện qua `buildLeadsFoundPayload`. */
    emit?: boolean;
    aiState?: LeadAiState;
}
type LeadsFoundPayload = Parameters<LeadDetectorDeps['emit']>[1];

/** Gộp các khách mới của một lượt thành nội dung sự kiện `leads.found`: tổng số + tối đa 3 mẫu mới nhất. */
export function buildLeadsFoundPayload(leads: FbPosterLead[], auto: boolean): LeadsFoundPayload {
    const samples = leads.slice(-MAX_SAMPLES).reverse()
        .map((l) => ({ authorName: l.authorName, text: l.text, postUrl: l.postUrl }));
    return { count: leads.length, samples, auto };
}

interface Candidate { comment: FbPosterComment; matched: string[]; verdict: LeadVerdict | null }

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class LeadDetector {
    constructor(private readonly deps: LeadDetectorDeps) {}

    async process(comments: FbPosterComment[], opts: LeadProcessOptions): Promise<FbPosterLead[]> {
        try {
            const config = this.deps.readConfig();
            let candidates: Candidate[] = [];
            for (const comment of comments) {
                if (!String(comment.text ?? '').trim()) continue;
                const matched = matchLead(comment.text, config);
                if (matched) candidates.push({ comment, matched, verdict: null });
            }
            if (candidates.length === 0) return [];
            if (config.aiEnabled) candidates = await this.applyAi(candidates, config.aiMinScore, opts.aiState ?? { failed: false });
            if (candidates.length === 0) return [];
            return this.save(candidates, opts.auto, opts.emit !== false);
        } catch (err) {
            this.safeLog(`Lọc khách tiềm năng lỗi: ${errorText(err)}`);
            return [];
        }
    }

    /** Chấm theo lô; lỗi / không dùng được thì giữ nguyên các bình luận chưa chấm (cảnh báo một lần mỗi lượt, rồi bỏ AI cho phần còn lại của lượt). */
    private async applyAi(candidates: Candidate[], minScore: number, state: LeadAiState): Promise<Candidate[]> {
        const classify = this.deps.classify;
        const warn = (reason: string) => {
            if (state.failed) return;
            state.failed = true;
            this.safeLog(`AI không dùng được (${reason}), giữ các bình luận khớp từ khoá làm khách tiềm năng`);
        };
        if (!classify) {
            warn('chưa cấu hình');
            return candidates;
        }
        const kept: Candidate[] = [];
        for (let from = 0; from < candidates.length; from += AI_BATCH_SIZE) {
            const batch = candidates.slice(from, from + AI_BATCH_SIZE);
            let verdicts: (LeadVerdict | null)[] | null = null;
            if (!state.failed) {
                try {
                    verdicts = await classify(batch.map((c) => ({ text: c.comment.text })));
                } catch (err) {
                    warn(errorText(err));
                }
                if (!verdicts) warn('không có kết quả');
            }
            batch.forEach((candidate, i) => {
                const verdict = verdicts?.[i] ?? null;
                if (verdict && verdict.score < minScore) return;
                kept.push({ ...candidate, verdict });
            });
        }
        return kept;
    }

    private save(candidates: Candidate[], auto: boolean, emit: boolean): FbPosterLead[] {
        const { store } = this.deps;
        const now = (this.deps.now ?? Date.now)();
        let created: FbPosterLead[];
        try {
            const tracking = store.trackingByPostUrls(candidates.map((c) => c.comment.postUrl));
            created = store.createLeads(candidates.map(({ comment: c, matched, verdict }) => {
                const t = tracking.get(c.postUrl);
                return {
                    commentKey: c.key, postUrl: c.postUrl,
                    resultId: t?.resultId ?? null, groupUrl: t?.groupUrl ?? '', campaignId: t?.campaignId ?? null,
                    variant: t?.variant ?? '', profileId: c.profileId,
                    authorId: c.authorId, authorName: c.authorName, authorUrl: c.authorUrl, text: c.text,
                    commentedAtMs: c.commentedAtMs, matched,
                    aiIntent: verdict?.intent ?? null, aiScore: verdict?.score ?? null, aiReason: verdict?.reason ?? null,
                    status: 'new' as const, note: '', detectedAt: now, updatedAt: now,
                };
            }));
        } catch (err) {
            this.safeLog(`Không lưu được khách tiềm năng: ${errorText(err)}`);
            return [];
        }
        if (emit && created.length > 0) {
            try {
                this.deps.emit('leads.found', buildLeadsFoundPayload(created, auto));
            } catch (err) {
                this.safeLog(`Không phát được sự kiện khách tiềm năng: ${errorText(err)}`);
            }
        }
        return created;
    }

    private safeLog(message: string): void {
        try { this.deps.log(message); } catch { /* log hỏng không được làm hỏng lượt thu */ }
    }
}

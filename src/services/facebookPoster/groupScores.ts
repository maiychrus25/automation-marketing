/** Điểm nhóm Facebook: hàm thuần, store chỉ gom số liệu đầu vào (spec 26.23 §2). */

export const MIN_SCORE_POSTS = 3;

export interface GroupScoreInput {
    groupUrl: string;
    label: string;
    attempted: number;
    posted: number;
    failed: number;
    held: number;
    removed: number;
    withLink: number;
    measured: number;
    engagementRate: number | null;
    avgEngagement: number | null;
}

export type GroupGrade = 'good' | 'fair' | 'poor' | 'insufficient';

export interface GroupScore extends GroupScoreInput {
    score: number | null;
    grade: GroupGrade;
    /** Thành phần tương tác 0–1; null khi chưa đủ dữ liệu. */
    engagement: number | null;
    reasons: string[];
}

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function gradeOf(score: number): GroupGrade {
    if (score >= 70) return 'good';
    if (score >= 40) return 'fair';
    return 'poor';
}

/** Số thập phân kiểu Việt Nam, 1 chữ số: 2.34 → "2,3". */
function formatRatio(value: number): string {
    return (Math.round(value * 10) / 10).toFixed(1).replace('.', ',');
}

export function scoreGroups(rows: GroupScoreInput[]): GroupScore[] {
    const eligible = rows.filter(r => r.attempted >= MIN_SCORE_POSTS);
    const compared = eligible.filter(r => r.measured >= 1);
    // Đơn vị đo: engagementRate nếu mọi nhóm được so đều có, ngược lại avgEngagement cho cả lượt.
    const useRate = compared.length > 0 && compared.every(r => r.engagementRate !== null);
    const valueOf = (r: GroupScoreInput): number | null => (r.measured >= 1 ? (useRate ? r.engagementRate : r.avgEngagement) : null);
    const values = compared.map(valueOf).filter((v): v is number => v !== null);
    const mid = values.length ? median(values) : 0;

    const scored = rows.map((r): GroupScore => {
        if (r.attempted < MIN_SCORE_POSTS) {
            return { ...r, score: null, grade: 'insufficient', engagement: null, reasons: [`Mới có ${r.attempted} lượt đăng (cần ≥ ${MIN_SCORE_POSTS})`] };
        }
        const success = r.posted / r.attempted;
        const published = r.posted > 0 ? 1 - r.held / r.posted : 0;
        const survival = r.withLink > 0 ? 1 - r.removed / r.withLink : 1;
        const value = valueOf(r);
        const measuredValue = value !== null && mid > 0;
        const ratio = measuredValue ? value / mid : null;
        const engagement = ratio === null ? 0.5 : Math.min(ratio / 2, 1);
        const score = Math.round(20 * success + 25 * published + 20 * survival + 35 * engagement);

        const reasons: string[] = [];
        if (published < 0.7) reasons.push(`${r.held}/${r.posted} bài phải chờ duyệt hoặc không tìm thấy`);
        if (r.removed > 0) reasons.push(`${r.removed} bài nghi bị xoá`);
        if (success < 0.8) reasons.push(`${r.failed}/${r.attempted} lần đăng lỗi`);
        if (ratio !== null && engagement < 0.35) reasons.push('Tương tác thấp hơn mức giữa của các nhóm');
        if (ratio !== null && engagement >= 0.9) reasons.push(`Tương tác cao (gấp ~${formatRatio(ratio)} lần mức giữa)`);
        if (value === null) reasons.push('Chưa có số đo tương tác');
        return { ...r, score, grade: gradeOf(score), engagement, reasons };
    });

    return scored.sort((a, b) => {
        if ((a.score === null) !== (b.score === null)) return a.score === null ? 1 : -1;
        if (a.score === null || b.score === null) return b.attempted - a.attempted;
        return b.score - a.score;
    });
}

import type { FbPosterResult } from '../../models/facebookPoster';

export const CSV_COLUMNS = ['profile', 'target', 'name', 'outcome', 'error', 'post_url', 'comment_status', 'identity', 'time'];

/** Quotes one cell; cells that a spreadsheet would read as a formula (=, +, -, @, tab, CR) get a leading ' (CSV injection). */
export function csvField(v: unknown): string {
    let text = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
}

/** UTF-8 BOM + header + one CRLF-terminated row per result. */
export function buildRunCsv(results: FbPosterResult[]): string {
    const rows = results.map((r) => [
        r.profileName, r.targetUrl, r.targetName, r.outcome, r.error, r.postUrl ?? '', r.commentStatus, r.identity,
        new Date(r.createdAt).toISOString(),
    ]);
    return '﻿' + [CSV_COLUMNS, ...rows].map((row) => row.map(csvField).join(',')).join('\r\n') + '\r\n';
}

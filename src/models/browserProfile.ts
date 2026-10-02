export interface BrowserFingerprint {
    seed: number;
    hardwareConcurrency: number;
    language: string;
    timezone: string;
}

export interface BrowserProfile {
    id: string;
    name: string;
    group_id: number | null;
    proxy_id: number | null;
    fingerprint: BrowserFingerprint;
    note: string;
    last_opened_at: number | null;
    created_at: number;
    updated_at: number;
}

export interface BrowserProfileGroup {
    id: number;
    name: string;
    color: string;
    sort_order: number;
    created_at: number;
}

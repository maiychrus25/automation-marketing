// Nguồn: docs/specs/2026-10-19-topic-research.md mục 4.1. Chạy lại nhiều lần được (IF NOT EXISTS).
export const RESEARCH_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS research_scans (
    id           TEXT PRIMARY KEY,
    source       TEXT NOT NULL,             -- 'posts' | 'groups' | 'pages' | 'group_feed'
    query        TEXT NOT NULL DEFAULT '',
    params_json  TEXT NOT NULL DEFAULT '{}',
    profile_ids  TEXT NOT NULL DEFAULT '[]',
    details_json TEXT NOT NULL DEFAULT '{}',
    origin       TEXT NOT NULL DEFAULT 'manual',
    status       TEXT NOT NULL,             -- 'running' | 'done' | 'failed' | 'cancelled'
    error_code   TEXT NOT NULL DEFAULT '',
    error        TEXT NOT NULL DEFAULT '',
    item_count   INTEGER NOT NULL DEFAULT 0,
    started_at   INTEGER NOT NULL,
    finished_at  INTEGER DEFAULT NULL
);
CREATE INDEX IF NOT EXISTS idx_research_scans_started ON research_scans(started_at);

CREATE TABLE IF NOT EXISTS research_items (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_id        TEXT NOT NULL,
    kind           TEXT NOT NULL,           -- 'post' | 'group' | 'page'
    fb_id          TEXT NOT NULL,
    url            TEXT NOT NULL DEFAULT '',
    title          TEXT NOT NULL DEFAULT '',
    place_kind     TEXT NOT NULL DEFAULT 'unknown',
    place_id       TEXT NOT NULL DEFAULT '',
    place_name     TEXT NOT NULL DEFAULT '',
    author_kind    TEXT NOT NULL DEFAULT 'unknown',
    author_id      TEXT NOT NULL DEFAULT '',
    author_name    TEXT NOT NULL DEFAULT '',
    author_url     TEXT NOT NULL DEFAULT '',
    privacy        TEXT NOT NULL DEFAULT '',
    member_count   INTEGER DEFAULT NULL,
    follower_count INTEGER DEFAULT NULL,
    reactions      INTEGER DEFAULT NULL,
    comments       INTEGER DEFAULT NULL,
    shares         INTEGER DEFAULT NULL,
    posted_at      INTEGER DEFAULT NULL,
    captured_at    INTEGER NOT NULL,
    profile_id     TEXT NOT NULL DEFAULT '',
    UNIQUE (scan_id, kind, fb_id)
);
CREATE INDEX IF NOT EXISTS idx_research_items_scan ON research_items(scan_id);
CREATE INDEX IF NOT EXISTS idx_research_items_kind_fb ON research_items(kind, fb_id);
CREATE INDEX IF NOT EXISTS idx_research_items_profile ON research_items(profile_id, captured_at);

CREATE TABLE IF NOT EXISTS research_queries (
    friendly_name      TEXT PRIMARY KEY,
    doc_id             TEXT NOT NULL,
    variables_template TEXT NOT NULL,
    captured_at        INTEGER NOT NULL
);
`;

// Nguồn: docs/specs/2026-10-03-facebook-poster.md mục 5. Chạy lại nhiều lần được (IF NOT EXISTS).
export const PAGE_CAMPAIGN_EXECUTION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS page_campaign_executions (
    schedule_id TEXT PRIMARY KEY NOT NULL,
    workspace_id TEXT NOT NULL, page_id TEXT NOT NULL, profile_id TEXT NOT NULL,
    work_id TEXT NOT NULL, campaign_id TEXT NOT NULL, grant_id TEXT NOT NULL,
    planned_date TEXT NOT NULL, actual_date TEXT,
    status TEXT NOT NULL CHECK (status IN ('reserved','submitting','posted','uncertain','cancelled')),
    revision INTEGER NOT NULL, execution_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS page_campaign_execution_quota ON page_campaign_executions(workspace_id, page_id, planned_date, status);
`;
export const FB_POSTER_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS fb_poster_runs (
    id           TEXT PRIMARY KEY,          -- uuid
    kind         TEXT NOT NULL,             -- 'post' | 'join' | 'scan_groups' | 'collect_comments'
    mode         TEXT NOT NULL DEFAULT '',  -- 'group' | 'page' với kind='post', rỗng với kind khác
    params_json  TEXT NOT NULL,             -- tham số việc, KHÔNG chứa mật khẩu proxy
    status       TEXT NOT NULL,             -- 'running' | 'done' | 'cancelled' | 'failed' | 'missed'
    error        TEXT NOT NULL DEFAULT '',
    started_at   INTEGER NOT NULL,
    finished_at  INTEGER DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS fb_poster_results (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id         TEXT NOT NULL,          -- fb_poster_runs.id
    profile_id     TEXT NOT NULL,          -- browser_profiles.id
    profile_name   TEXT NOT NULL,          -- chụp lại tên lúc chạy, để lịch sử đọc được khi profile đã xóa
    target_url     TEXT NOT NULL,
    target_name    TEXT NOT NULL DEFAULT '',
    outcome        TEXT NOT NULL,          -- xem bảng bên dưới
    error          TEXT NOT NULL DEFAULT '',
    post_url       TEXT DEFAULT NULL,
    comment_status TEXT NOT NULL DEFAULT 'not_requested',
    identity       TEXT NOT NULL DEFAULT '',  -- danh tính đọc từ ô soạn bài
    created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fb_poster_results_run ON fb_poster_results(run_id);

CREATE TABLE IF NOT EXISTS fb_poster_groups (
    profile_id   TEXT NOT NULL,
    url          TEXT NOT NULL,           -- dạng chuẩn https://www.facebook.com/groups/<id hoặc slug>/
    name         TEXT NOT NULL DEFAULT '',
    scanned_at   INTEGER NOT NULL,
    PRIMARY KEY (profile_id, url)
);

CREATE TABLE IF NOT EXISTS fb_poster_comments (
    key          TEXT PRIMARY KEY,        -- author_id + '\\u0000' + post_url + '\\u0000' + text, như keyOf của FB Poster
    profile_id   TEXT NOT NULL,           -- profile đã thu
    post_url     TEXT NOT NULL,
    author_id    TEXT NOT NULL DEFAULT '',
    author_name  TEXT NOT NULL DEFAULT '',
    author_url   TEXT NOT NULL DEFAULT '',
    text         TEXT NOT NULL DEFAULT '',
    commented_at TEXT NOT NULL DEFAULT '', -- chữ thời gian Facebook hiển thị, ví dụ "2 giờ"
    collected_at INTEGER NOT NULL
    -- commented_at_ms: thêm bằng migration (26.24)
);
CREATE INDEX IF NOT EXISTS idx_fb_poster_comments_post ON fb_poster_comments(post_url);

CREATE TABLE IF NOT EXISTS fb_poster_schedules (
    id            TEXT PRIMARY KEY,          -- uuid
    name          TEXT NOT NULL,             -- người dùng đặt, mặc định 40 ký tự đầu nội dung
    kind          TEXT NOT NULL,             -- 'once' | 'recurring'
    params_json   TEXT NOT NULL,             -- StartParams kiểu 'post'; mediaPaths là tên tệp trong thư mục media của lịch
    run_at        INTEGER DEFAULT NULL,      -- 'once': mốc giờ chạy (ms)
    days          TEXT NOT NULL DEFAULT '',  -- 'recurring': danh sách thứ "1,3,5" (0 = Chủ nhật)
    time          TEXT NOT NULL DEFAULT '',  -- 'recurring': "HH:mm"
    enabled       INTEGER NOT NULL DEFAULT 1,
    draft         INTEGER NOT NULL DEFAULT 0, -- 1 = bản nháp: luôn enabled = 0, next_run_at = NULL, không bao giờ tự chạy
    next_run_at   INTEGER DEFAULT NULL,      -- null khi đã xong ('once') hoặc tạm dừng
    last_run_id   TEXT DEFAULT NULL,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fb_poster_schedules_next ON fb_poster_schedules(enabled, next_run_at);

CREATE TABLE IF NOT EXISTS fb_poster_login_state (
    profile_id    TEXT PRIMARY KEY,
    state         TEXT NOT NULL,            -- ok / logged_out / checkpoint
    checked_at    INTEGER NOT NULL,         -- lần cuối xác định được trạng thái (ms epoch)
    source        TEXT NOT NULL,            -- 'check' (kiểm tra) hoặc 'run' (lượt đăng)
    last_error    TEXT,                     -- lỗi của lần kiểm tra gần nhất nếu không xác định được
    last_error_at INTEGER
);
-- Theo dõi bài đã đăng: docs/specs/2026-10-19-post-performance.md mục 2
CREATE TABLE IF NOT EXISTS fb_poster_post_tracking (
    result_id         INTEGER PRIMARY KEY,   -- fb_poster_results.id
    run_id            TEXT NOT NULL,
    schedule_id       TEXT DEFAULT NULL,
    profile_id        TEXT NOT NULL,
    group_url         TEXT NOT NULL,
    group_id          TEXT NOT NULL DEFAULT '',
    post_id           TEXT NOT NULL DEFAULT '',
    post_url          TEXT DEFAULT NULL,
    posted_at         INTEGER NOT NULL,
    text_head         TEXT NOT NULL DEFAULT '',
    link_status       TEXT NOT NULL,         -- known | missing | pending_approval | not_found
    removed_suspected INTEGER NOT NULL DEFAULT 0,
    last_seen_at      INTEGER DEFAULT NULL,
    last_checked_at   INTEGER DEFAULT NULL,
    check_count       INTEGER NOT NULL DEFAULT 0,
    next_check_at     INTEGER DEFAULT NULL,
    stats_done        TEXT NOT NULL DEFAULT '' -- nhãn mốc đo đã làm, ví dụ "60m,1440m"
);
CREATE INDEX IF NOT EXISTS idx_fb_poster_post_tracking_next ON fb_poster_post_tracking(next_check_at);
CREATE INDEX IF NOT EXISTS idx_fb_poster_post_tracking_pair ON fb_poster_post_tracking(profile_id, group_url);

CREATE TABLE IF NOT EXISTS fb_poster_post_stats (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    result_id   INTEGER NOT NULL,
    captured_at INTEGER NOT NULL,
    reactions   INTEGER DEFAULT NULL,
    comments    INTEGER DEFAULT NULL,
    shares      INTEGER DEFAULT NULL
);
CREATE INDEX IF NOT EXISTS idx_fb_poster_post_stats_result ON fb_poster_post_stats(result_id, captured_at);

-- Chiến dịch: docs/specs/2026-10-20-campaigns-variants.md mục 2
CREATE TABLE IF NOT EXISTS fb_poster_campaigns (
    id         TEXT PRIMARY KEY,           -- uuid
    name       TEXT NOT NULL,
    goal       TEXT NOT NULL DEFAULT '',
    status     TEXT NOT NULL DEFAULT 'active', -- 'active' | 'paused' | 'archived'
    start_at   INTEGER DEFAULT NULL,
    end_at     INTEGER DEFAULT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- Khách tiềm năng từ bình luận: docs/specs/2026-10-20-group-scores-times-leads.md mục 6.3
CREATE TABLE IF NOT EXISTS fb_poster_leads (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    comment_key     TEXT NOT NULL UNIQUE,    -- fb_poster_comments.key, chống trùng
    post_url        TEXT NOT NULL,
    result_id       INTEGER DEFAULT NULL,
    group_url       TEXT NOT NULL DEFAULT '',
    campaign_id     TEXT DEFAULT NULL,
    variant         TEXT NOT NULL DEFAULT '',
    profile_id      TEXT NOT NULL,
    author_id       TEXT NOT NULL DEFAULT '',
    author_name     TEXT NOT NULL DEFAULT '',
    author_url      TEXT NOT NULL DEFAULT '',
    text            TEXT NOT NULL DEFAULT '',
    commented_at_ms INTEGER DEFAULT NULL,
    matched         TEXT NOT NULL DEFAULT '', -- từ khoá khớp, cách nhau dấu phẩy; có thể có 'phone'
    ai_intent       TEXT DEFAULT NULL,
    ai_score        INTEGER DEFAULT NULL,
    ai_reason       TEXT DEFAULT NULL,
    status          TEXT NOT NULL DEFAULT 'new', -- new | contacted | won | ignored
    note            TEXT NOT NULL DEFAULT '',
    detected_at     INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fb_poster_leads_status ON fb_poster_leads(status, detected_at);
CREATE INDEX IF NOT EXISTS idx_fb_poster_leads_campaign ON fb_poster_leads(campaign_id);
`;

// Chạy sau FB_POSTER_SCHEMA_SQL, từng câu trong try/catch (cột đã có thì ALTER ném lỗi, bỏ qua).
export const FB_POSTER_MIGRATIONS: string[] = [
    'ALTER TABLE fb_poster_runs ADD COLUMN schedule_id TEXT DEFAULT NULL',
    'ALTER TABLE fb_poster_schedules ADD COLUMN draft INTEGER NOT NULL DEFAULT 0',
    "ALTER TABLE fb_poster_results ADD COLUMN error_code TEXT NOT NULL DEFAULT ''",
    'ALTER TABLE fb_poster_results ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1',
    // 26.22: chiến dịch và biến thể. Index tạo sau ALTER vì DB cũ chưa có cột.
    'ALTER TABLE fb_poster_schedules ADD COLUMN campaign_id TEXT DEFAULT NULL',
    'ALTER TABLE fb_poster_runs ADD COLUMN campaign_id TEXT DEFAULT NULL',
    "ALTER TABLE fb_poster_results ADD COLUMN variant TEXT NOT NULL DEFAULT ''",
    'ALTER TABLE fb_poster_post_tracking ADD COLUMN campaign_id TEXT DEFAULT NULL',
    "ALTER TABLE fb_poster_post_tracking ADD COLUMN variant TEXT NOT NULL DEFAULT ''",
    'CREATE INDEX IF NOT EXISTS idx_fb_poster_schedules_campaign ON fb_poster_schedules(campaign_id)',
    'CREATE INDEX IF NOT EXISTS idx_fb_poster_post_tracking_campaign ON fb_poster_post_tracking(campaign_id)',
    // 26.24: thu bình luận tự động và khách tiềm năng. Index tạo sau ALTER.
    'ALTER TABLE fb_poster_comments ADD COLUMN commented_at_ms INTEGER DEFAULT NULL',
    "ALTER TABLE fb_poster_post_tracking ADD COLUMN comments_done TEXT NOT NULL DEFAULT ''",
    'ALTER TABLE fb_poster_post_tracking ADD COLUMN next_comment_at INTEGER DEFAULT NULL',
    'CREATE INDEX IF NOT EXISTS idx_fb_poster_post_tracking_next_comment ON fb_poster_post_tracking(next_comment_at)',
    'ALTER TABLE fb_poster_schedules ADD COLUMN revision INTEGER NOT NULL DEFAULT 1',
    "ALTER TABLE fb_poster_schedules ADD COLUMN authority_kind TEXT NOT NULL DEFAULT 'owner' CHECK (authority_kind IN ('owner','autonomy'))",
];

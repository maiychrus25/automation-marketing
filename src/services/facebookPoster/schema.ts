// Nguồn: docs/specs/2026-10-03-facebook-poster.md mục 5. Chạy lại nhiều lần được (IF NOT EXISTS).
export const FB_POSTER_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS fb_poster_runs (
    id           TEXT PRIMARY KEY,          -- uuid
    kind         TEXT NOT NULL,             -- 'post' | 'join' | 'scan_groups' | 'collect_comments'
    mode         TEXT NOT NULL DEFAULT '',  -- 'group' | 'page' với kind='post', rỗng với kind khác
    params_json  TEXT NOT NULL,             -- tham số việc, KHÔNG chứa mật khẩu proxy
    status       TEXT NOT NULL,             -- 'running' | 'done' | 'cancelled' | 'failed'
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
`;

// Chạy sau FB_POSTER_SCHEMA_SQL, từng câu trong try/catch (cột đã có thì ALTER ném lỗi, bỏ qua).
export const FB_POSTER_MIGRATIONS: string[] = [
    'ALTER TABLE fb_poster_runs ADD COLUMN schedule_id TEXT DEFAULT NULL',
    'ALTER TABLE fb_poster_schedules ADD COLUMN draft INTEGER NOT NULL DEFAULT 0',
];

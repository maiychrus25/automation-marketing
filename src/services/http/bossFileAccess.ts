/**
 * Pure rules that keep employee file uploads and file paths inside the boss's media folders.
 * Only imports `path`, so it stays trivially testable (the real `fs.realpathSync` is injected).
 */
import * as path from 'path';

/** Params of a proxied boss command that hold a local file path (plus the array field `filePaths`). */
export const PROXY_FILE_PATH_FIELDS: readonly string[] = ['filePath', 'videoPath', 'thumbPath', 'voicePath', 'avatarPath', 'mediaPath', 'file_path'];
/** Fields whose value is an array of disk paths (`images` = campaign template blocks, the boss reads each file when it sends). */
const PROXY_FILE_PATH_LIST_FIELDS: readonly string[] = ['filePaths', 'images'];
/** Fields that hold JSON text whose content is scanned too (a campaign template saved as a string). */
const JSON_TEXT_FIELDS: readonly string[] = ['template_message'];

/** Last path segment of an employee-supplied file name (either slash style), or null when it is not a usable name. */
export function safeUploadName(raw: unknown): string | null {
    if (typeof raw !== 'string' || raw.includes('\0')) return null;
    const name = path.basename(raw.replace(/\\/g, '/'));
    if (!name || name === '.' || name === '..' || name.length > 255) return null;
    return name;
}

/** True when `target` is `root` or below it. Both must already be `path.resolve`d; a sibling sharing the prefix is outside. */
export function isInside(root: string, target: string): boolean {
    return target === root || target.startsWith(root + path.sep);
}

/** Account folder (first directory under `mediaRoot`) of an absolute path; `thumb/` and `avatar/` are skipped. Null when outside `mediaRoot`. */
export function mediaAccountOf(mediaRoot: string, absolutePath: string): string | null {
    const root = path.resolve(mediaRoot);
    const target = path.resolve(absolutePath);
    if (target === root || !isInside(root, target)) return null;
    const parts = target.slice(root.length + 1).split(path.sep);
    const first = parts[0] === 'thumb' || parts[0] === 'avatar' ? parts[1] : parts[0];
    return first || null;
}

export interface ProxyFileContext {
    /** Every boss media folder a file may come from (each still limited to the allowed accounts' sub-folders). */
    mediaRoots: readonly string[];
    uploadsRoot: string;
    allowed: readonly string[];
    /** `fs.realpathSync`; throws when the path does not exist. */
    realpath: (p: string) => string;
    /** The employee holds the `erp` module: a `file_path` may name a file already in `<media>/erp/tasks/` (re-saving a task keeps its attachments). */
    allowErpTaskFiles?: boolean;
    /** Turns a stored relative path ("media/erp/tasks/<id>/a.png") into an absolute one; without it a relative `file_path` is refused. */
    resolveStored?: (p: string) => string;
}

export type ProxyFileCheck = { ok: true } | { ok: false; code: 'PATH_FORBIDDEN' | 'ACCOUNT_FORBIDDEN' };

const MAX_DEPTH = 6;
/** Key of an ERP task attachment: the only one that may name a file already stored in `erp/tasks/`. */
const STORED_ATTACHMENT_KEY = 'file_path';

interface FilePathValue { value: unknown; stored: boolean }

/** Every value under a file-path key at any depth; false when the params nest deeper than MAX_DEPTH (fail closed). */
function collectFilePathValues(node: unknown, depth: number, out: FilePathValue[]): boolean {
    const isPlain = (v: unknown) => !!v && typeof v === 'object' && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
    // Array elements come through Object.entries with numeric keys, so containers inside arrays are walked too.
    if (!Array.isArray(node) && !isPlain(node)) return true; // strings, numbers, class instances: nothing to look into
    if (depth > MAX_DEPTH) return false;
    for (const [key, value] of Object.entries(node as object)) {
        if (value === undefined || value === null) continue;
        if (PROXY_FILE_PATH_FIELDS.includes(key) || PROXY_FILE_PATH_LIST_FIELDS.includes(key)) {
            const stored = key === STORED_ATTACHMENT_KEY;
            if (Array.isArray(value)) out.push(...value.map((v) => ({ value: v, stored })));
            else out.push({ value, stored });
        } else if (JSON_TEXT_FIELDS.includes(key) && typeof value === 'string') {
            let parsed: unknown;
            try { parsed = JSON.parse(value); } catch { continue; } // plain text is a message, not a template
            if (!collectFilePathValues(parsed, depth + 1, out)) return false;
        } else if (!collectFilePathValues(value, depth + 1, out)) {
            return false;
        }
    }
    return true;
}

/** Every file path anywhere in the params must, after following symlinks, sit in the uploads folder or in a media folder of an allowed account. */
export function checkProxyFilePaths(params: unknown, ctx: ProxyFileContext): ProxyFileCheck {
    const values: FilePathValue[] = [];
    if (!collectFilePathValues(params, 0, values)) return { ok: false, code: 'PATH_FORBIDDEN' };
    if (values.length === 0) return { ok: true };

    const rootOf = (p: string): string => {
        try { return ctx.realpath(path.resolve(p)); } catch { return path.resolve(p); }
    };
    const mediaRoots = ctx.mediaRoots.map(rootOf);
    const uploadsRoot = rootOf(ctx.uploadsRoot);
    const erpTaskRoots = ctx.allowErpTaskFiles ? mediaRoots.map((r) => path.join(r, 'erp', 'tasks')) : [];
    for (const { value: raw, stored } of values) {
        if (typeof raw !== 'string' || !raw || raw.includes('\0')) return { ok: false, code: 'PATH_FORBIDDEN' };
        const value = stored && !path.isAbsolute(raw) && ctx.resolveStored ? ctx.resolveStored(raw) : raw;
        if (!path.isAbsolute(value)) return { ok: false, code: 'PATH_FORBIDDEN' };
        let real: string;
        try {
            real = ctx.realpath(path.resolve(value));
        } catch {
            return { ok: false, code: 'PATH_FORBIDDEN' };
        }
        if (isInside(uploadsRoot, real)) continue;
        if (stored && erpTaskRoots.some((r) => isInside(r, real))) continue;
        const root = mediaRoots.find((r) => isInside(r, real));
        if (!root) return { ok: false, code: 'PATH_FORBIDDEN' };
        const account = mediaAccountOf(root, real);
        if (!account || !ctx.allowed.includes(account)) return { ok: false, code: 'ACCOUNT_FORBIDDEN' };
    }
    return { ok: true };
}

const SERVICE_ACCOUNT_KEY = 'serviceAccountPath';
/** Fields of a workflow that may hold its nodes as JSON text. */
const WORKFLOW_JSON_TEXT_FIELDS: readonly string[] = ['nodes', 'nodes_json'];

/** Every non-empty `serviceAccountPath` string in a workflow (nodes at any depth; node list may be JSON text). Null when nested past MAX_DEPTH (fail closed). */
export function serviceAccountPathsOf(workflow: unknown, depth = 0): string[] | null {
    if (!workflow || typeof workflow !== 'object') return [];
    if (depth > MAX_DEPTH) return null;
    const found: string[] = [];
    const add = (more: string[] | null): boolean => { if (more) found.push(...more); return more !== null; };
    for (const [key, value] of Object.entries(workflow as object)) {
        if (key === SERVICE_ACCOUNT_KEY && typeof value === 'string' && value) {
            found.push(value);
        } else if (WORKFLOW_JSON_TEXT_FIELDS.includes(key) && typeof value === 'string') {
            let parsed: unknown;
            try { parsed = JSON.parse(value); } catch { continue; } // not JSON: nothing to scan
            if (!add(serviceAccountPathsOf(parsed, depth + 1))) return null;
        } else if (!add(serviceAccountPathsOf(value, depth + 1))) {
            return null;
        }
    }
    return found;
}

/** An employee may keep a service-account key path the stored workflow already has, but not add or change one. */
export function checkServiceAccountPaths(submitted: unknown, stored: unknown): { ok: true } | { ok: false; code: 'PATH_FORBIDDEN' } {
    const existing = new Set(serviceAccountPathsOf(stored) ?? []);
    const wanted = serviceAccountPathsOf(submitted);
    return wanted && wanted.every((p) => existing.has(p)) ? { ok: true } : { ok: false, code: 'PATH_FORBIDDEN' };
}

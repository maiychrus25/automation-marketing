import * as fs from 'fs';
import * as path from 'path';

/** Chromium lock files that belong to the old process and must not be carried over. */
const SINGLETON_FILES = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];

export interface LegacyMigrationOptions {
    /** `<appData>/AHV Connect` */
    legacyDir: string;
    /** `<appData>/MaiHub` (the current userData path) */
    newDir: string;
    isAlive?: (pid: number) => boolean;
    rename?: (from: string, to: string) => void;
}

export type LegacyMigrationResult =
    | { status: 'skipped' | 'migrated' | 'blocked' }
    | { status: 'failed'; error: string };

export function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err: any) {
        return err?.code === 'EPERM';
    }
}

/** Linux/macOS: Chromium writes SingletonLock as a symlink "<hostname>-<pid>". */
function legacyInstancePid(legacyDir: string): number | null {
    try {
        const target = fs.readlinkSync(path.join(legacyDir, 'SingletonLock'));
        const pid = Number(target.slice(target.lastIndexOf('-') + 1));
        return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch {
        return null;
    }
}

/**
 * One-time move of the AHV Connect data folder into MaiHub's.
 * Call before requestSingleInstanceLock(): the new userData must not exist yet.
 */
export function migrateLegacyUserData(options: LegacyMigrationOptions): LegacyMigrationResult {
    const { legacyDir, newDir, isAlive = isProcessAlive, rename = fs.renameSync } = options;
    if (fs.existsSync(newDir) || !fs.existsSync(legacyDir)) return { status: 'skipped' };

    const pid = legacyInstancePid(legacyDir);
    if (pid !== null && pid !== process.pid && isAlive(pid)) return { status: 'blocked' };

    try {
        rename(legacyDir, newDir);
    } catch (err: any) {
        return { status: 'failed', error: err?.message || String(err) };
    }
    for (const file of SINGLETON_FILES) {
        try { fs.rmSync(path.join(newDir, file), { force: true }); } catch {}
    }
    return { status: 'migrated' };
}

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { migrateLegacyUserData, isProcessAlive } from '../../services/app/legacyDataMigration';

describe('migrateLegacyUserData', () => {
    let root: string; let legacyDir: string; let newDir: string;
    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-test-'));
        legacyDir = path.join(root, 'AHV Connect'); newDir = path.join(root, 'MaiHub');
    });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    const seedLegacy = () => {
        fs.mkdirSync(path.join(legacyDir, 'media'), { recursive: true });
        fs.writeFileSync(path.join(legacyDir, 'deplao-tool.db'), 'db');
        fs.writeFileSync(path.join(legacyDir, 'media', 'a.jpg'), 'img');
    };

    it('skips when the legacy directory does not exist', () => {
        expect(migrateLegacyUserData({ legacyDir, newDir })).toEqual({ status: 'skipped' });
        expect(fs.existsSync(newDir)).toBe(false);
    });

    it('no-op when new dir exists, even if the legacy one is still there', () => {
        seedLegacy(); fs.mkdirSync(newDir);
        expect(migrateLegacyUserData({ legacyDir, newDir })).toEqual({ status: 'skipped' });
        expect(fs.existsSync(legacyDir)).toBe(true);
    });

    it('moves the legacy directory and drops its singleton lock files', () => {
        seedLegacy();
        for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) fs.writeFileSync(path.join(legacyDir, f), '');
        expect(migrateLegacyUserData({ legacyDir, newDir, isAlive: () => false })).toEqual({ status: 'migrated' });
        expect(fs.existsSync(legacyDir)).toBe(false);
        expect(fs.readFileSync(path.join(newDir, 'deplao-tool.db'), 'utf8')).toBe('db');
        expect(fs.readFileSync(path.join(newDir, 'media', 'a.jpg'), 'utf8')).toBe('img');
        for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) expect(fs.existsSync(path.join(newDir, f))).toBe(false);
    });

    it('refuses while legacy instance is alive (SingletonLock symlink to a live pid)', () => {
        seedLegacy();
        fs.symlinkSync(`${os.hostname()}-4242`, path.join(legacyDir, 'SingletonLock'));
        expect(migrateLegacyUserData({ legacyDir, newDir, isAlive: (pid) => pid === 4242 })).toEqual({ status: 'blocked' });
        expect(fs.existsSync(legacyDir)).toBe(true);
        expect(fs.existsSync(newDir)).toBe(false);
    });

    it('migrates when the SingletonLock points at a dead pid', () => {
        seedLegacy();
        fs.symlinkSync(`${os.hostname()}-4242`, path.join(legacyDir, 'SingletonLock'));
        expect(migrateLegacyUserData({ legacyDir, newDir, isAlive: () => false }).status).toBe('migrated');
    });

    it('reports failure when rename throws and leaves the legacy directory intact', () => {
        seedLegacy();
        const result = migrateLegacyUserData({ legacyDir, newDir, isAlive: () => false, rename: () => { throw new Error('EPERM: locked'); } });
        expect(result).toEqual({ status: 'failed', error: 'EPERM: locked' });
        expect(fs.existsSync(legacyDir)).toBe(true);
        expect(fs.existsSync(newDir)).toBe(false);
    });
});

describe('isProcessAlive', () => {
    it('is true for this process and false for an impossible pid', () => {
        expect(isProcessAlive(process.pid)).toBe(true);
        expect(isProcessAlive(2 ** 22 + 1)).toBe(false);
    });
});

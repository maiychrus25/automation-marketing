const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)$/;

/** Parses "26.10.0" or "v26.10.0". Pre-release tags (e.g. "26.11.0-beta.1") are not supported and return null. */
function parseVersion(value: string): [number, number, number] | null {
    const match = VERSION_RE.exec(String(value || '').trim());
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** True only when `remote` is a valid version strictly newer than `current`, compared number by number. */
export function isNewerVersion(remote: string, current: string): boolean {
    const a = parseVersion(remote);
    const b = parseVersion(current);
    if (!a || !b) return false;
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) return a[i] > b[i];
    }
    return false;
}

export interface BrowserEnginePackage {
    url: string;
    sha256: string;
    /** Path of the browser executable, relative to the extracted archive root. */
    executable: string;
}

export interface BrowserEngineConfig {
    version: string;
    packages: Partial<Record<NodeJS.Platform, BrowserEnginePackage>>;
}

const RELEASE_BASE = 'https://github.com/adryfish/fingerprint-chromium/releases/download/148.0.7778.215';

/** Pinned antidetect Chromium build. Changing the engine means changing only this file and buildLaunchArgs(). */
export const BROWSER_ENGINE: BrowserEngineConfig = {
    version: '148.0.7778.215',
    packages: {
        win32: {
            url: `${RELEASE_BASE}/ungoogled-chromium_148.0.7778.215-1.1_windows_x64.zip`,
            sha256: '9ef3f471b7a6641b4224532522b29141ce3746e27d55788d88e2fd951f362579',
            executable: 'ungoogled-chromium_148.0.7778.215-1.1_windows_x64/chrome.exe',
        },
        linux: {
            url: `${RELEASE_BASE}/ungoogled-chromium-148.0.7778.215-1-x86_64_linux.tar.xz`,
            sha256: '70d239830332e5820aa34dfcb284161cac0429eee25da642830afe04bda717f4',
            executable: 'ungoogled-chromium-148.0.7778.215-1-x86_64_linux/chrome',
        },
    },
};

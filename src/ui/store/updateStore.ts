import { create } from 'zustand';
import type { UpdateState } from '../../services/update/UpdateService';
import { toStorePatch } from './updateMapping';

export interface UpdateInfo {
  version: string;
  releaseNotes?: string | Array<{ note: string }>;
}

export interface ProgressInfo {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

export interface UpdateError {
  message: string;
  platform?: string;
}

type UpdateStatus = 'idle' | 'available' | 'downloading' | 'downloaded' | 'error';

interface UpdateStore {
  status: UpdateStatus;
  updateInfo: UpdateInfo | null;
  progress: ProgressInfo | null;
  error: UpdateError | null;
  showPopup: boolean;
  platform: string;
  /** Windows/AppImage install in place; otherwise "Tải bản mới" opens releaseUrl. */
  canInstall: boolean;
  releaseUrl: string;
  /** Version closed with "Để sau": stays visible in the Sidebar but does not pop up again. */
  dismissedVersion: string | null;
  /** Error from the last download/install request (e.g. a posting job is running). */
  actionError: string | null;

  setStatus: (status: UpdateStatus) => void;
  setUpdateInfo: (info: UpdateInfo | null) => void;
  setProgress: (progress: ProgressInfo | null) => void;
  setError: (error: UpdateError | null) => void;
  setShowPopup: (show: boolean) => void;
  setPlatform: (platform: string) => void;

  applyState: (state: UpdateState) => void;
  openUpdatePopup: () => void;
  startDownload: () => Promise<void>;
  installUpdate: () => Promise<void>;
  dismiss: () => void;
  hasUpdate: () => boolean;
}

export const useUpdateStore = create<UpdateStore>((set, get) => ({
  status: 'idle',
  updateInfo: null,
  progress: null,
  error: null,
  showPopup: false,
  platform: (window as any).electronAPI?.platform || 'win32',
  canInstall: false,
  releaseUrl: '',
  dismissedVersion: null,
  actionError: null,

  setStatus: (status) => set({ status }),
  setUpdateInfo: (updateInfo) => set({ updateInfo }),
  setProgress: (progress) => set({ progress }),
  setError: (error) => set({ error }),
  setShowPopup: (showPopup) => set({ showPopup }),
  setPlatform: (platform) => set({ platform }),

  applyState: (state) => set({ ...toStorePatch(state, get().dismissedVersion), actionError: null }),

  openUpdatePopup: () => set({ showPopup: true, actionError: null }),

  // The main process drives status through update:state events; these only report request errors.
  startDownload: async () => {
    set({ actionError: null });
    try {
      const res = await (window as any).electronAPI?.update?.download();
      if (res && !res.success) set({ actionError: res.error || 'Không tải được bản cập nhật' });
    } catch (err: any) {
      set({ actionError: err?.message || 'Không tải được bản cập nhật' });
    }
  },

  installUpdate: async () => {
    set({ actionError: null });
    try {
      const res = await (window as any).electronAPI?.update?.install();
      if (res && !res.success) set({ actionError: res.error || 'Không cài được bản cập nhật' });
    } catch (err: any) {
      set({ actionError: err?.message || 'Không cài được bản cập nhật' });
    }
  },

  dismiss: () => {
    set({ showPopup: false, actionError: null, dismissedVersion: get().updateInfo?.version ?? get().dismissedVersion });
  },

  hasUpdate: () => {
    const { status, updateInfo } = get();
    return !!updateInfo && status === 'available';
  },
}));


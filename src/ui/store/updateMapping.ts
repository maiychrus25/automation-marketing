import type { UpdateState } from '../../services/update/UpdateService';

/** Store fields derived from the main-process UpdateState. Kept pure (no window/zustand) so it is unit-tested. */
export interface UpdateStorePatch {
  status: 'idle' | 'available' | 'downloading' | 'downloaded' | 'error';
  updateInfo: { version: string; releaseNotes?: string } | null;
  progress: { percent: number; transferred: number; total: number; bytesPerSecond: number } | null;
  error: { message: string } | null;
  showPopup: boolean;
  canInstall?: boolean;
  releaseUrl?: string;
}

/**
 * Maps a main-process UpdateState to update-store fields.
 * `dismissedVersion` is the version the user closed with "Để sau": it stays known (Sidebar dot) but does not pop up again.
 */
export function toStorePatch(state: UpdateState, dismissedVersion: string | null): UpdateStorePatch {
  switch (state.status) {
    case 'available':
      return {
        status: 'available',
        updateInfo: { version: state.version, releaseNotes: state.notes },
        canInstall: state.canInstall,
        releaseUrl: state.url,
        progress: null,
        error: null,
        showPopup: state.version !== dismissedVersion,
      };
    case 'downloading':
      return {
        status: 'downloading',
        updateInfo: { version: state.version },
        progress: { percent: state.percent, transferred: 0, total: 0, bytesPerSecond: 0 },
        error: null,
        showPopup: true,
      };
    case 'downloaded':
      return { status: 'downloaded', updateInfo: { version: state.version }, progress: null, error: null, showPopup: true };
    case 'error':
      return {
        status: 'error',
        updateInfo: state.version ? { version: state.version } : null,
        progress: null,
        error: { message: state.message },
        showPopup: true,
      };
    default:
      return { status: 'idle', updateInfo: null, progress: null, error: null, showPopup: false };
  }
}

import HttpClientService from './HttpClientService';
import WorkspaceManager from '../../utils/WorkspaceManager';
import Logger from '../../utils/Logger';
import { BrowserWindow } from 'electron';

interface WorkspaceClient {
    workspaceId: string;
    service: HttpClientService;
}

interface WorkspaceSnapshot {
    permissions?: Array<{ module: string; can_access: boolean }>;
    assignedAccounts?: string[];
    assigned_profiles?: string[];
    erpRole?: string;
    erpExtraJson?: string;
    employeesData?: any[];
    accountsData?: any[];
    onlineAccounts?: string[];
    updatedAt: number;
    source: 'initialState' | 'accountAccessUpdate';
}

/**
 * HttpConnectionManager - manages one HttpClientService instance per workspace.
 * Replaces SocketConnectionManager - uses HTTP instead of Socket.IO.
 */
class HttpConnectionManager {
    private static instance: HttpConnectionManager;
    private clients: Map<string, WorkspaceClient> = new Map();
    private snapshots: Map<string, WorkspaceSnapshot> = new Map();
    private mainWindow: BrowserWindow | null = null;
    private connecting: Set<string> = new Set();
    private healthCheckTimer: ReturnType<typeof setInterval> | null = null;

    public static getInstance(): HttpConnectionManager {
        if (!HttpConnectionManager.instance) {
            HttpConnectionManager.instance = new HttpConnectionManager();
        }
        return HttpConnectionManager.instance;
    }

    public setMainWindow(win: BrowserWindow): void {
        this.mainWindow = win;
    }

    public async connect(
        workspaceId: string,
        bossUrl: string,
        token: string,
        options?: {
            onInitialState?: (data: any) => void;
            onAccountAccessUpdate?: (data: any) => void;
            onSyncProgress?: (phase: string, percent: number) => void;
        }
    ): Promise<{ success: boolean; error?: string }> {
        if (this.connecting.has(workspaceId)) {
            Logger.log(`[HttpConnectionManager] Skip connect for "${workspaceId}": already in progress`);
            return { success: true };
        }

        if (this.clients.has(workspaceId)) {
            Logger.warn(`[HttpConnectionManager] ⚠️ connect() replacing EXISTING client for "${workspaceId}" - old SSE will be destroyed`);
            this.clients.get(workspaceId)!.service.disconnect();
            this.clients.delete(workspaceId);
        }

        this.connecting.add(workspaceId);

        const service = new HttpClientService();
        service.setWorkspaceId(workspaceId);
        this.clients.set(workspaceId, { workspaceId, service });

        service.setOnStatusChange((connected: boolean, latency: number) => {
            this.sendToRenderer('workspace:connectionStatus', { workspaceId, connected, latency, socketConnected: service.isSocketConnected() });
        });

        service.setOnInitialState((data: any) => {
            const snapshot: WorkspaceSnapshot = {
                permissions: data?.permissions || [],
                assignedAccounts: data?.assignedAccounts || [],
                assigned_profiles: data?.assigned_profiles || [],
                erpRole: data?.erpRole || '',
                erpExtraJson: data?.erpExtraJson || '',
                employeesData: data?.employeesData || [],
                accountsData: data?.accountsData || [],
                onlineAccounts: data?.onlineAccounts || [],
                updatedAt: Date.now(),
                source: 'initialState',
            };
            this.snapshots.set(workspaceId, snapshot);
            Logger.log(`[HttpConnectionManager] initialState → workspace=${workspaceId} assigned=${snapshot.assignedAccounts?.length || 0}`);
            this.sendToRenderer('workspace:initialState', { workspaceId, ...data });
            options?.onInitialState?.(data);
        });

        // Quyền hoặc hồ sơ đổi: không qua bộ nén 60 giây của initialState; cập nhật cả snapshot lưu để lần phát lại không đưa lại danh sách cũ.
        service.setOnPermissionUpdate((data: any) => {
            const previous = this.snapshots.get(workspaceId);
            if (previous) {
                this.snapshots.set(workspaceId, {
                    ...previous,
                    permissions: data?.permissions || previous.permissions,
                    assigned_profiles: data?.assigned_profiles || [],
                    erpRole: data?.erpRole ?? previous.erpRole,
                    erpExtraJson: data?.erpExtraJson ?? previous.erpExtraJson,
                    employeesData: data?.employeesData || previous.employeesData,
                    updatedAt: Date.now(),
                });
            }
            this.sendToRenderer('workspace:permissionUpdate', { workspaceId, ...data });
        });

        service.setOnAccountAccessUpdate((data: any) => {
            const previous = this.snapshots.get(workspaceId);
            const snapshot: WorkspaceSnapshot = {
                permissions: previous?.permissions || [],
                assignedAccounts: data?.assignedAccounts || [],
                assigned_profiles: previous?.assigned_profiles || [],
                erpRole: previous?.erpRole || '',
                erpExtraJson: previous?.erpExtraJson || '',
                employeesData: previous?.employeesData || [],
                accountsData: data?.accountsData || [],
                onlineAccounts: previous?.onlineAccounts || [],
                updatedAt: Date.now(),
                source: 'accountAccessUpdate',
            };
            this.snapshots.set(workspaceId, snapshot);
            this.sendToRenderer('workspace:accountAccessUpdate', { workspaceId, ...data });
            options?.onAccountAccessUpdate?.(data);
        });

        // Socket.IO tự động reconnect + catch-up (EventBuffer),
        // không cần refresh snapshot khi reconnect nữa.

        const result = await service.connect(bossUrl, token);
        this.connecting.delete(workspaceId);

        if (result.success) {
            Logger.log(`[HttpConnectionManager] ✅ Connected workspace "${workspaceId}"`);
        } else {
            const current = this.clients.get(workspaceId);
            if (current?.service === service) {
                this.clients.delete(workspaceId);
            }
            Logger.warn(`[HttpConnectionManager] ❌ Failed: ${result.error}`);
        }

        return result;
    }

    public disconnect(workspaceId: string): void {
        const client = this.clients.get(workspaceId);
        if (client) {
            client.service.disconnect();
            this.clients.delete(workspaceId);
            this.sendToRenderer('workspace:connectionStatus', { workspaceId, connected: false, latency: 0 });
        }
    }

    /** Máy vừa thức dậy: mọi workspace nhân viên đang nối kiểm tra lại. Máy boss không có client nên không làm gì. */
    public notifySystemResume(): void {
        for (const { service } of this.clients.values()) {
            try { service.notifySystemResume(); } catch (err: any) { Logger.warn(`[HttpConnectionManager] resume error: ${err.message}`); }
        }
    }

    public disconnectAll(): void {
        for (const [wsId] of this.clients) this.disconnect(wsId);
    }

    public isConnected(workspaceId: string): boolean {
        if (this.connecting.has(workspaceId)) return true;
        return this.clients.get(workspaceId)?.service.isConnected() ?? false;
    }

    public getStatus(workspaceId: string): { connected: boolean; bossUrl: string; latency: number } {
        const client = this.clients.get(workspaceId);
        if (!client) {
            if (this.connecting.has(workspaceId)) return { connected: true, bossUrl: '', latency: 0 };
            return { connected: false, bossUrl: '', latency: 0 };
        }
        return client.service.getStatus();
    }

    public getAllStatuses(): Record<string, { connected: boolean; bossUrl: string; latency: number }> {
        const result: Record<string, { connected: boolean; bossUrl: string; latency: number }> = {};
        for (const [wsId, client] of this.clients) result[wsId] = client.service.getStatus();
        return result;
    }

    public getServiceForWorkspace(workspaceId: string): HttpClientService | null {
        return this.clients.get(workspaceId)?.service ?? null;
    }

    public getSnapshot(workspaceId: string): WorkspaceSnapshot | null {
        return this.snapshots.get(workspaceId) ?? null;
    }

    public replaySnapshotToRenderer(workspaceId: string): boolean {
        const snapshot = this.snapshots.get(workspaceId);
        if (!snapshot) return false;

        this.sendToRenderer('workspace:initialState', {
            workspaceId,
            permissions: snapshot.permissions || [],
            assignedAccounts: snapshot.assignedAccounts || [],
            assigned_profiles: snapshot.assigned_profiles || [],
            erpRole: snapshot.erpRole || '',
            erpExtraJson: snapshot.erpExtraJson || '',
            employeesData: snapshot.employeesData || [],
            accountsData: snapshot.accountsData || [],
            onlineAccounts: snapshot.onlineAccounts || [],
            replayed: true,
            replaySource: snapshot.source,
            replayedAt: Date.now(),
        });
        return true;
    }

    public async proxyAction(workspaceId: string, channel: string, params: any, timeoutMs?: number): Promise<any> {
        const client = this.clients.get(workspaceId);
        if (!client) throw new Error(`Workspace "${workspaceId}" chưa kết nối tới BOSS`);
        return client.service.proxyAction(channel, params, timeoutMs);
    }

    public async proxyActiveWorkspace(channel: string, params: any): Promise<any> {
        const ws = WorkspaceManager.getInstance().getActiveWorkspace();
        if (!ws || ws.type !== 'remote') throw new Error('Workspace đang active không phải remote workspace');
        return this.proxyAction(ws.id, channel, params);
    }

    public async connectAutoWorkspaces(): Promise<void> {
        const autoConnects = WorkspaceManager.getInstance().getAutoConnectRemotes();
        if (autoConnects.length === 0) return;

        Logger.log(`[HttpConnectionManager] Auto-connecting ${autoConnects.length} remote workspace(s)...`);
        for (const ws of autoConnects) {
            if (!ws.bossUrl || !ws.token) continue;
            if (this.isConnected(ws.id)) continue;
            try {
                await this.connect(ws.id, ws.bossUrl, ws.token);
            } catch (err: any) {
                Logger.warn(`[HttpConnectionManager] Auto-connect failed for "${ws.name}": ${err.message}`);
            }
        }
    }

    /**
     * Start periodic health check that detects dead connections and triggers reconnect.
     * Called once at app startup after connectAutoWorkspaces.
     */
    public startHealthCheck(intervalMs = 60_000): void {
        this.stopHealthCheck();
        this.healthCheckTimer = setInterval(async () => {
            const wm = WorkspaceManager.getInstance();
            for (const [wsId, client] of this.clients) {
                const status = client.service.getStatus();
                if (status.connected) continue; // Already connected - skip

                const ws = wm.getWorkspaceById(wsId);
                if (!ws || ws.type !== 'remote' || !ws.bossUrl || !ws.token) continue;

                Logger.log(`[HttpConnectionManager] Health check: "${wsId}" disconnected - attempting reconnect`);
                try {
                    await this.connect(wsId, ws.bossUrl, ws.token);
                } catch (err: any) {
                    Logger.warn(`[HttpConnectionManager] Health check reconnect failed for "${wsId}": ${err.message}`);
                }
            }
        }, intervalMs);
        Logger.log(`[HttpConnectionManager] Health check started (interval=${intervalMs}ms)`);
    }

    public stopHealthCheck(): void {
        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer);
            this.healthCheckTimer = null;
        }
    }

    private sendToRenderer(channel: string, data: any): void {
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send(channel, data);
        }
    }
}

export default HttpConnectionManager;


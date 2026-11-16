import { ipcMain } from 'electron';
import DatabaseService from '../../src/services/database/DatabaseService';
import Logger from '../../src/utils/Logger';
import { checkProxyWorks, createProxyAgent } from '../../src/utils/ProxyHelper';
import { applyFacebookProxyChange } from '../../src/services/facebook/facebookProxyChange';

export function registerProxyIpc() {
    // ─── Lấy danh sách proxies ─────────────────────────────────────────────────
    ipcMain.handle('proxy:list', async () => {
        try {
            const proxies = DatabaseService.getInstance().getProxies();
            return { success: true, proxies };
        } catch (err: any) {
            Logger.error(`[proxyIpc] list error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });

    // ─── Tạo proxy mới ─────────────────────────────────────────────────────────
    ipcMain.handle('proxy:save', async (_event, { proxy }) => {
        try {
            if (!proxy?.host || !proxy?.port) {
                return { success: false, error: 'Host và Port không được để trống' };
            }
            const id = DatabaseService.getInstance().saveProxy({
                name: proxy.name || `${proxy.host}:${proxy.port}`,
                type: proxy.type || 'http',
                host: proxy.host.trim(),
                port: Number(proxy.port),
                username: proxy.username || '',
                password: proxy.password || '',
            });
            const saved = DatabaseService.getInstance().getProxyById(id);
            return { success: true, id, proxy: saved };
        } catch (err: any) {
            Logger.error(`[proxyIpc] save error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });

    // ─── Cập nhật proxy ────────────────────────────────────────────────────────
    ipcMain.handle('proxy:update', async (_event, { id, proxy }) => {
        try {
            if (!id) return { success: false, error: 'Thiếu id proxy' };
            DatabaseService.getInstance().updateProxy(Number(id), proxy);
            const updated = DatabaseService.getInstance().getProxyById(Number(id));
            return { success: true, proxy: updated };
        } catch (err: any) {
            Logger.error(`[proxyIpc] update error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });

    // ─── Xóa proxy ──────────────────────────────────────────────────────���──────
    ipcMain.handle('proxy:delete', async (_event, { id }) => {
        try {
            if (!id) return { success: false, error: 'Thiếu id proxy' };
            DatabaseService.getInstance().deleteProxy(Number(id));
            return { success: true };
        } catch (err: any) {
            Logger.error(`[proxyIpc] delete error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });

    // ─── Gắn/gỡ proxy cho tài khoản ────────────────────────────────────────────
    ipcMain.handle('proxy:setAccount', async (_event, { zaloId, proxyId }) => {
        try {
            if (!zaloId || typeof zaloId !== 'string') return { success: false, error: 'Thiếu zaloId' };
            const db = DatabaseService.getInstance();
            const account = db.queryOne<{ channel: string | null }>('SELECT channel FROM accounts WHERE zalo_id = ?', [zaloId]);
            if (!account) return { success: false, error: 'Không tìm thấy tài khoản' };
            const channel = account.channel || 'zalo';
            if (channel !== 'zalo' && channel !== 'facebook') return { success: false, error: 'Kênh này chưa hỗ trợ proxy' };
            const nextProxyId: number | null = proxyId ?? null;
            const proxy = nextProxyId !== null && Number.isInteger(nextProxyId) ? db.getProxyById(nextProxyId) : null;
            if (nextProxyId !== null && !proxy) return { success: false, error: 'Proxy không tồn tại' };
            if (channel === 'facebook') {
                // Page đi cùng proxy với tài khoản cha (resolveFBProxyId): gán riêng cho Page không có tác dụng.
                const fb = db.queryOne<{ parent_facebook_id: string | null }>('SELECT parent_facebook_id FROM fb_accounts WHERE facebook_id = ?', [zaloId]);
                if (fb?.parent_facebook_id) return { success: false, error: 'Page dùng proxy của tài khoản Facebook chính' };
            }
            if (proxy) {
                // Thử trước khi đổi, bằng đúng phép thử của nút Test: gán một proxy không dùng được sẽ làm tài khoản đang chạy
                // mất kết nối (với Facebook là ngay lập tức).
                const agent = createProxyAgent(proxy);
                const probe = agent ? await checkProxyWorks(agent) : { ok: false, status: 0 };
                if (!probe.ok) {
                    return { success: false, error: `Proxy này không kết nối được (HTTP ${probe.status || 'timeout'}). Hãy kiểm tra lại proxy bằng nút Test; tài khoản vẫn giữ thiết lập cũ.` };
                }
            }
            db.setAccountProxy(zaloId, nextProxyId);
            // Facebook đang kết nối: nối lại ngay (cùng các Page con) qua proxy mới. Zalo đọc proxy lúc đăng nhập, và lần tự nối lại
            // của phiên đang chạy vẫn giữ proxy cũ, nên proxy mới có hiệu lực sau khi mở lại app.
            const applied = channel === 'facebook' ? (applyFacebookProxyChange(zaloId) ? 'reconnecting' : 'next_connect') : 'next_start';
            return { success: true, applied };
        } catch (err: any) {
            Logger.error(`[proxyIpc] setAccount error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });

    // ─── Lấy proxy của 1 tài khoản ─────────────────────────────────────────────
    ipcMain.handle('proxy:getForAccount', async (_event, { zaloId }) => {
        try {
            if (!zaloId) return { success: false, error: 'Thiếu zaloId' };
            const proxy = DatabaseService.getInstance().getAccountProxy(zaloId);
            return { success: true, proxy };
        } catch (err: any) {
            Logger.error(`[proxyIpc] getForAccount error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });

    // ─── Test proxy connection ──────────────────────────────────────────────────
    ipcMain.handle('proxy:test', async (_event, { proxy }) => {
        try {
            if (!proxy?.host || !proxy?.port) {
                return { success: false, error: 'Host và Port không được để trống' };
            }
            const agent = createProxyAgent({
                id: 0,
                name: proxy.name || '',
                type: proxy.type || 'http',
                host: proxy.host.trim(),
                port: Number(proxy.port),
                username: proxy.username || '',
                password: proxy.password || '',
            });
            if (!agent) {
                return { success: false, error: 'Không thể tạo proxy agent' };
            }

            // Thử qua proxy tới các trang trung lập (HEAD); chỉ mã 2xx / 3xx mới tính là qua được.
            const result = await checkProxyWorks(agent);
            if (result.ok) return { success: true, ms: result.ms, status: result.status };
            const lastError = `HTTP ${result.status || 'timeout'}`;
            return { success: false, error: `Proxy không phản hồi (${lastError}). Kiểm tra lại host/port/credentials.` };
        } catch (err: any) {
            Logger.error(`[proxyIpc] test error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });
}


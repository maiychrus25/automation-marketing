/**
 * SocketIOService - Boss-side Socket.IO server.
 *
 * Attaches to the existing HTTP server (port 9900) at path /socket.io.
 * - Employee authenticates via token from handshake.auth
 * - Each employee joins their own room emp:{employeeId}
 * - All events are pushed to EventBuffer before emit (no miss guarantee)
 * - On connect, employee sends 'catch-up' { proto: 2, bootId, lastSeqId } → ack 'replayed' (missed events re-sent,
 *   filtered by current access) or 'reset' (boss-restart | gap | fresh); clients without proto get the legacy filtered replay
 *
 * Room lifecycle (Socket.IO dynamic rooms):
 * - Room created automatically on first socket.join()
 * - Room destroyed when last socket leaves
 * - No pre-creation needed by Boss
 *
 * Integration:
 *   HttpRelayService.start() → this.attach(httpServer)
 *   HttpRelayService.relayEventToEmployees() → this.emitToEmployee(empId, channel, data)
 */
import * as http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import EventBuffer, { BufferedEvent } from './EventBuffer';
import { RelayAudience, canReceiveRelayEvent, EPHEMERAL_RELAY_CHANNELS } from './relayAudience';
import { CATCH_UP_JOIN_FALLBACK_MS, CATCH_UP_PROTO, CatchUpAck, CatchUpRequest, planCatchUp } from './catchUpProtocol';
import Logger from '../../utils/Logger';
import EmployeeService from '../employee/EmployeeService';
import WorkspaceManager from '../../utils/WorkspaceManager';

interface SocketIOEmployee {
  employeeId: string;
  socketId: string;
  connectedAt: number;
}

class SocketIOService {
  private static instance: SocketIOService;
  private io: SocketIOServer | null = null;
  private running = false;
  private joinFallbackMs = CATCH_UP_JOIN_FALLBACK_MS;

  /** In-memory buffer cho catch-up (5000 event gần nhất) */
  private eventBuffer = new EventBuffer();

  /** Tài khoản nhân viên được dùng, hỏi lại mỗi lần phát/nhận bù. Mặc định đóng: không tài khoản nào. */
  private allowedAccountsResolver: (employeeId: string) => string[] = () => [];

  public setAllowedAccountsResolver(fn: (employeeId: string) => string[]): void {
    this.allowedAccountsResolver = fn;
  }

  /** Hồ sơ trình duyệt nhân viên được dùng (Facebook Poster); mặc định không ai. */
  private allowedProfilesResolver: (employeeId: string) => string[] = () => [];

  public setAllowedProfilesResolver(fn: (employeeId: string) => string[]): void {
    this.allowedProfilesResolver = fn;
  }

  private allowedProfilesFor(employeeId: string): string[] {
    try { return this.allowedProfilesResolver(employeeId) || []; } catch { return []; }
  }

  /** Quyền module của nhân viên, hỏi lại mỗi lần phát/nhận bù. Mặc định đóng. */
  private modulePermissionResolver: (employeeId: string, module: string) => boolean = () => false;

  public setModulePermissionResolver(fn: (employeeId: string, module: string) => boolean): void {
    this.modulePermissionResolver = fn;
  }

  private hasModuleFor(employeeId: string): (module: string) => boolean {
    return (module) => { try { return this.modulePermissionResolver(employeeId, module) === true; } catch { return false; } };
  }

  private allowedFor(employeeId: string): string[] {
    try { return this.allowedAccountsResolver(employeeId) || []; } catch { return []; }
  }

  public static getInstance(): SocketIOService {
    if (!SocketIOService.instance) {
      SocketIOService.instance = new SocketIOService();
    }
    return SocketIOService.instance;
  }

  /**
   * Attach Socket.IO vào HTTP server hiện tại.
   * Gọi từ HttpRelayService.start() sau khi tạo httpServer.
   */
  public attach(httpServer: http.Server, joinFallbackMs: number = CATCH_UP_JOIN_FALLBACK_MS): void {
    if (this.running) {
      Logger.log('[SocketIOService] Already attached');
      return;
    }

    this.joinFallbackMs = joinFallbackMs;
    this.eventBuffer.reset(); // mỗi lần khởi động là một luồng mới

    this.io = new SocketIOServer(httpServer, {
      path: '/socket.io',
      cors: {
        origin: '*',
        methods: ['GET', 'POST'],
      },
      // Ping/pong 25s, timeout 30s → phát hiện mất kết nối trong ~55s
      // Timeout 30s (tăng từ 20s) để tránh false disconnect trên tunnel
      pingInterval: 25000,
      pingTimeout: 30000,
      // WebSocket ưu tiên, fallback HTTP polling nếu WS bị firewall chặn
      transports: ['websocket', 'polling'],
      // Giảm memory unused
      maxHttpBufferSize: 1e6, // 1MB
    });

    // ─── Auth middleware ────────────────────────────────────────────
    this.io.use((socket, next) => {
      const token = socket.handshake.auth?.token;
      if (!token) {
        return next(new Error('Missing auth token'));
      }

      try {
        const empService = EmployeeService.getInstance();
        const payload = empService.validateToken(token);

        if (!payload || !payload.valid || !payload.employee_id) {
          return next(new Error('Invalid token'));
        }

        const employee = empService.getEmployeeById(payload.employee_id);
        if (!employee || !employee.is_active) {
          return next(new Error('Employee not found or inactive'));
        }

        // Attach employee data to socket for use in connection handler
        socket.data.employeeId = employee.employee_id;
        socket.data.displayName = employee.display_name;
        next();
      } catch (err: any) {
        Logger.warn(`[SocketIOService] Auth error: ${err.message}`);
        next(new Error('Authentication failed'));
      }
    });

    // ─── Connection handler ──────────────────────────────────────────
    this.io.on('connection', (socket) => {
      const employeeId: string = socket.data.employeeId;
      const displayName: string = socket.data.displayName || employeeId;

      // Room `conn:` theo dõi kết nối (online, ngắt). Room `emp:` (nhận trực tiếp) chỉ vào sau catch-up đầu
      // tiên, để sự kiện phát giữa lúc nối và lúc nhận bù không bị gửi hai lần; quá hạn thì vào luôn.
      socket.join(`conn:${employeeId}`);
      let live = false;
      // Số thứ tự mới nhất lúc vào phòng bằng đường dự phòng: sự kiện sau mốc này đã gửi trực tiếp, nhận bù muộn không gửi lại.
      let fallbackCutoff: number | null = null;
      const joinLive = () => {
        if (live) return;
        live = true;
        clearTimeout(fallbackTimer);
        socket.join(`emp:${employeeId}`);
      };
      const fallbackTimer = setTimeout(() => {
        fallbackCutoff = this.eventBuffer.newestSeqId() ?? 0;
        joinLive();
      }, this.joinFallbackMs);

      Logger.log(`[SocketIOService] 🟢 ${displayName} connected (socket=${socket.id})`);

      // ── Catch-up: employee gửi lastSeqId → replay buffer ────────
      socket.on('catch-up', (req: CatchUpRequest | undefined, ack?: (a: CatchUpAck) => void) => {
        const request: CatchUpRequest = req && typeof req === 'object' ? req : {};
        const buf = this.eventBuffer;
        // Một ảnh chụp quyền cho cả việc đếm (trần phát lại) lẫn vòng phát lại: "đếm" và "gửi" không thể lệch nhau.
        const allowed = this.allowedFor(employeeId);
        const hasModule = this.hasModuleFor(employeeId);
        const profiles = this.allowedProfilesFor(employeeId);
        const visible = (ev: BufferedEvent) => canReceiveRelayEvent(ev.audience, employeeId, allowed, hasModule, profiles);
        const plan = planCatchUp(request, {
          bootId: buf.bootId,
          oldestSeqId: buf.oldestSeqId(),
          newestSeqId: buf.newestSeqId(),
          countAfter: (n) => buf.countAfter(n, visible),
          evicted: buf.evicted,
        });
        let sent = 0;
        if (plan.mode !== 'reset') {
          for (const ev of buf.getSince(plan.sinceSeqId)) {
            if (fallbackCutoff !== null && ev.seqId > fallbackCutoff) break; // đã nhận trực tiếp
            if (!visible(ev)) continue;
            socket.emit('event', {
              seqId: ev.seqId,
              bootId: buf.bootId,
              channel: ev.channel,
              data: ev.data,
            });
            sent++;
          }
          if (sent > 0) {
            Logger.log(`[SocketIOService] Catch-up: sent ${sent}/${buf.size} events to ${displayName} (lastSeqId=${plan.sinceSeqId})`);
          }
        }
        joinLive(); // đồng bộ với vòng phát lại: không có khoảng hở và không trùng
        if (plan.mode !== 'legacy' && typeof ack === 'function') {
          ack({
            proto: CATCH_UP_PROTO,
            bootId: buf.bootId,
            status: plan.mode === 'reset' ? 'reset' : 'replayed',
            ...(plan.mode === 'reset' ? { reason: plan.reason } : {}),
            lastSeqId: buf.newestSeqId(),
          });
        }
      });

      // ── Disconnect ──────────────────────────────────────────────
      socket.on('disconnect', (reason) => {
        clearTimeout(fallbackTimer);
        // Socket.IO tự động rời room khi disconnect; online = room conn: còn socket (xem isOnline)
        Logger.log(`[SocketIOService] 🔴 ${displayName} disconnected (reason=${reason})`);
      });

      // ── Error ───────────────────────────────────────────────────
      socket.on('error', (err) => {
        Logger.warn(`[SocketIOService] Socket error for ${displayName}: ${err.message}`);
      });
    });

    this.running = true;
    Logger.log('[SocketIOService] ✅ Socket.IO server attached to HTTP server');
  }

  /**
   * Gửi event đến 1 employee qua Socket.IO.
   * - Event luôn được push vào EventBuffer trước (đảm bảo không miss)
   * - Nếu employee offline (room rỗng) → no-op, event vẫn ở buffer → catch-up sau
   * - Không throw exception dù employee không tồn tại
   */
  public emitToEmployee(employeeId: string, channel: string, data: any): void {
    if (!this.io || !this.running) return;

    // 1. Buffer trước → đảm bảo không miss dù offline
    const seqId = this.eventBuffer.push(channel, data, { kind: 'employees', ids: [employeeId] });

    // 2. Emit vào room của employee
    //    Nếu room rỗng (offline) → no-op, event vẫn ở buffer
    try {
      this.io.to(`emp:${employeeId}`).emit('event', {
        seqId,
        bootId: this.eventBuffer.bootId,
        channel,
        data,
      });
    } catch (err: any) {
      Logger.warn(`[SocketIOService] emitToEmployee error: ${err.message}`);
    }
  }

  /**
   * Phát một sự kiện cho mọi nhân viên đang nối mà audience cho phép.
   * Buffer đúng một lần kèm audience; catch-up lọc lại bằng cùng quy tắc.
   */
  public publish(channel: string, data: unknown, audience: RelayAudience): void {
    if (!this.io || !this.running) return;
    // Kênh tức thời phát trực tiếp, không vào bộ đệm và không mang seqId (client không được dùng nó làm vị trí).
    const bootId = this.eventBuffer.bootId;
    const envelope = EPHEMERAL_RELAY_CHANNELS.has(channel)
      ? { channel, data, bootId }
      : { seqId: this.eventBuffer.push(channel, data, audience), bootId, channel, data };
    try {
      for (const [roomId, sockets] of this.io.sockets.adapter.rooms) {
        if (!roomId.startsWith('emp:') || sockets.size === 0) continue;
        const employeeId = roomId.slice(4);
        // Hồ sơ chỉ tra khi sự kiện thuộc hồ sơ: nhật ký đăng bài dồn dập, không tốn thêm truy vấn cho mọi sự kiện khác.
        const profiles = audience.kind === 'profiles' ? this.allowedProfilesFor(employeeId) : [];
        if (!canReceiveRelayEvent(audience, employeeId, this.allowedFor(employeeId), this.hasModuleFor(employeeId), profiles)) continue;
        this.io.to(roomId).emit('event', envelope);
      }
    } catch (err: any) {
      Logger.warn(`[SocketIOService] publish error: ${err.message}`);
    }
  }

  /** Ngắt mọi socket của employee (khi token bị thu hồi). */
  public disconnectEmployee(employeeId: string): void {
    if (!this.io) return;
    this.io.in(`conn:${employeeId}`).disconnectSockets(true);
  }

  /**
   * Kiểm tra employee có đang online qua Socket.IO không
   */
  public isOnline(employeeId: string): boolean {
    if (!this.io) return false;
    const room = this.io.sockets.adapter.rooms.get(`conn:${employeeId}`);
    return !!(room && room.size > 0);
  }

  /**
   * Đếm số employee đang online
   */
  public getOnlineCount(): number {
    if (!this.io) return 0;
    let count = 0;
    // Duyệt rooms có prefix conn:
    for (const [roomId, sockets] of this.io.sockets.adapter.rooms) {
      if (roomId.startsWith('conn:') && sockets.size > 0) count++;
    }
    return count;
  }

  /**
   * Dừng server
   */
  public stop(): void {
    if (this.io) {
      this.io.close();
      this.io = null;
    }
    this.running = false;
    this.eventBuffer.reset();
    Logger.log('[SocketIOService] Stopped');
  }

  /** Chỉ dùng cho test */
  public _getBuffer(): EventBuffer { return this.eventBuffer; }
}

export default SocketIOService;

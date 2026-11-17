/**
 * SocketIOClient - Employee-side Socket.IO client.
 *
 * Replaces the SSE connection for real-time event delivery.
 * - Connects to Boss Socket.IO server (attach to same port, path /socket.io)
 * - Authenticates via JWT token
 * - Auto-reconnects with Socket.IO built-in (không watchdog, không code tay)
 * - Tracks lastSeqId for catch-up on reconnect
 * - Forwards received events to EventBroadcaster.sendDirect
 *
 * Integration:
 *   HttpClientService.connect() → this.connect(bossUrl, token)
 *   HttpClientService.disconnect() → this.disconnect()
 */
import { io as socketIOClient, Socket } from 'socket.io-client';
import Logger from '../../utils/Logger';
import type { CatchUpAck } from './catchUpProtocol';
import { CATCH_UP_ACK_TIMEOUT_MS, StreamPosition, resyncReasonForAck, type ResyncReason } from '../http/employeeConnection';

class SocketIOClient {
  private socket: Socket | null = null;
  private bossUrl = '';
  private token = '';
  private workspaceId = '';

  /** Vị trí trong luồng của boss (dùng cho catch-up khi reconnect) */
  private position = new StreamPosition();

  constructor(private readonly ackTimeoutMs: number = CATCH_UP_ACK_TIMEOUT_MS) {}

  private ackTimer: ReturnType<typeof setTimeout> | null = null;
  private clearAckTimer(): void {
    if (this.ackTimer) clearTimeout(this.ackTimer);
    this.ackTimer = null;
  }

  /** Callback khi phát hiện có thể đã lỡ sự kiện → giao diện cần tải lại */
  private onResync: ((reason: ResyncReason) => void) | null = null;

  /** Callback khi nhận event từ Boss */
  private onEvent: ((channel: string, data: any) => void) | null = null;
  /** Callback khi trạng thái kết nối thay đổi */
  private onStatusChange: ((connected: boolean) => void) | null = null;

  /**
   * Kết nối đến Boss Socket.IO server.
   * Socket.IO tự động:
   * - Dùng WebSocket nếu khả dụng, fallback xuống HTTP polling
   * - Ping/pong để phát hiện mất kết nối
   * - Auto-reconnect với exponential backoff
   * - Buffer events trong quá trình reconnect
   */
  public connect(bossUrl: string, token: string): void {
    this.disconnect();
    this.bossUrl = bossUrl;
    this.token = token;
    this.position = new StreamPosition();

    Logger.log(`[SocketIOClient] Connecting to ${bossUrl}...`);

    this.socket = socketIOClient(bossUrl, {
      path: '/socket.io',
      auth: { token },
      // Ưu tiên WebSocket, fallback polling cho tunnel
      transports: ['websocket', 'polling'],
      // Auto-reconnect
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 15000,
      randomizationFactor: 0.5,
      timeout: 20000,
      // Giảm memory
      forceNew: true,
    });

    // ─── Connected ───────────────────────────────────────────────
    this.socket.on('connect', () => {
      Logger.log(`[SocketIOClient] 🟢 Connected to ${this.bossUrl} (id=${this.socket?.id})`);
      this.onStatusChange?.(true);

      // Catch-up sau MỌI lần connect (boss chỉ cho vào phòng nhận trực tiếp sau lượt này).
      // Boss bản cũ không gọi ack → hết hạn thì coi là chưa kiểm chứng.
      // Hạn chờ tự đặt (không dùng socket.timeout()): socket.io gọi ack với Error cả khi socket đóng, và chỉ phân biệt
      // với hết giờ bằng chuỗi thông báo. Ở đây đóng socket chỉ huỷ hạn chờ → không có kết luận, không resync.
      const sock = this.socket;
      if (!sock) return;
      this.clearAckTimer();
      let answered = false; // đã nhận ack thật
      let timedOut = false; // hạn chờ đã hết và đã báo catchup-unverified
      const current = () => this.socket === sock; // socket đã bị đóng/thay thì mọi kết quả muộn bị bỏ
      this.ackTimer = setTimeout(() => {
        if (answered || timedOut || !current()) return;
        timedOut = true;
        Logger.log('[SocketIOClient] Resync needed (reason=catchup-unverified)');
        this.onResync?.('catchup-unverified');
      }, this.ackTimeoutMs);
      const onAck = (ack: CatchUpAck) => {
        if (answered || !current()) return;
        answered = true;
        this.clearAckTimer();
        this.position.adopt(ack.bootId, ack.lastSeqId); // ack muộn vẫn cho biết vị trí thật của boss
        if (timedOut) return; // đã tải lại vì catchup-unverified, không báo lần hai
        const reason = resyncReasonForAck(ack);
        if (reason) {
          Logger.log(`[SocketIOClient] Resync needed (reason=${reason})`);
          this.onResync?.(reason);
        }
      };
      sock.emit('catch-up', this.position.request(), (ack?: CatchUpAck) => { if (ack) onAck(ack); });
    });

    // ─── Event từ Boss ──────────────────────────────────────────
    this.socket.on('event', (payload: { seqId?: number; bootId?: string; channel: string; data: any }) => {
      if (!payload || !payload.channel) return;

      // Sự kiện tức thời không có seqId → track bỏ qua, không dịch vị trí
      this.position.track(payload);

      // Forward đến handler (handlePushedEvent trong HttpClientService)
      this.onEvent?.(payload.channel, payload.data);
    });

    // ─── Disconnected ───────────────────────────────────────────
    this.socket.on('disconnect', (reason) => {
      Logger.log(`[SocketIOClient] 🔴 Disconnected from ${this.bossUrl}: ${reason}`);
      this.clearAckTimer(); // lần nối lại sẽ gửi catch-up mới
      this.onStatusChange?.(false);
    });

    // ─── Connect error ──────────────────────────────────────────
    this.socket.on('connect_error', (err) => {
      Logger.warn(`[SocketIOClient] Connection error: ${err.message}`);
      this.onStatusChange?.(false);
    });

    // ─── Error ──────────────────────────────────────────────────
    this.socket.on('error', (err) => {
      Logger.warn(`[SocketIOClient] Error: ${err.message}`);
    });
  }

  /**
   * Ngắt kết nối
   */
  public disconnect(): void {
    this.clearAckTimer();
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.close();
      this.socket = null;
    }
    this.position = new StreamPosition();
  }

  /**
   * Kiểm tra trạng thái kết nối
   */
  public isConnected(): boolean {
    return this.socket?.connected ?? false;
  }

  // ─── Callbacks ────────────────────────────────────────────────

  public setOnEvent(cb: (channel: string, data: any) => void): void {
    this.onEvent = cb;
  }

  public setOnStatusChange(cb: (connected: boolean) => void): void {
    this.onStatusChange = cb;
  }

  public setOnResync(cb: (reason: ResyncReason) => void): void {
    this.onResync = cb;
  }

  public setWorkspaceId(id: string): void {
    this.workspaceId = id;
  }
}

export default SocketIOClient;

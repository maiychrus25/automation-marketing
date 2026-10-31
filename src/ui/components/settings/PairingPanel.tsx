import React, { useEffect, useState } from 'react';
import type { ScopedKeyPolicy } from '../../../services/control/controlAuthorization';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import { showConfirm } from '../common/ConfirmDialog';
import { Spinner } from '../common/PageLoading';
import { KeyIcon } from '../common/icons';
import { Card, CodeBox } from './controlApiParts';

type Ticket = { kind?: ScopedKeyPolicy['kind']; code: string; command: string; firewall: string; expiresAt: number; botIp: string; name: string };

const formatCountdown = (ms: number) => {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

interface Props {
  policy?: ScopedKeyPolicy | null;
  scopeError?: string;
  /** Địa chỉ MaiHub điền sẵn (publicHost đã lưu hoặc IP công khai dò được). */
  publicHost: string;
  onCopy: (text: string) => void;
  /** Gọi sau khi tạo mã: API đã được bật và IP đã thêm vào allow-list ở phía máy chủ. */
  onCreated: () => void | Promise<void>;
  /** Gọi khi bot đã dùng mã: tải lại danh sách khoá. */
  onPaired: () => void | Promise<void>;
}

export default function PairingPanel({ publicHost, onCopy, onCreated, onPaired, policy = null, scopeError = '' }: Props) {
  const { showNotification } = useAppStore();
  const [name, setName] = useState('');
  const [botIp, setBotIp] = useState('');
  const [host, setHost] = useState(publicHost);
  const [hostTouched, setHostTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [pairedName, setPairedName] = useState('');

  // Điền sẵn địa chỉ khi cấu hình tải xong, nhưng không ghi đè giá trị người dùng đã sửa.
  useEffect(() => { if (!hostTouched) setHost(publicHost); }, [publicHost, hostTouched]);

  // Đếm ngược theo expiresAt; dừng khi hết hạn, huỷ, đã ghép nối hoặc rời trang.
  useEffect(() => {
    if (!ticket) return undefined;
    const tick = () => setRemaining(ticket.expiresAt - Date.now());
    tick();
    const timer = window.setInterval(() => {
      tick();
      if (ticket.expiresAt - Date.now() <= 0) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [ticket]);

  // Tham chiếu mới nhất của callback để listener không phải đăng ký lại.
  const pairedRef = React.useRef(onPaired);
  pairedRef.current = onPaired;
  const ticketRef = React.useRef(ticket);
  ticketRef.current = ticket;
  useEffect(() => {
    const off = ipc.on?.('controlApi:paired', (info: { keyName?: string; ip?: string }) => {
      const current = ticketRef.current;
      setPairedName(info?.keyName || current?.name || '');
      setTicket(null);
      Promise.resolve(pairedRef.current()).catch(() => {});
    });
    return () => { if (typeof off === 'function') off(); };
  }, []);

  const expired = !!ticket && remaining <= 0;
  const canSubmit = !busy && !scopeError && name.trim() && botIp.trim() && host.trim();

  const create = async () => {
    setError('');
    if (scopeError) { setError(scopeError); return; }
    const ok = await showConfirm({
      title: 'Tạo mã ghép nối?',
      message: `Sẽ bật API và thêm IP này vào danh sách được phép.${policy ? ' Chỉ tạo tệp staging riêng cho role, không tự cài MCP/service và chưa chứng minh cách ly.' : ''}${policy?.kind === 'page_receiver' ? ` Tôi đã xác nhận Chat ID ${policy.ownerChatId} và Sender ID ${policy.ownerSenderId} của chủ Page; giữ khoá receiver ngoài cấu hình/.env/MCP của runner.` : ''}`,
      confirmText: 'Tạo mã',
      variant: 'warning',
    });
    if (!ok) return;
    setBusy(true);
    setPairedName('');
    try {
      const res = await ipc.controlApi?.createPairing({ name: name.trim(), botIp: botIp.trim(), publicHost: host.trim(), ...(policy ? { policy } : {}) });
      if (res?.success && res.code && res.command && res.expiresAt) {
        setTicket({ kind: policy?.kind, code: res.code, command: res.command, firewall: res.firewall || '', expiresAt: res.expiresAt, botIp: botIp.trim(), name: name.trim() });
        Promise.resolve(onCreated()).catch(() => {});
      } else setError(res?.error || 'Không tạo được mã ghép nối');
    } catch (e: any) {
      setError(e?.message || 'Không tạo được mã ghép nối');
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!ticket) return;
    try {
      const res = await ipc.controlApi?.cancelPairing(ticket.botIp);
      if (res?.success) { setTicket(null); showNotification('Đã huỷ mã', 'success'); }
      else showNotification(res?.error || 'Không huỷ được mã', 'error');
    } catch (e: any) {
      showNotification(e?.message || 'Không huỷ được mã', 'error');
    }
  };

  return (
    <Card title="Ghép nối bot mới">
      <p className="text-xs text-gray-400 leading-relaxed">Nhập thông tin bot, MaiHub tạo mã dùng một lần và hai lệnh để chạy: một trên máy Windows này, một trên VPS bot.</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="min-w-0">
          <label htmlFor="pair-name" className="text-xs text-gray-400 block mb-1">Tên bot</label>
          <input id="pair-name" className="input-field" maxLength={60} placeholder="bot-telegram" value={name} onChange={e => setName(e.target.value)} />
        </div>
        <div className="min-w-0">
          <label htmlFor="pair-bot-ip" className="text-xs text-gray-400 block mb-1">IP VPS bot</label>
          <input id="pair-bot-ip" className="input-field font-mono" inputMode="decimal" placeholder="203.0.113.5" value={botIp} onChange={e => setBotIp(e.target.value)} />
        </div>
        <div className="min-w-0">
          <label htmlFor="pair-host" className="text-xs text-gray-400 block mb-1">Địa chỉ MaiHub mà bot nhìn thấy</label>
          <input id="pair-host" className="input-field font-mono" placeholder="IP công khai hoặc tên miền" value={host} onChange={e => { setHost(e.target.value); setHostTouched(true); }} />
        </div>
      </div>
      {error && <p className="text-xs text-red-400 break-words" role="alert">{error}</p>}
      <button type="button" className="btn-primary flex items-center gap-2" onClick={create} disabled={!canSubmit}>
        {busy ? <Spinner size={4} className="text-white" /> : <KeyIcon className="w-4 h-4" />} Tạo mã ghép nối
      </button>

      {pairedName && <p className="text-sm text-green-500 break-words" role="status">Đã ghép nối: {pairedName}</p>}

      {ticket && (
        <div className="space-y-3 min-w-0">
          <div>
            <p className="text-xs text-gray-400 mb-1">Bước 1: chạy trên máy Windows này (PowerShell quyền Administrator)</p>
            <CodeBox text={ticket.firewall} onCopy={onCopy} label="Sao chép lệnh tường lửa" />
          </div>
          <div>
            <p className="text-xs text-gray-400 mb-1">{ticket.kind ? `Bước 2: staging bằng root vào /root/maihub-page-${ticket.kind === 'page_runner' ? 'runner' : 'receiver'}` : 'Bước 2: chạy bằng root trên VPS bot'}</p>
            {expired
              ? <p className="text-xs text-amber-500" role="status">Mã đã hết hạn — tạo mã mới</p>
              : <CodeBox text={ticket.command} onCopy={onCopy} label={ticket.kind ? 'Sao chép lệnh staging' : 'Sao chép lệnh cài'} />}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {!expired && <span className="text-xs text-gray-300" aria-live="off">Còn lại: <span className="font-mono">{formatCountdown(remaining)}</span></span>}
            <button type="button" className="btn-secondary" onClick={cancel}>Huỷ mã</button>
          </div>
          {ticket.kind && <p className="text-xs text-amber-500 leading-relaxed">Đây chỉ là tệp staging, không phải cài đặt cách ly đã được xác minh. Không nhập khoá receiver vào runner hoặc chạy --install cho role scoped. Bước bàn giao tài khoản hệ điều hành/cài đặt và runtime scoped còn chờ kiểm chứng; giữ ghi được bảo vệ tắt.</p>}
          <p className="text-xs text-gray-400">Mỗi IP chỉ có một mã đang chờ; tạo mã mới sẽ thay mã cũ. Khởi động lại MaiHub sẽ làm mã mất hiệu lực.</p>
        </div>
      )}
    </Card>
  );
}

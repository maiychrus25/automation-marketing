import { EventNotifier } from './EventNotifier';
import type { ControlStore } from './ControlStore';
import { setControlEventSink } from './controlEvents';

type RecorderStore = Pick<ControlStore, 'addEvent' | 'listEventsAfter'>;

/**
 * Ghi sự kiện vào `control_events` độc lập với máy chủ HTTPS: bật khi workspace đang mở có cấu hình enabled và app không ở chế độ
 * nhân viên, kể cả khi cổng chưa bind được. `sync` chạy đồng bộ (không await) nên gọi được ngay trước khi scheduler khởi động.
 * Một notifier duy nhất sống suốt app; đổi store (đổi workspace) chỉ thay con trỏ, không có khoảng trống không sink.
 */
export class ControlEventRecorder {
    private store: RecorderStore | null = null;
    readonly notifier = new EventNotifier({ listEventsAfter: (seq, limit) => this.store?.listEventsAfter(seq, limit) ?? [] });

    sync(enabled: boolean, blocked: boolean, makeStore: () => RecorderStore): void {
        if (!enabled || blocked) { this.deactivate(); return; }
        const store = makeStore();
        this.store = store;
        setControlEventSink((type, payload) => {
            store.addEvent(type, payload);
            this.notifier.notify();
        });
    }

    deactivate(): void {
        this.store = null;
        setControlEventSink(null);
    }
}

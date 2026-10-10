import React, { useState } from 'react';

export interface PosterChannel {
  id: string;
  name: string;
  group: string;
  provider: { id: string; name: string; badge: string };
}

interface Props {
  channels: PosterChannel[];
  selected: string[] | null;
  onChange: (ids: string[] | null) => void;
  onCompose: () => void;
  onAdd: () => void;
  loading: boolean;
  error: string;
  onRetry: () => void;
}

export default function ChannelsPanel({ channels, selected, onChange, onCompose, onAdd, loading, error, onRetry }: Props) {
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const groups = new Map<string, PosterChannel[]>();
  for (const channel of channels.filter(c => c.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()))) {
    groups.set(channel.group, [...(groups.get(channel.group) || []), channel]);
  }
  const toggle = (id: string) => {
    const ids = selected ?? channels.map(c => c.id);
    onChange(ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id]);
  };
  return (
    <aside className="poster-channels" aria-label="Kênh đăng">
      <div className="poster-channel-tools">
        <button type="button" onClick={onAdd} className="poster-button w-full"><span aria-hidden="true">＋</span> Thêm kênh</button>
        <button type="button" onClick={onCompose} className="poster-primary w-full"><span aria-hidden="true">＋</span> Soạn bài</button>
      </div>
      <div className="flex items-center justify-between gap-2 mb-4">
        <h2 className="font-semibold">Kênh <span className="poster-muted font-normal">({channels.length})</span></h2>
        <button type="button" className="poster-link text-xs" onClick={() => onChange(selected === null ? [] : null)}>{selected === null ? 'Bỏ chọn' : 'Tất cả'}</button>
      </div>
      <input className="poster-input w-full mb-4" aria-label="Tìm kênh" placeholder="Tìm kênh…" value={search} onChange={e => setSearch(e.target.value)} />
      {loading && <p className="poster-muted text-sm" role="status">Đang tải kênh…</p>}
      {error && <div role="alert" className="space-y-2 text-sm"><p>{error}</p><button className="poster-button" onClick={onRetry}>Thử lại</button></div>}
      {!loading && !error && groups.size === 0 && <p className="poster-muted text-sm">{channels.length ? 'Không có kênh khớp tìm kiếm.' : 'Thêm profile để bắt đầu đăng bài.'}</p>}
      <div className="poster-channel-list">
        {[...groups].map(([name, items]) => <section key={name} className="mb-5">
          <button type="button" className="flex items-center gap-2 w-full text-left poster-muted text-xs mb-2" aria-expanded={!collapsed.includes(name)} onClick={() => setCollapsed(prev => prev.includes(name) ? prev.filter(value => value !== name) : [...prev, name])}>
            <span aria-hidden="true">{collapsed.includes(name) ? '▸' : '▾'}</span><span className="truncate flex-1">{name}</span><span>{items.length}</span>
          </button>
          {!collapsed.includes(name) && items.map(channel => <label key={`${channel.provider.id}:${channel.id}`} className="poster-channel-row">
            <span className="poster-channel-avatar"><span className="poster-avatar">{channel.name.slice(0, 1).toUpperCase()}</span><span className="poster-provider-badge" title={channel.provider.name}>{channel.provider.badge}</span></span>
            <span className="truncate flex-1" title={channel.name}>{channel.name}</span>
            <input type="checkbox" aria-label={`Lọc kênh ${channel.name}`} checked={selected === null || selected.includes(channel.id)} onChange={() => toggle(channel.id)} />
          </label>)}
        </section>)}
      </div>
      <p className="poster-muted text-xs mt-auto pt-4">Kênh là profile · Nhóm/Trang là đích đăng.</p>
    </aside>
  );
}

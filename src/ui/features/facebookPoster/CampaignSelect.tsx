import React, { useEffect, useState } from 'react';
import ipc from '@/lib/ipc';

interface Props {
  value: string | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
}

/** Ô chọn chiến dịch (chỉ chiến dịch chưa lưu trữ); chiến dịch đang gán mà đã lưu trữ vẫn hiện để không mất giá trị. */
export default function CampaignSelect({ value, onChange, disabled }: Props) {
  const [campaigns, setCampaigns] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    let cancelled = false;
    ipc.facebookPoster?.campaignList().then((res) => {
      if (!cancelled && res?.success) setCampaigns((res.campaigns ?? []).filter((c) => c.status !== 'archived'));
    }).catch(() => { /* ô chọn vẫn dùng được với "Không thuộc chiến dịch" */ });
    return () => { cancelled = true; };
  }, []);
  const known = value === null || campaigns.some((c) => c.id === value);
  return (
    <label className="block text-xs text-gray-400">
      Chiến dịch
      <select className="input-field text-sm w-full mt-1" value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">Không thuộc chiến dịch</option>
        {!known && <option value={value!}>Chiến dịch hiện tại</option>}
        {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
    </label>
  );
}

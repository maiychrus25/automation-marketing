import React from 'react';
import { toLocalMediaUrl } from '@/lib/localMedia';
import { isVideo } from '../../../services/facebookPoster/mediaRules';
import type { FbPosterMode } from '../../../models/facebookPoster';

interface Props {
  text: string;
  comment: string;
  mediaPaths: string[];
  names: string[];
  mode: FbPosterMode;
  targetName?: string;
}

export default function PostPreview({ text, comment, mediaPaths, names, mode, targetName }: Props) {
  const name = names[0] || 'Tên kênh của anh';
  return (
    <article className="poster-facebook-preview" aria-label="Xem trước bài Facebook">
      <header className="flex items-start gap-3 p-4">
        <span className="poster-avatar shrink-0" aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold break-words">{name}{mode === 'group' && <span className="font-normal"> ▸ {targetName || 'Nhóm đã chọn'}</span>}</p>
          <p className="poster-muted text-xs mt-1">Vừa xong · {mode === 'group' ? 'Nhóm' : 'Trang'} · ◎</p>
        </div>
        <span className="poster-muted" aria-hidden="true">•••</span>
      </header>
      <p className={`px-4 pb-4 whitespace-pre-wrap break-words ${text ? '' : 'poster-muted'}`}>{text || 'Nội dung bài viết sẽ xuất hiện ở đây…'}</p>
      {mediaPaths.length > 0 && <div className={`poster-preview-media ${mediaPaths.length > 1 ? 'is-grid' : ''}`}>
        {mediaPaths.slice(0, 4).map((path, index) => (
          <div key={path} className="relative min-w-0">
            {isVideo(path) ? <video controls preload="metadata" src={toLocalMediaUrl(path)} aria-label="Video xem trước" />
              : <img src={toLocalMediaUrl(path)} alt={`Ảnh xem trước ${index + 1}`} />}
            {index === 3 && mediaPaths.length > 4 && <span className="poster-media-more">+{mediaPaths.length - 4}</span>}
          </div>
        ))}
      </div>}
      <div className="poster-preview-actions"><span>♡ Thích</span><span>▢ Bình luận</span><span>↗ Chia sẻ</span></div>
      {comment && <div className="flex gap-2 p-4 border-t border-poster-border">
        <span className="poster-avatar is-small shrink-0" aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>
        <div className="poster-preview-comment min-w-0"><strong className="block text-xs break-words">{name}</strong><p className="whitespace-pre-wrap break-words mt-1">{comment}</p></div>
      </div>}
      {names.length > 1 && <p className="poster-muted text-xs p-4 border-t border-poster-border">Xem trước kênh đầu tiên · Bài sẽ đăng bằng {names.length} profile đã chọn.</p>}
    </article>
  );
}

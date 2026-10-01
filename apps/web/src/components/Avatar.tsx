'use client';
import { useEffect, useState } from 'react';
import Image from 'next/image';
import { API_URL } from '../lib/config';
import { initials } from '../lib/format';
export function Avatar({ token, name, mediaId, className, fallback }: { token: string; name: string; mediaId: string | null | undefined; className: string; fallback?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!mediaId) { setUrl(null); return; }
    let objectUrl: string | null = null;
    let cancelled = false;
    void fetch(`${API_URL}/media/${mediaId}`, { headers: { Authorization: `Bearer ${token}` } })
      .then((response) => { if (!response.ok) throw new Error('avatar'); return response.blob(); })
      .then((blob) => { objectUrl = URL.createObjectURL(blob); if (!cancelled) setUrl(objectUrl); else URL.revokeObjectURL(objectUrl); })
      .catch(() => { if (!cancelled) setUrl(null); });
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [mediaId, token]);
  return <div className={`${className} avatarImageWrap`}>{url ? <Image src={url} alt="" width={128} height={128} unoptimized /> : (fallback || initials(name))}</div>;
}

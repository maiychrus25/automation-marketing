/** Mục CIDR IPv4 rộng hơn /16 (kể cả 0.0.0.0/0) trong ô "IP được phép"; dùng để cảnh báo, không chặn. */
export function findBroadCidrs(text: string): string[] {
  return text.split(/[\s,;]+/).filter((entry) => {
    const m = /^\d{1,3}(?:\.\d{1,3}){3}\/(\d{1,2})$/.exec(entry);
    return !!m && Number(m[1]) < 16;
  });
}

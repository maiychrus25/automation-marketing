import { useCallback, useRef, useState } from 'react';

/** Bề rộng hiện tại của một phần tử (0 khi chưa gắn). Gắn `ref` trả về vào phần tử cần đo. */
export default function useElementWidth<T extends HTMLElement>(): [(element: T | null) => void, number] {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);

  const ref = useCallback((element: T | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!element) return;
    setWidth(element.getBoundingClientRect().width);
    observer.current = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.current.observe(element);
  }, []);

  return [ref, width];
}

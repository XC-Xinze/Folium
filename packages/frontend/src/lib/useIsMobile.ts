import { useEffect, useState } from 'react';

const MOBILE_QUERY = '(max-width: 768px)';

/**
 * 简易 mobile 检测：用 matchMedia 监听窗口宽度。
 * 在 SSR 场景默认 false（这个项目是 SPA，无所谓）。
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia(MOBILE_QUERY).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return isMobile;
}

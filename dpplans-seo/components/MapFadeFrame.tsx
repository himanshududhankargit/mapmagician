'use client';

import { useEffect, useRef } from 'react';

/**
 * The "plan at 0%" frame of the map-showcase fade (see MapEmbed). Rendered with NO
 * src/srcset — only data-* attributes — so it never competes with the hero (LCP)
 * image. After window load it swaps the real srcsets in, waits for decode, and adds
 * `is-animating` to the showcase; the CSS keyframes in globals.css do the rest.
 *
 * Skipped entirely (the static plan frame stays) for reduced-motion, Save-Data and
 * 2G visitors. The animation pauses while the banner is scrolled out of view.
 */
export function MapFadeFrame() {
  const ref = useRef<HTMLPictureElement>(null);

  useEffect(() => {
    const pic = ref.current;
    const showcase = pic?.closest('.map-showcase');
    const img = pic?.querySelector('img');
    if (!pic || !showcase || !img) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const conn = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
    if (conn && (conn.saveData || /2g/.test(conn.effectiveType || ''))) return;

    let io: IntersectionObserver | undefined;
    const go = () => {
      // a resize can swap the srcset candidate and fire load again
      if (showcase.classList.contains('is-animating')) return;
      showcase.classList.add('is-animating');
      if ('IntersectionObserver' in window) {
        io = new IntersectionObserver(entries => {
          showcase.classList.toggle('is-paused', !entries[0].isIntersecting);
        });
        io.observe(showcase);
      }
    };
    const start = () => {
      img.onload = () => { img.decode().then(go, go); };
      pic.querySelectorAll<HTMLSourceElement>('source[data-srcset]').forEach(s => {
        s.srcset = s.dataset.srcset || '';
      });
      img.src = img.dataset.src || '';
    };

    if (document.readyState === 'complete') start();
    else window.addEventListener('load', start, { once: true });
    return () => {
      window.removeEventListener('load', start);
      io?.disconnect();
    };
  }, []);

  return (
    <picture ref={ref} aria-hidden="true">
      <source
        type="image/webp"
        media="(max-width: 720px)"
        data-srcset="/AssetsGIS/hero-banner-base-sq480.webp 480w, /AssetsGIS/hero-banner-base-sq640.webp 640w, /AssetsGIS/hero-banner-base-sq800.webp 800w"
        sizes="100vw"
      />
      <source
        type="image/webp"
        data-srcset="/AssetsGIS/hero-banner-base-768.webp 768w, /AssetsGIS/hero-banner-base-1280.webp 1280w, /AssetsGIS/hero-banner-base-1920.webp 1920w"
        sizes="100vw"
      />
      <img
        data-src="/AssetsGIS/hero-banner-base-1280.jpg"
        width={1920}
        height={640}
        alt=""
        decoding="async"
        className="banner-img banner-base"
      />
    </picture>
  );
}

export interface MapReadingPosition {
  itemId: string;
  mobileTab: 'map' | 'list';
  openerTop: number;
  listScrollTop: number;
}

/** Keep the return anchor steady while saved pictures arrive, until the reader takes over. */
export function restoreMapReading(
  root: HTMLElement,
  position: MapReadingPosition,
  anchor: () => HTMLElement | null,
  list: HTMLElement | null,
) {
  let live = true;
  const place = () => {
    if (!live || !root.isConnected) return;
    if (list) list.scrollTop = position.listScrollTop;
    const target = anchor() || root;
    window.scrollBy({ top: target.getBoundingClientRect().top - position.openerTop, behavior: 'instant' });
  };
  const observer = new ResizeObserver(place);
  const events = ['pointerdown', 'wheel', 'touchstart', 'keydown'] as const;
  const stop = () => {
    if (!live) return;
    live = false;
    clearTimeout(timer);
    observer.disconnect();
    for (const event of events) window.removeEventListener(event, stop, true);
  };
  const timer = setTimeout(stop, 10000);
  observer.observe(document.body);
  observer.observe(root);
  for (const event of events) window.addEventListener(event, stop, { capture: true, passive: true });
  (anchor() || root).focus({ preventScroll: true });
  place();
  return stop;
}

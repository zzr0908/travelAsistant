import { useEffect, useRef, useSyncExternalStore } from 'react';

const slots = new Map<object, number>(), listeners = new Set<() => void>();
let order = 0, small = false, media: MediaQueryList | undefined;
const notify = () => listeners.forEach(listener => listener());
const resized = () => { small = !!media?.matches; notify(); };
const subscribe = (listener: () => void) => {
  if (!listeners.size) { media = matchMedia('(max-width: 600px)'); small = media.matches; media.addEventListener('change', resized); }
  listeners.add(listener);
  return () => { listeners.delete(listener); if (!listeners.size) media?.removeEventListener('change', resized); };
};
const permitted = (token: object) => [...slots.entries()].sort((a,b) => b[1] - a[1]).slice(0, small ? 1 : 2).some(([id]) => id === token);

export function useMapSlot() {
  const token = useRef({}).current;
  const enabled = useSyncExternalStore(subscribe, () => permitted(token), () => false);
  const activate = () => { slots.set(token, ++order); notify(); };
  useEffect(() => { activate(); return () => { slots.delete(token); notify(); }; }, [token]);
  return { enabled, activate };
}

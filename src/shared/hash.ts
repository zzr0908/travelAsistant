import { createHash } from 'node:crypto';
export const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const canonical = (value: unknown): string => JSON.stringify(value, (_k, v: unknown) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);

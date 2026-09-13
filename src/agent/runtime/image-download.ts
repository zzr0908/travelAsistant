import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { defaultHosts, hostMatches, privateAddress } from '../../shared/browser-sources.js';
const limit = 8 * 1024 * 1024;
function ensure(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
// Resolve once, reject private addresses, then pin that address for this request.
// Redirects receive the same validation. No browser cookies or authorization headers are sent.
export async function downloadImage(raw: string, parentSignal?: AbortSignal, redirects = 0): Promise<Buffer> {
  const url = new URL(raw), signal = AbortSignal.any([AbortSignal.timeout(12000), ...(parentSignal ? [parentSignal] : [])]);
  ensure(['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && (!url.port || ['443','80'].includes(url.port)) && hostMatches(url.hostname, defaultHosts), '图片来源不在允许范围');
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve,reject) => {abort = () => reject(signal.reason);signal.addEventListener('abort',abort,{once:true});});
  const addresses = await Promise.race([lookup(url.hostname, { all: true }),cancelled]).finally(() => {if(abort)signal.removeEventListener('abort',abort);});
  signal.throwIfAborted();
  ensure(addresses.length && addresses.every(a => !privateAddress(a.address)), '图片来源不是公共地址');
  const address = addresses[0];
  return new Promise<Buffer>((resolve, reject) => {
    const req = (url.protocol === 'https:' ? https : http).get(url, {
      signal, headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg', 'User-Agent': 'TravelAssistant/1.0' },
      lookup: ((_host: unknown, options: {all?: boolean}, cb: (...args: unknown[]) => void) => options.all ? cb(null, [address]) : cb(null, address.address, address.family)) as http.RequestOptions['lookup'],
    }, res => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.destroy();
        if (redirects >= 3) { reject(new Error('图片重定向次数过多')); return; }
        downloadImage(new URL(res.headers.location, url).href, signal, redirects + 1).then(resolve, reject); return;
      }
      if (res.statusCode !== 200 || !/^image\/(jpeg|png|webp|avif)(;|$)/i.test(res.headers['content-type'] || '')) {
        res.destroy(); reject(new Error(res.statusCode === 404 ? '原图已失效（404）' : '来源未返回支持的图片')); return;
      }
      if (Number(res.headers['content-length']) > limit) { res.destroy(); reject(new Error('图片超过 8 MB')); return; }
      const chunks: Buffer[] = []; let length = 0;
      res.on('data', (chunk: Buffer) => { length += chunk.length; if (length > limit) { res.destroy(); reject(new Error('图片超过 8 MB')); } else chunks.push(chunk); });
      res.on('end', () => resolve(Buffer.concat(chunks))); res.on('error', reject);
    });
    req.on('error', reject);
  });
}

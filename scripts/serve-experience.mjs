import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, realpath } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { networkInterfaces } from 'node:os';

// Serve only the sanitized prototype build. Never expose the project, QA
// databases, .env, the Vite file server, or source data preparation scripts.
const root = await realpath(resolve('.cache/experience-preview'));
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json', '.svg':'image/svg+xml', '.webp':'image/webp', '.png':'image/png' };
const server = createServer(async (req,res) => {
  if (!['GET','HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
  try {
    const requested = decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    if (requested.split('/').some(part=>part.startsWith('.'))) throw new Error('hidden path');
    const filename=await realpath(resolve(root, '.'+(requested==='/'?'/index.html':requested)));
    if (!filename.startsWith(root+sep) || !types[extname(filename)]) throw new Error('outside public build');
    const info=await stat(filename); if(!info.isFile()) throw new Error('not a file');
    res.writeHead(200,{'Content-Type':types[extname(filename)],'Content-Length':info.size,'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
    if(req.method==='HEAD')res.end(); else createReadStream(filename).pipe(res);
  } catch {res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'}).end('找不到这个页面或文件。');}
});
server.listen(4350,'0.0.0.0',()=>{
  console.log('Experience preview: http://localhost:4350/');
  for(const interfaces of Object.values(networkInterfaces()))for(const ip of interfaces||[])if(ip.family==='IPv4'&&!ip.internal)console.log(`Phone preview: http://${ip.address}:4350/`);
});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>process.exit(0)));

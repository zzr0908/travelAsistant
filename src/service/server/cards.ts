import type { FastifyInstance } from 'fastify';
import type { CardImports } from '../../cards/import.js';
export function cardRoutes(app:FastifyInstance,cards:CardImports,signedIn:(req:any)=>{id:string}) {
  app.get('/api/card-drafts',async req=>cards.list(signedIn(req).id,(req.query as {workspaceId:string}).workspaceId));
  app.get('/api/card-drafts/:id',async req=>cards.view(signedIn(req).id,(req.params as {id:string}).id));
  app.post('/api/card-drafts',{bodyLimit:8*1024*1024},async req=>cards.start(signedIn(req).id,req.body));
  app.put('/api/card-drafts/:id',async req=>cards.update(signedIn(req).id,(req.params as {id:string}).id,req.body));
}

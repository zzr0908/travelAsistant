import {notesForPlan,type Note} from './notes.js';
import {itineraryGroups} from './itinerary.js';
import type {WorkspaceData} from './model.js';
export interface NoteGroup {id:string;title:string;notes:Note[];expanded:boolean}
export function noteGroups(data:WorkspaceData,nodeId:string,search=''):NoteGroup[] {
 const query=search.trim().toLocaleLowerCase();
 const notes=notesForPlan(data,nodeId).filter(note=>!query || `${note.title}\n${note.body}\n${note.nodeIds.map(id=>data.nodes[id]?.title || '').join(' ')}`.toLocaleLowerCase().includes(query));
 const branches=itineraryGroups(data,nodeId).flatMap(group=>group.nodes).map(node=>({node,ids:new Set(notesForPlan(data,node.id).map(note=>note.id))}));
 const groups:NoteGroup[]=[{id:'current',title:'当前计划',notes:[],expanded:true},{id:'shared',title:'多个子计划共用',notes:[],expanded:true},...branches.map(({node})=>({id:node.id,title:node.title,notes:[] as Note[],expanded:false})),{id:'library',title:'旅行资料',notes:[],expanded:true}];
 for(const note of notes) {
  const matched=branches.filter(branch=>branch.ids.has(note.id));
  const direct=note.nodeIds.includes(nodeId)||(data.spatial?.[nodeId] || []).some(binding=>note.spatialIds?.includes(binding.assetId));
  const id=direct?'current':matched.length>1?'shared':matched[0]?.node.id || 'library';
  groups.find(group=>group.id===id)!.notes.push(note);
 }
 return groups.filter(group=>group.notes.length);
}
export function noteExcerpt(body:string):string {
 return body.replace(/!\[[^\]]*\]\([^)]*\)/g,'').replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/(^|\n)\s{0,3}(?:#{1,6}\s+|[-*>]\s+)/g,' ').replace(/[`*_~]/g,'').replace(/\s+/g,' ').trim().slice(0,120);
}

/** Avoid rendering the same title twice while preserving the editable source. */
export function noteReadingBody(title:string,body:string):string {
 const first=body.match(/^\s{0,3}#{1,6}[ \t]+([^\r\n]+)\r?\n/);
 return first && first[1].trim()===title.trim() ? body.slice(first[0].length).replace(/^\r?\n/,'') : body;
}

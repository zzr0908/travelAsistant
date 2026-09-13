import test from 'node:test';
import assert from 'node:assert/strict';
import {nodeFields,type WorkspaceData} from '../src/shared/model.js';
import {noteFields,notesForPlace,type Note} from '../src/shared/notes.js';
import {noteGroups,noteExcerpt,noteReadingBody} from '../src/shared/note-groups.js';
const node=(id:string,parentId:string|null,order=0)=>({...nodeFields.parse({title:id}),id,parentId,order});
const note=(id:string,nodeIds:string[],body='攻略'):Note=>({...noteFields.parse({title:id,nodeIds,body}),id,createdAt:'2026-09-09T00:00:00Z',updatedAt:'2026-09-09T00:00:00Z'});
test('notebook groups preserve scope, deduplicate shared notes and search folded descendants',()=>{
 const data:WorkspaceData={rootId:'root',kind:'trip',sample:false,nodes:{root:node('root',null),day:node('day','root'),other:node('other','root',1),walk:node('walk','day')},preparations:{},progress:{},notebook:{direct:note('direct',['root']),shared:note('shared',['day','other']),walk:note('walk',['walk'],'沿河咖啡'),library:note('library',[])}};
 const before=JSON.stringify(data),groups=noteGroups(data,'root');
 assert.deepEqual(groups.map(g=>[g.id,g.notes.map(n=>n.id)]),[['current',['direct']],['shared',['shared']],['day',['walk']],['library',['library']]]);
 assert.equal(groups.find(g=>g.id==='day')?.expanded,false);
 assert.deepEqual(noteGroups(data,'day').flatMap(g=>g.notes.map(n=>n.id)).sort(),['shared','walk']);
 assert.deepEqual(noteGroups(data,'root','咖啡').flatMap(g=>g.notes.map(n=>n.id)),['walk']);
 assert.deepEqual(noteGroups(data,'root','不存在'),[]);
 assert.equal(JSON.stringify(data),before);
});
test('note previews show readable text instead of markdown links and image identifiers',()=>{
 assert.equal(noteExcerpt('# 散步\n\n[来源](https://example.com)\n![图片](media:some-id)\n**指引**'),'散步 来源 指引');
});

test('map notes use explicit references without pulling nearby or parent content into a place',()=>{
 const direct=note('direct',['walk']),place={...note('place',[]),spatialIds:['poi']},both={...note('both',['walk']),spatialIds:['poi']};
 const data:WorkspaceData={rootId:'root',kind:'trip',sample:false,nodes:{root:node('root',null),day:node('day','root'),walk:node('walk','day')},preparations:{},progress:{},notebook:{direct,place,both,parent:note('parent',['day']),other:{...note('other',[]),spatialIds:['other-poi']}}};
 const before=JSON.stringify(data);
 assert.deepEqual(notesForPlace(data,['poi'],['walk']).map(n=>n.id),['both','direct','place']);
 assert.deepEqual(notesForPlace(data,['poi']).map(n=>n.id),['both','place']);
 assert.deepEqual(notesForPlace(data,['unknown']),[]);
 assert.equal(JSON.stringify(data),before);
});

test('note reading suppresses only an exact duplicate leading title without rewriting the source',()=>{
 const body='# 同一标题\n\n介绍\n\n## 第二节';
 assert.equal(noteReadingBody('同一标题',body),'介绍\n\n## 第二节');
 assert.equal(noteReadingBody('不同标题',body),body);
 assert.equal(noteReadingBody('同一标题','正文\n# 同一标题'),'正文\n# 同一标题');
 assert.equal(noteReadingBody('同一标题','```\n# 同一标题\n```'),'```\n# 同一标题\n```');
 assert.equal(noteReadingBody('同一标题','# 同一标题\r\n\r\n正文'),'正文');
});

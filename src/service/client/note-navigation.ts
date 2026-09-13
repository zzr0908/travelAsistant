import {useLayoutEffect,useRef,useState} from 'react';

/** Keep reading entry and return positions independent of the list's scroll. */
export function useNoteNavigation(){
 const [selected,setSelected]=useState(()=>new URLSearchParams(location.hash.slice(1)).get('note')||'');
 const readingRoot=useRef<HTMLElement>(null),rows=useRef(new Map<string,HTMLButtonElement>());
 const listReturn=useRef<{top:number;id:string}|undefined>(undefined),pendingNavigation=useRef(false);
 useLayoutEffect(()=>{
  if(!pendingNavigation.current)return;
  pendingNavigation.current=false;
  if(selected){readingRoot.current?.focus({preventScroll:true});readingRoot.current?.scrollIntoView({block:'start'});}
  else if(listReturn.current){rows.current.get(listReturn.current.id)?.focus({preventScroll:true});window.scrollTo({top:listReturn.current.top,behavior:'instant'});}
 },[selected]);
 const selectNote=(id:string)=>{
  if(id===selected)return;
  if(id&&!selected)listReturn.current={top:window.scrollY,id};
  pendingNavigation.current=true;setSelected(id);
  const hash=new URLSearchParams(location.hash.slice(1));
  if(id)hash.set('note',id);else hash.delete('note');
  history.replaceState(null,'',`#${hash}`);
 };
 return {selected,readingRoot,rows,selectNote};
}

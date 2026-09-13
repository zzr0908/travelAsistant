import {z} from 'zod';
interface StoragePort {getItem(key:string):string|null;setItem(key:string,value:string):void}
/** Bounded tab-local view state; storage failures retain the in-memory fallback. */
export class SessionMap<T> extends Map<string,T> {
 constructor(private name:string,private schema:z.ZodType<T>,private limit=50,private storage:()=>StoragePort=()=>sessionStorage){
  super();
  try{
   const parsed=z.array(z.tuple([z.string().max(200000),schema])).max(limit).safeParse(JSON.parse(storage().getItem(name)||'[]'));
   if(parsed.success)for(const [key,value] of parsed.data)super.set(key,value);
  }catch{ /* Invalid or unavailable storage does not prevent normal use. */ }
 }
 private persist(){try{this.storage().setItem(this.name,JSON.stringify([...this]));}catch{ /* Memory remains usable when storage is full or disabled. */ }}
 override set(key:string,value:T){
  const parsed=this.schema.parse(value);super.delete(key);super.set(key,parsed);
  while(this.size>this.limit)super.delete(this.keys().next().value!);
  this.persist();return this;
 }
 override delete(key:string){const changed=super.delete(key);if(changed)this.persist();return changed;}
 override clear(){super.clear();this.persist();}
}

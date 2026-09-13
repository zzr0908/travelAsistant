const formatters=new Map<string,Intl.DateTimeFormat>();
function formatter(zone:string) {
 let value=formatters.get(zone);
 if(!value){value=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});formatters.set(zone,value);}
 return value;
}
export function civilTime(ms:number,zone:string):string {
 const parts=Object.fromEntries(formatter(zone).formatToParts(ms).map(part=>[part.type,part.value]));
 return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
/** Only a unique civil-time mapping may be used for chronological ordering. */
export function uniqueInstant(date:string,time:string,zone:string):number|null {
 try {
  const wanted=`${date}T${time}`,base=Date.parse(`${wanted}:00Z`);
  if(!Number.isFinite(base))return null;
  const offsets=new Set([-36,-12,0,12,36].map(hours=>{const probe=base+hours*3600000;return Date.parse(`${civilTime(probe,zone)}:00Z`)-probe;}));
  const matches=[...offsets].map(offset=>base-offset).filter(ms=>civilTime(ms,zone)===wanted);
  return matches.length===1?matches[0]:null;
 }catch{return null;}
}

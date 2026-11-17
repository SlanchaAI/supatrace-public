// Validate local calendar/time components before Date.parse can normalize them.
// Raw source values remain in payload; output is only the millisecond display time.
export function normalizeTimestamp(value,{allowSpace=false}={}){
 if(typeof value!=='string')return null;
 const match=/^(\d{4})-(\d{2})-(\d{2})(T| )(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
 if(!match||match[4]===' '&&!allowSpace)return null;
 const year=Number(match[1]),month=Number(match[2]),day=Number(match[3]),hour=Number(match[5]),minute=Number(match[6]),second=Number(match[7]);
 const leap=year%4===0&&(year%100!==0||year%400===0),days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
 if(month<1||month>12||day<1||day>days[month-1]||hour>23||minute>59||second>59||match[8]!=='Z'&&(Number(match[10])>23||Number(match[11])>59))return null;
 const timestamp=Date.parse(value.replace(' ','T'));return Number.isFinite(timestamp)?new Date(timestamp).toISOString():null;
}
// Compare original decimal timestamp precision without rounding fractions to ms.
// Whole-second epoch values are exact across the supported four-digit years.
export function compareTimestamps(left,right,{allowSpace=false}={}){
 if(normalizeTimestamp(left,{allowSpace})===null||normalizeTimestamp(right,{allowSpace})===null)return null;
 const parts=value=>{const text=value.replace(' ','T'),fraction=/\.(\d+)(?=Z|[+-]\d{2}:\d{2}$)/.exec(text)?.[1]||'';return{seconds:Date.parse(text.replace(/\.\d+(?=Z|[+-]\d{2}:\d{2}$)/,'')),fraction};};
 const a=parts(left),b=parts(right);if(a.seconds!==b.seconds)return a.seconds<b.seconds?-1:1;const width=Math.max(a.fraction.length,b.fraction.length),af=a.fraction.padEnd(width,'0'),bf=b.fraction.padEnd(width,'0');return af===bf?0:af<bf?-1:1;
}

// Conservative RFC9110 Retry-After parser: integer seconds or canonical IMF-fixdate.
// Obsolete HTTP-date formats are rejected, never interpreted as zero delay.
export function retryAfterMs(value,{now=Date.now(),maxMs=60000}={}){
 if(typeof value!=='string')throw Error('invalid_retry_after');let ms;
 if(/^\d+$/.test(value))ms=Number(value)*1000;
 else{
  if(!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value))throw Error('invalid_retry_after');
  const date=Date.parse(value);if(!Number.isFinite(date)||new Date(date).toUTCString()!==value)throw Error('invalid_retry_after');ms=Math.max(0,date-now);
 }
 if(!Number.isFinite(ms)||ms>maxMs)throw Error('retry_after_exceeds_budget');return ms;
}

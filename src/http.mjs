export class HttpError extends Error{constructor(status,code){super(code);this.status=status;this.code=code;}}
export const securityHeaders=(extra={})=>({
 'Cache-Control':'no-store',
 'X-Content-Type-Options':'nosniff',
 'Referrer-Policy':'no-referrer',
 'X-Frame-Options':'DENY',
 'Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
 ...extra
});
export function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:securityHeaders({'Content-Type':'application/json'})});}
export async function boundedText(request,limit=524288){
 if(request.headers.get('content-encoding'))throw new HttpError(415,'compressed_upload_not_supported');
 if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))throw new HttpError(415,'json_required');
 if(!request.body)throw new HttpError(400,'empty_body');
 const reader=request.body.getReader();let length=0;const parts=[];
 try{while(true){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>limit){await reader.cancel();throw new HttpError(413,'batch_too_large');}parts.push(value);}}finally{reader.releaseLock();}
 const bytes=new Uint8Array(length);let at=0;for(const p of parts){bytes.set(p,at);at+=p.byteLength;}
 try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new HttpError(400,'invalid_utf8');}
}
export function requireOrigin(request,origin){if(request.headers.get('origin')!==origin)throw new HttpError(403,'origin_required');}

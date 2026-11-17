// API Gateway v2 transport adapter only. No network, secrets, grants or payment access.
import {isIP} from 'node:net';
import {HttpError} from './http.mjs';
const fail=(status,code)=>{const e=new HttpError(status,code);e.billingIngress=true;throw e;};
export function isApiGatewayIngress(event){return typeof event?.requestContext?.domainName==='string'&&event.requestContext.domainName.includes('.execute-api.');}
export function stripeIngressRequest(event,{apiId,accountId,region,appOrigin='https://supatrace.dev'}={}){
 if(typeof apiId!=='string'||!/^[-a-z0-9]{1,40}$/.test(apiId)||!/^\d{12}$/.test(accountId||'')||!/^[-a-z0-9]{1,32}$/.test(region||'')||!['https://supatrace.dev','https://supatrace.tech'].includes(appOrigin))fail(503,'billing_ingress_disabled');
 const c=event?.requestContext;if(event.version!=='2.0'||event.routeKey!=='POST /api/billing/webhook'||c?.routeKey!=='POST /api/billing/webhook'||c.apiId!==apiId||c.accountId!==accountId||c.stage!=='$default'||c.domainName!==apiId+'.execute-api.'+region+'.amazonaws.com'||c.http?.method!=='POST'||event.rawPath!=='/api/billing/webhook'||c.http.path!=='/api/billing/webhook'||event.rawQueryString!=='')fail(403,'billing_ingress_scope_mismatch');
 if(typeof event.body!=='string'||typeof event.isBase64Encoded!=='boolean'||event.body.length>349528)fail(413,'billing_ingress_body_limit');
 if(event.isBase64Encoded&&(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(event.body)))fail(400,'invalid_ingress_base64');
 stripeIngressSourceIp(event);
 const raw=Buffer.from(event.body,event.isBase64Encoded?'base64':'utf8');if(!raw.length||raw.length>262144)fail(413,'billing_ingress_body_limit');
 const headers=new Headers();for(const [name,value] of Object.entries(event.headers||{})){if(typeof value!=='string'||/[\r\n]/.test(value))fail(400,'invalid_ingress_header');const n=name.toLowerCase();if(['content-type','content-encoding','stripe-signature'].includes(n)){if(headers.has(n))fail(400,'duplicate_ingress_header');headers.set(n,value);}}
 if(headers.get('content-type')?.split(';')[0]!=='application/json'||headers.has('content-encoding')||!headers.get('stripe-signature')||headers.get('stripe-signature').length>8192)fail(400,'invalid_ingress_headers');
 // Cookies, caller Origin/host, Authorization and project fields never cross this boundary.
 return new Request(appOrigin+'/api/billing/webhook',{method:'POST',headers,body:raw});
}

export function stripeIngressSourceIp(event){const ip=event?.requestContext?.http?.sourceIp;if(typeof ip!=='string'||!isIP(ip))fail(400,'invalid_ingress_source_ip');return ip;}

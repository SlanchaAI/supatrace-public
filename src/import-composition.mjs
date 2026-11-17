import {createServerPullController} from './server-pull-import.mjs';
// Production import composition from server configuration only. Missing or invalid configuration composes nothing,
// so the API keeps refusing review/consent/revoke/Start. Start is not composed here: it needs genuine installed-host
// readiness, which no application-side source can attest.
import {createPrivateImportPolicy} from './private-import-policy.mjs';
import {createPrivateImportConsentStore} from './private-import-consent.mjs';
import {createImportConsentReviewController} from './import-consent-review.mjs';
import {approvalFields as fields} from './private-import-approval.mjs';

export function composeImportControllers(text,{store,objects,origins}={}){
 if(typeof text!=='string'||!text||text.length>16384)return {};
 try{
  const config=JSON.parse(text);
  if(!fields(config,['policy_id','policy_hash','origin','runtime'])||!origins?.includes(config.origin))return {};
  const {policy_id,policy_hash,origin,runtime}=config;
  const policy=createPrivateImportPolicy({store,objects,runtime,policy_id,policy_hash});
  const consents=createPrivateImportConsentStore({store,objects,origin,runtime,authorize:policy.authorize});
  return {importConsentReviewController:createImportConsentReviewController({store,objects,origin,runtime,consents,proposalProvider:policy.proposalProvider,authorize:policy.authorize})};
 }catch{return {};}
}

// Separate opt-in: no legacy worker policy can imply server-pull readiness.
export function composeServerPullController(text,{store,objects,origins,fetchImpl}={}){
 if(typeof text!=='string'||text.length>1024)return {};
 try{const config=JSON.parse(text);if(!fields(config,['mode','origin'])||config.mode!=='bounded-server-pull-v1'||!origins?.includes(config.origin))return {};
 return {serverPullController:createServerPullController({store,objects,origin:config.origin,...(fetchImpl?{fetchImpl}:{})})};}catch{return {};}
}

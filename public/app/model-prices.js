// Public list prices in USD per one million tokens: [base input, base output].
// Standard (non-batch) tier, lowest prompt-size tier, no caching, tools, audio or
// negotiated discounts. Read from the provider pages below on PRICES_AS_OF.
// A cost built from this table is an estimate for reading a trace, never a bill.
// Update the numbers and the date together; a model that is not listed stays unpriced.
export const PRICES_AS_OF='2026-11-14';
export const PRICE_SOURCES=Object.freeze([
 'https://developers.openai.com/api/docs/pricing',
 'https://platform.claude.com/docs/en/about-claude/pricing',
 'https://aistudio.google.com/docs/pricing'
]);
// Anthropic's page lists display names; the ids below follow its published
// claude-<family>-<major>-<minor> id form. Promotional or scheduled price changes
// after PRICES_AS_OF (several land on 2026-12-01 and 2027-01-01) are not modelled.
const TABLE=new Map(Object.entries({
 'gpt-6-astra':[10,50],'gpt-6.1-sol':[2,10],'gpt-6.1-terra':[1,5],'gpt-6-luna':[0.1,0.5],'gpt-6-sol':[2,10],
 'gpt-5.6-sol':[4,20],'gpt-5.6-terra':[2,12],'gpt-5.6-luna':[0.2,1.2],
 'gpt-5.5':[5,30],'gpt-5.5-pro':[30,180],'gpt-5.4':[2.5,15],'gpt-5.4-pro':[30,180],'gpt-5.4-mini':[0.75,4.5],'gpt-5.4-nano':[0.2,1.25],
 'gpt-5.2':[1.75,14],'gpt-5.2-pro':[21,168],'gpt-5.1':[1.25,10],'gpt-5':[1.25,10],'gpt-5-mini':[0.25,2],'gpt-5-nano':[0.05,0.4],'gpt-5-pro':[15,120],
 'gpt-4.1':[2,8],'gpt-4.1-mini':[0.4,1.6],'gpt-4o':[2.5,10],'gpt-4o-mini':[0.15,0.6],'o3-pro':[20,80],'o3':[2,8],
 'claude-opus-5-5':[4,20],'claude-opus-5':[5,25],'claude-opus-4-8':[5,25],'claude-opus-4-7':[5,25],'claude-opus-4-6':[5,25],'claude-opus-4-5':[5,25],'claude-opus-4-1':[15,75],
 'claude-sonnet-5-5':[2,10],'claude-sonnet-5':[2,10],'claude-sonnet-4-6':[3,15],'claude-sonnet-4-5':[3,15],
 'claude-haiku-5-5':[0.1,0.5],'claude-haiku-4-5':[1,5],
 'gemini-4-carbon':[2,10],'gemini-4-argon':[2,10],'gemini-4-hydrogen':[1.5,7.5],
 'gemini-3.8-flash':[0.75,3.75],'gemini-3.6-flash':[0.75,3.75],'gemini-3.5-flash-lite':[0.3,2.5],
 'gemini-3.1-pro-preview':[2,12],'gemini-3.1-flash-lite':[0.25,1.5],'gemini-3-flash-preview':[0.5,3],'gemini-2.5-pro':[1.25,10]
}));
// Exact id first, then the same id without a provider prefix or a dated snapshot suffix.
export function priceFor(model){
 if(typeof model!=='string'||!model||model.length>200)return null;
 const bare=model.toLowerCase().replace(/^(?:openai|anthropic|google|models)\//,'');
 for(const id of [bare,bare.replace(/-(?:\d{4}-\d{2}-\d{2}|\d{8}|latest)$/,'')]){const price=TABLE.get(id);if(price)return {id,input:price[0],output:price[1]};}
 return null;
}

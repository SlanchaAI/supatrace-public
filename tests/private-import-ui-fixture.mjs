// Exercise retained private-checkout workflows without advertising unavailable forms.
export async function enablePrivateImportUi(context) {
 await context.addInitScript(() => {
  new MutationObserver(() => {
   for (const card of document.querySelectorAll('#langfuse-import-card,.braintrust-card,.langsmith-card')) if(card.hidden)card.hidden=false;
  }).observe(document, {childList:true,subtree:true,attributes:true,attributeFilter:['hidden']});
 });
}

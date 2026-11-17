// Fixed vocabulary only: SDK messages, stacks, request data and identifiers can contain secrets.
const names=new Set(['Error','TypeError','ReferenceError','RangeError','TransactionCanceledException','TransactionConflictException','ConditionalCheckFailedException','ProvisionedThroughputExceededException','ThrottlingException','RequestLimitExceeded','InternalServerError','ServiceUnavailable','TimeoutError','AccessDeniedException','ValidationException','ResourceNotFoundException']);
const reasons=new Set(['None','ConditionalCheckFailed','TransactionConflict','ProvisionedThroughputExceeded','ThrottlingError','ValidationError','ItemCollectionSizeLimitExceeded']);
export function apiDiagnostic(error,phase,emit){
 try{
  const status=error?.$metadata?.httpStatusCode;
  emit?.({event:'api_unexpected_error',phase:phase==='handler'?'handler':'api',error:names.has(error?.name)?error.name:'Error',sdk_status:Number.isInteger(status)&&status>=100&&status<=599?status:0,cancellation_codes:Array.isArray(error?.CancellationReasons)?error.CancellationReasons.slice(0,100).map(reason=>reasons.has(reason?.Code)?reason.Code:'Unknown'):[]});
 }catch{/* Diagnostics must never change the response. */}
}

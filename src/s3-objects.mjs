import {createHash} from 'node:crypto';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export class ObjectStoreError extends Error {constructor(code){super(code);this.code=code;}}
// Inject the official SDK client/commands so tests never require AWS credentials.
export class S3Objects {
 constructor({client,commands,bucket,maxBytes=524288}) {if(!bucket)throw new ObjectStoreError('bucket_required');Object.assign(this,{client,commands,bucket,maxBytes});}
 key(key){if(!/^v1\/[a-f0-9]{64}\/[a-f0-9]{64}\.json$/.test(key))throw new ObjectStoreError('invalid_object_key');return key;}
 async putImmutable(key,raw,expectedHash){
  this.key(key);const bytes=Buffer.from(raw);if(bytes.length>this.maxBytes||sha(bytes)!==expectedHash)throw new ObjectStoreError('invalid_payload');
  try {await this.client.send(new this.commands.PutObjectCommand({Bucket:this.bucket,Key:key,Body:bytes,ContentType:'application/json',ServerSideEncryption:'AES256',IfNoneMatch:'*',ChecksumSHA256:Buffer.from(expectedHash,'hex').toString('base64')}));}
  catch(e){if(e?.$metadata?.httpStatusCode!==412&&e?.name!=='PreconditionFailed')throw new ObjectStoreError('object_write_unavailable');const old=await this.get(key);if(sha(Buffer.from(old))!==expectedHash)throw new ObjectStoreError('object_conflict');}
 }
 async get(key){
  this.key(key);let response;try{response=await this.client.send(new this.commands.GetObjectCommand({Bucket:this.bucket,Key:key,ChecksumMode:'ENABLED'}));}catch{throw new ObjectStoreError('object_read_unavailable');}
  if(response.ContentLength>this.maxBytes){response.Body?.destroy?.();throw new ObjectStoreError('stored_payload_too_large');}
  let size=0,chunks=[];for await(const chunk of response.Body){const bytes=Buffer.from(chunk);size+=bytes.length;if(size>this.maxBytes){response.Body?.destroy?.();throw new ObjectStoreError('stored_payload_too_large');}chunks.push(bytes);}
  const bytes=Buffer.concat(chunks);const expected=key.slice(-69,-5);if(sha(bytes)!==expected)throw new ObjectStoreError('stored_content_mismatch');return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
 }
}

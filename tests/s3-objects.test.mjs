import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {S3Objects} from '../src/s3-objects.mjs';
const raw='{"safe":true}',hash=createHash('sha256').update(raw).digest('hex'),key=`v1/${'a'.repeat(64)}/${hash}.json`;
class PutObjectCommand{constructor(input){this.input=input;}}class GetObjectCommand{constructor(input){this.input=input;}}
function store(send){return new S3Objects({bucket:'synthetic',commands:{PutObjectCommand,GetObjectCommand},client:{send}});}
const body=async function*(text){yield Buffer.from(text)};
test('immutable put binds conditional create and checksum to exact bytes',async()=>{let seen;await store(async c=>{seen=c.input}).putImmutable(key,raw,hash);assert.equal(seen.IfNoneMatch,'*');assert.equal(seen.ChecksumSHA256,Buffer.from(hash,'hex').toString('base64'));assert.equal(seen.Body.toString(),raw);});
test('lost put response retry verifies existing identical object',async()=>{let calls=0;const s=store(async c=>{calls++;if(c instanceof PutObjectCommand)throw {name:'PreconditionFailed'};return{Body:body(raw)}});await s.putImmutable(key,raw,hash);assert.equal(calls,2)});
test('existing corrupted bytes cannot receive acceptance',async()=>{await assert.rejects(store(async c=>{if(c instanceof PutObjectCommand)throw {name:'PreconditionFailed'};return{Body:body('wrong')}}).putImmutable(key,raw,hash),/stored_content_mismatch/)});
test('network failure does not masquerade as durable put',async()=>{await assert.rejects(store(async()=>{throw Error('network')}).putImmutable(key,raw,hash),/object_write_unavailable/)});
test('wrong digest and unsafe object key rejected before transport',async()=>{const s=store(async()=>assert.fail());await assert.rejects(s.putImmutable(key,raw,'b'.repeat(64)),/invalid_payload/);await assert.rejects(s.get('../secret'),/invalid_object_key/)});
test('read bounded even when declared size is absent',async()=>{const s=store(async()=>({Body:body('x'.repeat(524289))}));await assert.rejects(s.get(key),/stored_payload_too_large/)});

import test from 'node:test';
import assert from 'node:assert/strict';
import {selectLinuxMount} from '../src/private-host-readiness.mjs';
const root='10 1 259:1 / / rw,relatime - xfs /dev/nvme0n1p1 rw';
test('Linux readiness selects the longest mount boundary with decoded paths and device/source identity',()=>{
 const text=root+'\n11 10 259:2 / /srv/private rw - ext4 /dev/nvme1n1 rw\n12 10 259:3 / /srv/private-copy ro - ext4 /dev/nvme2n1 ro\n';
 assert.deepEqual(selectLinuxMount(text,'/srv/private/run'),{point:'/srv/private',device:'259:2',root:'/',filesystem:'ext4',source:'/dev/nvme1n1',writable:true});
 assert.equal(selectLinuxMount(text,'/srv/private-other/run').point,'/');
 assert.equal(selectLinuxMount(text,'/srv/private-copy/run').writable,false);
 assert.equal(selectLinuxMount(root+'\n13 10 259:4 / /srv/has\\040space rw - ext4 /dev/disk\\134name rw\n','/srv/has space/run').source,'/dev/disk\\name');
});
test('Linux mount parsing fails closed on malformed/oversized/relative input',()=>{
 for(const text of ['',root.replace('259:1','bad'),root.replace(' / / ',' / relative '),'x'.repeat(1048577),root+' - extra'])assert.throws(()=>selectLinuxMount(text,'/srv/run'),/unverified/);
 assert.throws(()=>selectLinuxMount(root,'relative'),/unverified/);
});

test('stacked mounts at the selected point are ambiguous even on the same source/device',()=>{
 const first='11 10 8:16 / /data rw - ext4 /dev/sdb rw',hidden='12 10 8:16 /other-root /data rw - ext4 /dev/sdb rw';
 for(const pair of [first+'\n'+hidden,hidden+'\n'+first,first+'\n'+first])assert.throws(()=>selectLinuxMount(root+'\n'+pair,'/data/job'),/unverified/);
 const child='13 10 8:17 / /data/child rw - ext4 /dev/sdc rw';
 assert.equal(selectLinuxMount(root+'\n'+first+'\n'+hidden+'\n'+child,'/data/child/job').source,'/dev/sdc');
});

test('writable readiness requires unambiguous rw in both mount and superblock options',()=>{
 for(const [mount,superblock]of [['rw','ro'],['ro','rw'],['rw,ro','rw'],['rw','rw,ro'],['rw','nosuid']])assert.equal(selectLinuxMount('10 1 8:16 / /data '+mount+' - ext4 /dev/vdb '+superblock,'/data/run').writable,false);
 assert.equal(selectLinuxMount('10 1 8:16 / /data rw,relatime - ext4 /dev/vdb rw,errors=remount-ro','/data/run').writable,true);
});

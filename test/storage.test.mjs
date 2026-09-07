import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import {readState,updateState,clearUserState,recoverLegacyState} from '../src/storage.js';

test('offline caches, drafts and queued writes remain scoped through account switches and logout',async()=>{
  const a='account-a',b='account-b';
  await updateState(a,{entries:[{id:'a-private'}],queue:[{operationId:'a-unsent'}],draft:'a-draft'});
  assert.deepEqual((await readState(b)).entries,[]);
  await Promise.all(Array.from({length:10},(_,i)=>updateState(b,s=>({...s,queue:[...s.queue,{operationId:String(i)}]}))));
  assert.equal((await readState(b)).queue.length,10);
  assert.equal((await readState(a)).draft,'a-draft');
  await clearUserState(a);
  assert.deepEqual(await readState(a),{entries:[],queue:[],draft:''});
  assert.equal((await readState(b)).queue.length,10);
});

test('only the owner recovers legacy drafts, and subsequent cache edits survive recovery',async()=>{
  await new Promise((resolve,reject)=>{const r=indexedDB.open('joybeat-me-v1',1);r.onupgradeneeded=()=>r.result.createObjectStore('state');r.onsuccess=()=>{const db=r.result,tx=db.transaction('state','readwrite');tx.objectStore('state').put({entries:[{id:'legacy'}],queue:[{operationId:'offline'}],draft:'legacy draft'},'main');tx.oncomplete=()=>{db.close();resolve();};};r.onerror=()=>reject(r.error);});
  await recoverLegacyState({id:'member',role:'member'});
  assert.deepEqual((await readState('member')).entries,[]);
  await recoverLegacyState({id:'owner',role:'owner'});
  assert.equal((await readState('owner')).draft,'legacy draft');
  await updateState('owner',s=>({...s,draft:'new draft'}));
  await recoverLegacyState({id:'owner',role:'owner'});
  assert.equal((await readState('owner')).draft,'new draft');
  await clearUserState('owner');
  await recoverLegacyState({id:'owner',role:'owner'});
  assert.equal((await readState('owner')).draft,'');
  assert.deepEqual((await readState('owner')).entries,[]);
});

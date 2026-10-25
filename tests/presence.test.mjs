import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request} from 'node:http';
import {PresenceRegistry} from '../apps/world-service/src/public-observer/presence.ts';
import {startDemo} from '../apps/world-service/src/demo/engine.ts';
function post(port,origin,active=true){const raw=JSON.stringify({session:'a'.repeat(32),active});return new Promise((resolve,reject)=>{const q=request({host:'127.0.0.1',port,path:'/presence',method:'POST',headers:{host:origin.replace('http://',''),origin,'content-type':'application/json','content-length':Buffer.byteLength(raw)}},r=>{let data='';r.on('data',c=>data+=c);r.on('end',()=>resolve({status:r.statusCode,headers:r.headers,body:JSON.parse(data)}))});q.on('error',reject);q.end(raw)})}

test('ephemeral local viewing sessions expire and never represent unique humans',()=>{let now=0;const p=new PresenceRegistry(()=>now);assert.equal(p.heartbeat('a'.repeat(32),true),1);now=45000;assert.equal(p.count(),0);p.close();assert.throws(()=>p.count())});

test('synthetic HTTP uses the real presence handler with explicit local viewer origin and clears it on restart',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'meridian-public-presence-'));let server;const origin='http://127.0.0.1:5173';try{
  server=await startDemo({directory,port:0,tickMilliseconds:60000,viewerOrigin:origin});
  const good=await post(server.port,origin);assert.equal(good.status,200);assert.deepEqual(good.body,{activeSessions:1});assert.equal(good.headers['cache-control'],'no-store');
  const denied=await post(server.port,'http://localhost:5173');assert.equal(denied.status,403);
  await server.close();server=await startDemo({directory,port:0,tickMilliseconds:60000,viewerOrigin:origin});
  const gone=await post(server.port,origin,false);assert.equal(gone.status,200);assert.deepEqual(gone.body,{activeSessions:0});
 }finally{await server?.close();rmSync(directory,{recursive:true,force:true})}
});

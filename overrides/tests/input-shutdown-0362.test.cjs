'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DriverSession}=require('../src/windows-input-driver.js');
test('closing a session requests driver shutdown before closing stdin',async()=>{
 const sent=[];let receive,closed=false;
 const transport={onMessage(fn){receive=fn;},onExit(){},write(msg){sent.push(msg);queueMicrotask(()=>receive({id:msg.id,ok:true}));},close(){closed=true;}};
 await new DriverSession(transport).close();
 assert.equal(sent.length,1);assert.equal(sent[0].cmd,'shutdown');assert.equal(closed,true);
});
test('closing a failed driver still closes its transport',async()=>{
 let closed=false;
 const transport={onMessage(){},onExit(){},write(){throw Error('driver gone');},close(){closed=true;}};
 await new DriverSession(transport).close();assert.equal(closed,true);
});

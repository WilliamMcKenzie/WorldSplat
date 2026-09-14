import test from 'node:test'
import assert from 'node:assert/strict'
import { createTabSync } from '../scripts/tab-sync.js'

test('slow saves serialize and coalesce newer snapshots without overwriting them', async () => {
 const sent=[]; let release
 const sync=createTabSync(async tabs=>{sent.push(tabs);if(sent.length===1)await new Promise(resolve=>release=resolve)})
 sync.queue([{name:'first'}]);const pending=sync.flush()
 sync.queue([{name:'second'}]);sync.queue([{name:'latest'}]);assert.equal(sync.dirty,true)
 release();await pending
 assert.deepEqual(sent,[[{name:'first'}],[{name:'latest'}]])
 assert.equal(sync.dirty,false)
})
test('a failed save retains the newest unsaved data for retry',async()=>{
 let fail=true;const sent=[];const states=[]
 const sync=createTabSync(async tabs=>{sent.push(tabs);if(fail)throw new Error('offline')},state=>states.push(state))
 sync.queue([{name:'unsaved'}]);await assert.rejects(sync.flush(),/offline/)
 assert.equal(sync.dirty,true)
 sync.queue([{name:'latest'}]);fail=false;await sync.flush()
 assert.deepEqual(sent.at(-1),[{name:'latest'}]);assert.equal(sync.dirty,false);assert.ok(states.includes('error'))
})
test('queued snapshots are copied so later edits do not mutate an in-flight save',async()=>{
 let sent;const sync=createTabSync(async tabs=>{sent=tabs})
 const tabs=[{name:'original'}];sync.queue(tabs);tabs[0].name='changed';await sync.flush()
 assert.equal(sent[0].name,'original')
})

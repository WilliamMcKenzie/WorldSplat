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

test('saving the current tab preserves other saved versions and excludes new unsaved tabs', async () => {
 const original = [{id:'a',name:'A'}, {id:'b',name:'B'}]
 let sent
 const sync = createTabSync(async tabs => { sent = tabs }, undefined, original)
 const edited = [{id:'a',name:'A edited'}, {id:'b',name:'B edited'}, {id:'c',name:'New'}]
 sync.queueTab(edited, 'a'); await sync.flush()
 assert.deepEqual(sent, [{id:'a',name:'A edited'}, original[1]])
 assert.equal(sync.isTabDirty(edited[0]), false)
 assert.equal(sync.isTabDirty(edited[1]), true)
 assert.equal(sync.isTabDirty(edited[2]), true)
})
test('dirty state clears only after acknowledgement and preserves edits made during a save', async () => {
 let release
 const sync = createTabSync(() => new Promise(resolve => { release = resolve }))
 const tab = {id:'a',name:'First'}
 sync.queueTab([tab], 'a'); const pending = sync.flush()
 assert.equal(sync.isTabDirty(tab), true)
 tab.name = 'Second'; release(); await pending
 assert.equal(sync.isTabDirty(tab), true)
 assert.equal(sync.isTabDirty({id:'a',name:'First'}), false)
})
test('saving another tab during an in-flight save retains both explicit saves', async () => {
 const sent = []; let release
 const sync = createTabSync(async tabs => { sent.push(tabs); if (sent.length === 1) await new Promise(resolve => { release = resolve }) })
 const tabs = [{id:'a',name:'A'}, {id:'b',name:'B'}]
 sync.queueTab(tabs, 'a'); const first = sync.flush()
 sync.queueTab(tabs, 'b'); const second = sync.flush()
 release(); await Promise.all([first, second])
 assert.deepEqual(sent, [[tabs[0]], tabs])
 assert.equal(sync.hasChanges(tabs), false)
})
test('failed manual saves remain dirty until explicitly retried', async () => {
 let fail = true
 const sync = createTabSync(async () => { if (fail) throw new Error('offline') })
 const tabs = [{id:'a',name:'A'}]
 sync.queueTab(tabs, 'a'); await assert.rejects(sync.flush(), /offline/)
 assert.equal(sync.isTabDirty(tabs[0]), true)
 fail = false; sync.queueTab(tabs, 'a'); await sync.flush()
 assert.equal(sync.isTabDirty(tabs[0]), false)
})
test('snapshot key order and clean restored normalization do not count as edits', () => {
 const tab = {id:'a',snapshot:{prompt:'A',prims:[]}}
 const sync = createTabSync(async () => {}, undefined, [tab])
 assert.equal(sync.isTabDirty({snapshot:{prims:[],prompt:'A'},id:'a'}), false)
 const normalized = {...tab,snapshot:{...tab.snapshot,baseGroundColor:'#fff'}}
 sync.normalizeSavedTab(normalized)
 assert.equal(sync.isTabDirty(normalized), false)
 assert.equal(sync.isTabDirty({...normalized,name:'Renamed'}), true)
})

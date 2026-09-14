import test from 'node:test'
import assert from 'node:assert/strict'
import { configureBackend, apiRequest, loginWithGoogle, restoreAccount, getAccount, SESSION_KEY, sessionToken } from '../scripts/backend.js'

test('Google credentials create backend sessions; saved sessions restore without resending Google credentials', async t=>{
 const values=new Map();globalThis.localStorage={getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)}
 globalThis.location={origin:'https://frontend.example'}
 configureBackend({backend:{googleClientId:'client.apps.googleusercontent.com',apiBaseURL:'https://api.example'}})
 const requests=[];const original=globalThis.fetch;t.after(()=>globalThis.fetch=original)
 globalThis.fetch=async(url,options)=>{requests.push({url,options});return Response.json(url.endsWith('/login')?{token:'session-token',user:{id:'u1',tabs:[]}}:{id:'u1',tabs:[]})}
 await loginWithGoogle('google-id-token')
 assert.equal(JSON.parse(requests[0].options.body).token,'google-id-token')
 assert.equal(requests[0].options.headers.has('Authorization'),false)
 assert.equal(sessionToken(),'session-token')
 await restoreAccount();assert.equal(getAccount().id,'u1')
 assert.equal(requests[1].options.headers.get('Authorization'),'Bearer session-token')
 assert.equal(requests[1].url,'https://api.example/me')
 globalThis.fetch=async()=>Response.json({error:'expired'},{status:401})
 assert.equal(await restoreAccount(),null);assert.equal(values.has(SESSION_KEY),false)
})
test('API paths cannot redirect a bearer to a different origin',async()=>{
 globalThis.location={origin:'https://frontend.example'}
 configureBackend({backend:{googleClientId:'client',apiBaseURL:'https://api.example'}})
 await assert.rejects(apiRequest('//evil.example/'),/Invalid API path/)
 assert.throws(()=>configureBackend({backend:{googleClientId:'client',apiBaseURL:'http://evil.example'}}),/HTTPS/)
})

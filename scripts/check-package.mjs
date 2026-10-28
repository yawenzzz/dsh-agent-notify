import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root=fileURLToPath(new URL('..',import.meta.url))
const manifest=JSON.parse(await readFile(join(root,'package.json'),'utf8'))
const lock=JSON.parse(await readFile(join(root,'package-lock.json'),'utf8'))
assert.equal(lock.version,manifest.version)
assert.equal(lock.packages[''].version,manifest.version)
for(const [name,entry] of Object.entries(lock.packages)){
  assert.ok(!entry.link,'Linked dependency in lockfile: '+name)
  if(!entry.resolved)continue
  const url=new URL(entry.resolved)
  assert.equal(url.protocol,'https:','Non-HTTPS dependency: '+name)
  assert.equal(url.hostname,'registry.npmjs.org','Dependency must use the public npm registry: '+name)
  assert.equal(url.username,'');assert.equal(url.password,'')
}
for(const dependencies of [manifest.dependencies,manifest.peerDependencies,manifest.devDependencies]){
  for(const [name,version] of Object.entries(dependencies??{})){
    assert.ok(!/^(file:|link:|\/|\.\.?\/)/.test(version),'Local dependency is not publishable: '+name)
    if(name.startsWith('@deepseek-ai/dsh'))assert.equal(version,manifest.engines.dsh,'DSH release must be pinned: '+name)
  }
}
console.log('Package versions, DSH pins and public-registry lockfile verified.')

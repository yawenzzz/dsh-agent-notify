import { execFileSync } from 'node:child_process'
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Script } from 'node:vm'
import { build } from 'esbuild'
import { transform } from 'lightningcss'

const root = fileURLToPath(new URL('..',import.meta.url))
const manifest = JSON.parse(await readFile(join(root,'package.json'),'utf8'))
await rm(join(root,'dist'),{recursive:true,force:true})
execFileSync(process.execPath,[join(root,'node_modules/typescript/bin/tsc'),'-p','tsconfig.build.json'],{cwd:root,stdio:'inherit'})
await build({absWorkingDir:root,entryPoints:['dist/types/index.js'],outfile:'dist/index.js',
  platform:'node',target:'node24',format:'esm',bundle:true,packages:'external'})
const styles = new Map()
const client = await build({
  absWorkingDir:root,entryPoints:['dist/types/client/index.js'],platform:'browser',target:'es2022',
  format:'cjs',bundle:true,write:false,external:['react','react/jsx-runtime','react-dom','@deepseek-ai/*'],
  plugins:[{name:'notify-css',setup(builder){
    builder.onResolve({filter:/\.module\.css$/},args=>({
      path:join(root,'src',relative(join(root,'dist/types'),resolve(args.resolveDir,args.path))),namespace:'notify-css'}))
    builder.onLoad({filter:/.*/,namespace:'notify-css'},async args=>{
      const transformed=transform({filename:relative(root,args.path),code:await readFile(args.path),cssModules:{pattern:'notify_[local]_[hash]'},minify:true})
      styles.set(args.path,transformed.code.toString())
      return {contents:'export default '+JSON.stringify(Object.fromEntries(Object.entries(transformed.exports??{}).map(([key,value])=>[key,value.name]))),loader:'js'}
    })
  }}],
})
const css=[...styles.values()].join('\n')
const factory = [
  'window.__ModuleLoader__.load({id:'+JSON.stringify(manifest.name)+',factory:(require)=>{',
  'const plugin=(()=>{const module={exports:{}};const exports=module.exports;',
  client.outputFiles[0].text,
  'return module.exports;})();',
  'return {...plugin,apply(ctx,...args){ctx.effect(()=>{const style=document.createElement("style");style.dataset.plugin='+JSON.stringify(manifest.name)+';style.textContent='+JSON.stringify(css)+';const script=document.querySelector("script[nonce]");if(script)style.nonce=script.nonce;document.head.append(style);return()=>style.remove()});return plugin.apply(ctx,...args)}};',
  '}});',
].join('\n')+'\n'
new Script(factory)
await mkdir(join(root,'dist'),{recursive:true})
await writeFile(join(root,'dist/client.js'),factory)
console.log('Built '+manifest.name+'@'+manifest.version+'; official DSH modules remain external.')

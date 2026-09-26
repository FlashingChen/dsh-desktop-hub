#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { execSync } from 'node:child_process'

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const credPath = join(dshHome, '.credentials.yaml')
const credBackup = join(dshHome, `.credentials.yaml.smoke-orig-${Date.now()}`)
const results = []
function log(s){ console.log(s) }
function assert(cond, msg){ if(!cond) throw new Error(msg) }

async function run(){
  log(`=== Smoke Windows ${new Date().toISOString()} ===`)
  log(`DSH_HOME=${dshHome} credPath=${credPath}`)
  // 轻量备份：只备份凭据文件
  if(existsSync(credPath)){
    cpSync(credPath, credBackup)
    log(`[backup cred] ${credPath} -> ${credBackup} : ${readFileSync(credPath,'utf8').slice(0,80)}`)
  } else {
    log(`[backup] no cred file, will create`)
  }
  const bakListBefore = readdirSync(dshHome).filter(f=>f.startsWith('.credentials.yaml.bak-'))
  log(`[baks before] ${bakListBefore.join(',')||'none'}`)

  let mod
  try{ mod = await import('../dist/core/credentials-migration.js') }catch{ mod = await import('./dist/core/credentials-migration.js') }
  const { checkCredentialsFile, backupAndMigrate } = mod
  let diagMod
  try{ diagMod = await import('../dist/core/diagnostics.js') }catch{ diagMod = await import('./dist/core/diagnostics.js') }

  function dumpCred(){ try{ return readFileSync(credPath,'utf8')}catch{ return '<missing>' } }
  function writeCred(text){ mkdirSync(dirname(credPath),{recursive:true}); writeFileSync(credPath,text,'utf8') }
  function listBaks(){ try{ return readdirSync(dshHome).filter(f=>f.startsWith('.credentials.yaml.bak-')) }catch{ return [] } }
  function dshDumpConfig(){
    try{
      const nodeBin = join(process.cwd(),'resources','nd','node.exe')
      const binJs = join(process.cwd(),'resources','rt','node_modules','@deepseek-ai','dsh','lib','bin.js')
      const out = execSync(`"${nodeBin}" "${binJs}" --profile web --dump-config`, {encoding:'utf8', timeout:8000})
      return {ok:true, lines: out.split('\n').length}
    }catch(e){ return {ok:false, error: String(e.message||e).slice(0,600)} }
  }
  async function caseRun(name, setup, expect){
    log(`\n--- CASE: ${name} ---`)
    try{
      setup()
      const before = checkCredentialsFile(credPath)
      log(` before format=${before.format} text=${JSON.stringify((before.text||'').slice(0,100))}`)
      const r = backupAndMigrate(credPath)
      log(` result ${JSON.stringify(r)}`)
      const after = checkCredentialsFile(credPath)
      log(` after format=${after.format}`)
      log(` cred:\n${dumpCred().slice(0,400)}`)
      log(` baks: ${listBaks().join(',')}`)
      const dump = dshDumpConfig()
      log(` dump-config ok=${dump.ok} ${dump.ok?`lines=${dump.lines}`:dump.error.slice(0,200)}`)
      if(expect) expect({before, r, after, dump})
      results.push({name, ok:true})
      log(` ✅ ${name} PASS`)
    }catch(e){
      results.push({name, ok:false, error:String(e.stack||e)})
      log(` ❌ ${name} FAIL: ${e.stack||e}`)
    }
  }

  await caseRun('1-missing (clean install)', ()=>{
    try{ rmSync(credPath) }catch{}
    listBaks().forEach(f=>{try{rmSync(join(dshHome,f))}catch{}})
  }, ({before,r})=>{
    assert(before.format==='missing','expected missing')
    assert(r.ok && r.migrated===false,'missing should not migrate')
  })

  await caseRun('2-empty', ()=>{
    writeCred('')
  }, ({before,r})=>{
    assert(before.format==='empty','expected empty')
    assert(r.ok && !r.migrated,'empty should not migrate')
  })

  await caseRun('3-flat->versioned', ()=>{
    writeCred('DEEPSEEK_API_KEY: sk-EXAMPLE-KEY-FOR-TEST-ONLY-111111\nOTHER_KEY: sk-EXAMPLE-OTHER\n')
  }, ({before,r,after,dump})=>{
    assert(before.format==='flat','expected flat')
    assert(r.ok && r.migrated && r.formatAfter==='versioned','should migrate')
    assert(after.format==='versioned','after versioned')
    assert(dump.ok,'dump ok')
    const t=readFileSync(credPath,'utf8')
    assert(t.startsWith('version: 1\nrefs:\n'),'header')
    assert(t.includes('  DEEPSEEK_API_KEY:'),'indent')
  })

  await caseRun('4-versioned idempotent', ()=>{}, ({before,r})=>{
    assert(before.format==='versioned','expected versioned')
    assert(r.ok && !r.migrated,'idempotent')
  })

  await caseRun('5-version "1" string fix', ()=>{
    writeCred('version: "1"\nrefs:\n  DEEPSEEK_API_KEY: sk-EXAMPLE-TEST-STRING\n')
  }, ({before,r,after})=>{
    assert(before.format==='unknown','string version unknown')
    assert(r.ok && r.migrated,'should fix')
    assert(after.format==='versioned','after versioned')
    const t=readFileSync(credPath,'utf8')
    assert(t.includes('version: 1\n') && !t.includes('"1"'),'fixed')
  })

  await caseRun('6-version single quotes', ()=>{
    writeCred("version: '1'\nrefs:\n  DEEPSEEK_API_KEY: sk-EXAMPLE-TEST2\n")
  }, ({r,after})=>{
    assert(r.ok && r.migrated)
    assert(after.format==='versioned')
  })

  await caseRun('7-corrupted yaml', ()=>{
    writeCred('DEEPSEEK_API_KEY: [unclosed\n  bad: : :\n')
  }, ({before,r})=>{
    assert(before.format==='unknown','corrupted unknown')
    assert(!r.ok,'should fail')
  })

  await caseRun('8-extra key unknown', ()=>{
    writeCred('version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-EXAMPLE-X\nunknownKey: 123\n')
  }, ({before,r})=>{
    assert(before.format==='unknown','extra key unknown')
    assert(!r.ok,'should not migrate')
  })

  await caseRun('9-rollback', ()=>{
    writeCred('DEEPSEEK_API_KEY: sk-EXAMPLE-ROLLBACK\n')
    const r=backupAndMigrate(credPath)
    assert(r.ok && r.backupPath,'backup')
    const bakText=readFileSync(r.backupPath,'utf8')
    assert(bakText.includes('sk-EXAMPLE-ROLLBACK') && !bakText.includes('version:'),'backup flat')
    const migrated=readFileSync(credPath,'utf8')
    assert(migrated.includes('version: 1'),'migrated')
    writeFileSync(credPath, bakText,'utf8')
    const afterRollback=checkCredentialsFile(credPath)
    assert(afterRollback.format==='flat','rollback flat')
    backupAndMigrate(credPath)
  }, ({after})=>{
    assert(after.format==='versioned','final versioned')
  })

  log(`\n--- CASE: 10-diagnostics ---`)
  try{
    const cred=checkCredentialsFile(credPath)
    const { formatDiagnostics, DIAGNOSTIC_FORMAT_VERSION } = diagMod
    const text=formatDiagnostics({
      formatVersion: DIAGNOSTIC_FORMAT_VERSION,
      generatedAt: new Date().toISOString(),
      appVersion: '0.1.0-test', packaged:false, profile:'web', platform:'win32', osRelease:'10', arch:'x64',
      electronVersion:'43', chromeVersion:'120', nodeVersion:process.versions.node,
      dshVersion:'0.1.1-rc.2', pnpmVersion:'11.22.0', harnessState:'ready', harnessExitCode:null,
      credentialsFormat: cred.format,
    })
    log(text.split('\n').slice(0,22).join('\n'))
    assert(text.includes('Credentials format'),'has cred')
    assert(text.includes('versioned'),'versioned')
    const dump=dshDumpConfig()
    assert(dump.ok,'dump ok')
    results.push({name:'10-diagnostics', ok:true})
    log(` ✅ 10-diagnostics PASS`)
  }catch(e){ results.push({name:'10-diagnostics', ok:false, error:String(e)}); log(` ❌ 10-diagnostics FAIL ${e.stack||e}`) }

  log(`\n=== SUMMARY ===`)
  results.forEach(r=> log(`${r.ok?'✅':'❌'} ${r.name} ${r.error||''}`))
  const fail=results.filter(r=>!r.ok)
  log(`Total ${results.length} pass ${results.length-fail.length} fail ${fail.length}`)
  if(fail.length) throw new Error(`${fail.length} failed`)
  writeCred('version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-EXAMPLE-KEY-FOR-TEST-ONLY-111111\n')
  log(`[final cred]\n${readFileSync(credPath,'utf8')}`)
  log(`[baks] ${listBaks().join(', ')}`)
  if(existsSync(credBackup)){
    log(`[orig backup kept at] ${credBackup}`)
  }
}
run().catch(e=>{ console.error(e); process.exit(1) })

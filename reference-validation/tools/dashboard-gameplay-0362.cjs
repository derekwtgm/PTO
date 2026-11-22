'use strict';
const fs=require('fs'),path=require('path'),cp=require('child_process'),{chromium}=require('playwright');
const B=require('./simulator-benchmark-035.cjs'),SC=require('../src/simulator-controls.js');
const arg=(k,d)=>{const i=process.argv.indexOf('--'+k);return i<0?d:process.argv[i+1];};
const WORK=path.resolve(arg('work','dashboard-gameplay-work'));fs.mkdirSync(WORK,{recursive:true});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
 let host,browser,page,api;const started=Date.now(),report={format:'eightmax-dashboard-gameplay',version:1,startedAt:new Date(started).toISOString(),ok:false},errors=[];
 try{
  host=B.startHost();const ready=await B.waitReady(host.ready);api=new SC.HostApi({token:ready.token,fetch});
  browser=await chromium.launch({headless:false,args:['--window-size=1000,700']});page=await browser.newPage({viewport:{width:980,height:650},acceptDownloads:true});page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  await page.goto(ready.origin+'/#desktop-token='+ready.token);await page.click('#simc-nav');await page.click('#simc-launch');
  const setup=path.join(WORK,'start-dialog.ps1');fs.writeFileSync(setup,`Add-Type -AssemblyName UIAutomationClient\nAdd-Type -AssemblyName UIAutomationTypes\n$deadline=(Get-Date).AddSeconds(30)\ndo {\n $form=[System.Windows.Automation.AutomationElement]::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children,(New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,'EightMax controlled tournament setup')))\n if($form){break};Start-Sleep -Milliseconds 200\n} while((Get-Date) -lt $deadline)\nif(-not $form){throw 'Simulator setup dialog did not appear'}\n$button=$form.FindFirst([System.Windows.Automation.TreeScope]::Descendants,(New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,'Start simulator')))\nif(-not $button){throw 'Start simulator button missing'}\n$invoke=$button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)\n$button.SetFocus()\nAdd-Type -AssemblyName System.Windows.Forms\n[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')\nStart-Sleep -Milliseconds 500\n`);
  const result=cp.spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',setup],{encoding:'utf8',timeout:45000});if(result.status!==0)throw Error('Simulator dialog: '+result.stdout+result.stderr);
  let hwnd;
  for(let i=0;i<30;i++){await page.click('#simc-list');await sleep(500);const opts=await page.locator('#simc-window option').evaluateAll(es=>es.map(e=>({value:e.value,text:e.textContent})));const found=opts.find(o=>o.text.includes('EightMax Test Table 01'));if(found){hwnd=found.value;break;}}
  if(!hwnd)throw Error('Launched simulator window not listed: '+await page.locator('#simc-window').innerText());await page.selectOption('#simc-window',hwnd);
  for(const id of ['simc-own','simc-test','simc-nomoney'])await page.check('#'+id);
  await page.click('#simc-register');await page.waitForFunction(()=>document.getElementById('simc-status').textContent.startsWith('Registered'),null,{timeout:15000});
  await page.check('#simc-scripted');await page.selectOption('#simc-set-pattern','straight');await page.fill('#simc-set-maxSpeed','1200');await page.click('#simc-save-settings');await sleep(300);
  await page.screenshot({path:path.join(WORK,'dashboard-ready.png'),fullPage:true});await page.click('#simc-start');
  const until=Date.now()+600000;let observed;
  while(Date.now()<until){await sleep(1000);observed=await page.evaluate(()=>{const s=window.WorkbenchSimulatorControlsUi.state,t=s.tables[0];return {running:s.running,status:document.getElementById('simc-status').textContent,table:t?{state:t.state,paused:t.paused,report:t.report(),log:t.log}:null};});
   if(observed.table&&observed.table.paused)throw Error('Dashboard paused: '+observed.table.paused);
   if(observed.table){const logs=observed.table.log.filter(e=>e.status==='confirmed');if(observed.table.state&&observed.table.state.hand>=4&&['preflop','flop','turn','river'].every(s=>logs.some(e=>e.street===s))&&logs.some(e=>e.action&&e.action.type==='raise'))break;}
  }
  report.observed=observed;await page.click('#simc-estop');await sleep(750);report.emergencyStatus=await api.request('/api/input/status');
  const download=page.waitForEvent('download');await page.click('#simc-diag');await (await download).saveAs(path.join(WORK,'dashboard-diagnostics.json'));
  await page.screenshot({path:path.join(WORK,'dashboard-stopped.png'),fullPage:true});
  const base=path.join(process.env.LOCALAPPDATA,'EightMax-Test-Workbench','Acceptance-0.36.1');const dirs=fs.readdirSync(base).filter(n=>n.startsWith('manual-')).map(n=>path.join(base,n)).filter(p=>fs.statSync(p).mtimeMs>=started-2000).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs);
  if(!dirs.length)throw Error('Launched simulator oracle not found');const file=path.join(dirs[0],'oracle-table-01.jsonl');const ev=fs.readFileSync(file,'utf8').trim().split(/\r?\n/).map(JSON.parse);fs.copyFileSync(file,path.join(WORK,'oracle-table-01.jsonl'));
  const complete=ev.filter(e=>e.kind==='hand-complete').map(e=>e.hand),first=new Set(complete.slice(0,3));const confirmed=observed.table.log.filter(e=>e.status==='confirmed'&&first.has(e.hand)),applied=ev.filter(e=>e.kind==='action'&&e.result==='accepted'&&first.has(e.applied.hand)).map(e=>e.applied);
  const matched=confirmed.length===applied.length&&confirmed.every((e,i)=>e.hand===applied[i].hand&&e.seat===applied[i].seat&&e.action.type===applied[i].type&&(e.action.type!=='raise'||e.action.amount===applied[i].amount));
  report.completedHands=complete;report.confirmedActionsInFirstThree=confirmed.length;report.oracleMatched=matched;report.pageErrors=errors;report.streets=[...new Set(confirmed.map(e=>e.street))];report.wagerActions=confirmed.filter(e=>e.action.type==='raise').length;
  report.ok=complete.length>=3&&matched&&confirmed.length>0&&report.wagerActions>0&&['preflop','flop','turn','river'].every(s=>report.streets.includes(s))&&errors.length===0&&!!report.emergencyStatus.driver.estop;
 }catch(e){report.error=e.stack;if(page)try{report.status=await page.textContent('#simc-status');await page.screenshot({path:path.join(WORK,'dashboard-failure.png'),fullPage:true});}catch(_){}}
 finally{
  if(api)try{await api.request('/api/input/estop',{});await api.request('/api/desktop/shutdown',{});}catch(_){}
  if(browser)await browser.close();if(host)try{host.child.kill();}catch(_){}
  report.completedAt=new Date().toISOString();fs.writeFileSync(path.join(WORK,'dashboard-gameplay.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({ok:report.ok,error:report.error,completedHands:report.completedHands}));process.exitCode=report.ok?0:1;
 }
}
main();

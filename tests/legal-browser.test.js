#!/usr/bin/env node
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const http=require('node:http');
const path=require('node:path');
const {chromium}=require('/home/campbell/node_modules/playwright');
const root=path.resolve(__dirname,'..');
(async()=>{
 const server=http.createServer((request,response)=>{const relative=decodeURIComponent(new URL(request.url,'http://localhost').pathname).replace(/^\/+/, '')||'index.html';if(relative==='config.js')return response.writeHead(404).end();const file=path.resolve(root,relative);if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||fs.statSync(file).isDirectory())return response.writeHead(404).end();response.end(fs.readFileSync(file));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
 try {
  for(const entry of ['index.html','app.html']){
   const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}/${entry}`,{waitUntil:'domcontentloaded'});
   if(entry==='app.html')await page.evaluate(()=>App.showLegalModal());
   const notice=page.locator('[data-notices-src]');await notice.waitFor({state:'attached'});await page.waitForFunction(()=>document.querySelector('[data-notices-src]')?.dataset.loaded==='true');
   const measurements=await notice.evaluate(element=>({sections:element.querySelectorAll('section').length,iframe:!!element.querySelector('iframe'),longText:element.textContent.includes('SIL OPEN FONT LICENSE'),horizontal:element.scrollWidth>element.clientWidth,preWrap:getComputedStyle(element.querySelector('pre')).whiteSpace}));
   assert.ok(measurements.sections>5,entry);assert.equal(measurements.iframe,false);assert.ok(measurements.longText);assert.equal(measurements.horizontal,false);assert.equal(measurements.preWrap,'pre-wrap');await page.close();
  }
  console.log('PASS legal browser');
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
})().catch(error=>{console.error(error);process.exitCode=1});

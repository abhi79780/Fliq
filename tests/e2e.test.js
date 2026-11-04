import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base=process.env.FLIQ_TEST_URL||`http://127.0.0.1:${process.env.PORT||3000}`;
let browser;
before(async()=>{browser=await chromium.launch({headless:true})});
after(async()=>{await browser?.close()});

test('every public and app route renders without a browser exception',async()=>{
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const routes=[['/','Find bugs'],['/features','A smarter'],['/pricing','Simple, transparent'],['/docs','Test. Fix. Ship.'],['/blog','Notes from the testing floor'],['/signup','Create your account'],['/login','Welcome back'],['/forgot-password','Reset your password'],['/onboarding','What type of websites'],['/dashboard','Welcome back'],['/dashboard/new-test','What should we test'],['/dashboard/history','Test History'],['/dashboard/reports','Reports'],['/dashboard/monitors','Monitors'],['/dashboard/team','Team'],['/dashboard/settings','Settings'],['/demo','See what your website sees']];
  for(const [route,expected] of routes){await page.goto(base+route);await page.getByText(expected,{exact:false}).first().waitFor({state:'visible',timeout:5000});}
  await page.goto(base+'/');assert.equal(await page.locator('.topnav .logo').evaluate(img=>img.complete&&img.naturalWidth>0),true,'official logo asset must load');
  assert.deepEqual(errors,[]);await page.close();
});

test('marketing, onboarding, settings and URL safety interactions work',async()=>{
  const page=await browser.newPage();await page.goto(base+'/');
  await page.getByRole('button',{name:'Watch demo'}).click();await page.getByRole('dialog').waitFor();await page.getByRole('button',{name:'×'}).click();
  await page.goto(base+'/pricing');await page.getByRole('button',{name:'Yearly'}).click();await page.getByText('$4',{exact:false}).waitFor();
  await page.goto(base+'/onboarding');await page.getByRole('button',{name:/E-commerce/}).click();await page.getByRole('button',{name:/Next/}).click();await page.waitForURL('**/dashboard');
  await page.goto(base+'/dashboard/settings');await page.getByRole('link',{name:'Preferences'}).click();await page.getByText('Default viewport').waitFor();
  await page.locator('#email-notifications').uncheck();await page.locator('#default-viewport').selectOption('Mobile');await page.getByRole('button',{name:'Save changes'}).click();await page.getByRole('button',{name:'Saved'}).waitFor();await page.goto(base+'/dashboard/settings#Preferences');assert.equal(await page.locator('#email-notifications').isChecked(),false);assert.equal(await page.locator('#default-viewport').inputValue(),'Mobile');
  await page.goto(base+'/dashboard/new-test');await page.getByLabel('Website URL').fill('http://127.0.0.1:3000');await page.getByRole('button',{name:/Run website test/}).click();await page.getByText(/restricted network address|not publicly reachable/).waitFor({timeout:5000});
  await page.goto(base+'/signup');await page.getByLabel('Name').fill('Test User');await page.getByLabel('Email').fill('test@example.com');await page.getByLabel('Password').fill('GoodPass123');await page.getByRole('button',{name:'Create account'}).click();await page.getByText(/Firebase is not configured/).waitFor();
  await page.goto(base+'/login');await page.getByLabel('Email').fill('test@example.com');await page.getByLabel('Password').fill('GoodPass123');await page.getByRole('button',{name:'Sign in'}).click();await page.getByText(/Firebase is not configured/).waitFor();
  await page.goto(base+'/forgot-password');await page.getByLabel('Email').fill('test@example.com');await page.getByRole('button',{name:'Send reset link'}).click();await page.getByText(/Password reset needs Firebase/).waitFor();
  await page.setViewportSize({width:390,height:844});await page.goto(base+'/');await page.getByRole('button',{name:'Open navigation'}).click();await page.getByRole('link',{name:'Features'}).click();await page.waitForURL('**/features');
  await page.close();
});

test('broken route ids show a useful not found state',async()=>{
  const page=await browser.newPage();await page.goto(base+'/dashboard/tests/not-a-real-id');await page.getByText('Test not found').waitFor();await page.close();
});

test('completed scan reports, category tabs, screenshots and export work',async()=>{
  const response=await fetch(`${base}/api/tests`),all=await response.json(),report=all.find(x=>x.status==='completed');
  if(!report)return; // The end-to-end scan is run separately by tests/run-real-scan.mjs.
  const localShare=await fetch(`${base}/api/tests/${report.id}/shares`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'recipient@example.com'})});assert.equal(localShare.status,503,'report sharing must stay disabled without Firebase sign-in');
  const page=await browser.newPage();await page.goto(`${base}/dashboard/tests/${report.id}`);await page.getByRole('heading',{name:report.hostname}).waitFor();
  await page.getByRole('button',{name:'Performance'}).click();await page.getByText(/Page load completed in/).waitFor();
  await page.getByRole('button',{name:'SEO'}).click();await page.getByText('Basic page metadata').waitFor();
  await page.getByRole('button',{name:'Accessibility'}).click();await page.getByText('Nothing to review here.').waitFor();
  await page.getByRole('button',{name:/Screenshots/}).click();await page.getByAltText('Desktop website screenshot').waitFor();assert.equal(await page.locator('img[alt="Desktop website screenshot"]').evaluate(i=>i.complete&&i.naturalWidth>0),true);
  await page.getByRole('button',{name:/Issues/}).click();await page.getByRole('button',{name:'Download report'}).waitFor();
  const share=page.getByRole('button',{name:'Share'});if(await share.count()){await share.click();await page.getByRole('heading',{name:'Share with a signed-in user.'}).waitFor();await page.getByText(/Sharing requires Firebase Authentication/).waitFor();await page.getByRole('button',{name:'Close sharing dialog'}).click();}
  const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'Download report'}).click()]);assert.match(download.suggestedFilename(),/fliq-report-.*\.json/);
  await page.setViewportSize({width:390,height:844});await page.goto(base+'/pricing');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'pricing page should not overflow on mobile');await page.close();
});

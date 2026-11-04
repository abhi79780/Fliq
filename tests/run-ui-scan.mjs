import { chromium } from 'playwright';

const origin=process.env.FLIQ_TEST_URL||`http://127.0.0.1:${process.env.PORT||3000}`;
const browser=await chromium.launch({headless:true});
try{
  const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${origin}/dashboard/new-test`);await page.getByLabel('Website URL').fill('https://example.com');await page.getByRole('button',{name:/Run website test/}).click();
  await page.waitForURL(/\/dashboard\/tests\/[\w-]+$/, {timeout:10000});await page.getByText(/Completed ·/).waitFor({timeout:90000});
  const id=page.url().split('/').at(-1),api=await fetch(`${origin}/api/tests/${id}`),report=await api.json();
  console.log(JSON.stringify({pageUrl:page.url(),title:await page.title(),reportStatus:report.status,hostname:report.hostname,httpStatus:report.httpStatus,reportRetrieval:api.status,consoleErrors:errors},null,2));
  if(report.status!=='completed'||report.hostname!=='example.com'||api.status!==200||errors.length)process.exitCode=1;
}finally{await browser.close()}

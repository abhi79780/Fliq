const origin=process.env.FLIQ_TEST_URL||`http://127.0.0.1:${process.env.PORT||3000}`;
const start=await fetch(`${origin}/api/tests`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:'https://example.com'})});
const job=await start.json();if(!start.ok)throw Error(`Scan start failed (${start.status}): ${job.error}`);
console.log(`Started permitted public scan: ${job.id}`);
let result;
for(let i=0;i<90;i++){
  await new Promise(r=>setTimeout(r,1000));
  const response=await fetch(`${origin}/api/tests/${job.id}`);result=await response.json();
  if(result.status==='completed'||result.status==='failed')break;
}
if(!result||!['completed','failed'].includes(result.status))throw Error('Scan did not finish within 90 seconds.');
const verify=await fetch(`${origin}/api/tests/${job.id}`);const saved=await verify.json();
const screenshot=await fetch(`${origin}/api/screenshots/${result.screenshots?.[0]}`);
console.log(JSON.stringify({status:result.status,stage:result.stage,error:result.error,id:result.id,hostname:result.hostname,title:result.title,httpStatus:result.httpStatus,score:result.score,issueCount:result.issues?.length,screenshots:result.screenshots,retrievalStatus:verify.status,retrievedSameId:saved.id===job.id,screenshotStatus:screenshot.status,screenshotType:screenshot.headers.get('content-type')},null,2));
if(result.status!=='completed'||verify.status!==200||saved.id!==job.id||screenshot.status!==200)process.exitCode=1;

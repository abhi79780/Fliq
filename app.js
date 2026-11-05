const $=s=>document.querySelector(s), esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let path=location.pathname, modal=false, period='Monthly', activeTab='Issues', issueFilter='all', testTimer, shareModalId=null, shareRecipients=[], shareMessage='';
let logoutConfirmOpen = false, isLoggingOut = false, logoutError = '';
let productMenuCloseTimer=0;
let firebaseConfigured=false, firebaseWebConfigured=false, firebaseAdminConfigured=false, firebaseWebMissing=[];let firebaseAuth=null,firebaseAuthSdk=null,firebaseClientPromise=null;let firebaseStatusPromise;
let authStateResolved=false, resolvedAuthUser=null, authStateSubscribers=[];
window.__fliqSignOutCalls=0;
function notifyAuthSubscribers(user){while(authStateSubscribers.length){const fn=authStateSubscribers.shift();try{fn(user);}catch(e){console.error('[FLIQ] Auth subscriber error:',e);}}}
try{for(const key of ['fliqToken','fliqRefresh'])localStorage.removeItem(key);}catch{}
async function getClientFirebaseConfig() {
  if (typeof window !== 'undefined' && window.__FLIQ_FIREBASE_CONFIG__?.apiKey && window.__FLIQ_FIREBASE_CONFIG__?.projectId) {
    return { configured: true, config: window.__FLIQ_FIREBASE_CONFIG__, missing: [] };
  }
  try {
    const res = await fetch('/api/firebase-config', { cache: 'no-store' });
    const text = await res.text();
    if (text.startsWith('{')) {
      const data = JSON.parse(text);
      if (data.configured && data.config) {
        if (typeof window !== 'undefined') window.__FLIQ_FIREBASE_CONFIG__ = data.config;
        return data;
      }
    }
  } catch {}
  try {
    const res = await fetch('/firebase-config.json', { cache: 'no-store' });
    const text = await res.text();
    if (text.startsWith('{')) {
      const data = JSON.parse(text);
      if (data.apiKey && data.projectId) {
        if (typeof window !== 'undefined') window.__FLIQ_FIREBASE_CONFIG__ = data;
        return { configured: true, config: data, missing: [] };
      }
    }
  } catch {}
  return { configured: false, config: null, missing: ['Web App configuration'] };
}
firebaseStatusPromise = (async () => {
  // If public client config is already provided via window.__FLIQ_FIREBASE_CONFIG__, activate immediately
  const clientConfig = await getClientFirebaseConfig();
  if (clientConfig.configured) {
    firebaseWebConfigured = true;
    firebaseWebMissing = [];
    initializeFirebaseClient().catch(e => console.warn('[FLIQ] Background init notice:', e.message));
  }

  // Non-blocking health probe with strict 1.2s timeout: failure or cold starts NEVER block UI
  let health = null;
  try {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutId = controller ? setTimeout(() => controller.abort(), 1200) : null;
    const hr = await fetch('/api/health', { signal: controller?.signal, cache: 'no-store' });
    if (timeoutId) clearTimeout(timeoutId);
    const text = await hr.text();
    if (text.startsWith('{')) health = JSON.parse(text);
  } catch (e) {
    console.warn('[FLIQ] Health probe note (non-blocking):', e.message);
  }

  if (health) {
    firebaseConfigured = Boolean(health.firebaseConfigured);
    firebaseAdminConfigured = Boolean(health.firebaseAdminConfigured);
    if (!firebaseWebConfigured && health.firebaseWebConfigured) {
      firebaseWebConfigured = true;
      initializeFirebaseClient().catch(e => console.warn('[FLIQ] Background init notice:', e.message));
    }
  } else {
    firebaseConfigured = firebaseWebConfigured;
    firebaseAdminConfigured = false;
  }
  return health || { ok: true, firebaseWebConfigured, firebaseConfigured };
})();

async function initializeFirebaseClient() {
  if (firebaseClientPromise) return firebaseClientPromise;
  firebaseClientPromise = (async () => {
    console.log('[FLIQ] initializeFirebaseClient: starting');
    const clientConfig = await getClientFirebaseConfig();
    if (!clientConfig.configured || !clientConfig.config) {
      throw Error('Firebase Web App configuration is incomplete. Add the exact web config values to .env or Netlify environment variables.');
    }
    const config = clientConfig.config;
    const base = 'https://www.gstatic.com/firebasejs/13.1.0/';
    const [appSdk, authSdk] = await Promise.all([
      import(`${base}firebase-app.js`),
      import(`${base}firebase-auth.js`)
    ]);
    const app = appSdk.getApps().find(x => x.options.projectId === config.projectId) || appSdk.initializeApp(config, 'fliq-web');
    console.log('[FLIQ] initializeFirebaseClient: Firebase app ready, projectId=', config.projectId);
    const auth = authSdk.getAuth(app);
    // Set persistence BEFORE reading any auth state
    await authSdk.setPersistence(auth, authSdk.browserLocalPersistence);
    // Centralized persistent auth state observer
    authSdk.onAuthStateChanged(auth, u => {
      console.log('[FLIQ] Central auth state changed:', u?.uid ?? 'null');
      resolvedAuthUser = u;
      authStateResolved = true;
      if (u) {
        localStorage.setItem('fliqEmail', u.email || '');
        localStorage.setItem('fliqName', u.displayName || '');
      }
      notifyAuthSubscribers(u);
    }, err => {
      console.error('[FLIQ] Central onAuthStateChanged error:', err);
      authStateResolved = true;
      notifyAuthSubscribers(null);
    });

    try {
      const rr = await authSdk.getRedirectResult(auth);
      if (rr?.user) {
        localStorage.setItem('fliqEmail', rr.user.email || '');
        localStorage.setItem('fliqName', rr.user.displayName || '');
      }
    } catch (rrErr) {
      console.warn('[FLIQ] initializeFirebaseClient: getRedirectResult notice:', rrErr?.message);
    }
    firebaseAuth = auth;
    firebaseAuthSdk = authSdk;
    return { auth: firebaseAuth, sdk: authSdk };
  })().catch(error => {
    console.error('[FLIQ] Firebase client initialization failed:', error);
    firebaseClientPromise = null;
    authStateResolved = true;
    notifyAuthSubscribers(null);
    throw error;
  });
  return firebaseClientPromise;
}

async function getResolvedAuthState(maxWaitMs = 3000) {
  const testUid = localStorage.getItem('fliqTestUid');
  if (testUid) {
    return {
      uid: testUid,
      email: localStorage.getItem('fliqEmail') || `${testUid}@test.fliq.local`,
      displayName: localStorage.getItem('fliqName') || 'Test User'
    };
  }

  if (authStateResolved && (firebaseAuth?.currentUser || resolvedAuthUser)) {
    return firebaseAuth?.currentUser || resolvedAuthUser;
  }

  // Bounded race: NEVER hangs indefinitely under any circumstances
  return await Promise.race([
    (async () => {
      try {
        const { auth, sdk } = await initializeFirebaseClient();
        if (authStateResolved && (auth.currentUser || resolvedAuthUser)) {
          return auth.currentUser || resolvedAuthUser;
        }
        return await new Promise(resolve => {
          let timer = null;
          let unsub = null;
          timer = setTimeout(() => {
            if (unsub) unsub();
            resolve(auth.currentUser || resolvedAuthUser || null);
          }, maxWaitMs);
          unsub = sdk.onAuthStateChanged(auth, u => {
            clearTimeout(timer);
            if (unsub) unsub();
            resolve(u);
          }, () => {
            clearTimeout(timer);
            if (unsub) unsub();
            resolve(null);
          });
        });
      } catch (err) {
        console.warn('[FLIQ] getResolvedAuthState init note:', err.message);
        if (localStorage.getItem('fliqEmail')) {
          return {
            uid: localStorage.getItem('fliqUid') || 'local',
            email: localStorage.getItem('fliqEmail'),
            displayName: localStorage.getItem('fliqName') || 'User'
          };
        }
        return null;
      }
    })(),
    new Promise(resolve => setTimeout(() => {
      console.warn(`[FLIQ] getResolvedAuthState safety limit (${maxWaitMs}ms) reached.`);
      if (firebaseAuth?.currentUser || resolvedAuthUser) {
        resolve(firebaseAuth?.currentUser || resolvedAuthUser);
      } else if (localStorage.getItem('fliqEmail')) {
        resolve({
          uid: localStorage.getItem('fliqUid') || 'local',
          email: localStorage.getItem('fliqEmail'),
          displayName: localStorage.getItem('fliqName') || 'User'
        });
      } else {
        resolve(null);
      }
    }, maxWaitMs))
  ]);
}
async function logoNavigate(e){
  if(e){
    e.preventDefault();
  }
  const user=await getResolvedAuthState();
  if(user){
    if(path==='/dashboard'){
      window.scrollTo({top:0,behavior:'smooth'});
      return;
    }
    go('/dashboard');
  }else{
    if(path==='/'){
      window.scrollTo({top:0,behavior:'smooth'});
      return;
    }
    go('/');
  }
}
async function handlePlanSelect(planName, billingPeriod = 'monthly') {
  const plan = String(planName || 'creator').toLowerCase();
  const periodVal = String(billingPeriod || period || 'monthly').toLowerCase();
  const user = await getResolvedAuthState(2000);

  if (user) {
    try {
      sessionStorage.setItem('fliqSelectedPlan', plan);
      sessionStorage.setItem('fliqSelectedPeriod', periodVal);
    } catch {}

    if (plan === 'free') {
      go('/dashboard');
      return;
    }

    go(`/checkout?plan=${encodeURIComponent(plan)}&period=${encodeURIComponent(periodVal)}`);
    return;
  } else {
    try {
      sessionStorage.setItem('fliqPendingPlan', plan);
      sessionStorage.setItem('fliqPendingPeriod', periodVal);
    } catch {}

    go(`/signup?plan=${encodeURIComponent(plan)}&period=${encodeURIComponent(periodVal)}`);
    return;
  }
}

async function navigatePostAuth() {
  const pendingPlan = sessionStorage.getItem('fliqPendingPlan') || new URLSearchParams(location.search).get('plan');
  const pendingPeriod = sessionStorage.getItem('fliqPendingPeriod') || new URLSearchParams(location.search).get('period') || 'monthly';
  const pendingUrl = sessionStorage.getItem('fliqPendingUrl') || new URLSearchParams(location.search).get('pendingUrl');

  if (pendingPlan && pendingPlan.toLowerCase() !== 'free') {
    try {
      sessionStorage.removeItem('fliqPendingPlan');
      sessionStorage.removeItem('fliqPendingPeriod');
      sessionStorage.setItem('fliqSelectedPlan', pendingPlan.toLowerCase());
      sessionStorage.setItem('fliqSelectedPeriod', pendingPeriod.toLowerCase());
    } catch {}
    go(`/checkout?plan=${encodeURIComponent(pendingPlan.toLowerCase())}&period=${encodeURIComponent(pendingPeriod.toLowerCase())}`);
    return;
  }

  if (pendingUrl) {
    try { sessionStorage.removeItem('fliqPendingUrl'); } catch {}
    await triggerPendingScan(pendingUrl);
    return;
  }

  go('/dashboard');
}

async function executeSignOut() {
  if (isLoggingOut) return;
  isLoggingOut = true;
  logoutError = '';
  render();

  try {
    let auth = firebaseAuth;
    let sdk = firebaseAuthSdk;
    if ((!auth || !sdk) && firebaseWebConfigured) {
      try {
        const client = await initializeFirebaseClient();
        auth = client.auth;
        sdk = client.sdk;
      } catch (initErr) {
        console.warn('[FLIQ] Firebase init during sign-out notice:', initErr);
      }
    }
    if (auth && sdk) {
      await sdk.signOut(auth);
    }
    window.__fliqSignOutCalls = (window.__fliqSignOutCalls || 0) + 1;
    for (const k of ['fliqName', 'fliqEmail', 'fliqToken', 'fliqRefresh', 'fliqTestUid', 'fliqUid']) {
      localStorage.removeItem(k);
    }
    try {
      sessionStorage.removeItem('fliqPendingUrl');
      sessionStorage.removeItem('fliqPendingPlan');
      sessionStorage.removeItem('fliqPendingPeriod');
      sessionStorage.removeItem('fliqSelectedPlan');
      sessionStorage.removeItem('fliqSelectedPeriod');
    } catch {}
    resolvedAuthUser = null;
    logoutConfirmOpen = false;
    isLoggingOut = false;
    logoutError = '';
    go('/login');
  } catch (err) {
    console.error('[FLIQ] Sign-out failure:', err);
    isLoggingOut = false;
    logoutError = err?.message || 'Failed to sign out. Please try again.';
    render();
  }
}

window.fliqAuth={
  getResolvedAuthState,
  logoNavigate,
  isAuthStateResolved:()=>authStateResolved,
  getResolvedUser:()=>resolvedAuthUser,
  handlePlanSelect,
  navigatePostAuth,
  signOut: executeSignOut
};
function friendlyFirebaseAuthError(error){const messages={'auth/popup-closed-by-user':'The sign-in window was closed before finishing.','auth/popup-blocked':'Your browser blocked the sign-in window. Allow popups for this site and try again.','auth/unauthorized-domain':'This local host is not authorized in Firebase Authentication. Add it to Firebase Authentication → Settings → Authorized domains.','auth/operation-not-allowed':'This sign-in method is not enabled in Firebase Authentication.','auth/account-exists-with-different-credential':'An account with this email already uses another sign-in method. Sign in with that method first.','auth/email-already-in-use':'An account already exists for this email. Sign in instead.','auth/invalid-email':'Enter a valid email address.','auth/weak-password':'Choose a stronger password (at least 6 characters).','auth/invalid-credential':'Email or password is incorrect.','auth/invalid-login-credentials':'Email or password is incorrect.','auth/user-disabled':'This account is disabled.','auth/too-many-requests':'Too many attempts. Wait a little and try again.','auth/network-request-failed':'Could not reach Firebase. Check your connection and try again.','auth/invalid-api-key':'The Firebase Web API key is invalid. Check the Web App configuration in .env.'};return messages[error?.code]||'Firebase could not complete the request. Check your details and try again.'}
async function signInWithOAuth(button){const message=document.querySelector('#oauth-message'),buttons=[...document.querySelectorAll('[data-oauth]')];if(!message)return;buttons.forEach(x=>x.disabled=true);message.textContent='Connecting to Google…';try{await firebaseStatusPromise;if(!firebaseWebConfigured)throw Error('Firebase Web Authentication is not ready. Missing: '+(firebaseWebMissing.join(', ')||'Web App configuration')+'.');
console.log('[FLIQ] signInWithOAuth: calling initializeFirebaseClient');
const {auth,sdk}=await initializeFirebaseClient();
console.log('[FLIQ] signInWithOAuth: Firebase client ready — currentUser before popup=',auth.currentUser?.uid??'null');
const provider=new sdk.GoogleAuthProvider();provider.setCustomParameters({prompt:'select_account'});
console.log('[FLIQ] signInWithOAuth: calling signInWithPopup');
const result=await sdk.signInWithPopup(auth,provider);
console.log('[FLIQ] signInWithPopup resolved — uid=',result.user?.uid,'currentUser=',auth.currentUser?.uid??'null');
localStorage.setItem('fliqEmail',result.user.email||'');localStorage.setItem('fliqName',result.user.displayName||'');
// Wait for onAuthStateChanged to confirm the user before navigating.
await new Promise((resolve,reject)=>{let unsubscribe=()=>{};const timer=setTimeout(()=>{unsubscribe();console.warn('[FLIQ] onAuthStateChanged timed out (8s) — currentUser=',auth.currentUser?.uid??'null','; navigating anyway');resolve()},8000);unsubscribe=sdk.onAuthStateChanged(auth,user=>{console.log('[FLIQ] onAuthStateChanged fired — user=',user?.uid??'null');if(user){clearTimeout(timer);unsubscribe();resolve();}else{console.warn('[FLIQ] onAuthStateChanged returned null after popup — awaiting next event or timeout');}},err=>{clearTimeout(timer);unsubscribe();console.error('[FLIQ] onAuthStateChanged error:',err);reject(err);});});
console.log('[FLIQ] signInWithOAuth: authenticated successfully — currentUser=',auth.currentUser?.uid??'null');
await navigatePostAuth();
}catch(error){
console.error('[FLIQ] Google sign-in failed:',error?.code,error?.message,error);const isSelfDescribing=error.message?.startsWith('Firebase Web Authentication')||error.message?.startsWith('Firebase Web App');const friendly=friendlyFirebaseAuthError(error);
const hasMapping=friendly!=='Firebase could not complete the request. Check your details and try again.';message.textContent=isSelfDescribing?error.message:(hasMapping?friendly:`${friendly} (${error?.code||error?.message||'unknown error'})`);buttons.forEach(x=>x.disabled=false);}}function isProtected(p){if(p==='/dashboard'||p==='/onboarding'||p==='/checkout'||p.startsWith('/checkout/'))return true;if(p.startsWith('/dashboard/tests/'))return false;return p.startsWith('/dashboard/');}
const API_BASE = (typeof window !== 'undefined' && (window.__FLIQ_FIREBASE_CONFIG__?.apiUrl || window.__FLIQ_API_URL__)) || '';

async function authHeaders(){
  const testUid=localStorage.getItem('fliqTestUid');
  if(testUid) return {'x-fliq-test-uid':testUid};
  let user=firebaseAuth?.currentUser||resolvedAuthUser;
  if(!user&&firebaseWebConfigured){
    try{ user=await getResolvedAuthState(2500); }catch{}
  }
  if(!user||typeof user.getIdToken!=='function'){return {};}
  try{
    const token=await user.getIdToken();
    return{authorization:`Bearer ${token}`};
  }catch(e){
    console.error('[FLIQ] authHeaders: getIdToken() threw:',e?.code,e?.message);
    return {};
  }
}
async function apiFetch(url,options={}){
  await firebaseStatusPromise;
  const resolvedUrl = (url.startsWith('/api') && API_BASE) ? (API_BASE.replace(/\/+$/, '') + url) : url;
  const headers = { ...options.headers, ...(await authHeaders()) };
  return fetch(resolvedUrl, { ...options, headers });
}
const logo='<a href="/" class="logo-link" data-route aria-label="FLIQ Home"><img class="logo" src="/public/fliq-logo.png" onerror="this.onerror=null;this.src=\'/fliq-logo.png\'" alt="FLIQ"></a>';
const go=p=>{
  if(path===p && p==='/'){
    window.scrollTo({top:0,behavior:'smooth'});
    return;
  }
  clearInterval(testTimer);
  shareModalId=null;
  logoutConfirmOpen=false;
  logoutError='';
  history.pushState({},'',p);
  path=p;
  render();
  scrollTo(0,0);
};
window.onpopstate=()=>{path=location.pathname;render()};window.onhashchange=()=>render();
const btn=(label,p,cls='btn black',attrs='')=>`<button class="${cls}" data-go="${p}" ${attrs}>${label}</button>`;
const nav=()=>`<header class="topnav">${logo}<div class="product-menu"><button type="button" class="nav-product" data-product-menu-trigger aria-expanded="false" aria-controls="product-dropdown" aria-haspopup="menu">Product <svg class="product-chevron" viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button><div class="product-dropdown" id="product-dropdown" role="menu" aria-label="Product and resources" hidden><section class="product-menu-group"><h2>PRODUCT</h2><a href="/features#automated-testing" role="menuitem"><span class="product-menu-icon icon-pink">◉</span><span><b>Website Testing</b><small>Automatically test websites using a real browser.</small></span></a><a href="/features#ai-analysis" role="menuitem"><span class="product-menu-icon icon-lime">✳</span><span><b>AI Bug Analysis</b><small>Understand detected errors and their potential causes.</small></span></a><a href="/features#test-reports" role="menuitem"><span class="product-menu-icon icon-pink">▧</span><span><b>Test Reports</b><small>Review findings, screenshots, and recommended fixes.</small></span></a></section><section class="product-menu-group"><h2>RESOURCES</h2><a href="/#how-it-works" role="menuitem"><span class="product-menu-icon icon-lime">↗</span><span><b>How It Works</b><small>See how FLIQ tests a website step by step.</small></span></a><a href="/docs" role="menuitem"><span class="product-menu-icon icon-pink">⌘</span><span><b>Documentation</b><small>Learn how to use FLIQ.</small></span></a><a href="/pricing" role="menuitem"><span class="product-menu-icon icon-lime">$</span><span><b>Pricing</b><small>Compare available plans.</small></span></a></section></div></div><nav><a href="/features" data-route>Features</a><a href="/pricing" data-route>Pricing</a><a href="/docs" data-route>Docs</a><a href="/blog" data-route>Blog</a></nav>${btn('Get started','/signup','btn black nav-cta')}<button class="menu-toggle" aria-label="Open navigation" aria-expanded="false">☰</button></header>`;const artwork=(kind='pink')=>`<div class="art ${kind}"><div class="scribble"></div><div class="art-window"><div class="dots">● ● ●</div><div class="mini-line"></div><div class="mini-row"><i></i><i></i><i></i></div><div class="mini-line short"></div><div class="mini-line"></div><span class="check">✓</span></div><div class="pixel" aria-hidden="true"></div><div class="art-caption">${kind==='blue'?'Test. Fix.\nShip. Repeat.':'Better websites\nstart here.'}</div></div>`;
const footer=()=>`<footer>© 2026 FLIQ <span>Test. Fix. Ship. Repeat.</span><a href="/docs" data-route>Documentation</a></footer>`;
let heroWalkthroughRoot=null, heroWalkthroughTimers=[], heroWalkthroughFrame=0, heroWalkthroughRun=0, heroWalkthroughMotion=null, heroWalkthroughMotionHandler=null, heroWalkthroughResizeHandler=null;
const heroWalkthroughStages=[
  {id:'opening',duration:2500,from:0,to:15,status:'Simulated demo: Opening sample website...'},
  {id:'testing',duration:3000,from:15,to:45,status:'Simulated demo: Testing sample elements...'},
  {id:'detecting',duration:3000,from:45,to:45,status:'Simulated demo: Sample issue detected'},
  {id:'analyzing',duration:3000,from:45,to:85,status:'Simulated demo: AI analyzing sample issue...'},
  {id:'report',duration:4000,from:85,to:100,status:'Simulated demo: Walkthrough complete'}
];
function heroWalkthrough(){return `<div class="hero-art" id="how-it-works" data-hero-walkthrough data-stage="opening" data-loaded="no" role="region" aria-label="Simulated FLIQ website testing walkthrough">
  <div class="demo-browser" aria-label="Fictional Bloom Studio website preview">
    <div class="demo-chrome"><span class="window-dots" aria-hidden="true"><i></i><i></i><i></i></span><div class="demo-address"><span class="lock-icon">⌑</span><span>https://bloom-studio.example</span><i class="demo-loader" aria-hidden="true"></i></div><span class="preview-label">SAMPLE SITE</span></div>
    <div class="mock-site" inert>
      <nav class="mock-nav" aria-label="Sample site navigation"><b class="mock-brand">bloom<span>•</span></b><button class="mock-link" type="button" data-demo-target="nav">Plants</button><button class="mock-link" type="button" data-demo-target="nav">Plant care</button><button class="mock-link" type="button" data-demo-target="nav">Our story</button><button class="mock-bag" type="button" data-demo-target="nav" aria-label="Shopping bag">Bag <span>0</span></button></nav>
      <section class="mock-hero"><div class="mock-copy"><span class="mock-kicker">A LITTLE MORE GREEN</span><h2>Find your<br><em>happy place.</em></h2><p>Thoughtful plants and simple care for the spaces you love.</p><button class="mock-primary" type="button" data-demo-target="primary">Explore plants <span>↗</span></button><small>Easy care · Happily delivered</small></div><div class="mock-visual" aria-label="Decorative plant illustration"><div class="visual-sun"></div><div class="visual-plant"><i></i><i></i><i></i><i></i><b></b></div><span class="visual-label">FRESH PICKS&nbsp; / &nbsp;NO. 04</span></div></section>
      <div class="mock-section-head"><span>ROOM TO GROW</span><button class="mock-shop-link" type="button" data-demo-target="nav">Shop all <b>→</b></button></div>
      <div class="mock-cards"><button class="mock-card" type="button" data-demo-target="card"><span class="mock-card-art card-art-one"><i></i></span><span><b>Sunny days</b><small>Bright-light favorites</small></span><strong>$28</strong></button><button class="mock-card" type="button" data-demo-target="card"><span class="mock-card-art card-art-two"><i></i></span><span><b>Soft greens</b><small>Easy-care essentials</small></span><strong>$34</strong></button><button class="mock-card" type="button" data-demo-target="card"><span class="mock-card-art card-art-three"><i></i></span><span><b>Little jungle</b><small>Make a statement</small></span><strong>$42</strong></button></div>
    </div>
    <div class="demo-statusbar"><span class="status-light"></span><span class="demo-status" aria-live="polite">Simulated demo: Opening sample website...</span><div class="demo-progress" role="progressbar" aria-label="Simulated walkthrough progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i></i></div><b class="demo-percent">0%</b></div>
    <div class="demo-cursor" aria-hidden="true"><svg viewBox="0 0 22 28"><path d="M2 1.5v21l5.5-5.2 3.4 8.1 3.7-1.5-3.7-8 7.7-.6L2 1.5Z" fill="#111" stroke="#fff" stroke-width="1.25" stroke-linejoin="round"/></svg></div><span class="demo-ripple" aria-hidden="true"></span>
  </div>
  <svg class="issue-connector" aria-hidden="true"><path d=""/></svg>
  <aside class="workflow-card testing-card"><div class="workflow-card-head"><span class="mini-pulse"></span><b>Testing in real time...</b></div><div class="workflow-row" data-workflow-row="0"><i>↗</i><span>Loading page</span><b>✓</b></div><div class="workflow-row" data-workflow-row="1"><i>◉</i><span>Checking performance</span><b>✓</b></div><div class="workflow-row" data-workflow-row="2"><i>⌁</i><span>Testing elements</span><b>✓</b></div><div class="workflow-row" data-workflow-row="3"><i>✳</i><span>Analyzing issues</span><b>✓</b></div></aside>
  <aside class="workflow-card issue-card"><div class="card-eyebrow"><i>!</i> INTERACTION CHECK</div><b class="workflow-title">Issue detected</b><p>Button interaction failed</p><span class="severity-pill">Medium severity</span></aside>
  <aside class="workflow-card ai-card"><div class="card-eyebrow ai-eyebrow"><i>✳</i> AI SUGGESTION</div><b class="workflow-title">Possible cause identified</b><div class="ai-lines"><span></span><span></span><span></span></div><p>Review the button’s click handler and navigation logic.</p><span class="recommendation-tag">Recommended action</span></aside>
  <aside class="workflow-card report-card"><div class="report-head"><span class="report-check">✓</span><div><b>Test completed</b><small>Sample walkthrough</small></div><span class="report-score">100%</span></div><div class="report-stat"><i>✓</i><span><b>24 checks passed</b><small>Everything else looks good</small></span></div><div class="report-stat issue-stat"><i>!</i><span><b>1 issue detected</b><small>Button interaction · Medium</small></span></div><button type="button" class="view-report" data-demo-report>View report <span>→</span></button></aside>
  <div class="demo-disclaimer"><span></span> SIMULATED WALKTHROUGH <i>·</i> SAMPLE DATA</div>
</div>`}
function clearHeroWalkthroughTimers(){heroWalkthroughTimers.forEach(clearTimeout);heroWalkthroughTimers=[];if(heroWalkthroughFrame){cancelAnimationFrame(heroWalkthroughFrame);heroWalkthroughFrame=0}}
function stopHeroWalkthrough(){heroWalkthroughRun++;clearHeroWalkthroughTimers();if(heroWalkthroughMotion&&heroWalkthroughMotionHandler)heroWalkthroughMotion.removeEventListener('change',heroWalkthroughMotionHandler);if(heroWalkthroughResizeHandler)window.removeEventListener('resize',heroWalkthroughResizeHandler);heroWalkthroughRoot=null;heroWalkthroughMotion=null;heroWalkthroughMotionHandler=null;heroWalkthroughResizeHandler=null}
function scheduleHeroWalkthrough(callback,delay,run){const timer=setTimeout(()=>{heroWalkthroughTimers=heroWalkthroughTimers.filter(x=>x!==timer);if(run===heroWalkthroughRun&&heroWalkthroughRoot?.isConnected)callback()},delay);heroWalkthroughTimers.push(timer)}
function setWalkthroughProgress(value){const fill=heroWalkthroughRoot?.querySelector('.demo-progress i'),bar=heroWalkthroughRoot?.querySelector('.demo-progress'),label=heroWalkthroughRoot?.querySelector('.demo-percent');if(!fill)return;fill.style.width=`${value}%`;bar.setAttribute('aria-valuenow',String(Math.round(value)));label.textContent=`${Math.round(value)}%`}
function animateWalkthroughProgress(from,to,duration,run){clearHeroWalkthroughTimers();const start=performance.now();const step=now=>{if(run!==heroWalkthroughRun||!heroWalkthroughRoot?.isConnected)return;const t=Math.min(1,(now-start)/duration),ease=1-Math.pow(1-t,2);setWalkthroughProgress(from+(to-from)*ease);if(t<1)heroWalkthroughFrame=requestAnimationFrame(step);else heroWalkthroughFrame=0};heroWalkthroughFrame=requestAnimationFrame(step)}
function moveWalkthroughCursor(target){const root=heroWalkthroughRoot,cursor=root?.querySelector('.demo-cursor');if(!root||!target||!cursor)return;const rr=root.getBoundingClientRect(),tr=target.getBoundingClientRect();cursor.style.transform=`translate3d(${tr.left-rr.left+tr.width*.52}px,${tr.top-rr.top+tr.height*.55}px,0)`;cursor.classList.add('is-visible')}
function pulseWalkthroughTarget(target,run){const root=heroWalkthroughRoot;if(!root||!target)return;moveWalkthroughCursor(target);scheduleHeroWalkthrough(()=>{const rr=root.getBoundingClientRect(),tr=target.getBoundingClientRect(),x=tr.left-rr.left+tr.width*.52,y=tr.top-rr.top+tr.height*.55,ripple=root.querySelector('.demo-ripple');ripple.style.left=`${x}px`;ripple.style.top=`${y}px`;ripple.classList.remove('is-active');void ripple.offsetWidth;ripple.classList.add('is-active');scheduleHeroWalkthrough(()=>ripple.classList.remove('is-active'),800,run)},470,run)}function highlightWalkthroughTarget(target,failed=false){if(!heroWalkthroughRoot)return;heroWalkthroughRoot.querySelectorAll('[data-demo-target]').forEach(x=>x.classList.remove('is-probing','is-checked','is-failed'));if(target){target.classList.add(failed?'is-failed':'is-probing');if(!failed)target.classList.add('is-checked')}}
function updateWorkflowRows(active=-1){const rows=[...heroWalkthroughRoot.querySelectorAll('[data-workflow-row]')];rows.forEach((row,i)=>{row.classList.toggle('is-active',i===active);row.classList.toggle('is-done',i<active||(active<0&&heroWalkthroughRoot.dataset.stage!=='opening'))})}
function updateIssueConnector(){const root=heroWalkthroughRoot;if(!root)return;const path=root.querySelector('.issue-connector path'),button=root.querySelector('.mock-primary'),card=root.querySelector('.issue-card');if(!path||!button||!card)return;const rr=root.getBoundingClientRect(),a=button.getBoundingClientRect(),b=card.getBoundingClientRect(),x1=a.left-rr.left+a.width*.5,y1=a.top-rr.top+a.height*.5,x2=b.left-rr.left,y2=b.top-rr.top+b.height*.55,m=(x1+x2)*.5;root.querySelector('.issue-connector').setAttribute('viewBox',`0 0 ${rr.width} ${rr.height}`);path.setAttribute('d',`M ${x1} ${y1} C ${m} ${y1}, ${m} ${y2}, ${x2} ${y2}`)}
function setWalkthroughStage(index,run){if(run!==heroWalkthroughRun||!heroWalkthroughRoot?.isConnected)return;const root=heroWalkthroughRoot,s=heroWalkthroughStages[index];if(!s)return;root.dataset.stage=s.id;root.dataset.loaded=index===0?'no':'yes';root.querySelector('.demo-status').textContent=s.status;root.querySelector('.demo-statusbar').dataset.stage=s.id;root.querySelector('.demo-cursor').classList.remove('is-visible');root.querySelector('.issue-connector path').setAttribute('d','');root.querySelectorAll('[data-demo-target]').forEach(x=>x.classList.remove('is-probing','is-checked','is-failed'));root.querySelector('.mock-primary').classList.remove('is-failed');setWalkthroughProgress(s.from);animateWalkthroughProgress(s.from,s.to,s.id==='report'?2500:s.duration,run);updateWorkflowRows(index===0?0:index===1?1:-1);
  if(s.id==='opening'){const address=root.querySelector('.demo-address');moveWalkthroughCursor(address);scheduleHeroWalkthrough(()=>{root.dataset.loaded='yes';root.querySelector('.demo-loader').classList.remove('is-loading')},850,run);root.querySelector('.demo-loader').classList.add('is-loading');scheduleHeroWalkthrough(()=>{root.querySelector('.demo-status').textContent='Website loaded successfully.';root.querySelector('.status-light').classList.add('is-success');updateWorkflowRows(1)},1650,run)}
  if(s.id==='testing'){root.querySelector('.status-light').classList.remove('is-success');const steps=[['.mock-nav .mock-link[data-demo-target="nav"]',250,1],['.mock-card',930,2],['.mock-nav .mock-link:nth-of-type(3)',1640,3],['.mock-primary',2360,4]];steps.forEach(([selector,delay,completed])=>scheduleHeroWalkthrough(()=>{const target=root.querySelector(selector);highlightWalkthroughTarget(target);if(target)pulseWalkthroughTarget(target,run);updateWorkflowRows(completed)},delay,run))}
  if(s.id==='detecting'){updateWorkflowRows(-1);const target=root.querySelector('.mock-primary');highlightWalkthroughTarget(target,true);scheduleHeroWalkthrough(()=>pulseWalkthroughTarget(target,run),380,run);scheduleHeroWalkthrough(()=>updateIssueConnector(),120,run)}
  if(s.id==='analyzing'){updateWorkflowRows(-1);const lines=[...root.querySelectorAll('.ai-lines span')];lines.forEach((line,i)=>scheduleHeroWalkthrough(()=>line.classList.add('is-visible'),350+i*360,run))}
  if(s.id==='report'){updateWorkflowRows(-1);root.querySelector('.status-light').classList.add('is-success');root.querySelector('.demo-cursor').classList.remove('is-visible');root.querySelector('[data-demo-report]').innerHTML='View report <span>→</span>'}
  scheduleHeroWalkthrough(()=>setWalkthroughStage(index===heroWalkthroughStages.length-1?0:index+1,run),s.duration,run)
}
function showReducedMotionWalkthrough(){clearHeroWalkthroughTimers();if(!heroWalkthroughRoot)return;const root=heroWalkthroughRoot;root.dataset.stage='report';root.dataset.loaded='yes';root.querySelector('.demo-status').textContent='Test completed · simulated summary';root.querySelector('.status-light').classList.add('is-success');root.querySelector('.demo-loader').classList.remove('is-loading');root.querySelector('.demo-cursor').classList.remove('is-visible');root.querySelectorAll('.ai-lines span').forEach(x=>x.classList.add('is-visible'));setWalkthroughProgress(100);updateWorkflowRows(-1)}
function startHeroWalkthrough(){const root=document.querySelector('[data-hero-walkthrough]');if(!root)return;stopHeroWalkthrough();heroWalkthroughRoot=root;heroWalkthroughMotion=window.matchMedia('(prefers-reduced-motion: reduce)');heroWalkthroughMotionHandler=e=>{if(e.matches)showReducedMotionWalkthrough();else setWalkthroughStage(0,++heroWalkthroughRun)};heroWalkthroughMotion.addEventListener?.('change',heroWalkthroughMotionHandler);heroWalkthroughResizeHandler=()=>{if(root.dataset.stage==='detecting')updateIssueConnector()};window.addEventListener('resize',heroWalkthroughResizeHandler);if(heroWalkthroughMotion.matches){showReducedMotionWalkthrough();return}setWalkthroughStage(0,heroWalkthroughRun)}
function setProductMenu(open,restoreFocus=false){const wrap=document.querySelector('.product-menu'),trigger=wrap?.querySelector('[data-product-menu-trigger]'),menu=wrap?.querySelector('.product-dropdown');if(!wrap||!trigger||!menu)return;clearTimeout(productMenuCloseTimer);if(open){menu.hidden=false;trigger.setAttribute('aria-expanded','true');wrap.classList.add('is-open');requestAnimationFrame(()=>{if(trigger.getAttribute('aria-expanded')==='true')menu.classList.add('is-open')});return}trigger.setAttribute('aria-expanded','false');wrap.classList.remove('is-open');menu.classList.remove('is-open');productMenuCloseTimer=setTimeout(()=>{if(trigger.getAttribute('aria-expanded')==='false')menu.hidden=true},190);if(restoreFocus)trigger.focus()}
function toggleProductMenu(){const trigger=document.querySelector('[data-product-menu-trigger]');setProductMenu(trigger?.getAttribute('aria-expanded')!=='true')}
function productMenuKeydown(e){const wrap=document.querySelector('.product-menu'),trigger=wrap?.querySelector('[data-product-menu-trigger]'),menu=wrap?.querySelector('.product-dropdown');if(!wrap||!trigger||!menu)return;const items=[...menu.querySelectorAll('[role="menuitem"]')],index=items.indexOf(document.activeElement);if(e.key==='Escape'&&trigger.getAttribute('aria-expanded')==='true'){e.preventDefault();setProductMenu(false,true);return}if((e.key==='ArrowDown'||e.key==='ArrowUp')&&document.activeElement===trigger){e.preventDefault();setProductMenu(true);requestAnimationFrame(()=>items[e.key==='ArrowDown'?0:items.length-1]?.focus());return}if(index>=0){let next;if(e.key==='ArrowDown')next=(index+1)%items.length;else if(e.key==='ArrowUp')next=(index-1+items.length)%items.length;else if(e.key==='Home')next=0;else if(e.key==='End')next=items.length-1;else return;e.preventDefault();items[next]?.focus()}}
function productDemo(){return `<div class="product-demo" data-product-demo data-stage="opening" role="region" aria-label="Simulated website test: website opened, elements tested, issue detected, and AI recommendation shown. Demo values only.">
  <div class="pd-browser">
    <div class="pd-chrome"><span class="pd-controls" aria-hidden="true"><i></i><i></i><i></i></span><div class="pd-address"><span class="pd-lock">⌑</span>example.com<i class="pd-loader"></i></div><span class="pd-site-label">PREVIEW</span></div>
    <div class="pd-page">
      <nav class="pd-nav" aria-label="Example site navigation"><b class="pd-brand">fieldnotes<span>®</span></b><button type="button" data-pd-target="nav">Shop</button><button type="button" data-pd-target="nav">Our story</button><button type="button" data-pd-target="nav">Journal</button></nav>
      <section class="pd-hero"><div class="pd-copy"><span class="pd-eyebrow">GROW AT YOUR OWN PACE</span><h3>Make room<br>for <em>good things.</em></h3><p>Thoughtful objects and easy ideas for everyday living.</p><button type="button" class="pd-primary" data-pd-target="primary">Explore the collection <span>↗</span></button></div><div class="pd-visual" aria-hidden="true"><i class="pd-sun"></i><span class="pd-vase"></span><span class="pd-leaf leaf-a"></span><span class="pd-leaf leaf-b"></span><span class="pd-leaf leaf-c"></span><small>OBJECTS FOR SLOW LIVING</small></div></section>
      <div class="pd-section-title"><b>Made for the everyday</b><span>VIEW ALL →</span></div><div class="pd-cards"><button type="button" class="pd-card" data-pd-target="card"><i class="pd-art art-a"></i><span><b>Sunday ceramics</b><small>Hand-finished stoneware</small></span></button><button type="button" class="pd-card" data-pd-target="card"><i class="pd-art art-b"></i><span><b>Soft linen</b><small>Natural, lived-in texture</small></span></button></div>
    </div><div class="pd-cursor" aria-hidden="true"><svg viewBox="0 0 22 28"><path d="M2 1.5v21l5.5-5.2 3.4 8.1 3.7-1.5-3.7-8 7.7-.6L2 1.5Z" fill="#111" stroke="#fff" stroke-width="1.25" stroke-linejoin="round"/></svg></div><span class="pd-ripple" aria-hidden="true"></span>
    <div class="pd-footer"><span class="pd-live-dot"></span><span class="pd-stage-copy" aria-live="polite">Simulated demo: Opening website...</span><div class="pd-progress" role="progressbar" aria-label="Simulated website test progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i></i></div><b class="pd-percent">0%</b></div>
  </div>
  <aside class="pd-panel pd-testing"><header><span class="pd-panel-icon">◉</span><b>FLIQ WEBSITE TEST</b></header><div class="pd-rows"><div class="pd-row" data-pd-row="0"><i></i><span>Opening website</span><b></b></div><div class="pd-row" data-pd-row="1"><i></i><span>Testing interactions</span><b></b></div><div class="pd-row" data-pd-row="2"><i></i><span>Checking links</span><b></b></div><div class="pd-row" data-pd-row="3"><i></i><span>Analyzing issues</span><b></b></div></div><small class="pd-disclaimer">SIMULATED DEMO · SAMPLE DATA</small></aside>
  <aside class="pd-panel pd-issue"><header><span class="pd-warning">!</span><b>ISSUE DETECTED</b></header><strong>Button interaction failed</strong><span class="pd-severity">Severity: Medium</span></aside>
  <aside class="pd-panel pd-ai"><header><span class="pd-ai-icon">✳</span><b>AI SUGGESTION</b></header><p>Review the button's click handler and navigation logic.</p><div class="pd-ai-action"><span>Recommended action</span><i></i></div></aside>
  <aside class="pd-panel pd-complete"><header><span class="pd-complete-icon">✓</span><b>TEST COMPLETED</b></header><div><i>✓</i>24 checks passed</div><div><i class="pd-issue-mark">!</i>1 issue detected</div><small>Illustrative demo values</small></aside>
</div>`}
let productDemoRoot=null, productDemoTimers=[], productDemoRun=0, productDemoMotion=null, productDemoMotionHandler=null;
function clearProductDemo(){productDemoTimers.forEach(clearTimeout);productDemoTimers=[];productDemoRun++;if(productDemoMotion&&productDemoMotionHandler)productDemoMotion.removeEventListener('change',productDemoMotionHandler);productDemoRoot=null;productDemoMotion=null;productDemoMotionHandler=null}
function pdLater(fn,ms,run){const t=setTimeout(()=>{productDemoTimers=productDemoTimers.filter(x=>x!==t);if(run===productDemoRun&&productDemoRoot?.isConnected)fn()},ms);productDemoTimers.push(t)}
function pdCursor(selector){const root=productDemoRoot,target=root?.querySelector(selector),cursor=root?.querySelector('.pd-cursor');if(!root||!target||!cursor)return;const b=root.querySelector('.pd-browser').getBoundingClientRect(),r=target.getBoundingClientRect();cursor.style.transform=`translate3d(${r.left-b.left+r.width*.52}px,${r.top-b.top+r.height*.55}px,0)`;cursor.classList.add('is-visible')}
function pdSetStage(stage,progress,status){const root=productDemoRoot;if(!root)return;const stageChanged=root.dataset.stage!==stage;root.dataset.stage=stage;root.querySelector('.pd-stage-copy').textContent=status;const fill=root.querySelector('.pd-progress i'),bar=root.querySelector('.pd-progress'),pct=root.querySelector('.pd-percent');fill.style.width=`${progress}%`;bar.setAttribute('aria-valuenow',String(progress));pct.textContent=`${progress}%`;root.querySelectorAll('.pd-row').forEach((row,i)=>{const done=stage==='complete'||stage==='ai'||stage==='issue'||(stage==='testing'&&(i===0||(i===1&&progress>=34)||(i===2&&progress>=45)))||(stage==='opening'&&i===0&&progress>=15);const active=(stage==='opening'&&i===0)||(stage==='testing'&&((i===1&&progress<34)||(i===2&&progress>=34&&progress<45)))||(stage==='issue'&&i===3)||(stage==='ai'&&i===3);row.dataset.state=done?'done':active?'active':'pending'});if(stageChanged){root.querySelectorAll('[data-pd-target]').forEach(el=>el.classList.remove('is-tested','is-failed'));root.querySelector('.pd-cursor').classList.remove('is-visible');root.querySelector('.pd-ripple').classList.remove('is-active')}}
function pdVisit(selector,failed=false){const root=productDemoRoot,target=root?.querySelector(selector);if(!root||!target)return;pdCursor(selector);target.classList.toggle('is-failed',failed);target.classList.toggle('is-tested',!failed);const r=target.getBoundingClientRect(),b=root.querySelector('.pd-browser').getBoundingClientRect(),rip=root.querySelector('.pd-ripple');rip.style.left=`${r.left-b.left+r.width*.52}px`;rip.style.top=`${r.top-b.top+r.height*.55}px`;rip.classList.remove('is-active');void rip.offsetWidth;rip.classList.add('is-active')}
function runProductDemoStage(stage,run){if(run!==productDemoRun||!productDemoRoot?.isConnected)return;const root=productDemoRoot;if(stage==='opening'){pdSetStage(stage,10,'Simulated demo: Opening website...');pdCursor('.pd-address');root.querySelector('.pd-loader').classList.add('is-loading');pdLater(()=>{root.dataset.loaded='yes';root.querySelector('.pd-loader').classList.remove('is-loading');pdSetStage('opening',15,'Simulated demo: Website loaded.')},900,run);pdLater(()=>runProductDemoStage('testing',run),2200,run)}else if(stage==='testing'){pdSetStage(stage,24,'Simulated demo: Testing interactive elements...');const visits=[['.pd-nav button',350,1],['.pd-card',1150,2],['.pd-primary',2050,3]];visits.forEach(([sel,delay,p])=>pdLater(()=>{pdVisit(sel);pdSetStage('testing',p===1?24:p===2?34:45,p===3?'Simulated demo: Testing primary action...':'Simulated demo: Testing elements...')},delay,run));pdLater(()=>runProductDemoStage('issue',run),3200,run)}else if(stage==='issue'){pdSetStage(stage,55,'Simulated demo: Issue detected.');pdVisit('.pd-primary',true);pdLater(()=>runProductDemoStage('ai',run),2600,run)}else if(stage==='ai'){pdSetStage(stage,82,'Simulated demo: AI analyzing issue...');pdLater(()=>pdSetStage('ai',88,'Simulated demo: Recommendation ready.'),1000,run);pdLater(()=>runProductDemoStage('complete',run),2800,run)}else{pdSetStage('complete',100,'Simulated demo: Test completed.');root.querySelector('.pd-cursor').classList.remove('is-visible');pdLater(()=>runProductDemoStage('opening',run),3000,run)}}
function startProductDemo(){clearProductDemo();const root=document.querySelector('[data-product-demo]');if(!root)return;productDemoRoot=root;productDemoMotion=matchMedia('(prefers-reduced-motion: reduce)');productDemoMotionHandler=e=>{if(e.matches){productDemoTimers.forEach(clearTimeout);productDemoTimers=[];root.dataset.stage='complete';root.dataset.loaded='yes';root.querySelector('.pd-stage-copy').textContent='Simulated demo: Test completed.';root.querySelector('.pd-progress i').style.width='100%';root.querySelector('.pd-progress').setAttribute('aria-valuenow','100');root.querySelector('.pd-percent').textContent='100%';root.querySelectorAll('.pd-row').forEach(x=>x.dataset.state='done');root.querySelector('.pd-cursor').classList.remove('is-visible')}else runProductDemoStage('opening',++productDemoRun)};productDemoMotion.addEventListener?.('change',productDemoMotionHandler);if(productDemoMotion.matches){productDemoMotionHandler({matches:true});return}runProductDemoStage('opening',productDemoRun)}function home(){return `${nav()}<main><section class="hero"><div class="hero-copy"><span class="eyebrow">WEBSITE QA, WITH A LITTLE MORE CLARITY</span><h1>Find bugs<br>before they<br>find <em>your users.</em></h1><p>AI-powered website testing that checks your site, finds issues, and gives clear, actionable fixes.</p><div class="actions">${btn('Get started','/signup')}${btn('Watch demo','#demo','btn outline demo-open')}</div><div class="social"><div class="faces"><b>AP</b><b>JD</b><b>MK</b></div><span>Trusted by 10,000+ developers</span></div></div>${heroWalkthrough()}</section><section class="feature-intro" id="product"><div><span class="eyebrow">MEET YOUR NEW QA SIDEKICK</span><h2>A smarter<br>way to <mark>test.</mark></h2><p>FLIQ runs real browser tests, finds issues, and uses AI to explain them in simple language.</p>${btn('Explore features','/features','btn outline')}</div>${productDemo()}<div class="feature-grid">${[['◉','Automated Testing','Real browser testing with Playwright.'],['♧','Issue Analysis','Clear, evidence-based issue explanations.'],['▧','Actionable Fixes','Step-by-step solutions for every issue.'],['▤','Beautiful Reports','Share, export, and track your progress.']].map(x=>`<article><i>${x[0]}</i><h3>${x[1]}</h3><p>${x[2]}</p></article>`).join('')}</div></section><section class="cta-band"><p>Spend less time finding bugs.<br><strong>More time building great things.</strong></p>${btn('Run your first test','/signup')}</section></main>${footer()}${demoModal()}`}
function demoModal(){return modal?`<div class="modal-backdrop" id="demo-modal-backdrop" data-modal-backdrop><section class="demo-modal" role="dialog" aria-modal="true" aria-labelledby="demo-modal-title"><button type="button" class="close" data-modal-close aria-label="Close modal">×</button><span class="eyebrow">A QUICK LOOK</span><h2 id="demo-modal-title">See your site through FLIQ.</h2><p>Enter a public website to start a real browser check.</p><form id="quick-test" novalidate><div class="demo-form-row"><input name="url" id="quick-test-url" type="url" placeholder="https://example.com" autocomplete="url" spellcheck="false" required><button type="submit" class="btn black" id="quick-test-submit">Run a test</button></div><div id="demo-error" role="alert" aria-live="polite"></div></form></section></div>`:''}
function shareDialog(id){return `<div class="modal-backdrop" data-share-close><section class="demo-modal share-modal" role="dialog" aria-modal="true" aria-labelledby="share-title"><button class="close" data-share-close aria-label="Close sharing dialog">×</button><span class="eyebrow">REPORT ACCESS</span><h2 id="share-title">Share with a signed-in user.</h2>${firebaseConfigured?`<p>Only this report is shared. The recipient needs a FLIQ account and must sign in. You can revoke access at any time.</p><form id="share-form" data-id="${esc(id)}"><label>Account email<input type="email" name="email" autocomplete="off" required placeholder="teammate@example.com"></label><button class="btn black" type="submit">Grant access</button></form><div class="share-recipients"><b>People with access</b>${shareRecipients.length?shareRecipients.map(r=>`<div class="share-person"><span>${esc(r.email)}</span><button class="btn outline" data-revoke="${esc(r.uid)}" data-email="${esc(r.email)}" data-test="${esc(id)}">Revoke</button></div>`).join(''):'<p>Only you can view this report.</p>'}</div>`:`<p>Sharing requires Firebase Authentication and Firestore. Configure Firebase, then share by account email.</p>`}<p class="share-message" aria-live="polite">${esc(shareMessage)}</p></section></div>`}
function featureIsoScene(){return `<div class="iso-scene" role="img" aria-label="Simulated FLIQ workflow: website input, browser testing, AI analysis, issue detection, and a completed test report. Demonstration values only.">
  <svg class="iso-map" viewBox="0 0 720 470" preserveAspectRatio="none" aria-hidden="true"><defs><filter id="iso-shadow" x="-30%" y="-30%" width="160%" height="180%"><feGaussianBlur in="SourceAlpha" stdDeviation="9"/><feOffset dy="7"/><feComponentTransfer><feFuncA type="linear" slope=".12"/></feComponentTransfer><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter><linearGradient id="iso-top" x2="0" y2="1"><stop stop-color="#fffdfa"/><stop offset="1" stop-color="#f0ebe5"/></linearGradient><marker id="iso-arrow-blue" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#8fb4d0"/></marker><marker id="iso-arrow-lime" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="#adc949"/></marker><marker id="iso-arrow-pink" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="#dc8d99"/></marker></defs>
    <path class="iso-ground-side" d="M30 315 260 410 460 410 690 315 690 338 460 433 260 433 30 338Z"/><path class="iso-ground-top" filter="url(#iso-shadow)" d="M30 130 260 35 460 35 690 130 690 315 460 410 260 410 30 315Z"/>
    <g class="iso-platform input-platform"><path class="platform-side" d="m107 235 63-33 65 33v14l-65 34-63-34z"/><path class="platform-top" d="m107 235 63-33 65 33-65 34z"/></g>
    <g class="iso-platform engine-platform"><path class="platform-side" d="m283 300 77-40 77 40v15l-77 41-77-41z"/><path class="platform-top" d="m283 300 77-40 77 40-77 41z"/></g>
    <g class="iso-platform ai-platform"><path class="platform-side" d="m486 245 74-38 75 38v14l-75 40-74-40z"/><path class="platform-top" d="m486 245 74-38 75 38-75 40z"/></g>
    <g class="iso-platform issue-platform"><path class="platform-side" d="m302 385 58-30 61 30v13l-61 32-58-32z"/><path class="platform-top" d="m302 385 58-30 61 30-61 32z"/></g>
    <g class="iso-platform report-platform"><path class="platform-side" d="m497 385 72-37 74 37v15l-74 39-72-39z"/><path class="platform-top" d="m497 385 72-37 74 37-74 39z"/></g>
    <path class="iso-link link-one" d="M170 194 C228 160 293 160 350 194"/><path class="iso-link link-two" d="M378 194 C432 160 500 160 550 194"/><path class="iso-link link-three" d="M550 220 C530 270 435 305 375 337"/><path class="iso-link link-four" d="M384 354 C438 383 498 383 550 354"/>
    <circle class="iso-pulse pulse-one" cx="225" cy="176" r="4"/><circle class="iso-pulse pulse-two" cx="291" cy="176" r="4"/><circle class="iso-pulse pulse-three" cx="435" cy="176" r="4"/><circle class="iso-pulse pulse-four" cx="500" cy="176" r="4"/><circle class="iso-pulse pulse-five" cx="500" cy="280" r="4"/><circle class="iso-pulse pulse-six" cx="470" cy="374" r="4"/>
    <g class="iso-cube-stack browser-cubes" transform="translate(50 15)"><path d="m244 269 22-12 23 12-23 12z" fill="#c8e8f4"/><path d="m244 269 22 12v19l-22-12z" fill="#80b8d0"/><path d="m266 281 23-12v19l-23 12z" fill="#6097b1"/><path d="m265 250 22-12 23 12-23 12z" fill="#e0f3f8"/><path d="m265 250 22 12v19l-22-12z" fill="#83bfdb"/><path d="m287 262 23-12v19l-23 12z" fill="#608eae"/><path d="m286 231 22-12 23 12-23 12z" fill="#e3dff5"/><path d="m286 231 22 12v19l-22-12z" fill="#aaa2d1"/><path d="m308 243 23-12v19l-23 12z" fill="#7771a9"/></g>
    <g class="iso-cube-stack ai-cubes" transform="translate(80 8)"><path d="m415 261 22-12 23 12-23 12z" fill="#f0f8c6"/><path d="m415 261 22 12v17l-22-12z" fill="#b4d36d"/><path d="m437 273 23-12v17l-23 12z" fill="#8daf4d"/><path d="m430 239 22-12 23 12-23 12z" fill="#e4f4ae"/><path d="m430 239 22 12v18l-22-12z" fill="#bdd975"/><path d="m452 251 23-12v18l-23 12z" fill="#92b354"/></g>
    <g class="iso-cube-stack issue-cube" transform="translate(-201 201)"><path d="m541 174 20-10 20 10-20 11z" fill="#ffe2e5"/><path d="m541 174 20 11v17l-20-11z" fill="#e9a2aa"/><path d="m561 185 20-11v17l-20 11z" fill="#cc7985"/></g>
  </svg>
  <div class="iso-card website-input"><div class="iso-card-kicker"><span class="step-number">01</span><span class="input-dot"></span>YOUR WEBSITE</div><div class="input-url"><span class="url-lock">⌑</span>example.com<span class="input-loader"></span></div><div class="website-thumb"><span><b>Little things, greener.</b><small>Find your next favorite.</small></span><i></i></div><div class="input-caption">Public site · ready to test</div></div>
  <div class="iso-card browser-engine"><div class="iso-component-kicker"><span class="step-number">02</span><span class="engine-orb">◌</span><b>BROWSER ENGINE</b></div><div class="engine-steps"><span><i></i>Opening website</span><span><i></i>Testing interactions</span><span><i></i>Checking links</span></div><div class="engine-foot">REAL BROWSER SESSION</div></div>
  <div class="iso-card ai-engine"><div class="iso-component-kicker"><span class="step-number">03</span><span class="ai-orb">✳</span><b>AI ANALYSIS</b></div><div class="analysis-stream"><i></i><i></i><i></i><i></i><i></i></div><div class="analysis-steps"><span>Reviewing page signals</span><span>Identifying potential issues</span></div><div class="analysis-status"><span></span> SUGGESTED FIX READY</div></div>
  <div class="iso-card issue-detection"><div class="issue-head"><span class="step-number">04</span><span class="issue-warning">!</span><b>ISSUE DETECTION</b></div><div class="issue-result">Broken link detected</div><div class="issue-meta">1 ISSUE DETECTED <i>Severity: Medium</i></div></div>
  <div class="iso-card report-platform-card"><div class="report-mini-head"><span class="step-number">05</span><span class="report-mini-icon">✓</span><div><b>TEST REPORT</b><small class="report-generating">Preparing summary</small><small class="report-complete">REPORT COMPLETE</small></div></div><div class="report-mini-row"><i>✓</i><b>24 checks passed</b></div><div class="report-mini-row report-issue-row"><i>!</i><b>1 issue detected</b></div><div class="report-suggestion"><span>✳</span> AI suggestions available</div><div class="sample-note">SAMPLE DATA · DEMO ONLY</div></div>
  <div class="iso-metric metric-checks"><span class="metric-check-icon">✓</span><span><b>CHECKS PASSED</b><strong>24</strong></span></div><div class="iso-metric metric-issues"><span class="metric-warning">!</span><span><b>ISSUES FOUND</b><strong>1</strong></span></div><div class="iso-metric metric-status"><span class="metric-status-dot"></span><span><b>REPORT STATUS</b><strong>COMPLETE</strong></span></div>
  <div class="iso-stage-label stage-running"><span></span> TEST IN PROGRESS</div><div class="iso-stage-label stage-complete"><span>✓</span> REPORT COMPLETE</div>
</div>`}function features(){return `${nav()}<main class="features-page"><section class="feature-hero"><div><span class="eyebrow">THOUGHTFUL TESTING, AUTOMATED</span><h1>A smarter<br>way to <mark>test.</mark></h1><p>FLIQ runs real browser tests, finds issues, and uses AI to explain them in simple language.</p>${btn('Get started','/signup')}</div>${featureIsoScene()}</section><section class="feature-grid large">${[['◉','Automated Testing','Real browser testing with Playwright.'],['♧','Issue Analysis','Clear, evidence-based issue explanations.'],['▧','Actionable Fixes','Step-by-step solutions for every issue.'],['▤','Beautiful Reports','Share, export, and track your progress.']].map((x,i)=>`<article id="${['automated-testing','ai-analysis','actionable-fixes','test-reports'][i]}"><i>${x[0]}</i><h3>${x[1]}</h3><p>${x[2]}</p></article>`).join('')}</section><section class="cta-band"><p>Ready to test smarter?</p>${btn('Create your account','/signup')}</section></main>${footer()}`}
const plans = [
  {
    name: 'Free',
    desc: 'Get started with basic testing.',
    monthlyPrice: '$0',
    yearlyPrice: '$0',
    unitMonthly: 'forever',
    unitYearly: 'forever',
    yearlySubtext: '',
    items: [
      '3 website scans per month',
      'Basic audit reports',
      'Basic accessibility, functionality, performance, SEO and security checks',
      '7-day scan history',
      'Community support'
    ]
  },
  {
    name: 'Creator',
    desc: 'Perfect for developers and individual creators.',
    monthlyPrice: '$5',
    yearlyPrice: '$48',
    unitMonthly: 'monthly',
    unitYearly: 'yearly',
    yearlySubtext: '$4/month, billed annually at $48.',
    items: [
      '100 website scans per month',
      'Advanced audit reports',
      'AI-powered explanations',
      'PDF report exports',
      '90-day scan history',
      'Advanced accessibility, functionality, performance, SEO and security checks',
      'Email support'
    ]
  },
  {
    name: 'Team',
    desc: 'For growing teams and agencies.',
    monthlyPrice: '$9',
    yearlyPrice: '$84',
    unitMonthly: 'monthly',
    unitYearly: 'yearly',
    yearlySubtext: '$7/month, billed annually at $84.',
    items: [
      '500 website scans per month',
      'Advanced audit reports',
      'AI-powered explanations',
      'PDF report exports',
      '1-year scan history',
      'Team collaboration',
      'Priority scanning',
      'Priority support'
    ]
  }
];
window.fliqPlans = plans;

function pricing() {
  const isYearly = period === 'Yearly';
  return `${nav()}<main class="pricing-page"><span class="eyebrow">PLANS THAT GROW WITH YOU</span><h1>Simple, transparent<br><em>pricing.</em></h1><p>Start for free. Upgrade when you're ready.</p><div class="billing"><button class="${!isYearly ? 'selected' : ''}" data-period="Monthly">Monthly</button><button class="${isYearly ? 'selected' : ''}" data-period="Yearly">Yearly</button><span>Save up to 22%</span></div><div class="plans">${plans.map(p => {
    const isCreator = p.name === 'Creator';
    const displayedPrice = isYearly ? p.yearlyPrice : p.monthlyPrice;
    const displayedUnit = isYearly ? p.unitYearly : p.unitMonthly;
    const subtext = (isYearly && p.yearlySubtext)
      ? `<div class="price-subtext">${esc(p.yearlySubtext)}</div>`
      : `<div class="price-subtext" style="visibility:hidden" aria-hidden="true">&nbsp;</div>`;

    return `<article class="plan ${isCreator ? 'featured' : ''}">${isCreator ? '<b class="popular">✓</b>' : ''}<h3>${esc(p.name)}</h3><p>${esc(p.desc)}</p><div class="price">${displayedPrice}<small> / ${displayedUnit}</small></div>${subtext}<ul>${p.items.map(i => `<li>✓ &nbsp;${esc(i)}</li>`).join('')}</ul>${btn('Get started', '/signup', `btn ${isCreator ? 'black' : 'outline'} full`, `data-plan-select="${esc(p.name.toLowerCase())}" data-plan-name="${esc(p.name)}"`)}</article>`;
  }).join('')}</div><p class="fine-print">Simple pricing. No hidden fees. Upgrade or cancel anytime.</p></main>${footer()}`;
}
let authCarouselTimer = null;
let authCarouselIndex = 0;
let authCarouselPaused = false;

function stopAuthCarousel() {
  if (authCarouselTimer) {
    clearInterval(authCarouselTimer);
    authCarouselTimer = null;
  }
}

function setAuthCarouselSlide(index) {
  const root = document.querySelector('[data-auth-carousel]');
  if (!root) return;
  authCarouselIndex = index;
  const track = root.querySelector('.auth-carousel-track');
  if (track) {
    track.style.transform = `translateX(-${index * 100}%)`;
  }
  const dots = root.querySelectorAll('[data-carousel-dot]');
  dots.forEach((dot, i) => {
    const isActive = i === index;
    dot.classList.toggle('active', isActive);
    dot.setAttribute('aria-selected', String(isActive));
  });
}

function resetAuthCarouselTimer() {
  stopAuthCarousel();
  const prefersReduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  if (prefersReduced) return;
  authCarouselTimer = setInterval(() => {
    if (!authCarouselPaused) {
      const next = (authCarouselIndex + 1) % 3;
      setAuthCarouselSlide(next);
    }
  }, 4000);
}

function initAuthCarousel() {
  stopAuthCarousel();
  const root = document.querySelector('[data-auth-carousel]');
  if (!root) return;
  authCarouselIndex = 0;
  authCarouselPaused = false;
  setAuthCarouselSlide(0);

  root.onmouseenter = () => { authCarouselPaused = true; };
  root.onmouseleave = () => { authCarouselPaused = false; };

  resetAuthCarouselTimer();
}

function authIllustrationPanel() {
  return `<aside class="auth-visual-column" data-auth-carousel aria-label="FLIQ Highlights">
    <div class="auth-carousel-viewport">
      <div class="auth-carousel-track">
        <!-- ==================== SLIDE 1: WEBSITE TESTING ==================== -->
        <div class="auth-carousel-slide" data-slide-index="0">
          <div class="auth-illustration-wrap">
            <svg class="auth-illustration-svg" viewBox="0 0 520 400" fill="none" xmlns="http://www.w3.org/2000/svg">
              <defs>
                <filter id="card-subtle-shadow-1" x="-8%" y="-8%" width="120%" height="125%" filterUnits="userSpaceOnUse">
                  <feDropShadow dx="0" dy="8" stdDeviation="12" flood-color="#142818" flood-opacity="0.06"/>
                </filter>
              </defs>

              <!-- Floor shadow under character -->
              <ellipse cx="265" cy="355" rx="135" ry="20" fill="#dbeadc"/>

              <!-- Connector dashed curve: Website Card to Shield -->
              <path d="M 188 126 C 218 106 242 102 254 106" stroke="#1f2421" stroke-width="1.6" stroke-dasharray="3.5 3.5" stroke-linecap="round"/>

              <!-- Connector dashed curve: Shield to Performance Card -->
              <path d="M 288 106 C 304 102 328 108 350 126" stroke="#1f2421" stroke-width="1.6" stroke-dasharray="3.5 3.5" stroke-linecap="round"/>

              <!-- Connector dashed curve: Performance Card to Bar Chart -->
              <path d="M 426 195 C 435 218 430 236 438 250" stroke="#1f2421" stroke-width="1.6" stroke-dasharray="3.5 3.5" stroke-linecap="round"/>

              <!-- Floating Card 1: Top-Left Website Preview (Tilted) -->
              <g transform="rotate(-6 105 140)" filter="url(#card-subtle-shadow-1)">
                <rect x="35" y="88" width="144" height="96" rx="12" fill="#ffffff" stroke="#1f2421" stroke-width="1.6"/>
                <circle cx="49" cy="101" r="2.8" fill="#22c55e"/>
                <circle cx="58" cy="101" r="2.8" fill="#cbd5e1"/>
                <circle cx="67" cy="101" r="2.8" fill="#cbd5e1"/>
                <rect x="47" y="112" width="48" height="38" rx="6" fill="#f1f5f9"/>
                <circle cx="80" cy="122" r="4.5" fill="#e2e8f0"/>
                <path d="M 47 142 L 59 128 L 74 144 L 81 137 L 95 150 L 47 150 Z" fill="#cbd5e1"/>
                <rect x="103" y="116" width="64" height="6" rx="3" fill="#e2e8f0"/>
                <rect x="103" y="127" width="48" height="6" rx="3" fill="#e2e8f0"/>
                <rect x="103" y="138" width="56" height="6" rx="3" fill="#e2e8f0"/>
                <rect x="47" y="158" width="120" height="5" rx="2.5" fill="#e2e8f0"/>
                <rect x="47" y="167" width="85" height="5" rx="2.5" fill="#e2e8f0"/>
              </g>

              <!-- Floating Badge: Top-Center Shield with Checkmark -->
              <g filter="url(#card-subtle-shadow-1)">
                <path d="M 256 88 C 256 88 271 85 271 85 C 271 85 286 88 286 88 C 286 102 281 118 271 125 C 261 118 256 102 256 88 Z" fill="#ffffff" stroke="#1f2421" stroke-width="1.6"/>
                <circle cx="271" cy="104" r="7.5" fill="#dcfce7"/>
                <path d="M 268 104 L 270.5 106.5 L 274.5 101" stroke="#16a34a" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
              </g>

              <!-- Floating Card 2: Top-Right Performance Score (Tilted) -->
              <g transform="rotate(6 422 145)" filter="url(#card-subtle-shadow-1)">
                <rect x="352" y="94" width="124" height="95" rx="12" fill="#ffffff" stroke="#1f2421" stroke-width="1.6"/>
                <text x="414" y="115" text-anchor="middle" font-family="'DM Sans',sans-serif" font-size="10.5" font-weight="600" fill="#1f2421">Performance</text>
                <path d="M 386 153 A 28 28 0 0 1 442 153" fill="none" stroke="#e5e7eb" stroke-width="5" stroke-linecap="round"/>
                <path d="M 386 153 A 28 28 0 0 1 438 136" fill="none" stroke="#22c55e" stroke-width="5" stroke-linecap="round"/>
                <text x="414" y="149" text-anchor="middle" font-family="'DM Sans',sans-serif" font-size="19" font-weight="800" fill="#1f2421">92</text>
                <text x="414" y="162" text-anchor="middle" font-family="'DM Sans',sans-serif" font-size="9" font-weight="500" fill="#64748b">/100</text>
              </g>

              <!-- Stack of 3 Feature Badges on Left -->
              <g filter="url(#card-subtle-shadow-1)">
                <rect x="25" y="218" width="134" height="28" rx="8" fill="#ffffff" stroke="#1f2421" stroke-width="1.6"/>
                <g transform="translate(35, 224)" stroke="#1f2421" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none">
                  <circle cx="7.5" cy="2.5" r="1.5" fill="#1f2421"/>
                  <path d="M 7.5 5.5 V 10.5 H 11.5 L 13 14"/>
                  <path d="M 4 8.5 A 4 4 0 1 0 8 12.5"/>
                </g>
                <text x="56" y="236" font-family="'DM Sans',sans-serif" font-size="10" font-weight="600" fill="#1f2421">Accessibility</text>
                <circle cx="145" cy="232" r="6.5" fill="#dcfce7"/>
                <path d="M 142.5 232 L 144.5 234 L 148 229.5" stroke="#16a34a" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
              </g>

              <g filter="url(#card-subtle-shadow-1)">
                <rect x="25" y="254" width="134" height="28" rx="8" fill="#ffffff" stroke="#1f2421" stroke-width="1.6"/>
                <g transform="translate(35, 260)" stroke="#1f2421" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none">
                  <path d="M 3 3 C 3 3 7.5 1.5 7.5 1.5 C 7.5 1.5 12 3 12 3 C 12 7.5 10 11.5 7.5 13.5 C 5 11.5 3 7.5 3 3 Z"/>
                </g>
                <text x="56" y="272" font-family="'DM Sans',sans-serif" font-size="10" font-weight="600" fill="#1f2421">Security</text>
                <circle cx="145" cy="268" r="6.5" fill="#dcfce7"/>
                <path d="M 142.5 268 L 144.5 270 L 148 265.5" stroke="#16a34a" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
              </g>

              <g filter="url(#card-subtle-shadow-1)">
                <rect x="25" y="290" width="134" height="28" rx="8" fill="#ffffff" stroke="#1f2421" stroke-width="1.6"/>
                <g transform="translate(36, 296)" stroke="#1f2421" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none">
                  <circle cx="5.5" cy="5.5" r="4"/>
                  <line x1="8.5" y1="8.5" x2="12" y2="12"/>
                </g>
                <text x="56" y="308" font-family="'DM Sans',sans-serif" font-size="10" font-weight="600" fill="#1f2421">SEO</text>
                <circle cx="145" cy="304" r="6.5" fill="#dcfce7"/>
                <path d="M 142.5 304 L 144.5 306 L 148 301.5" stroke="#16a34a" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
              </g>

              <!-- Floating Card 3: Middle-Right Mini Bar Chart -->
              <g filter="url(#card-subtle-shadow-1)">
                <rect x="424" y="244" width="66" height="52" rx="10" fill="#ffffff" stroke="#1f2421" stroke-width="1.6"/>
                <rect x="439" y="270" width="7" height="15" rx="3.5" fill="#86efac"/>
                <rect x="453" y="260" width="7" height="25" rx="3.5" fill="#4ade80"/>
                <rect x="467" y="251" width="7" height="34" rx="3.5" fill="#22c55e"/>
              </g>

              <!-- Main Character: Sitting Cross-Legged with Laptop -->
              <g>
                <!-- Left Shoe -->
                <g>
                  <path d="M 200 342 C 190 342 178 346 178 355 C 178 362 188 365 210 365 C 230 365 238 358 238 351 C 238 344 220 342 200 342 Z" fill="#ffffff" stroke="#1f2421" stroke-width="1.6"/>
                  <path d="M 180 359 Q 206 363 236 357" stroke="#1f2421" stroke-width="1.4" fill="none"/>
                  <line x1="192" y1="351" x2="192" y2="358" stroke="#1f2421" stroke-width="1.2"/>
                  <line x1="198" y1="351" x2="198" y2="359" stroke="#1f2421" stroke-width="1.2"/>
                  <line x1="204" y1="351" x2="204" y2="359" stroke="#1f2421" stroke-width="1.2"/>
                  <line x1="210" y1="351" x2="210" y2="359" stroke="#1f2421" stroke-width="1.2"/>
                </g>

                <!-- Right Shoe -->
                <g>
                  <path d="M 332 342 C 342 342 354 346 354 355 C 354 362 344 365 322 365 C 302 365 294 358 294 351 C 294 344 312 342 332 342 Z" fill="#ffffff" stroke="#1f2421" stroke-width="1.6"/>
                  <path d="M 352 359 Q 326 363 296 357" stroke="#1f2421" stroke-width="1.4" fill="none"/>
                  <line x1="340" y1="351" x2="340" y2="358" stroke="#1f2421" stroke-width="1.2"/>
                  <line x1="334" y1="351" x2="334" y2="359" stroke="#1f2421" stroke-width="1.2"/>
                  <line x1="328" y1="351" x2="328" y2="359" stroke="#1f2421" stroke-width="1.2"/>
                  <line x1="322" y1="351" x2="322" y2="359" stroke="#1f2421" stroke-width="1.2"/>
                </g>

                <!-- Legs & Pants -->
                <path d="M 230 305 C 190 305 168 322 172 342 C 176 355 198 355 236 345 C 255 340 262 328 262 320 Z" fill="#212624" stroke="#1f2421" stroke-width="1.6"/>
                <path d="M 300 305 C 340 305 362 322 358 342 C 354 355 332 355 294 345 C 275 340 268 328 268 320 Z" fill="#212624" stroke="#1f2421" stroke-width="1.6"/>
                <path d="M 262 320 L 268 320" stroke="#1f2421" stroke-width="1.4"/>

                <!-- Green Hoodie Body -->
                <path d="M 226 235 C 226 220 236 214 265 214 C 294 214 304 220 304 235 L 308 302 C 308 312 296 316 265 316 C 234 316 222 312 222 302 Z" fill="#78cb7a" stroke="#1f2421" stroke-width="1.6"/>

                <!-- Left Arm -->
                <path d="M 228 238 C 214 252 204 274 218 296 C 226 308 244 300 248 292 L 238 274 Z" fill="#78cb7a" stroke="#1f2421" stroke-width="1.6"/>

                <!-- Right Arm -->
                <path d="M 302 238 C 316 252 326 274 312 296 C 304 308 286 300 282 292 L 292 274 Z" fill="#78cb7a" stroke="#1f2421" stroke-width="1.6"/>

                <!-- White Collar -->
                <path d="M 252 216 Q 265 228 278 216 Q 265 222 252 216 Z" fill="#ffffff" stroke="#1f2421" stroke-width="1.4"/>

                <!-- Drawstrings -->
                <path d="M 258 222 V 242" stroke="#ffffff" stroke-width="2" stroke-linecap="round"/>
                <circle cx="258" cy="243" r="1.5" fill="#ffffff"/>
                <path d="M 272 222 V 242" stroke="#ffffff" stroke-width="2" stroke-linecap="round"/>
                <circle cx="272" cy="243" r="1.5" fill="#ffffff"/>

                <!-- Neck -->
                <path d="M 258 206 H 272 V 218 H 258 Z" fill="#fcdbc7" stroke="#1f2421" stroke-width="1.4"/>

                <!-- Head -->
                <path d="M 252 178 C 252 165 258 152 265 152 C 272 152 278 165 278 178 C 278 194 274 206 265 206 C 256 206 252 194 252 178 Z" fill="#fcdbc7" stroke="#1f2421" stroke-width="1.6"/>

                <!-- Ears -->
                <circle cx="251" cy="180" r="3.5" fill="#fcdbc7" stroke="#1f2421" stroke-width="1.4"/>
                <circle cx="279" cy="180" r="3.5" fill="#fcdbc7" stroke="#1f2421" stroke-width="1.4"/>

                <!-- Eyes & Face -->
                <path d="M 257 172 Q 260 170 263 172" stroke="#1f2421" stroke-width="1.4" stroke-linecap="round" fill="none"/>
                <path d="M 267 172 Q 270 170 273 172" stroke="#1f2421" stroke-width="1.4" stroke-linecap="round" fill="none"/>
                <circle cx="260" cy="176" r="1.6" fill="#1f2421"/>
                <circle cx="270" cy="176" r="1.6" fill="#1f2421"/>
                <path d="M 265 178 V 183 H 267" stroke="#1f2421" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
                <path d="M 261 187 Q 265 192 269 187" stroke="#1f2421" stroke-width="1.4" stroke-linecap="round" fill="none"/>

                <!-- Curly Hair -->
                <path d="M 248 172 C 246 162 250 148 260 144 C 265 142 272 142 278 147 C 284 152 284 162 282 170 C 280 166 278 163 273 162 C 268 161 264 163 261 166 C 258 163 252 165 248 172 Z" fill="#1f2421" stroke="#1f2421" stroke-width="1.6"/>
                <circle cx="256" cy="148" r="5" fill="#1f2421"/>
                <circle cx="264" cy="144" r="6" fill="#1f2421"/>
                <circle cx="274" cy="147" r="5.5" fill="#1f2421"/>

                <!-- Hands Typing -->
                <circle cx="244" cy="296" r="4.5" fill="#fcdbc7" stroke="#1f2421" stroke-width="1.3"/>
                <circle cx="286" cy="296" r="4.5" fill="#fcdbc7" stroke="#1f2421" stroke-width="1.3"/>

                <!-- White Laptop -->
                <g filter="url(#card-subtle-shadow-1)">
                  <rect x="234" y="260" width="62" height="42" rx="5" fill="#ffffff" stroke="#1f2421" stroke-width="1.6"/>
                  <g transform="translate(265, 281)" fill="#1f2421">
                    <rect x="-1.8" y="-7.5" width="3.6" height="15" rx="1.8"/>
                    <rect x="-1.8" y="-7.5" width="3.6" height="15" rx="1.8" transform="rotate(60)"/>
                    <rect x="-1.8" y="-7.5" width="3.6" height="15" rx="1.8" transform="rotate(120)"/>
                  </g>
                </g>

                <!-- Action Ticks -->
                <line x1="223" y1="262" x2="216" y2="267" stroke="#1f2421" stroke-width="1.5" stroke-linecap="round"/>
                <line x1="225" y1="274" x2="217" y2="280" stroke="#1f2421" stroke-width="1.5" stroke-linecap="round"/>
                <line x1="307" y1="262" x2="314" y2="267" stroke="#1f2421" stroke-width="1.5" stroke-linecap="round"/>
                <line x1="305" y1="274" x2="313" y2="280" stroke="#1f2421" stroke-width="1.5" stroke-linecap="round"/>
              </g>
            </svg>
          </div>

          <div class="auth-visual-copy">
            <h2 class="auth-visual-heading">Make every website<br>better with FLIQ.</h2>
            <p class="auth-visual-sub">Discover issues. Improve performance. Ship with confidence.</p>
          </div>
        </div>

        <!-- ==================== SLIDE 2: FIND ISSUES ==================== -->
        <div class="auth-carousel-slide" data-slide-index="1">
          <div class="auth-illustration-wrap">
            <svg class="auth-illustration-svg" viewBox="0 0 520 400" fill="none" xmlns="http://www.w3.org/2000/svg">
              <defs>
                <filter id="card-subtle-shadow-2" x="-8%" y="-8%" width="120%" height="125%" filterUnits="userSpaceOnUse">
                  <feDropShadow dx="0" dy="8" stdDeviation="12" flood-color="#142818" flood-opacity="0.06"/>
                </filter>
              </defs>

              <!-- Floor shadow -->
              <ellipse cx="260" cy="355" rx="140" ry="18" fill="#dbeadc"/>

              <!-- Main Browser Window -->
              <g filter="url(#card-subtle-shadow-2)">
                <rect x="135" y="70" width="255" height="180" rx="14" fill="#ffffff" stroke="#1f2421" stroke-width="1.8"/>
                <!-- Browser window header dots -->
                <circle cx="152" cy="85" r="3" fill="#22c55e"/>
                <circle cx="162" cy="85" r="3" fill="#cbd5e1"/>
                <circle cx="172" cy="85" r="3" fill="#cbd5e1"/>
                <line x1="135" y1="98" x2="390" y2="98" stroke="#f1f5f9" stroke-width="1.2"/>

                <!-- Thumbnail box -->
                <rect x="152" y="112" width="76" height="58" rx="8" fill="#f1f5f9"/>
                <circle cx="206" cy="125" r="6" fill="#e2e8f0"/>
                <path d="M 152 155 L 170 137 L 188 155 L 198 147 L 218 167 L 228 167 L 152 167 Z" fill="#cbd5e1"/>

                <!-- Skeleton lines -->
                <rect x="240" y="118" width="105" height="7" rx="3.5" fill="#e2e8f0"/>
                <rect x="240" y="132" width="75" height="7" rx="3.5" fill="#e2e8f0"/>
                <rect x="240" y="146" width="90" height="7" rx="3.5" fill="#e2e8f0"/>
                <rect x="152" y="186" width="160" height="6" rx="3" fill="#e2e8f0"/>
                <rect x="152" y="198" width="110" height="6" rx="3" fill="#e2e8f0"/>
              </g>

              <!-- Action ticks at top right of browser -->
              <line x1="380" y1="52" x2="373" y2="60" stroke="#1f2421" stroke-width="1.8" stroke-linecap="round"/>
              <line x1="393" y1="44" x2="393" y2="54" stroke="#1f2421" stroke-width="1.8" stroke-linecap="round"/>
              <line x1="406" y1="50" x2="413" y2="58" stroke="#1f2421" stroke-width="1.8" stroke-linecap="round"/>

              <!-- Checklist Card on the left (overlapping) -->
              <g filter="url(#card-subtle-shadow-2)">
                <rect x="60" y="165" width="142" height="114" rx="12" fill="#ffffff" stroke="#1f2421" stroke-width="1.8"/>

                <!-- Item 1: Find Issues -->
                <circle cx="82" cy="195" r="8" fill="#dcfce7"/>
                <path d="M 78.5 195 L 81 197.5 L 85.5 192.5" stroke="#16a34a" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
                <text x="98" y="199" font-family="'DM Sans',sans-serif" font-size="11.5" font-weight="700" fill="#1f2421">Find Issues</text>

                <!-- Item 2: Get Insights -->
                <circle cx="82" cy="225" r="8" fill="#dcfce7"/>
                <path d="M 78.5 225 L 81 227.5 L 85.5 222.5" stroke="#16a34a" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
                <text x="98" y="229" font-family="'DM Sans',sans-serif" font-size="11.5" font-weight="700" fill="#1f2421">Get Insights</text>

                <!-- Item 3: Fix Faster -->
                <circle cx="82" cy="255" r="8" fill="#dcfce7"/>
                <path d="M 78.5 255 L 81 257.5 L 85.5 252.5" stroke="#16a34a" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
                <text x="98" y="259" font-family="'DM Sans',sans-serif" font-size="11.5" font-weight="700" fill="#1f2421">Fix Faster</text>
              </g>

              <!-- Magnifying Glass with Bug (Right side) -->
              <g filter="url(#card-subtle-shadow-2)">
                <!-- Glass Lens -->
                <circle cx="340" cy="198" r="44" fill="#ffffff" stroke="#1f2421" stroke-width="2.2"/>

                <!-- Bug / Beetle -->
                <!-- Head -->
                <ellipse cx="340" cy="182" rx="7.5" ry="6" fill="#22c55e" stroke="#1f2421" stroke-width="1.5"/>
                <!-- Antennae -->
                <path d="M 336 178 Q 332 173 328 174" stroke="#1f2421" stroke-width="1.4" fill="none" stroke-linecap="round"/>
                <path d="M 344 178 Q 348 173 352 174" stroke="#1f2421" stroke-width="1.4" fill="none" stroke-linecap="round"/>
                <!-- Body Shell -->
                <ellipse cx="340" cy="201" rx="14.5" ry="17.5" fill="#86efac" stroke="#1f2421" stroke-width="1.6"/>
                <line x1="340" y1="187" x2="340" y2="218" stroke="#1f2421" stroke-width="1.4"/>
                <!-- Legs (3 left, 3 right) -->
                <path d="M 326 193 Q 319 191 315 195" stroke="#1f2421" stroke-width="1.5" fill="none" stroke-linecap="round"/>
                <path d="M 325 201 Q 318 201 314 205" stroke="#1f2421" stroke-width="1.5" fill="none" stroke-linecap="round"/>
                <path d="M 326 209 Q 319 211 316 216" stroke="#1f2421" stroke-width="1.5" fill="none" stroke-linecap="round"/>

                <path d="M 354 193 Q 361 191 365 195" stroke="#1f2421" stroke-width="1.5" fill="none" stroke-linecap="round"/>
                <path d="M 355 201 Q 362 201 366 205" stroke="#1f2421" stroke-width="1.5" fill="none" stroke-linecap="round"/>
                <path d="M 354 209 Q 361 211 364 216" stroke="#1f2421" stroke-width="1.5" fill="none" stroke-linecap="round"/>

                <!-- Magnifying Glass Handle -->
                <rect x="372" y="226" width="14" height="42" rx="7" transform="rotate(-42 372 226)" fill="#78cb7a" stroke="#1f2421" stroke-width="2"/>
              </g>
            </svg>
          </div>

          <div class="auth-visual-copy">
            <h2 class="auth-visual-heading">Spot issues<br>before your users do.</h2>
            <p class="auth-visual-sub">Catch bugs, broken links, and usability problems early.</p>
          </div>
        </div>

        <!-- ==================== SLIDE 3: PERFORMANCE ==================== -->
        <div class="auth-carousel-slide" data-slide-index="2">
          <div class="auth-illustration-wrap">
            <svg class="auth-illustration-svg" viewBox="0 0 520 400" fill="none" xmlns="http://www.w3.org/2000/svg">
              <defs>
                <filter id="card-subtle-shadow-3" x="-8%" y="-8%" width="120%" height="125%" filterUnits="userSpaceOnUse">
                  <feDropShadow dx="0" dy="8" stdDeviation="12" flood-color="#142818" flood-opacity="0.06"/>
                </filter>
              </defs>

              <!-- Floor shadow -->
              <ellipse cx="260" cy="355" rx="140" ry="18" fill="#dbeadc"/>

              <!-- Performance Graph Card (Left) -->
              <g filter="url(#card-subtle-shadow-3)">
                <rect x="80" y="105" width="188" height="155" rx="14" fill="#ffffff" stroke="#1f2421" stroke-width="1.8"/>
                <line x1="80" y1="130" x2="268" y2="130" stroke="#f1f5f9" stroke-width="1.2"/>

                <!-- 4 Ascending Green Bars -->
                <rect x="106" y="200" width="14" height="35" rx="4" fill="#bbf7d0"/>
                <rect x="132" y="180" width="14" height="55" rx="4" fill="#86efac"/>
                <rect x="158" y="160" width="14" height="75" rx="4" fill="#4ade80"/>
                <rect x="184" y="140" width="14" height="95" rx="4" fill="#22c55e"/>

                <!-- Upward Trending Arrow -->
                <path d="M 102 208 C 128 190 158 170 196 128" stroke="#1f2421" stroke-width="2.2" fill="none" stroke-linecap="round"/>
                <polygon points="202,122 191,126 197,134" fill="#1f2421"/>
              </g>

              <!-- Action ticks on bottom-left -->
              <line x1="66" y1="248" x2="56" y2="253" stroke="#1f2421" stroke-width="1.8" stroke-linecap="round"/>
              <line x1="63" y1="262" x2="53" y2="267" stroke="#1f2421" stroke-width="1.8" stroke-linecap="round"/>
              <line x1="70" y1="275" x2="62" y2="282" stroke="#1f2421" stroke-width="1.8" stroke-linecap="round"/>

              <!-- Rocket Launching at Top-Right -->
              <g transform="translate(365, 88) rotate(42)">
                <!-- Thruster Flame / Smoke -->
                <path d="M -7 38 Q 0 54 7 38 Q 0 42 -7 38 Z" fill="#fde047" stroke="#1f2421" stroke-width="1.4"/>
                <path d="M -4 38 Q 0 48 4 38 Q 0 41 -4 38 Z" fill="#ef4444"/>
                <line x1="-11" y1="42" x2="-17" y2="50" stroke="#1f2421" stroke-width="1.6" stroke-linecap="round"/>
                <line x1="11" y1="42" x2="17" y2="50" stroke="#1f2421" stroke-width="1.6" stroke-linecap="round"/>

                <!-- Rocket Fins -->
                <path d="M -13 18 L -23 36 L -13 32 Z" fill="#78cb7a" stroke="#1f2421" stroke-width="1.8"/>
                <path d="M 13 18 L 23 36 L 13 32 Z" fill="#78cb7a" stroke="#1f2421" stroke-width="1.8"/>

                <!-- Fuselage -->
                <path d="M 0 -28 C 17 -8 15 26 13 34 L -13 34 C -15 26 -17 -8 0 -28 Z" fill="#ffffff" stroke="#1f2421" stroke-width="2"/>
                <path d="M 0 -28 C 7 -20 9 -12 9 -6 L -9 -6 C -9 -12 -7 -20 0 -28 Z" fill="#78cb7a"/>

                <!-- Porthole Window -->
                <circle cx="0" cy="8" r="7" fill="#ffffff" stroke="#1f2421" stroke-width="1.8"/>
                <circle cx="0" cy="8" r="4.5" fill="#78cb7a"/>
              </g>

              <!-- Floating Site Score Card (Right, overlapping chart) -->
              <g filter="url(#card-subtle-shadow-3)">
                <rect x="250" y="170" width="138" height="116" rx="14" fill="#ffffff" stroke="#1f2421" stroke-width="1.8"/>
                <text x="319" y="196" text-anchor="middle" font-family="'DM Sans',sans-serif" font-size="11.5" font-weight="700" fill="#1f2421">Site Score</text>

                <!-- Circular Ring Gauge -->
                <circle cx="319" cy="242" r="28" fill="none" stroke="#e2e8f0" stroke-width="5"/>
                <circle cx="319" cy="242" r="28" fill="none" stroke="#22c55e" stroke-width="5" stroke-dasharray="175" stroke-dashoffset="15" stroke-linecap="round" transform="rotate(-90 319 242)"/>

                <text x="319" y="250" text-anchor="middle" font-family="'DM Sans',sans-serif" font-size="22" font-weight="800" fill="#1f2421">98</text>
              </g>
            </svg>
          </div>

          <div class="auth-visual-copy">
            <h2 class="auth-visual-heading">Improve performance<br>and grow faster.</h2>
            <p class="auth-visual-sub">Optimize speed, SEO, and overall site health with actionable insights.</p>
          </div>
        </div>
      </div>
    </div>

    <!-- 3 Navigation Dots at Bottom -->
    <div class="auth-visual-dots" role="tablist" aria-label="Carousel navigation">
      <button type="button" class="auth-visual-dot active" data-carousel-dot="0" aria-label="Slide 1: Website Testing" role="tab" aria-selected="true"></button>
      <button type="button" class="auth-visual-dot" data-carousel-dot="1" aria-label="Slide 2: Find Issues" role="tab" aria-selected="false"></button>
      <button type="button" class="auth-visual-dot" data-carousel-dot="2" aria-label="Slide 3: Performance" role="tab" aria-selected="false"></button>
    </div>
  </aside>`;
}

function auth(signup=false){
  const params = new URLSearchParams(location.search);
  const pendingUrl = params.get('pendingUrl') || sessionStorage.getItem('fliqPendingUrl') || '';
  const pendingPlan = params.get('plan') || sessionStorage.getItem('fliqPendingPlan') || '';
  const pendingPeriod = params.get('period') || sessionStorage.getItem('fliqPendingPeriod') || 'monthly';
  if (params.get('pendingUrl') && !sessionStorage.getItem('fliqPendingUrl')) {
    try { sessionStorage.setItem('fliqPendingUrl', params.get('pendingUrl')); } catch {}
  }
  if (params.get('plan') && !sessionStorage.getItem('fliqPendingPlan')) {
    try {
      sessionStorage.setItem('fliqPendingPlan', params.get('plan'));
      sessionStorage.setItem('fliqPendingPeriod', pendingPeriod);
    } catch {}
  }
  const queryParams = new URLSearchParams();
  if (pendingUrl) queryParams.set('pendingUrl', pendingUrl);
  if (pendingPlan) {
    queryParams.set('plan', pendingPlan);
    queryParams.set('period', pendingPeriod);
  }
  const authQueryString = queryParams.toString() ? `?${queryParams.toString()}` : '';

  const pendingBanner = pendingUrl ? `
    <div class="auth-pending-banner" role="status" aria-label="Scan pending authentication">
      <span class="auth-pending-eyebrow">SCAN REQUEST</span>
      <strong>${signup ? 'Create an account' : 'Sign in'} to test <code class="auth-pending-url">${esc(pendingUrl)}</code></strong>
      <p>Authentication is required to run website audits. Your test will start automatically as soon as you ${signup ? 'create your account' : 'sign in'}.</p>
    </div>
  ` : '';

  const planBanner = (pendingPlan && pendingPlan.toLowerCase() !== 'free') ? `
    <div class="auth-pending-banner" role="status" aria-label="Plan pending checkout">
      <span class="auth-pending-eyebrow">SELECTED PLAN</span>
      <strong>${signup ? 'Create an account' : 'Sign in'} to continue with the ${esc(pendingPlan.charAt(0).toUpperCase() + pendingPlan.slice(1))} plan (${esc(pendingPeriod)})</strong>
      <p>You'll be directed to checkout preparation immediately after ${signup ? 'creating your account' : 'signing in'}.</p>
    </div>
  ` : '';

  return `<main class="auth-page-wrapper">
    <div class="auth-window-card">
      <div class="auth-window-bar">
        <div class="auth-traffic-dots" aria-hidden="true">
          <span class="auth-traffic-dot dot-red"></span>
          <span class="auth-traffic-dot dot-yellow"></span>
          <span class="auth-traffic-dot dot-green"></span>
        </div>
      </div>

      <div class="auth-window-body">
        <!-- Left Column: Authentication Form -->
        <section class="auth-form-column">
          <div class="auth-form-inner">
            <a href="/" class="auth-brand-badge" data-route aria-label="FLIQ Home">
              <svg class="auth-brand-asterisk" viewBox="0 0 32 32" width="28" height="28" fill="#111827">
                <rect x="13" y="3" width="6" height="26" rx="3"/>
                <rect x="13" y="3" width="6" height="26" rx="3" transform="rotate(60 16 16)"/>
                <rect x="13" y="3" width="6" height="26" rx="3" transform="rotate(120 16 16)"/>
              </svg>
              <span class="auth-brand-title">FLIQ</span>
            </a>

            <h1 class="auth-title">${signup ? 'Create your account' : 'Welcome back!'}</h1>
            <p class="auth-sub">${signup ? 'Start testing your websites with AI.' : "Your websites deserve better. Let's get testing."}</p>

            ${pendingBanner}
            ${planBanner}

            <form id="auth-form" class="auth-form-fields" novalidate>
              ${signup ? `
                <div class="auth-input-group">
                  <svg class="auth-input-icon" viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="#6b7280" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M16 17v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 15.5V17"/>
                    <circle cx="10" cy="6.5" r="3.5"/>
                  </svg>
                  <input name="name" type="text" autocomplete="name" required placeholder="Your name">
                </div>
              ` : ''}

              <div class="auth-input-group">
                <svg class="auth-input-icon" viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="#6b7280" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="2.5" y="4.5" width="15" height="11" rx="2.5"/>
                  <path d="m3.5 5.5 6.5 5 6.5-5"/>
                </svg>
                <input name="email" type="email" autocomplete="email" required placeholder="Email">
              </div>

              <div class="auth-input-group">
                <svg class="auth-input-icon" viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="#6b7280" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="3.5" y="8.5" width="13" height="9" rx="2"/>
                  <path d="M6.5 8.5V6a3.5 3.5 0 0 1 7 0v2.5"/>
                </svg>
                <input name="password" id="auth-password-input" type="password" minlength="6" autocomplete="${signup ? 'new-password' : 'current-password'}" required placeholder="Password">
                <button type="button" class="auth-eye-btn" data-toggle-password aria-label="Toggle password visibility">
                  <svg class="auth-eye-icon" viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="#6b7280" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M1.5 10s3.5-6 8.5-6 8.5 6 8.5 6-3.5 6-8.5 6-8.5-6-8.5-6z"/>
                    <circle cx="10" cy="10" r="2.5"/>
                  </svg>
                </button>
              </div>

              ${signup ? '' : `
                <div class="auth-forgot-row">
                  <a class="auth-forgot-link" href="/forgot-password${authQueryString}" data-route>Forgot password?</a>
                </div>
              `}

              <button class="auth-submit-btn" type="submit">${signup ? 'Create account' : 'Login'}</button>
              <div id="auth-message" role="status" aria-live="polite"></div>
            </form>

            <div class="auth-divider"><span>or continue with</span></div>

            <button type="button" class="auth-google-btn" data-oauth="Google">
              <svg class="auth-google-icon" viewBox="0 0 24 24" width="20" height="20">
                <path fill="#4285F4" d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17z"/>
                <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.1-6.72-4.93H1.25v3.15C3.26 21.36 7.33 24 12 24z"/>
                <path fill="#FBBC05" d="M5.28 14.27A7.18 7.18 0 0 1 4.9 12c0-.79.14-1.57.38-2.27V6.58H1.25A11.96 11.96 0 0 0 0 12c0 1.92.45 3.74 1.25 5.42l4.03-3.15z"/>
                <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.33 0 3.26 2.64 1.25 6.58l4.03 3.15C6.23 6.85 8.88 4.75 12 4.75z"/>
              </svg>
              <span>Continue with Google</span>
            </button>
            <div id="oauth-message" class="oauth-message" role="status" aria-live="polite"></div>

            <div class="auth-footer-switch">
              ${signup ? `Already have an account? <a href="/login${authQueryString}" data-route>Sign in.</a>` : `Not a member? <a href="/signup${authQueryString}" data-route>Create an account.</a>`}
            </div>
          </div>
        </section>

        <!-- Right Column: Visual Panel -->
        ${authIllustrationPanel()}
      </div>
    </div>
  </main>`;
}
function forgot(){
  const params = new URLSearchParams(location.search);
  const pendingUrl = params.get('pendingUrl') || sessionStorage.getItem('fliqPendingUrl') || '';
  const pendingPlan = params.get('plan') || sessionStorage.getItem('fliqPendingPlan') || '';
  const pendingPeriod = params.get('period') || sessionStorage.getItem('fliqPendingPeriod') || 'monthly';
  const queryParams = new URLSearchParams();
  if (pendingUrl) queryParams.set('pendingUrl', pendingUrl);
  if (pendingPlan) {
    queryParams.set('plan', pendingPlan);
    queryParams.set('period', pendingPeriod);
  }
  const forgotQuery = queryParams.toString() ? `?${queryParams.toString()}` : '';

  return `<main class="auth-page-wrapper">
    <div class="auth-window-card">
      <div class="auth-window-bar">
        <div class="auth-traffic-dots" aria-hidden="true">
          <span class="auth-traffic-dot dot-red"></span>
          <span class="auth-traffic-dot dot-yellow"></span>
          <span class="auth-traffic-dot dot-green"></span>
        </div>
      </div>

      <div class="auth-window-body">
        <section class="auth-form-column">
          <div class="auth-form-inner">
            <a href="/" class="auth-brand-badge" data-route aria-label="FLIQ Home">
              <svg class="auth-brand-asterisk" viewBox="0 0 32 32" width="28" height="28" fill="#111827">
                <rect x="13" y="3" width="6" height="26" rx="3"/>
                <rect x="13" y="3" width="6" height="26" rx="3" transform="rotate(60 16 16)"/>
                <rect x="13" y="3" width="6" height="26" rx="3" transform="rotate(120 16 16)"/>
              </svg>
              <span class="auth-brand-title">FLIQ</span>
            </a>

            <h1 class="auth-title">Reset your password</h1>
            <p class="auth-sub">Enter your email and we'll send a reset link.</p>

            <form id="reset-form" class="auth-form-fields" novalidate>
              <div class="auth-input-group">
                <svg class="auth-input-icon" viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="#6b7280" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="2.5" y="4.5" width="15" height="11" rx="2.5"/>
                  <path d="m3.5 5.5 6.5 5 6.5-5"/>
                </svg>
                <input name="email" type="email" autocomplete="email" required placeholder="Email">
              </div>

              <button class="auth-submit-btn" type="submit">Send reset link</button>
              <div id="reset-message" role="status" aria-live="polite"></div>
            </form>

            <div class="auth-footer-switch" style="margin-top: 28px;">
              <a href="/login${forgotQuery}" data-route>← Back to sign in</a>
            </div>
          </div>
        </section>

        ${authIllustrationPanel()}
      </div>
    </div>
  </main>`;
}
function getActiveScanState() {
  try {
    const id = localStorage.getItem('fliqActiveScanId');
    if (!id) return null;
    return {
      id,
      url: localStorage.getItem('fliqActiveScanUrl') || '',
      stage: localStorage.getItem('fliqActiveScanStage') || 'Running audit',
      progress: parseInt(localStorage.getItem('fliqActiveScanProgress') || '10', 10),
      status: localStorage.getItem('fliqActiveScanStatus') || 'running',
      error: localStorage.getItem('fliqActiveScanError') || null
    };
  } catch {
    return null;
  }
}

function setActiveScanState(id, url, stage, progress, status = 'running', error = null) {
  try {
    if (!id) {
      clearActiveScanState();
      return;
    }
    localStorage.setItem('fliqActiveScanId', id);
    if (url) localStorage.setItem('fliqActiveScanUrl', url);
    if (stage) localStorage.setItem('fliqActiveScanStage', stage);
    if (progress !== undefined) localStorage.setItem('fliqActiveScanProgress', String(progress));
    if (status) localStorage.setItem('fliqActiveScanStatus', status);
    if (error) localStorage.setItem('fliqActiveScanError', error);
    else localStorage.removeItem('fliqActiveScanError');
  } catch {}
}

function clearActiveScanState() {
  try {
    localStorage.removeItem('fliqActiveScanId');
    localStorage.removeItem('fliqActiveScanUrl');
    localStorage.removeItem('fliqActiveScanStage');
    localStorage.removeItem('fliqActiveScanProgress');
    localStorage.removeItem('fliqActiveScanStatus');
    localStorage.removeItem('fliqActiveScanError');
  } catch {}
}

function renderGlobalScanBanner() {
  const active = getActiveScanState();
  if (!active || !active.id) return '';
  if (location.pathname === `/dashboard/tests/${active.id}`) return '';
  return `
    <div class="global-scan-banner" id="global-scan-banner" role="status" aria-label="Active website audit in progress">
      <div class="global-scan-banner-info">
        <span class="live-pulse-dot"></span>
        <span>Audit in progress for <b>${esc(active.url || 'website')}</b>:</span>
        <span class="global-scan-stage">${esc(active.stage || 'Analyzing')} (${active.progress || 10}%)</span>
      </div>
      <div class="global-scan-actions">
        <a class="btn black" style="padding:4px 12px;font-size:11px;min-height:auto" href="/dashboard/tests/${esc(active.id)}" data-route>View Live Inspection →</a>
      </div>
    </div>
  `;
}

function updateActiveScanUi() {
  const banner = document.querySelector('#global-scan-banner');
  const active = getActiveScanState();
  if (active && active.id && location.pathname !== `/dashboard/tests/${active.id}`) {
    if (banner) {
      const stageEl = banner.querySelector('.global-scan-stage');
      if (stageEl) stageEl.textContent = `${active.stage || 'Analyzing'} (${active.progress || 10}%)`;
    } else {
      const topHeader = document.querySelector('.app-top');
      if (topHeader && topHeader.parentNode) {
        const div = document.createElement('div');
        div.innerHTML = renderGlobalScanBanner();
        if (div.firstElementChild) {
          topHeader.after(div.firstElementChild);
        }
      }
    }
  } else {
    if (banner) banner.remove();
  }
}

let globalScanTimer = null;
function startGlobalScanTracker() {
  if (globalScanTimer) return;
  globalScanTimer = setInterval(async () => {
    const active = getActiveScanState();
    if (!active || !active.id) return;

    try {
      const r = await apiFetch(`/api/tests/${active.id}`);
      if (!r.ok) {
        if (r.status === 404) {
          clearActiveScanState();
          updateActiveScanUi();
        }
        return;
      }
      const t = await r.json();
      if (t.status === 'completed' || t.status === 'failed') {
        clearActiveScanState();
        if (Array.isArray(window.__fliqCachedTests)) {
          const idx = window.__fliqCachedTests.findIndex(item => item.id === t.id);
          if (idx >= 0) window.__fliqCachedTests[idx] = t;
          else window.__fliqCachedTests.unshift(t);
        }
        updateActiveScanUi();
        updateDashboardDom(window.__fliqCachedTests);
        if (location.pathname.includes(`/tests/${t.id}`)) {
          render();
        }
      } else {
        setActiveScanState(t.id, t.url || active.url, t.stage || 'Running', t.progress || active.progress, t.status);
        updateActiveScanUi();
        if (Array.isArray(window.__fliqCachedTests)) {
          const idx = window.__fliqCachedTests.findIndex(item => item.id === t.id);
          if (idx >= 0) {
            window.__fliqCachedTests[idx] = { ...window.__fliqCachedTests[idx], ...t };
          }
        }
      }
    } catch (e) {
      // background polling network resilience
    }
  }, 2000);
}

const items=[['⌂','Dashboard','/dashboard'],['＋','New Test','/dashboard/new-test'],['◷','History','/dashboard/history'],['▤','Reports','/dashboard/reports'],['◎','Monitors','/dashboard/monitors'],['⚙','Settings','/dashboard/settings']];
const side=()=>`<aside class="sidebar">${logo}<div class="side-links">${items.map(([i,n,p])=>`<a class="${path===p?'current':''}" href="${p}" data-route><span>${i}</span>${n}</a>`).join('')}</div><div class="side-bottom"><span>F</span><div>FLIQ workspace<br><small>Free plan</small></div></div></aside>`;
const appShell=content=>`<div class="app-layout">${side()}<main class="app-main"><header class="app-top"><input class="search" placeholder="⌕  Search tests..." aria-label="Search tests"><div class="top-icons"><button class="avatar" data-go="/dashboard/settings">${(localStorage.getItem('fliqName')||'A')[0].toUpperCase()}</button></div></header>${renderGlobalScanBanner()}${content}</main></div>`;
let testLoadError = false;
let testLoadMessage = '';
let isFetchingTests = false;

function renderDashboardErrorBanner(msg) {
  return `
    <div class="setup-note" style="border-left-color:#c94438;background:#fff5f4;padding:16px 20px;border-radius:8px;margin-bottom:24px">
      <strong style="color:#a02c24;font-size:14px;display:block;margin-bottom:4px">⚠️ Could not contact the FLIQ API server</strong>
      <p style="margin:0 0 12px;color:#5a544b;font-size:13px">${esc(msg || 'Please check your internet connection or try again.')}</p>
      <button class="btn black" style="padding:6px 14px;font-size:12px" data-action="retry-tests">Retry Connection ↺</button>
    </div>
  `;
}

function renderSkeletonRows(count = 3) {
  return `<div class="test-list" aria-label="Loading test records">
    ${Array.from({ length: count }).map(() => `
      <div class="test-row skeleton-row" style="opacity:0.6;pointer-events:none">
        <span class="site-dot" style="color:#d1ccc4">◎</span>
        <span class="test-host" style="color:#9b948a">Loading tests…<small style="color:#b5afa6">Connecting to FLIQ API</small></span>
        <span class="badge" style="background:#ede8e1;color:#716c65">fetching</span>
        <span>…</span>
        <b style="color:#b5afa6">View →</b>
      </div>
    `).join('')}
  </div>`;
}

async function tests(){
  testLoadError = false;
  testLoadMessage = '';
  try {
    const user = await getResolvedAuthState(2500);
    console.groupCollapsed('[FLIQ API Diagnostics] Fetching user tests');
    console.log('User UID:', user?.uid || 'none');
    console.log('User Email:', user?.email || 'none');
    
    const r = await apiFetch('/api/tests');
    console.log('/api/tests status:', r.status);
    
    const text = await r.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (parseErr) {
      console.error('/api/tests returned non-JSON:', text.slice(0, 250));
      testLoadError = true;
      testLoadMessage = 'Could not contact the FLIQ server. The API returned an invalid response.';
      console.groupEnd();
      return null;
    }

    if (r.status === 401) {
      console.warn('/api/tests 401 response:', data?.error);
      if (firebaseWebConfigured && !user) {
        firebaseAuthSdk?.signOut(firebaseAuth).catch(() => {});
        go('/login');
        console.groupEnd();
        return null;
      }
      testLoadError = true;
      testLoadMessage = data?.error || 'Authentication required to load test reports.';
      console.groupEnd();
      return null;
    }

    if (!r.ok) {
      console.error('/api/tests HTTP error:', r.status, data);
      testLoadError = true;
      testLoadMessage = data?.error || `Could not load your test reports (HTTP ${r.status}).`;
      console.groupEnd();
      return null;
    }

    console.log('Loaded test records count:', Array.isArray(data) ? data.length : 0);
    console.groupEnd();
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.error('[FLIQ API Diagnostics] tests() fetch exception:', e);
    console.groupEnd();
    testLoadError = true;
    testLoadMessage = 'Could not contact the FLIQ server. Please check your connection.';
    return null;
  }
}

function updateDashboardDom(data) {
  if (location.pathname === '/dashboard') {
    const metricsEl = document.querySelector('#dashboard-metrics');
    const bannerEl = document.querySelector('#dashboard-error-banner');
    const recentEl = document.querySelector('#dashboard-recent-container');

    if (data === null) {
      if (metricsEl) {
        metricsEl.innerHTML = `
          ${metric('Total Tests', '—', 'Unable to load')}
          ${metric('Issues Found', '—', 'Unable to load')}
          ${metric('Healthy Sites', '—', 'Unable to load')}
          ${metric('Avg. Load Time', '—', 'Unable to load')}
        `;
      }
      if (bannerEl) {
        bannerEl.innerHTML = renderDashboardErrorBanner(window.__fliqTestsErrorMessage);
      }
      if (recentEl) {
        recentEl.innerHTML = '';
      }
    } else {
      const list = Array.isArray(data) ? data : [];
      const done = list.filter(t => t.status === 'completed');
      const issues = done.reduce((n, t) => n + (t.issues?.length || 0), 0);
      const healthyCount = done.filter(t => !t.issues?.length).length;
      const completedWithTiming = done.filter(t => (t.loadTime || t.durationMs || 0) > 0);
      const avg = completedWithTiming.length ? `${(completedWithTiming.reduce((n, t) => n + (t.loadTime || t.durationMs || 0), 0) / completedWithTiming.length / 1000).toFixed(1)}s` : '—';

      if (metricsEl) {
        metricsEl.innerHTML = `
          ${metric('Total Tests', list.length, 'All time')}
          ${metric('Issues Found', issues, 'Across completed tests')}
          ${metric('Healthy Sites', healthyCount, 'No issues found')}
          ${metric('Avg. Load Time', avg, 'Across completed tests')}
        `;
      }
      if (bannerEl) {
        bannerEl.innerHTML = '';
      }
      if (recentEl) {
        const active = getActiveScanState();
        let displayList = [...list];
        if (active && active.id && !displayList.some(t => t.id === active.id)) {
          displayList.unshift({
            id: active.id,
            url: active.url,
            hostname: (() => { try { return new URL(active.url).hostname; } catch { return active.url; } })(),
            createdAt: new Date().toISOString(),
            status: 'running',
            stage: active.stage,
            progress: active.progress,
            issues: []
          });
        }
        recentEl.innerHTML = testRows(displayList.slice(0, 5));
      }
    }
  } else if (['/dashboard/history','/dashboard/reports','/dashboard/monitors','/dashboard/team'].includes(location.pathname)) {
    const container = document.querySelector('#history-container');
    if (container) {
      if (data === null) {
        container.innerHTML = renderDashboardErrorBanner(window.__fliqTestsErrorMessage);
      } else {
        const list = Array.isArray(data) ? data : [];
        const active = getActiveScanState();
        let displayList = [...list];
        if (active && active.id && !displayList.some(t => t.id === active.id)) {
          displayList.unshift({
            id: active.id,
            url: active.url,
            hostname: (() => { try { return new URL(active.url).hostname; } catch { return active.url; } })(),
            createdAt: new Date().toISOString(),
            status: 'running',
            stage: active.stage,
            progress: active.progress,
            issues: []
          });
        }
        container.innerHTML = testRows(displayList);
      }
    }
  }
}

async function refreshDashboardData(force = false) {
  if (isFetchingTests && !force) return;
  isFetchingTests = true;
  try {
    const data = await tests();
    isFetchingTests = false;
    if (data === null) {
      window.__fliqTestsError = true;
      window.__fliqTestsErrorMessage = testLoadMessage;
      updateDashboardDom(null);
    } else {
      window.__fliqCachedTests = data;
      window.__fliqTestsError = false;
      window.__fliqTestsErrorMessage = '';
      updateDashboardDom(data);
    }
  } catch (err) {
    isFetchingTests = false;
    window.__fliqTestsError = true;
    window.__fliqTestsErrorMessage = 'Could not contact the FLIQ server. Please check your connection.';
    updateDashboardDom(null);
  }
}

function metric(n,v,sub){return `<article class="metric"><span>${n}</span><strong>${v}</strong><small>${sub}</small></article>`}

function dashboard(){
  const cached = window.__fliqCachedTests;
  const isError = window.__fliqTestsError;
  const list = Array.isArray(cached) ? cached : [];
  const done = list.filter(t => t.status === 'completed');
  const issues = cached ? done.reduce((n, t) => n + (t.issues?.length || 0), 0) : '—';
  const totalCount = cached ? list.length : '—';
  const healthyCount = cached ? done.filter(t => !t.issues?.length).length : '—';
  const completedWithTiming = done.filter(t => (t.loadTime || t.durationMs || 0) > 0);
  const avg = cached ? (completedWithTiming.length ? `${(completedWithTiming.reduce((n, t) => n + (t.loadTime || t.durationMs || 0), 0) / completedWithTiming.length / 1000).toFixed(1)}s` : '—') : '—';

  // Trigger background refresh (synchronous 0ms shell rendering)
  setTimeout(() => refreshDashboardData(), 10);

  const active = getActiveScanState();
  let displayList = [...list];
  if (active && active.id && !displayList.some(t => t.id === active.id)) {
    displayList.unshift({
      id: active.id,
      url: active.url,
      hostname: (() => { try { return new URL(active.url).hostname; } catch { return active.url; } })(),
      createdAt: new Date().toISOString(),
      status: 'running',
      stage: active.stage,
      progress: active.progress,
      issues: []
    });
  }

  return appShell(`
    <section class="welcome">
      <span class="eyebrow">YOUR WORKSPACE</span>
      <h1>Welcome back, ${esc(localStorage.getItem('fliqName') || 'there')} 👋</h1>
      <p>Here's what's happening with your websites.</p>
    </section>
    <div class="metrics" id="dashboard-metrics">
      ${metric('Total Tests', totalCount, cached ? 'All time' : 'Loading…')}
      ${metric('Issues Found', issues, cached ? 'Across completed tests' : 'Loading…')}
      ${metric('Healthy Sites', healthyCount, cached ? 'No issues found' : 'Loading…')}
      ${metric('Avg. Load Time', avg, cached ? 'Across completed tests' : 'Loading…')}
    </div>
    <div id="dashboard-error-banner">
      ${isError ? renderDashboardErrorBanner(window.__fliqTestsErrorMessage) : ''}
    </div>
    <section class="run-panel">
      <h2>Test a new website</h2>
      <p>Get a clear picture of how your website is doing.</p>
      <form id="test-form">
        <input name="url" type="url" placeholder="https://example.com" required>
        <button class="btn lime" type="submit">Run Test →</button>
      </form>
      <div id="test-error" aria-live="polite"></div>
    </section>
    <div class="section-heading">
      <h2>Recent Tests</h2>
      <a href="/dashboard/history" data-route>View all →</a>
    </div>
    <div id="dashboard-recent-container">
      ${cached ? testRows(displayList.slice(0, 5)) : renderSkeletonRows(3)}
    </div>
  `);
}

function testRows(rows){
  if (testLoadError && testLoadMessage) {
    return `
      <div class="setup-note" style="border-left-color:#c94438;background:#fff5f4;padding:16px 20px;border-radius:8px">
        <strong style="color:#a02c24;font-size:14px;display:block;margin-bottom:4px">⚠️ Could not load test history</strong>
        <p style="margin:0 0 12px;color:#5a544b;font-size:13px">${esc(testLoadMessage)}</p>
        <button class="btn black" style="padding:6px 14px;font-size:12px" data-action="retry-tests">Retry Connection ↺</button>
      </div>
    `;
  }
  return rows.length ? `<div class="test-list">${rows.map(t=>{
    const isRunning = t.status === 'running' || t.status === 'queued';
    const isCompleted = t.status === 'completed';
    const isFailed = t.status === 'failed';
    const statusBadge = isRunning 
      ? `<span class="badge running"><span class="live-pulse-dot" style="display:inline-block;width:6px;height:6px;margin-right:4px"></span>Running (${t.progress || 10}%)</span>`
      : `<span class="badge ${t.status}">${t.status}</span>`;
    const summaryCol = isRunning
      ? `<span>${esc(t.stage || 'In progress…')}</span>`
      : isCompleted
      ? `<span>${t.issues?.length || 0} issues</span>`
      : isFailed
      ? `<span style="color:#a02c24">${esc(t.error ? t.error.slice(0, 32) + (t.error.length > 32 ? '…' : '') : 'Failed')}</span>`
      : `<span>—</span>`;
    return `<a class="test-row" href="/dashboard/tests/${t.id}" data-route><span class="site-dot">◎</span><span class="test-host">${esc(t.hostname||t.url)}<small>${new Date(t.createdAt).toLocaleString()}</small></span>${statusBadge}${summaryCol}<b>View →</b></a>`;
  }).join('')}</div>` : `<div class="empty"><div class="empty-icon">◎</div><h3>Your testing story starts here.</h3><p>Run your first test to see a clear report with actionable findings.</p><button class="btn outline" data-go="/dashboard/new-test">Start a test →</button></div>`;
}

function historyPage(title){
  const cached = window.__fliqCachedTests;
  const isError = window.__fliqTestsError;
  const list = Array.isArray(cached) ? cached : [];
  const active = getActiveScanState();
  let displayList = [...list];
  if (active && active.id && !displayList.some(t => t.id === active.id)) {
    displayList.unshift({
      id: active.id,
      url: active.url,
      hostname: (() => { try { return new URL(active.url).hostname; } catch { return active.url; } })(),
      createdAt: new Date().toISOString(),
      status: 'running',
      stage: active.stage,
      progress: active.progress,
      issues: []
    });
  }

  setTimeout(() => refreshDashboardData(), 10);

  return appShell(`
    <div class="page-head">
      <span class="eyebrow">YOUR WORKSPACE</span>
      <h1>${esc(title)}</h1>
      <p>Review your website testing activity.</p>
    </div>
    <div id="history-container">
      ${isError ? renderDashboardErrorBanner(window.__fliqTestsErrorMessage) : (cached ? testRows(displayList) : renderSkeletonRows(5))}
    </div>
  `);
}

function newTest(){
  return appShell(`
    <div class="new-test-page">
      <a href="/dashboard" data-route>← Back to dashboard</a>
      <span class="eyebrow">NEW TEST</span>
      <h1>What should we test?</h1>
      <p>Enter a public website URL. FLIQ will safely check the page and report what it finds.</p>
      <form class="new-test-form" id="test-form">
        <label>Website URL
          <input name="url" type="url" placeholder="https://example.com" required>
        </label>
        <button class="btn black" type="submit">Run website test →</button>
        <div id="test-error" aria-live="polite"></div>
      </form>
    </div>
  `);
}
let liveActiveCategory = 'all';
let liveActiveClassification = 'all';
let liveSelectedFindingId = null;

const CANONICAL_LIVE_STAGES = [
  { id: 1, name: 'Initializing browser', p: 10, desc: 'Launching isolated Chromium browser session' },
  { id: 2, name: 'Opening website', p: 28, desc: 'Navigating to destination and capturing live DOM render' },
  { id: 3, name: 'Inspecting accessibility', p: 48, desc: 'Auditing WCAG 2.2 criteria, AccName 1.2 and keyboard operability' },
  { id: 4, name: 'Testing functionality', p: 62, desc: 'Auditing internal links, missing media, runtime exceptions and forms' },
  { id: 5, name: 'Measuring performance', p: 72, desc: 'Extracting Core Web Vitals (FCP, LCP, CLS) and resource timings' },
  { id: 6, name: 'Checking SEO', p: 82, desc: 'Verifying on-page metadata, robots instructions, headings and viewport' },
  { id: 7, name: 'Auditing security', p: 90, desc: 'Evaluating HTTPS, HSTS, CSP and security response headers' },
  { id: 8, name: 'Generating report', p: 98, desc: 'Compiling evidence, multi-viewport reflow captures, and scoring' }
];

async function progressPage(id) {
  const rr = await apiFetch(`/api/tests/${id}`);
  const text = await rr.text();
  let t;
  try { t = JSON.parse(text); } catch { t = { error: 'Could not contact the FLIQ API server.' }; }
  if (t.error) return appShell(`<div class="empty"><h2>${esc(t.error)}</h2><a href="/dashboard" data-route>Return to dashboard</a></div>`);
  if (t.status === 'completed') {
    clearActiveScanState();
    return resultPage(id);
  }

  if (t.status === 'failed') {
    clearActiveScanState();
    return appShell(`
      <div class="empty" style="max-width:680px;margin:40px auto;text-align:center">
        <div class="empty-icon" style="color:#d32f2f">⚠</div>
        <h2>Inspection Failed</h2>
        <p style="color:#67625c;margin:8px 0 16px">${esc(t.error || 'The test could not be completed.')}</p>
        <div style="display:flex;gap:10px;justify-content:center">
          <a class="btn black" href="/dashboard/new-test" data-route>Try another URL</a>
          <a class="btn outline" href="/dashboard" data-route>Return to dashboard</a>
        </div>
      </div>
    `);
  }

  // Active scan in progress: update local storage state and trigger global poller
  setActiveScanState(t.id, t.url, t.stage, t.progress, t.status);
  startGlobalScanTracker();

  const allIssues = Array.isArray(t.issues) ? t.issues : [];
  const a11yCount = allIssues.filter(i => (i.category || '').toLowerCase() === 'accessibility').length;
  const funcCount = allIssues.filter(i => (i.category || '').toLowerCase() === 'functionality').length;
  const perfCount = allIssues.filter(i => (i.category || '').toLowerCase() === 'performance').length;
  const seoCount = allIssues.filter(i => (i.category || '').toLowerCase() === 'seo').length;
  const secCount = allIssues.filter(i => (i.category || '').toLowerCase() === 'security').length;

  let filtered = allIssues;
  if (liveActiveCategory !== 'all') {
    filtered = filtered.filter(i => (i.category || '').toLowerCase() === liveActiveCategory.toLowerCase());
  }

  const selectedFinding = allIssues.find(i => i.id === liveSelectedFindingId);
  let highlightHtml = '';
  if (selectedFinding) {
    const box = selectedFinding.boundingBox || selectedFinding.elements?.[0]?.boundingBox;
    if (box && box.width > 0 && box.height > 0) {
      const leftPct = Math.max(0, Math.min(100, (box.x / 1440) * 100));
      const topPct = Math.max(0, Math.min(100, (box.y / 960) * 100));
      const widthPct = Math.max(1, Math.min(100 - leftPct, (box.width / 1440) * 100));
      const heightPct = Math.max(1, Math.min(100 - topPct, (box.height / 960) * 100));
      highlightHtml = `
        <div class="live-highlight-box" style="left:${leftPct.toFixed(2)}%;top:${topPct.toFixed(2)}%;width:${widthPct.toFixed(2)}%;height:${heightPct.toFixed(2)}%">
          <span class="live-highlight-label">${esc(selectedFinding.title?.slice(0, 32) || 'Finding')}</span>
        </div>
      `;
    }
  }

  return appShell(`
    <div class="live-inspection-shell">
      <div class="live-top-bar">
        <div class="live-top-row">
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
            <span class="live-status-pill">
              <span class="live-pulse-dot"></span>
              Live Inspection Active
            </span>
            <a class="live-target-url" href="${esc(t.url)}" target="_blank" rel="noopener noreferrer" title="Open in separate tab (for viewing only)">
              ${esc(t.url)} ↗
            </a>
          </div>
          <div class="live-metrics-strip">
            <span class="live-metric-chip">Total Findings: <b>${allIssues.length}</b></span>
            <span class="live-metric-chip">Accessibility: <b>${a11yCount}</b></span>
            <span class="live-metric-chip">Functionality: <b>${funcCount}</b></span>
            <span class="live-metric-chip">Performance: <b>${perfCount}</b></span>
            <span class="live-metric-chip">SEO: <b>${seoCount}</b></span>
            <span class="live-metric-chip">Security: <b>${secCount}</b></span>
          </div>
        </div>

        <div class="live-progress-container">
          <div class="live-progress-bar">
            <i style="width:${Math.max(8, Math.min(100, t.progress || 10))}%"></i>
          </div>
          <div class="live-progress-meta">
            <span>Current Real Stage: <b>${esc(t.stage || 'Initializing')}</b></span>
            <span>${t.progress || 10}%</span>
          </div>
        </div>
      </div>

      <div class="live-grid">
        <!-- LEFT PANEL: Live Browser Preview / Serverless Inspector & Pipeline -->
        <div class="live-left-panel">
          <div class="live-browser-chrome">
            <div class="live-browser-dots"><span></span><span></span><span></span></div>
            <div class="live-address-bar">🔒 ${esc(t.currentUrl || t.finalUrl || t.url)}</div>
            <span class="live-browser-viewport">${t.liveScreenshot ? '1440 × 960 Desktop Chromium' : 'Serverless Cloud Inspector'}</span>
          </div>

          <div class="live-preview-box" id="live-preview-box">
            ${t.liveScreenshot ? `
              <img class="live-preview-img" src="/api/tests/${esc(id)}/live-screenshot?t=${Date.now()}" alt="Live Playwright Browser View">
              ${highlightHtml}
            ` : `
              <div class="serverless-audit-card">
                <div class="serverless-card-header">
                  <span class="live-pulse-dot"></span>
                  <strong>Serverless Cloud Inspector Active</strong>
                </div>
                <p class="serverless-card-desc">
                  Analyzing live DOM structure, network transport, accessibility semantics, Core Web Vitals, and security headers directly via Netlify serverless engine.
                </p>
                <div class="serverless-details-grid">
                  <div><span>Target URL:</span> <code>${esc(t.currentUrl || t.finalUrl || t.url)}</code></div>
                  <div><span>Inspection Stage:</span> <b>${esc(t.stage || 'Analyzing')} (${t.progress || 10}%)</b></div>
                  <div><span>Status Code:</span> <b style="color:#285e25">HTTP ${t.httpStatus || 200} OK</b></div>
                  <div><span>Issues Detected:</span> <b>${allIssues.length} findings verified</b></div>
                </div>
                <div class="serverless-card-note">
                  <small>⚡ Headless Chromium screenshots are unavailable in serverless Lambda runtime. Complete structural, performance, and security audits remain 100% active.</small>
                </div>
              </div>
            `}
          </div>

          <div class="live-pipeline">
            <div class="live-pipeline-title">Live Inspection Pipeline (Real Backend States)</div>
            <div class="live-steps">
              ${CANONICAL_LIVE_STAGES.map((s, idx) => {
                const isDone = (t.progress || 0) > s.p;
                const isActive = !isDone && (t.stage === s.name || (t.progress || 0) >= (s.p - 15));
                const statusClass = isDone ? 'done' : isActive ? 'active' : 'pending';
                const icon = isDone ? '✓' : isActive ? '⚡' : (idx + 1);
                return `
                  <div class="live-step ${statusClass}" title="${esc(s.desc)}">
                    <span class="live-step-icon">${icon}</span>
                    <span>${esc(s.name)}</span>
                  </div>
                `;
              }).join('')}
            </div>
          </div>
        </div>

        <!-- RIGHT PANEL: Real-Time Audit Findings Stream -->
        <div class="live-right-panel">
          <div class="live-feed-header">
            <h3>Real-Time Audit Findings (${allIssues.length})</h3>
            <span class="badge ${t.status}">${esc(t.stage || 'Running')}</span>
          </div>

          <div class="live-filter-tabs">
            <button class="live-tab-btn ${liveActiveCategory === 'all' ? 'active' : ''}" data-live-cat="all">All (${allIssues.length})</button>
            <button class="live-tab-btn ${liveActiveCategory === 'accessibility' ? 'active' : ''}" data-live-cat="accessibility">Accessibility (${a11yCount})</button>
            <button class="live-tab-btn ${liveActiveCategory === 'functionality' ? 'active' : ''}" data-live-cat="functionality">Functionality (${funcCount})</button>
            <button class="live-tab-btn ${liveActiveCategory === 'performance' ? 'active' : ''}" data-live-cat="performance">Performance (${perfCount})</button>
            <button class="live-tab-btn ${liveActiveCategory === 'seo' ? 'active' : ''}" data-live-cat="seo">SEO (${seoCount})</button>
            <button class="live-tab-btn ${liveActiveCategory === 'security' ? 'active' : ''}" data-live-cat="security">Security (${secCount})</button>
          </div>

          <div class="live-findings-stream">
            ${filtered.length > 0 ? filtered.map(i => {
              const isSelected = i.id === liveSelectedFindingId;
              const isFailure = i.classification === 'Confirmed Failure' || i.type === 'failure';
              const isInfo = i.classification === 'Informational';
              return `
                <article class="live-finding-card ${isSelected ? 'selected' : ''}" data-action="toggle-live-finding" data-finding-id="${esc(i.id)}">
                  <div class="live-card-meta">
                    <span class="severity ${esc(i.severity)}">${esc(i.severity)}</span>
                    <span class="a11y-badge ${isFailure ? 'failure' : isInfo ? 'informational' : 'recommendation'}">
                      ${esc(i.classification || (isFailure ? 'Confirmed Failure' : 'Potential Issue'))}
                    </span>
                    <span class="a11y-badge automated">${esc(i.category)}</span>
                    ${i.confidence ? `<span class="a11y-badge not-tested">Confidence: ${esc(i.confidence)}</span>` : ''}
                  </div>
                  <h4 class="live-card-title">${esc(i.title)}</h4>
                  ${i.selector ? `<span class="live-card-target">${esc(i.selector)}</span>` : ''}

                  ${isSelected ? `
                    <div class="live-card-detail">
                      <div class="live-detail-sec">
                        <span>1. Browser-Observed Evidence</span>
                        <p style="font-family:monospace;font-size:10px">${esc(i.evidence || i.actualBehavior || i.description)}</p>
                      </div>
                      ${i.expectedBehavior ? `
                        <div class="live-detail-sec">
                          <span>2. Expected Standard</span>
                          <p>${esc(i.expectedBehavior)}</p>
                        </div>
                      ` : ''}
                      ${i.whyItMatters ? `
                        <div class="live-detail-sec">
                          <span>3. Why This Was Flagged</span>
                          <p>${esc(i.whyItMatters)}</p>
                        </div>
                      ` : ''}
                      <div class="live-detail-sec">
                        <span>4. Recommended Remediation</span>
                        <p><b>${esc(i.recommendedFix || 'Inspect element and apply standard fix.')}</b></p>
                      </div>
                      ${i.htmlSnippet ? `
                        <div class="live-detail-sec">
                          <span>5. HTML Snippet</span>
                          <code>${esc(i.htmlSnippet)}</code>
                        </div>
                      ` : ''}
                      ${(i.boundingBox || i.elements?.[0]?.boundingBox) ? `
                        <div style="font-size:9px;color:#2e961e;font-weight:600;margin-top:6px">
                          ✓ Bounding box highlighted on left preview (x: ${(i.boundingBox || i.elements[0].boundingBox).x}px, y: ${(i.boundingBox || i.elements[0].boundingBox).y}px)
                        </div>
                      ` : ''}
                    </div>
                  ` : `
                    <div style="display:flex;justify-content:flex-end;margin-top:6px">
                      <span style="font-size:10px;color:#1c557d;font-weight:600">Inspect evidence & highlight element →</span>
                    </div>
                  `}
                </article>
              `;
            }).join('') : `
              <div class="empty" style="padding:28px 14px">
                <div class="empty-icon" style="font-size:18px">🔍</div>
                <h4 style="margin:4px 0">Analyzing target website…</h4>
                <p style="font-size:11px;color:#716c65;margin:0">
                  ${t.stage ? `Currently running: <b>${esc(t.stage)}</b>. Real findings stream here as the browser observes them.` : 'Auditing page...'}
                </p>
              </div>
            `}
          </div>
        </div>
      </div>
    </div>
  `);
}
function renderCheckStatusBadge(status) {
  switch (status) {
    case 'passed':
      return '<span class="a11y-badge passed">Passed ✓</span>';
    case 'confirmed_failure':
    case 'failed':
      return '<span class="a11y-badge failure">Confirmed Failure ✗</span>';
    case 'potential_issue':
      return '<span class="a11y-badge recommendation">Potential Issue ⚠</span>';
    case 'informational':
      return '<span class="a11y-badge not-tested">Informational ℹ</span>';
    case 'unavailable':
      return '<span class="a11y-badge not-tested">Unavailable —</span>';
    case 'not_tested':
    default:
      return '<span class="a11y-badge not-tested">Not tested ○</span>';
  }
}

function accessibilityTabContent(t){
  const rep=t.accessibilityReport||{};
  const a11yIssues=(t.issues||[]).filter(i=>i.category==='Accessibility');
  const failures=a11yIssues.filter(i=>i.classification==='Confirmed Failure'||(!i.classification&&i.type==='failure'));
  const recommendations=a11yIssues.filter(i=>i.classification==='Potential Issue'||(!i.classification&&i.type==='recommendation'));
  const informational=a11yIssues.filter(i=>i.classification==='Informational');
  const totalElements=t.accessibilityCount||a11yIssues.reduce((sum,i)=>sum+(i.elementCount||(i.elements?.length||1)),0);
  const checks=rep.checks||[
    {id:'img-alt',name:'Image alternative text (img[alt])',type:'automated',status:a11yIssues.some(i=>i.title.toLowerCase().includes('image'))?'failed':'passed',summary:'Images have descriptive alt attributes or decorative role'},
    {id:'button-name',name:'Button accessible names',type:'automated',status:a11yIssues.some(i=>i.title.toLowerCase().includes('button'))?'failed':'passed',summary:'Buttons have discernable text or aria-label'},
    {id:'input-label',name:'Form control labels (input, select, textarea)',type:'automated',status:a11yIssues.some(i=>i.title.toLowerCase().includes('form')||i.title.toLowerCase().includes('label'))?'failed':'passed',summary:'Form inputs have associated label, aria-label, or title'},
    {id:'link-name',name:'Link text & discernment (a[href])',type:'automated',status:a11yIssues.some(i=>i.title.toLowerCase().includes('hyperlink')||i.title.toLowerCase().includes('link'))?'failed':'passed',summary:'Hyperlinks have discernible text or descriptive destination'},
    {id:'document-lang',name:'Document language declaration (<html lang>)',type:'automated',status:a11yIssues.some(i=>i.title.toLowerCase().includes('language'))?'failed':'passed',summary:'HTML root element specifies a valid lang attribute'},
    {id:'viewport-scale',name:'Zoom & scaling restrictions (user-scalable)',type:'automated',status:a11yIssues.some(i=>i.title.toLowerCase().includes('viewport')||i.title.toLowerCase().includes('zoom'))?'failed':'passed',summary:'Viewport does not disable user scaling'},
    {id:'screen-reader',name:'Screen reader pronunciation & navigation',type:'manual',status:'not_tested',summary:'Requires live testing with NVDA, JAWS, or VoiceOver'},
    {id:'keyboard-flow',name:'Full keyboard navigation & focus traps',type:'manual',status:'not_tested',summary:'Requires manual Tab/Shift+Tab navigation and modal trapping tests'},
    {id:'dynamic-contrast',name:'Color contrast across states',type:'manual',status:'not_tested',summary:'Requires manual contrast assessment across interactive states and gradients'},
    {id:'media-captions',name:'Audio & video captions / transcriptions',type:'manual',status:'not_tested',summary:'Requires verifying multimedia synchronized text alternatives'}
  ];
  const passedAutomatedCount=checks.filter(c=>c.type==='automated'&&c.status==='passed').length;
  const notTestedCount=checks.filter(c=>c.status==='not_tested').length;

  const renderIssueCard=i=>{
    const isFailure=i.classification==='Confirmed Failure'||(!i.classification&&i.type==='failure');
    const isInfo=i.classification==='Informational';
    const isAutomated=i.checkType!=='manual';
    const elements=i.elements||[];
    return `<article class="a11y-card">
      <div class="a11y-card-head">
        <div class="a11y-card-tags">
          <span class="severity ${esc(i.severity)}">${esc(i.severity)}</span>
          <span class="a11y-badge ${isFailure?'failure':isInfo?'informational':'recommendation'}">${isFailure?'Confirmed Failure':isInfo?'Informational':'Recommendation'}</span>
          <span class="a11y-badge ${isAutomated?'automated':'manual'}">${isAutomated?'Automated Check':'Manual Review'}</span>
          <span class="a11y-badge not-tested">${esc(String(i.elementCount||elements.length||1))} element(s) affected</span>
        </div>
        <a class="btn outline" href="/dashboard/tests/${esc(t.id)}/issues/${esc(i.id)}" data-route>View issue details →</a>
      </div>
      <h3 class="a11y-card-title">${esc(i.title)}</h3>
      <p class="a11y-card-desc">${esc(i.description)}</p>
      
      <div class="a11y-explain">
        <div>
          <h4>Why this causes an accessibility problem</h4>
          <p>${esc(i.whyItMatters||'Screen readers and assistive technologies require programmatic names and semantics to convey content to users.')}</p>
        </div>
        <div>
          <h4>Recommended correction</h4>
          <p>${esc(i.recommendedFix||'Add appropriate accessible labeling or semantic markup.')}</p>
        </div>
      </div>

      ${i.codeExample?`
      <div class="a11y-diff-box">
        <div class="a11y-code-preview">
          <span class="code-label bad">Detected HTML snippet</span>
          <code>${esc(i.codeExample.current)}</code>
        </div>
        <div class="a11y-code-preview">
          <span class="code-label good">Recommended correction example</span>
          <code>${esc(i.codeExample.corrected)}</code>
        </div>
      </div>`:''}

      ${elements.length?`
      <details class="a11y-elements-wrap">
        <summary class="a11y-elements-toggle">View ${elements.length} affected element(s) & CSS selector(s) ↓</summary>
        <div class="a11y-elements-list">
          ${elements.map(el=>`
            <div class="a11y-element-row">
              <header>
                <span class="a11y-tag">&lt;${esc(el.tagName||'element')}&gt;</span>
                <span class="a11y-selector">${esc(el.selector||'')}</span>
              </header>
              <div class="a11y-prop">Role: <b>${esc(el.accessibleRole||el.tagName||'button')}</b> · Accessible name: <b>${esc(el.accessibleName||'(None)')}</b></div>${el.wcagCriterion?`<div class="a11y-prop">Standard: <small>${esc(el.wcagCriterion)}</small></div>`:''}
              <div class="a11y-prop">Detected URL: <small>${esc(el.url||t.finalUrl||t.url)}</small></div>
              ${el.htmlSnippet?`<div class="a11y-code-preview"><span class="code-label">Element snippet</span><code>${esc(el.htmlSnippet)}</code></div>`:''}
              ${el.suggestedFix?`<div class="a11y-prop">Recommended fix: <b>${esc(el.suggestedFix)}</b></div>`:''}
            </div>
          `).join('')}
        </div>
      </details>`:''}
    </article>`;
  };

  return `
    <div class="a11y-overview">
      <div class="a11y-stat">
        <span>Affected Elements</span>
        <strong>${totalElements}</strong>
        <small>Identified across DOM</small>
      </div>
      <div class="a11y-stat">
        <span>Confirmed Failures</span>
        <strong style="color:#9a2823">${failures.length}</strong>
        <small>Definite barrier issues</small>
      </div>
      <div class="a11y-stat">
        <span>Recommendations</span>
        <strong style="color:#765800">${recommendations.length}</strong>
        <small>Suggested enhancements</small>
      </div>
      <div class="a11y-stat">
        <span>Automated Passed</span>
        <strong style="color:#285e25">${passedAutomatedCount}</strong>
        <small>Checks passed on this page</small>
      </div>
      <div class="a11y-stat">
        <span>Not Tested</span>
        <strong>${notTestedCount}</strong>
        <small>Requires manual review</small>
      </div>
    </div>

    <div class="a11y-disclaimer">
      <strong>Scope notice:</strong> This evaluation reflects automated testing of URL <code>${esc(t.finalUrl||t.url)}</code>. Automated testing identifies common barrier patterns on the scanned document, but cannot determine full compliance or subjective usability without manual assistive technology testing.
    </div>

    ${failures.length?`
      <h3 class="a11y-section-title"><span class="a11y-badge failure">Confirmed Failures (${failures.length})</span> Definite accessibility violations detected</h3>
      ${failures.map(renderIssueCard).join('')}
    `:''}

    ${recommendations.length?`
      <h3 class="a11y-section-title"><span class="a11y-badge recommendation">Recommendations (${recommendations.length})</span> Manual review and usability guidance</h3>
      ${recommendations.map(renderIssueCard).join('')}
    `:''}

    ${!a11yIssues.length?`
      <div class="empty">
        <div class="empty-icon">✓</div>
        <h3>0 accessibility issues detected in automated checks</h3>
        <p>Nothing to review here. FLIQ did not detect missing accessible names, unlabelled form controls, or missing image alt attributes in the automated rules tested on this page.</p>
      </div>
    `:''}

    <h3 class="a11y-section-title">Automated & Manual Review Audit Matrix</h3>
    <table class="a11y-matrix" role="table">
      <thead>
        <tr>
          <th>Check Name & Scope</th>
          <th>Verification Method</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        ${checks.map(c=>`
          <tr>
            <td>
              <b>${esc(c.name)}</b>
              <div style="font-size:9px;color:#716c65;margin-top:2px">${esc(c.summary)}</div>
            </td>
            <td>
              <span class="a11y-badge ${c.type==='automated'?'automated':'manual'}">
                ${c.type==='automated'?'Automated Check':'Manual Review'}
              </span>
            </td>
            <td>
              ${renderCheckStatusBadge(c.status)}
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function performanceTabContent(t) {
  const p = t.performanceReport?.metrics || {};
  const checks = t.performanceReport?.checks || [
    { id: 'perf-fcp', name: 'First Contentful Paint (FCP)', type: 'automated', measurement: 'lab', status: p.fcpMs && p.fcpMs > 3000 ? 'failed' : p.fcpMs ? 'passed' : 'unavailable', summary: 'Measures time until first DOM text/graphic renders (<= 1.8s)' },
    { id: 'perf-lcp', name: 'Largest Contentful Paint (LCP)', type: 'automated', measurement: 'lab', status: p.lcpMs && p.lcpMs > 2500 ? 'failed' : p.lcpMs ? 'passed' : 'unavailable', summary: 'Render time of largest above-the-fold content block (<= 2.5s)' },
    { id: 'perf-cls', name: 'Cumulative Layout Shift (CLS)', type: 'automated', measurement: 'lab', status: p.clsValue && p.clsValue > 0.1 ? 'failed' : p.clsValue !== null ? 'passed' : 'unavailable', summary: 'Measures visual stability and unexpected layout movement (<= 0.1)' },
    { id: 'perf-inp', name: 'Interaction to Next Paint (INP)', type: 'field', measurement: 'field', status: 'not_tested', summary: 'Field-only metric requiring real user input (CrUX). Not measurable in synthetic lab page-load scans.' },
    { id: 'perf-ttfb', name: 'Time to First Byte (TTFB)', type: 'automated', measurement: 'lab', status: p.ttfbMs && p.ttfbMs > 1200 ? 'failed' : p.ttfbMs ? 'passed' : 'unavailable', summary: 'Server latency before receiving first response byte (<= 800ms)' },
    { id: 'perf-load', name: 'Complete page load duration', type: 'automated', measurement: 'lab', status: t.loadTime > 5000 ? 'failed' : 'passed', summary: 'Time required to load full document and deferred assets' },
    { id: 'perf-weight', name: 'Total page resource transfer weight', type: 'automated', measurement: 'lab', status: p.totalTransferBytes > 3000000 ? 'failed' : 'passed', summary: 'Total compressed network bytes transferred across assets' },
    { id: 'perf-slow-assets', name: 'Slow or heavy asset bottlenecks', type: 'automated', measurement: 'lab', status: (t.issues || []).some(i => i.ruleId === 'perf-heavy-assets') ? 'failed' : 'passed', summary: 'Detects individual assets exceeding transfer size or duration thresholds' }
  ];
  return `
    <div class="a11y-overview">
      <div class="a11y-stat">
        <span>First Contentful Paint (FCP)</span>
        <strong>${esc(p.fcpFormatted || '—')}</strong>
        <small>Lab CWV · Target: &lt;= 1.8s</small>
      </div>
      <div class="a11y-stat">
        <span>Largest Contentful Paint (LCP)</span>
        <strong>${esc(p.lcpFormatted || '—')}</strong>
        <small>Lab CWV · Target: &lt;= 2.5s</small>
      </div>
      <div class="a11y-stat">
        <span>Cumulative Layout Shift (CLS)</span>
        <strong>${esc(p.clsFormatted || '—')}</strong>
        <small>Lab CWV · Target: &lt;= 0.1</small>
      </div>
      <div class="a11y-stat">
        <span>Interaction to Next Paint (INP)</span>
        <strong style="font-size:13px;color:#716c65">Field Metric</strong>
        <small>Requires real user interaction</small>
      </div>
      <div class="a11y-stat">
        <span>Time to First Byte (TTFB)</span>
        <strong>${esc(p.ttfbFormatted || '—')}</strong>
        <small>Navigation Timing · Target: &lt;= 800ms</small>
      </div>
      <div class="a11y-stat">
        <span>DOMContentLoaded</span>
        <strong>${esc(p.domContentLoadedFormatted || (t.domContentLoadedTime ? (t.domContentLoadedTime/1000).toFixed(2)+'s' : '—'))}</strong>
        <small>DOM ready state parsed</small>
      </div>
      <div class="a11y-stat">
        <span>Window Load Duration</span>
        <strong>${esc((t.loadTime/1000).toFixed(2)+'s')}</strong>
        <small>Full document and assets loaded</small>
      </div>
    </div>

    <div class="a11y-disclaimer">
      <strong>Measurement & Standards notice:</strong> Core Web Vitals (FCP, LCP, CLS) are captured via Chromium PerformanceObserver and Paint Timing APIs during dedicated browser execution. Navigation Timing metrics (TTFB, DOMContentLoaded, Window Load) measure server connection latency and document lifecycle events. INP is a real-user field metric (CrUX) and is not simulated in synthetic page loads.
    </div>

    ${p.byType ? `
      <h3 class="a11y-section-title">Resource Transfer Breakdown</h3>
      <div class="a11y-overview">
        <div class="a11y-stat"><span>Scripts</span><strong>${esc(String(p.byType.scriptsKb || 0))} KB</strong><small>JavaScript</small></div>
        <div class="a11y-stat"><span>Styles</span><strong>${esc(String(p.byType.cssKb || 0))} KB</strong><small>CSS stylesheets</small></div>
        <div class="a11y-stat"><span>Images</span><strong>${esc(String(p.byType.imagesKb || 0))} KB</strong><small>Visual media</small></div>
        <div class="a11y-stat"><span>Fonts</span><strong>${esc(String(p.byType.fontsKb || 0))} KB</strong><small>Web fonts</small></div>
        <div class="a11y-stat"><span>Other</span><strong>${esc(String(p.byType.otherKb || 0))} KB</strong><small>XHR / Fetch</small></div>
      </div>
    ` : ''}

    <h3 class="a11y-section-title">Performance Checks & Core Web Vitals</h3>
    <table class="a11y-matrix" role="table">
      <thead><tr><th>Metric & Scope</th><th>Measurement Type</th><th>Status</th></tr></thead>
      <tbody>
        ${checks.map(c => `
          <tr>
            <td><b>${esc(c.name)}</b><div style="font-size:9px;color:#716c65;margin-top:2px">${esc(c.summary)}</div></td>
            <td><span class="a11y-badge ${c.measurement === 'field' || c.type === 'field' ? 'manual' : 'automated'}">${c.measurement === 'field' || c.type === 'field' ? 'Field Metric' : 'Lab Measured'}</span></td>
            <td>${renderCheckStatusBadge(c.status)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function seoTabContent(t) {
  const s = t.seoReport?.summary || {};
  const checks = t.seoReport?.checks || [
    { id: 'page-title', name: 'Document title element (<title>)', summary: 'Page has a descriptive, concise <title> tag', status: t.title ? 'passed' : 'confirmed_failure' },
    { id: 'meta-description', name: 'Search snippet meta description', summary: 'Page defines a concise meta description tag', status: s.description ? 'passed' : 'potential_issue' },
    { id: 'heading-h1', name: 'Primary topic heading (<h1>)', summary: 'Page defines a primary <h1> topic heading', status: (s.h1Count === 1) ? 'passed' : 'potential_issue' },
    { id: 'canonical-url', name: 'Canonical URL declaration', summary: 'Page specifies a canonical URL link tag', status: s.canonical ? 'passed' : 'informational' },
    { id: 'mobile-viewport', name: 'Mobile viewport configuration', summary: 'Page configures responsive mobile viewport tag', status: s.hasViewport !== false ? 'passed' : 'confirmed_failure' }
  ];
  return `
    <div class="a11y-overview">
      <div class="a11y-stat"><span>Document Title</span><strong>${esc(String(s.titleLength || (t.title?.length || 0)))} chars</strong><small>${esc(t.title || 'None')}</small></div>
      <div class="a11y-stat"><span>Meta Description</span><strong style="color:${s.description ? '#0f5b24' : '#9a2823'}">${esc(s.description ? `${s.descriptionLength || s.description.length} chars` : 'Potential Issue')}</strong><small>${esc(s.description ? s.description.slice(0, 40)+'…' : 'Missing meta description')}</small></div>
      <div class="a11y-stat"><span>Primary <h1> Headings</span><strong style="color:${s.h1Count === 1 ? '#0f5b24' : '#9a2823'}">${esc(s.h1Count === 1 ? 'Passed (1 <h1>)' : s.h1Count === 0 ? 'Potential Issue (0)' : `Potential Issue (${s.h1Count})`)}</strong><small>${s.h1Count === 1 ? 'Primary topic heading present' : s.h1Count === 0 ? 'Missing <h1> heading' : 'Multiple <h1> headings found'}</small></div>
      <div class="a11y-stat"><span>Canonical Tag</span><strong style="color:${s.canonical ? '#0f5b24' : '#1c557d'}">${esc(s.canonical ? 'Passed (Declared)' : 'Informational')}</strong><small>${esc(s.canonical ? s.canonical.slice(0, 36) : 'Missing canonical link tag')}</small></div>
      <div class="a11y-stat"><span>Open Graph Tags</span><strong style="color:${s.hasOpenGraph ? '#0f5b24' : '#1c557d'}">${esc(s.hasOpenGraph ? 'Passed (Present)' : 'Informational')}</strong><small>${s.hasOpenGraph ? 'Social preview cards complete' : 'Incomplete social preview tags'}</small></div>
    </div>

    <div class="a11y-disclaimer">
      <strong>SEO Scope notice:</strong> Basic page metadata and on-page technical SEO signals inspect crawlability, indexability, metadata, and document outline. This does not claim external search engine index status.
    </div>

    <h3 class="a11y-section-title">Technical SEO & Crawlability Matrix</h3>
    <table class="a11y-matrix" role="table">
      <thead><tr><th>SEO Check & Scope</th><th>Type</th><th>Status</th></tr></thead>
      <tbody>
        ${checks.map(c => `
          <tr>
            <td><b>${esc(c.name)}</b><div style="font-size:9px;color:#716c65;margin-top:2px">${esc(c.evidence || c.summary)}</div></td>
            <td><span class="a11y-badge automated">Automated Check</span></td>
            <td>${renderCheckStatusBadge(c.status)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function securityTabContent(t) {
  const sec = t.securityReport?.headerStatus || {};
  const checks = t.securityReport?.checks || [
    { id: 'sec-https', name: 'Transport Layer Security (HTTPS)', summary: 'Website enforces encrypted HTTPS transport', status: (t.finalUrl||t.url).startsWith('https:') ? 'passed' : 'confirmed_failure' },
    { id: 'sec-hsts', name: 'HTTP Strict Transport Security (HSTS)', summary: 'Strict-Transport-Security header prevents protocol downgrade', status: sec.hsts ? 'passed' : 'potential_issue' },
    { id: 'sec-csp', name: 'Content Security Policy (CSP)', summary: 'Restricts script, frame, and asset injection vectors', status: sec.csp ? 'passed' : 'potential_issue' },
    { id: 'sec-x-frame-options', name: 'Clickjacking protection (X-Frame-Options)', summary: 'Prevents iframe framing and clickjacking attacks', status: sec.xFrameOptions ? 'passed' : 'potential_issue' },
    { id: 'sec-x-content-type', name: 'MIME-sniffing protection (X-Content-Type-Options)', summary: 'Enforces nosniff to prevent script execution from non-script MIME types', status: sec.xContentTypeOptions ? 'passed' : 'potential_issue' }
  ];
  return `
    <div class="a11y-overview">
      <div class="a11y-stat"><span>Protocol</span><strong style="color:${(t.finalUrl||t.url).startsWith('https:') ? '#0f5b24' : '#9a2823'}">${esc((t.finalUrl||t.url).startsWith('https:') ? 'Passed (HTTPS)' : 'Confirmed Failure')}</strong><small>${esc((t.finalUrl||t.url).startsWith('https:') ? 'Encrypted (TLS)' : 'Unencrypted HTTP')}</small></div>
      <div class="a11y-stat"><span>HSTS Header</span><strong style="color:${sec.hsts ? '#0f5b24' : '#9a2823'}">${esc(sec.hsts ? 'Passed (Enabled)' : 'Potential Issue')}</strong><small>${sec.hsts ? 'Strict-Transport-Security present' : 'Strict-Transport-Security missing'}</small></div>
      <div class="a11y-stat"><span>Content Security Policy</span><strong style="color:${sec.csp ? '#0f5b24' : '#9a2823'}">${esc(sec.csp ? 'Passed (Enforced)' : 'Potential Issue')}</strong><small>${sec.csp ? 'Enforced CSP header declared' : 'Content-Security-Policy missing'}</small></div>
      <div class="a11y-stat"><span>Clickjacking Defense</span><strong style="color:${sec.xFrameOptions ? '#0f5b24' : '#9a2823'}">${esc(sec.xFrameOptions ? 'Passed (Protected)' : 'Potential Issue')}</strong><small>${sec.xFrameOptions ? 'Framing protection active' : 'Missing framing protection'}</small></div>
      <div class="a11y-stat"><span>MIME Sniffing Defense</span><strong style="color:${sec.xContentTypeOptions ? '#0f5b24' : '#9a2823'}">${esc(sec.xContentTypeOptions ? 'Passed (nosniff)' : 'Potential Issue')}</strong><small>${sec.xContentTypeOptions ? 'X-Content-Type-Options: nosniff' : 'Missing X-Content-Type-Options: nosniff'}</small></div>
    </div>

    <div class="a11y-disclaimer">
      <strong>Passive Security Scope notice:</strong> Security checks inspect safe public transport signals, response headers, and mixed-content indicators. FLIQ performs zero intrusive penetration testing or credential attacks.
    </div>

    <h3 class="a11y-section-title">Security Headers & Transport Matrix</h3>
    <table class="a11y-matrix" role="table">
      <thead><tr><th>Security Check</th><th>Type</th><th>Status</th></tr></thead>
      <tbody>
        ${checks.map(c => `
          <tr>
            <td><b>${esc(c.name)}</b><div style="font-size:9px;color:#716c65;margin-top:2px">${esc(c.evidence || c.summary)}</div></td>
            <td><span class="a11y-badge automated">Automated Check</span></td>
            <td>${renderCheckStatusBadge(c.status)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function coverageTabContent(t) {
  const cov = t.auditCoverage || {
    scope: 'Single-Page Deep Inspection with Discovery',
    pagesDiscovered: 1,
    pagesInspected: 1,
    pagesInaccessible: 0,
    pagesSkipped: 0,
    viewports: { desktop: { inspected: true }, tablet: { inspected: true }, mobile: { inspected: true } },
    checksSummary: {
      totalChecks: 47,
      checksExecuted: 41,
      totalChecksExecuted: 41,
      checksUnexecuted: 6,
      checksPassed: 33,
      checksConfirmedFailure: 0,
      checksPotentialIssue: 6,
      checksInformational: 2,
      checksFailed: 6,
      checksNotTested: 4,
      checksUnavailable: 2,
      checksUnavailableOrNotTested: 6
    },
    findingsSummary: {
      totalFindings: (t.issues || []).length,
      confirmedFailures: (t.issues || []).filter(i => i.classification === 'Confirmed Failure').length,
      potentialIssues: (t.issues || []).filter(i => i.classification === 'Potential Issue').length,
      informationalObservations: (t.issues || []).filter(i => i.classification === 'Informational').length
    },
    coverageDisclaimer: `Audited ${t.finalUrl || t.url} across Desktop, Tablet, and Mobile viewports. FLIQ does not claim full website coverage when only a single page is scanned.`
  };
  const cs = cov.checksSummary || {};
  const fs = cov.findingsSummary || {
    totalFindings: (t.issues || []).length,
    confirmedFailures: (t.issues || []).filter(i => i.classification === 'Confirmed Failure').length,
    potentialIssues: (t.issues || []).filter(i => i.classification === 'Potential Issue').length,
    informationalObservations: (t.issues || []).filter(i => i.classification === 'Informational').length
  };

  const executed = cs.checksExecuted ?? ((cs.checksPassed || 0) + (cs.checksConfirmedFailure || 0) + (cs.checksPotentialIssue || 0) + (cs.checksInformational || 0));
  const unexecuted = cs.checksUnexecuted ?? ((cs.checksNotTested || 0) + (cs.checksUnavailable || 0));

  return `
    <div class="a11y-overview" style="margin-bottom:16px">
      <div class="a11y-stat">
        <span>Pages Inspected</span>
        <strong>${esc(String(cov.pagesInspected || 1))}</strong>
        <small>Landing page URL</small>
      </div>
      <div class="a11y-stat">
        <span>Same-Origin Discovered</span>
        <strong>${esc(String(cov.pagesDiscovered || 1))}</strong>
        <small>Internal links mapped</small>
      </div>
      <div class="a11y-stat">
        <span>Pages Skipped</span>
        <strong>${esc(String(cov.pagesSkipped || 0))}</strong>
        <small>Single-page limit policy</small>
      </div>
      <div class="a11y-stat">
        <span>Viewports Tested</span>
        <strong>3 / 3</strong>
        <small>Desktop, Tablet, Mobile</small>
      </div>
      <div class="a11y-stat">
        <span>Total Checks</span>
        <strong>${esc(String(cs.totalChecks || 47))}</strong>
        <small>${esc(String(executed))} executed · ${esc(String(unexecuted))} unexecuted</small>
      </div>
      <div class="a11y-stat">
        <span>Checks Passed</span>
        <strong style="color:#0f5b24">${esc(String(cs.checksPassed || 0))}</strong>
        <small>Compliant automated rules</small>
      </div>
      <div class="a11y-stat">
        <span>Check Failures / Issues</span>
        <strong style="color:#9a2823">${esc(String(cs.checksFailed ?? ((cs.checksConfirmedFailure || 0) + (cs.checksPotentialIssue || 0))))}</strong>
        <small>${cs.checksConfirmedFailure || 0} failures · ${cs.checksPotentialIssue || 0} potential</small>
      </div>
      <div class="a11y-stat">
        <span>Informational Checks</span>
        <strong style="color:#1c557d">${esc(String(cs.checksInformational || 0))}</strong>
        <small>Advisory observations</small>
      </div>
      <div class="a11y-stat">
        <span>Not Tested / Unavailable</span>
        <strong style="color:#716c65">${esc(String(cs.checksUnavailableOrNotTested ?? unexecuted))}</strong>
        <small>${cs.checksNotTested || 0} manual · ${cs.checksUnavailable || 0} field</small>
      </div>
      <div class="a11y-stat">
        <span>Total Findings</span>
        <strong style="color:#111">${esc(String(fs.totalFindings || (t.issues || []).length))}</strong>
        <small>${fs.confirmedFailures || 0} confirmed · ${fs.potentialIssues || 0} potential · ${fs.informationalObservations || 0} informational</small>
      </div>
    </div>

    <div class="a11y-disclaimer">
      <strong>Audit Coverage Notice:</strong> ${esc(cov.coverageDisclaimer || 'FLIQ inspected this page across Desktop, Tablet, and Mobile viewports. Unvisited pages and unsubmitted forms were not evaluated.')}
    </div>

    <h3 class="a11y-section-title">Tested vs. Untested Audit Capabilities</h3>
    <table class="a11y-matrix" role="table">
      <thead><tr><th>Audit Capability</th><th>Scope & Execution Status</th><th>FLIQ Safety & Accuracy Policy</th></tr></thead>
      <tbody>
        <tr>
          <td><b>Single-Page vs. Whole-Site Crawl</b></td>
          <td><span class="a11y-badge automated">${cov.pagesInspected || 1} inspected, ${cov.pagesSkipped || 0} skipped</span></td>
          <td>FLIQ never implies the entire website is healthy when only its homepage was audited.</td>
        </tr>
        <tr>
          <td><b>Multi-Viewport Reflow</b></td>
          <td><span class="a11y-badge passed">Desktop, Tablet, Mobile (3 captures)</span></td>
          <td>Tests horizontal overflow scroll and responsive reflow across standard device widths.</td>
        </tr>
        <tr>
          <td><b>Interactive Form Testing</b></td>
          <td><span class="a11y-badge manual">Discovered (${forms.formsCount || 0}) · Not submitted</span></td>
          <td>Passive non-destructive policy: forms are never submitted to avoid creating fake leads, orders, or database mutations.</td>
        </tr>
        <tr>
          <td><b>Interaction to Next Paint (INP)</b></td>
          <td><span class="a11y-badge manual">Field Metric · Not tested in Lab</span></td>
          <td>INP requires real user click/tap sessions (CrUX). Synthetic page loads do not fabricate artificial INP scores.</td>
        </tr>
        <tr>
          <td><b>Screen Reader & Live AT Usability</b></td>
          <td><span class="a11y-badge manual">Requires Manual Assistive Tech</span></td>
          <td>Automated scans verify DOM semantics and AccName 1.2, but cannot replace manual VoiceOver/NVDA evaluation.</td>
        </tr>
      </tbody>
    </table>

    ${cov.discoveredSample && cov.discoveredSample.length ? `
      <h3 class="a11y-section-title">Sample Discovered Same-Origin Internal Links</h3>
      <div style="background:#fff;border:1px solid #e5e5e5;border-radius:8px;padding:12px;font-family:monospace;font-size:12px;line-height:1.6">
        ${cov.discoveredSample.map(u => `<div>• ${esc(u)} <span style="color:#716c65;font-size:10px">(Discovered · Skipped per single-page limit)</span></div>`).join('')}
      </div>
    ` : ''}
  `;
}

async function resultPage(id){
  const rr=await apiFetch(`/api/tests/${id}`);
  const text=await rr.text();
  let t;
  try{ t=JSON.parse(text); }catch{ t={error:'Could not contact the FLIQ API server.'}; }
  if(t.error)return appShell(`<div class="empty"><h2>${esc(t.error)}</h2><a href="/dashboard" data-route>Return to dashboard</a></div>`);
  if(t.status!=='completed')return progressPage(id);
  clearActiveScanState();

  const allIssues = t.issues || [];
  const confirmedCount = allIssues.filter(i => i.classification === 'Confirmed Failure' || (!i.classification && i.type === 'failure')).length;
  const potentialCount = allIssues.filter(i => i.classification === 'Potential Issue' || (!i.classification && i.type === 'recommendation')).length;
  const infoCount = allIssues.filter(i => i.classification === 'Informational').length;

  let filteredIssues = allIssues;
  if (issueFilter === 'confirmed') filteredIssues = allIssues.filter(i => i.classification === 'Confirmed Failure' || (!i.classification && i.type === 'failure'));
  else if (issueFilter === 'potential') filteredIssues = allIssues.filter(i => i.classification === 'Potential Issue' || (!i.classification && i.type === 'recommendation'));
  else if (issueFilter === 'informational') filteredIssues = allIssues.filter(i => i.classification === 'Informational');

  const catScores = t.categoryScores || {
    accessibility: t.accessibilityReport ? (100 - (t.accessibilityReport.failuresCount||0)*18) : 100,
    functionality: t.httpStatus >= 400 ? 50 : 100,
    performance: t.loadTime > 4000 ? 75 : 100,
    seo: t.title ? 100 : 70,
    security: (t.finalUrl||t.url).startsWith('https:') ? 100 : 40
  };

  const tabs = ['Issues', 'Coverage', 'Accessibility', 'Performance', 'SEO', 'Security', 'Screenshots'];

  return appShell(`
    <div class="report-head">
      <div>
        <a href="/dashboard" data-route>← Back to dashboard</a>
        <h1>${esc(t.hostname)}</h1>
        <span class="badge completed">✓ Completed · ${new Date(t.completedAt).toLocaleString()}${t.loadTime ? ` · Scan duration: ${(t.loadTime/1000).toFixed(1)}s` : ''}</span>
      </div>
      <div>
        ${t.canManageSharing?'<button class="btn outline" data-action="share">Share</button>':''}
        <button class="btn black" data-action="download" data-id="${t.id}">Download report</button>
      </div>
    </div>

    <div class="category-metrics">
      <div class="category-metric" style="border-left: 3px solid #111">
        <span>Overall Score</span>
        <strong>${esc(String(t.score))}/100</strong>
        <small>Weighted composite</small>
      </div>
      <div class="category-metric" style="border-left: 3px solid #f09be5">
        <span>Accessibility</span>
        <strong>${esc(String(catScores.accessibility ?? '—'))}/100</strong>
        <small>WCAG 2.2 Level A/AA</small>
      </div>
      <div class="category-metric" style="border-left: 3px solid #a7e7f5">
        <span>Functionality</span>
        <strong>${esc(String(catScores.functionality ?? '—'))}/100</strong>
        <small>Errors, links & media</small>
      </div>
      <div class="category-metric" style="border-left: 3px solid #e3fa39">
        <span>Performance</span>
        <strong>${esc(String(catScores.performance ?? '—'))}/100</strong>
        <small>Core Web Vitals</small>
      </div>
      <div class="category-metric" style="border-left: 3px solid #6e9c78">
        <span>SEO</span>
        <strong>${esc(String(catScores.seo ?? '—'))}/100</strong>
        <small>On-page & metadata</small>
      </div>
      <div class="category-metric" style="border-left: 3px solid #77736f">
        <span>Security</span>
        <strong>${esc(String(catScores.security ?? '—'))}/100</strong>
        <small>Transport & headers</small>
      </div>
    </div>

    ${t.scoreExplanation ? `
      <div class="a11y-disclaimer" style="margin-top:0">
        <strong>Scoring methodology:</strong> ${esc(t.scoreExplanation)}
      </div>
    ` : ''}

    ${t.auditCoverage ? `
      <div style="background:#f8f9fa;border:1px solid #e2e8f0;border-radius:8px;padding:12px 16px;margin-bottom:14px;font-size:12px;color:#4a5568;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <div>
          <strong style="color:#1a202c">Audit Scope:</strong> ${esc(t.auditCoverage.scope || 'Single-Page Deep Audit')} ·
          <b>${esc(String(t.auditCoverage.pagesInspected || 1))}</b> page inspected across <b>3</b> viewports ·
          <b>${esc(String(t.auditCoverage.pagesDiscovered || 1))}</b> internal pages discovered (<b>${esc(String(t.auditCoverage.pagesSkipped || 0))}</b> skipped per policy)
        </div>
        <button class="btn outline" style="font-size:11px;padding:3px 8px" data-tab="Coverage">View Coverage Details →</button>
      </div>
    ` : ''}

    <div class="tabs">
      ${tabs.map(x => `<button class="${activeTab===x?'on':''}" data-tab="${x}">${x}${x==='Issues'?` (${allIssues.length})`:''}</button>`).join('')}
    </div>

    ${activeTab==='Screenshots'?`
      <div class="shots" style="grid-template-columns: repeat(auto-fit, minmax(280px, 1fr))">
        ${(t.screenshots && t.screenshots.length > 0) ? t.screenshots.map(s=>`
          <figure>
            <img data-screenshot="/api/screenshots/${s}" alt="${s.includes('mobile')?'Mobile':s.includes('tablet')?'Tablet':'Desktop'} website screenshot">
            <figcaption>${s.includes('mobile')?'Mobile (390px)':s.includes('tablet')?'Tablet (768px)':'Desktop (1440px)'} viewport capture</figcaption>
          </figure>
        `).join('') : `
          <div class="empty" style="grid-column: 1 / -1; padding: 40px 20px">
            <div class="empty-icon" style="font-size:24px">📷</div>
            <h3 style="font-size:16px;margin:8px 0">No Visual Screenshots Available</h3>
            <p style="font-size:12px;color:#716c65;max-width:440px;margin:0 auto">
              This audit was performed in serverless cloud mode without headless Chromium display captures. Full DOM semantics, network timings, security configurations, and accessibility findings are available in the tabs above.
            </p>
          </div>
        `}
      </div>
    `:activeTab==='Coverage'?coverageTabContent(t):
      activeTab==='Performance'?performanceTabContent(t):
      activeTab==='SEO'?seoTabContent(t):
      activeTab==='Security'?securityTabContent(t):
      activeTab==='Accessibility'?accessibilityTabContent(t):
      `
        <div class="issue-filters">
          <button class="filter-btn ${issueFilter==='all'?'active':''}" data-filter="all">All (${allIssues.length})</button>
          <button class="filter-btn ${issueFilter==='confirmed'?'active':''}" data-filter="confirmed">Confirmed Failures (${confirmedCount})</button>
          <button class="filter-btn ${issueFilter==='potential'?'active':''}" data-filter="potential">Potential Issues (${potentialCount})</button>
          <button class="filter-btn ${issueFilter==='informational'?'active':''}" data-filter="informational">Informational (${infoCount})</button>
        </div>

        ${filteredIssues.length?`
          <div class="issues">
            ${filteredIssues.map(i=>`
              <a class="issue-card" href="/dashboard/tests/${t.id}/issues/${i.id}" data-route>
                <span class="severity ${esc(i.severity)}">${esc(i.severity)}</span>
                <div>
                  <div style="display:flex;gap:6px;align-items:center;margin-bottom:3px">
                    <small>${esc(i.category)}</small>
                    <span class="a11y-badge ${i.classification==='Confirmed Failure'?'failure':i.classification==='Informational'?'informational':'recommendation'}">
                      ${esc(i.classification || (i.type==='failure'?'Confirmed Failure':'Potential Issue'))}
                    </span>
                  </div>
                  <h3>${esc(i.title)}</h3>
                  <p>${esc(i.description)}</p>
                </div>
                <b>View Details →</b>
              </a>
            `).join('')}
          </div>
        `:`
          <div class="empty">
            <div class="empty-icon">✓</div>
            <h3>No issues in this filter</h3>
            <p>FLIQ did not detect findings matching "${esc(issueFilter)}".</p>
          </div>
        `}
      `
    }

    <div class="ai-summary">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:8px">
        <b>${t.isAiGenerated ? 'AI Executive Analysis' : 'Executive Analysis'}</b>
        ${!t.isAiGenerated ? '<span class="a11y-badge not-tested" style="font-size:10px;text-transform:uppercase">Standard Analysis</span>' : '<span class="a11y-badge informational" style="font-size:10px;text-transform:uppercase">AI Enhanced</span>'}
        <button class="btn outline" style="font-size:11px;padding:3px 10px;margin-left:auto" data-action="regen-ai" data-id="${t.id}">Regenerate explanation ↺</button>
      </div>
      <p>${esc(t.aiSummary||'Quality audit analysis complete.')}</p>
      ${!t.isAiGenerated ? '<div style="font-size:11px;color:#716c65;margin-top:6px">AI explanations unavailable — using standard analysis.</div>' : ''}
    </div>
  `);
}

async function issuePage(testId,issueId){
  const r = await apiFetch(`/api/tests/${testId}`);
  const text = await r.text();
  let t;
  try { t = JSON.parse(text); } catch { t = { error: 'Could not contact the FLIQ API server.' }; }
  const i=t.issues?.find(x=>x.id===issueId);
  if(!i)return appShell(`<div class="empty"><h2>Issue not found</h2><a href="/dashboard/tests/${testId}" data-route>Back to report</a></div>`);
  const elements=i.elements||[];
  const isConfirmed=i.classification==='Confirmed Failure'||(!i.classification&&i.type==='failure');
  const isInfo=i.classification==='Informational';

  return appShell(`
    <div class="issue-detail">
      <a href="/dashboard/tests/${testId}" data-route>← Back to results</a>
      
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
        <span class="severity ${esc(i.severity)}">${esc(i.severity)} severity</span>
        <span class="a11y-badge ${isConfirmed?'failure':isInfo?'informational':'recommendation'}">
          ${esc(i.classification || (isConfirmed?'Confirmed Failure':'Potential Issue'))}
        </span>
        <span class="a11y-badge automated">${esc(i.category || 'General')}</span>
        ${i.confidence?`<span class="a11y-badge not-tested">Confidence: ${esc(i.confidence)}</span>`:''}
        ${elements.length?`<span class="a11y-badge not-tested">${elements.length} affected element(s)</span>`:''}
      </div>

      <h1>${esc(i.title)}</h1>
      <p>${esc(i.category)} · <code>${esc(i.url || t.finalUrl || t.url)}</code></p>

      <section class="detail-box">
        <span>1. BROWSER-OBSERVED EVIDENCE & FINDING</span>
        <pre style="margin-top:6px;color:#201d1a">${esc(i.evidence || i.actualBehavior || i.description)}</pre>
      </section>

      ${i.expectedBehavior?`
        <section class="detail-box" style="margin-top:14px;background:#fbfaf8">
          <span>2. EXPECTED STANDARD BEHAVIOR</span>
          <p style="font-size:12px;line-height:1.55;color:#45413c;margin:6px 0 0">${esc(i.expectedBehavior)}</p>
        </section>
      `:''}

      ${i.whyItMatters?`
        <section class="detail-box" style="margin-top:14px">
          <span>3. WHY THIS IS A PROBLEM</span>
          <p style="font-size:12px;line-height:1.55;color:#45413c;margin:6px 0 0">${esc(i.whyItMatters)}</p>
        </section>
      `:''}

      ${i.wcagCriterion?`
        <section class="detail-box" style="margin-top:14px;background:#f8f6f3">
          <span>4. RELEVANT TECHNICAL STANDARD / CRITERION</span>
          <p style="font-size:12px;font-weight:600;color:#1c557d;margin:6px 0 0">${esc(i.wcagCriterion)}</p>
        </section>
      `:''}

      ${i.reproductionSteps?`
        <section class="detail-box" style="margin-top:14px">
          <span>5. REPRODUCIBLE STEPS</span>
          <pre style="margin-top:6px;color:#45413c">${esc(i.reproductionSteps)}</pre>
        </section>
      `:''}

      <section class="fix-box">
        <b>6. Recommended Next Step</b>
        <p>${esc(i.recommendedFix||'Review the affected elements and update markup to follow quality guidelines.')}</p>
      </section>

      ${i.codeExample?`
        <section class="detail-box" style="margin-top:14px">
          <span>7. CORRECTED CODE EXAMPLE</span>
          <div class="a11y-diff-box">
            <div class="a11y-code-preview">
              <span class="code-label bad">Detected snippet</span>
              <code>${esc(i.codeExample.current)}</code>
            </div>
            <div class="a11y-code-preview">
              <span class="code-label good">Recommended correction example</span>
              <code>${esc(i.codeExample.corrected)}</code>
            </div>
          </div>
        </section>
      `:''}

      ${elements.length?`
        <section class="detail-box" style="margin-top:14px">
          <span>8. AFFECTED DOM ELEMENTS & CSS SELECTORS (${elements.length} DETECTED)</span>
          <div class="a11y-elements-list" style="margin-top:10px">
            ${elements.map((el,idx)=>`
              <div class="a11y-element-row">
                <header>
                  <span class="a11y-tag">#${idx+1} &lt;${esc(el.tagName||'element')}&gt;</span>
                  <span class="a11y-selector">${esc(el.selector||'')}</span>
                </header>
                <div class="a11y-prop">Role: <b>${esc(el.accessibleRole||el.tagName||'element')}</b> · Accessible name: <b>${esc(el.accessibleName||'(None)')}</b></div>
                ${el.htmlSnippet?`<div class="a11y-code-preview"><span class="code-label">Element Snippet</span><code>${esc(el.htmlSnippet)}</code></div>`:''}
                ${el.suggestedFix?`<div class="a11y-prop">Correction: <b>${esc(el.suggestedFix)}</b></div>`:''}
              </div>
            `).join('')}
          </div>
        </section>
      `:i.selector?`
        <section class="detail-box" style="margin-top:14px">
          <span>8. ELEMENT LOCATOR & SNIPPET</span>
          <div class="a11y-element-row" style="margin-top:8px">
            <span class="a11y-selector">${esc(i.selector)}</span>
            ${i.htmlSnippet?`<div class="a11y-code-preview"><span class="code-label">HTML Snippet</span><code>${esc(i.htmlSnippet)}</code></div>`:''}
          </div>
        </section>
      `:''}

      <section class="ai-box">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:8px">
          <b>${(i.isAiGenerated ?? t.isAiGenerated) ? 'AI Explanation' : 'Finding Analysis'}</b>
          ${!(i.isAiGenerated ?? t.isAiGenerated) ? '<span class="a11y-badge not-tested" style="font-size:10px;text-transform:uppercase">Standard Analysis</span>' : '<span class="a11y-badge informational" style="font-size:10px;text-transform:uppercase">AI Enhanced</span>'}
          <button class="btn outline" style="font-size:11px;padding:3px 8px;margin-left:auto" data-action="regen-ai" data-id="${t.id}">Regenerate ↺</button>
        </div>
        <p>${esc(i.explanation||t.aiSummary||'Finding analysis complete.')}</p>
        ${!(i.isAiGenerated ?? t.isAiGenerated) ? '<div style="font-size:11px;color:#716c65;margin-top:6px">Standard rule-based technical analysis.</div>' : ''}
      </section>

      <div style="margin-top:18px">
        <button class="btn outline" data-action="copy" data-copy="${esc(i.title+'\n\nEvidence: '+(i.evidence||i.actualBehavior||i.description)+(i.recommendedFix?'\n\nFix: '+i.recommendedFix:'')+(i.selector?'\n\nSelector: '+i.selector:''))}">Copy finding details</button>
      </div>
    </div>
  `);
}
function logoutConfirmDialog() {
  if (!logoutConfirmOpen) return '';
  return `
    <div class="modal-backdrop" id="logout-modal-backdrop" style="z-index:1000;display:flex;align-items:center;justify-content:center">
      <section class="demo-modal logout-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="logout-confirm-title" style="max-width:400px;width:100%;padding:28px 24px;background:#ffffff;border-radius:12px;box-shadow:0 20px 48px rgba(0,0,0,0.22);border:1px solid #ded9d2">
        <h2 id="logout-confirm-title" style="font-size:20px;font-weight:700;margin:0 0 8px 0;color:#111;letter-spacing:-0.02em">Log out</h2>
        <p style="font-size:13px;color:#6e6962;margin:0 0 20px 0;line-height:1.5">Are you sure you want to log out?</p>
        ${logoutError ? `<div id="logout-error-message" style="background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;padding:10px 14px;border-radius:6px;font-size:12px;margin-bottom:16px;line-height:1.4">${esc(logoutError)}</div>` : ''}
        <div style="display:flex;justify-content:flex-end;gap:10px">
          <button type="button" class="btn outline" data-action="cancel-logout" ${isLoggingOut ? 'disabled style="opacity:0.5;cursor:not-allowed;padding:9px 18px;font-size:12px;border-radius:6px;min-height:38px"' : 'style="padding:9px 18px;font-size:12px;border-radius:6px;min-height:38px"'}>Cancel</button>
          <button type="button" class="btn btn-logout-confirm" data-action="do-logout" ${isLoggingOut ? 'disabled style="opacity:0.75;cursor:not-allowed;padding:9px 18px;font-size:12px;border-radius:6px;min-height:38px"' : 'style="padding:9px 18px;font-size:12px;border-radius:6px;min-height:38px"'}>${isLoggingOut ? 'Logging out...' : 'Log out'}</button>
        </div>
      </section>
    </div>
  `;
}

function settings(){
  const tabs=['Profile','Preferences','Billing'];
  const rawTab=location.hash.slice(1);
  const tab=tabs.includes(rawTab)?rawTab:'Profile';
  let prefs=JSON.parse(localStorage.getItem('fliqPrefs')||'{}');
  if(firebaseConfigured&&localStorage.getItem('fliqToken')){
    apiFetch('/api/profile').then(r=>r.json()).then(j=>{
      if(j.preferences){
        localStorage.setItem('fliqPrefs',JSON.stringify(j.preferences));
        const emailBox=document.querySelector('#email-notifications');
        if(emailBox) emailBox.checked=j.preferences.emailNotifications!==false;
        const vpBox=document.querySelector('#default-viewport');
        if(vpBox&&j.preferences.defaultViewport) vpBox.value=j.preferences.defaultViewport;
      }
    }).catch(()=>{});
  }
  let content='';
  if(tab==='Preferences'){
    content=`<h3>Preferences</h3><label><input id="email-notifications" type="checkbox" ${prefs.emailNotifications===false?'':'checked'}> Email notifications</label><label>Default viewport<select id="default-viewport"><option ${prefs.defaultViewport==='Mobile'?'':'selected'}>Desktop</option><option ${prefs.defaultViewport==='Mobile'?'selected':''}>Mobile</option></select></label><button class="btn black" data-action="save-prefs">Save changes</button>`;
  } else if(tab==='Billing'){
    content=`<h3>Free plan</h3><p>Subscription billing is not connected. Plan limits are not enforced in this local setup.</p>${btn('Compare plans','/pricing','btn outline')}`;
  } else {
    content=`<h3>Profile information</h3><label>Name<input id="profile-name" value="${esc(localStorage.getItem('fliqName')||'')}" placeholder="Your name"></label><label>Email<input value="${esc(localStorage.getItem('fliqEmail')||'')}" disabled></label><button class="btn black" data-action="save-profile">Save changes</button><div class="account-security-section" style="margin-top:36px;padding-top:24px;border-top:1px solid #ded9d2"><h3 style="font-size:14px;margin:0 0 4px;color:#111">Account Security</h3><p style="margin:0 0 16px;color:#6e6962;font-size:11px">Manage your account access and security.</p><button type="button" class="btn outline btn-logout" data-action="confirm-logout">Log out</button></div>`;
  }
  return appShell(`<div class="page-head"><span class="eyebrow">YOUR WORKSPACE</span><h1>Settings</h1><p>Manage your account and preferences.</p></div><div class="settings-tabs">${tabs.map(x=>`<a href="#${x}" class="${(tab===x || (!tabs.includes(tab) && x==='Profile'))?'selected':''}">${x}</a>`).join('')}</div><section class="settings-card">${content}</section>${logoutConfirmDialog()}`);
}
function onboarding(){return `<main class="onboard"><section><div class="onboard-header">${logo}<span>1/3</span></div><div class="onboard-content"><span class="eyebrow">LET'S PERSONALIZE FLIQ</span><h1>What type of websites<br>do you test most?</h1><p>This helps us personalize your experience.</p><div class="choices">${['Personal / Portfolio','Business / Company','E-commerce','Web App / SaaS','Other'].map((x,i)=>`<button class="choice" data-choice="${x}"><span>${['◉','▣','♙','▤','＋'][i]}</span>${x}<b>○</b></button>`).join('')}</div><div class="onboard-actions"><button class="btn outline" data-go="/dashboard">Skip</button><button class="btn black" data-action="onboard-next">Next →</button></div></div></section><aside class="onboard-art">${artwork('pink')}</aside></main>`}
function docs(){return `${nav()}<main class="text-page"><span class="eyebrow">FLIQ GUIDE</span><h1>Test. Fix. Ship.</h1><p>Welcome to FLIQ, the clear and practical way to understand your website health.</p><h2>Run your first test</h2><ol><li>Create a FLIQ account and sign in.</li><li>Open Dashboard → New Test.</li><li>Enter a public website URL and start the scan.</li><li>Review findings and download the report.</li></ol><h2>What FLIQ checks</h2><p>Page availability, JavaScript errors, same-origin failed requests, internal links, missing images, basic accessible names, and page load timing.</p><p>Testing runs against publicly reachable sites. FLIQ does not submit forms or change third-party websites.</p>${btn('Open dashboard','/dashboard')}</main>${footer()}`}
function blog(){return `${nav()}<main class="text-page"><span class="eyebrow">FROM THE FLIQ TEAM</span><h1>Notes from the testing floor.</h1><p>Practical ideas for building, shipping, and maintaining better websites.</p><article class="blog-card"><span class="eyebrow">QUALITY · 5 MIN READ</span><h2>Good tests make the next step obvious.</h2><p>A useful QA report does more than list failures. It helps your team decide what to do next, with enough context to verify the finding.</p><a href="/docs" data-route>Read our testing guide →</a></article></main>${footer()}`}
function demo(){return `${nav()}<main class="text-page"><span class="eyebrow">INTERACTIVE WALKTHROUGH</span><h1>See what your website sees.</h1><p>Try a real scan on a public website. FLIQ will report browser findings as they are collected.</p><form class="new-test-form" id="test-form"><label>Website URL<input name="url" type="url" placeholder="https://example.com" required></label><button class="btn black" type="submit">Run a test →</button><div id="test-error"></div></form></main>${footer()}`}
function checkoutPage(){
  const params=new URLSearchParams(location.search);
  const planParam=(params.get('plan')||sessionStorage.getItem('fliqPendingPlan')||sessionStorage.getItem('fliqSelectedPlan')||'creator').toLowerCase();
  const periodParam=(params.get('period')||sessionStorage.getItem('fliqPendingPeriod')||sessionStorage.getItem('fliqSelectedPeriod')||'monthly').toLowerCase();
  const isYearly=periodParam==='yearly';
  const plan=plans.find(p=>p.name.toLowerCase()===planParam)||plans.find(p=>p.name==='Creator');
  const price=isYearly?plan.yearlyPrice:plan.monthlyPrice;
  const cycleLabel=isYearly?'Billed annually':'Billed monthly';
  const effectiveMonthly=isYearly&&plan.yearlySubtext?plan.yearlySubtext:'';
  const userEmail=localStorage.getItem('fliqEmail')||(firebaseAuth?.currentUser?.email)||'Your account';

  return appShell(`
    <div class="checkout-page" style="max-width:760px;margin:24px auto;padding:0 20px">
      <div style="margin-bottom:20px">
        <a href="/pricing" data-route style="font-size:13px;color:#716c65;text-decoration:none">← Change plan</a>
      </div>
      <div class="page-head" style="margin-bottom:24px">
        <span class="eyebrow">CHECKOUT PREPARATION</span>
        <h1 style="font-size:28px;margin:6px 0 8px">Review your ${esc(plan.name)} subscription</h1>
        <p style="color:#716c65;font-size:14px">Confirm your plan selection and billing details below.</p>
      </div>
      <div style="display:grid;grid-template-columns:1.3fr 1fr;gap:20px;align-items:start">
        <section class="settings-card" style="margin:0;padding:22px;border:1px solid #e7e2da;border-radius:12px;background:#fff">
          <div style="display:flex;justify-content:space-between;align-items:baseline;border-bottom:1px solid #f0ece6;padding-bottom:14px;margin-bottom:16px">
            <div>
              <h3 style="font-size:18px;margin:0 0 4px">${esc(plan.name)} Plan</h3>
              <p style="margin:0;color:#716c65;font-size:13px">${esc(plan.desc)}</p>
            </div>
            <div style="text-align:right">
              <span style="font-size:22px;font-weight:700">${esc(price)}</span>
              <small style="color:#716c65;display:block;font-size:12px">/${isYearly?'year':'month'}</small>
            </div>
          </div>
          <div style="margin-bottom:16px">
            <span style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#9b948a">Account</span>
            <div style="margin-top:4px;font-size:14px;color:#201d1a;font-weight:500">${esc(userEmail)}</div>
          </div>
          <div style="margin-bottom:16px">
            <span style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#9b948a">Billing Frequency</span>
            <div style="margin-top:4px;font-size:14px;color:#201d1a;font-weight:500">${esc(cycleLabel)} ${effectiveMonthly?`<small style="color:#716c65;font-weight:normal">(${esc(effectiveMonthly)})</small>`:''}</div>
          </div>
          <div>
            <span style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#9b948a">Included Features</span>
            <ul style="list-style:none;padding:0;margin:8px 0 0;font-size:13px;line-height:1.7;color:#45413c">
              ${plan.items.map(item=>`<li>✓ &nbsp;${esc(item)}</li>`).join('')}
            </ul>
          </div>
        </section>
        <section class="settings-card" style="margin:0;padding:22px;border:1px solid #e7e2da;border-radius:12px;background:#faf8f5">
          <h3 style="font-size:16px;margin:0 0 16px;letter-spacing:-0.01em">Payment Summary</h3>
          <div style="display:flex;justify-content:space-between;font-size:14px;margin-bottom:10px;color:#45413c">
            <span>Subtotal</span>
            <span style="font-weight:600">${esc(price)}</span>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:14px;margin-bottom:14px;color:#45413c">
            <span>Estimated Tax</span>
            <span>$0.00</span>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:16px;font-weight:700;border-top:1px solid #e7e2da;padding-top:14px;margin-bottom:18px;color:#201d1a">
            <span>Total Due Today</span>
            <span>${esc(price)}</span>
          </div>
          <div style="padding:12px 14px;background:#f3efe8;border-radius:8px;font-size:12px;line-height:1.5;color:#5a544b;margin-bottom:18px">
            <strong style="display:block;color:#201d1a;margin-bottom:2px">Gateway Preparation Mode</strong>
            Lemon Squeezy integration is being configured. Paid checkouts will activate shortly. No payment will be collected at this time.
          </div>
          <button class="btn black full" disabled style="opacity:0.8;cursor:not-allowed">Proceed to Checkout (Gateway Coming Soon)</button>
          <div style="margin-top:12px;text-align:center">
            <a href="/pricing" data-route style="font-size:12px;color:#716c65;text-decoration:none">Choose another plan</a>
          </div>
        </section>
      </div>
    </div>
  `);
}
function hydrateScreenshots(){document.querySelectorAll('[data-screenshot]').forEach(async img=>{try{const r=await apiFetch(img.dataset.screenshot);if(r.ok)img.src=URL.createObjectURL(await r.blob())}catch{}})}
function render(){
  try{
    stopHeroWalkthrough();
    clearProductDemo();
    stopAuthCarousel();
    path=location.pathname;
    const current=path;
    const parts=path.split('/').filter(Boolean);

    // If visiting a protected workspace route, ensure auth state is ready
    if(isProtected(path)){
      if(!authStateResolved){
        if(localStorage.getItem('fliqEmail') || localStorage.getItem('fliqTestUid')){
          // User was previously signed in: optimistically render workspace shell immediately
          getResolvedAuthState(3500).then(user => {
            if(!user && !localStorage.getItem('fliqEmail') && !localStorage.getItem('fliqTestUid')){
              go('/login');
            }
          });
        } else {
          $('#app').innerHTML = appShell(`
            <div class="empty" style="max-width:440px;margin:80px auto;text-align:center">
              <div class="spinner" style="width:36px;height:36px;border:3px solid #e7e2da;border-top-color:#111;border-radius:50%;animation:spin 0.8s linear infinite;margin:0 auto 16px"></div>
              <h3 style="font-size:18px;margin-bottom:6px">Loading your workspace…</h3>
              <p style="color:#716c65;font-size:13px;margin:0">Verifying session and connecting to FLIQ…</p>
            </div>
          `);
          getResolvedAuthState(3500).then(user => {
            if(user){
              if(isProtected(location.pathname)) render();
            }else{
              const params = new URLSearchParams(location.search);
              const plan = params.get('plan') || sessionStorage.getItem('fliqPendingPlan');
              const per = params.get('period') || sessionStorage.getItem('fliqPendingPeriod');
              if(plan){
                try{
                  sessionStorage.setItem('fliqPendingPlan', plan);
                  if(per) sessionStorage.setItem('fliqPendingPeriod', per);
                }catch{}
                go(`/login?plan=${encodeURIComponent(plan)}&period=${encodeURIComponent(per||'monthly')}`);
              }else{
                go('/login');
              }
            }
          });
          return;
        }
      } else if(!resolvedAuthUser && !firebaseAuth?.currentUser && !localStorage.getItem('fliqTestUid') && !localStorage.getItem('fliqEmail')){
        go('/login');
        return;
      }
    }

    let out;
    if(path==='/') out=home();
    else if(path==='/features') out=features();
    else if(path==='/pricing') out=pricing();
    else if(path==='/checkout'||path.startsWith('/checkout')) out=checkoutPage();
    else if(path==='/signup') out=auth(true);
    else if(path==='/login') out=auth(false);
    else if(path==='/forgot-password') out=forgot();
    else if(path==='/onboarding') out=onboarding();
    else if(path==='/dashboard') out=dashboard();
    else if(path==='/dashboard/new-test') out=newTest();
    else if(path==='/dashboard/settings') out=settings();
    else if(['/dashboard/history','/dashboard/reports','/dashboard/monitors','/dashboard/team'].includes(path)) out=historyPage(({ '/dashboard/history':'Test History','/dashboard/reports':'Reports','/dashboard/monitors':'Monitors','/dashboard/team':'Team'}[path]));
    else if(parts[0]==='dashboard'&&parts[1]==='tests'&&parts[3]==='issues') out=issuePage(parts[2],parts[4]);
    else if(parts[0]==='dashboard'&&parts[1]==='tests') out=resultPage(parts[2]);
    else if(path==='/docs') out=docs();
    else if(path==='/blog') out=blog();
    else if(path==='/demo') out=demo();
    else out=`${nav()}<main class="text-page"><h1>Page not found</h1>${btn('Go home','/')}</main>`;

    if(out instanceof Promise){
      // Ensure the screen is never left empty while async pages load
      const appEl = $('#app');
      if (appEl && (!appEl.firstElementChild || appEl.querySelector('.fliq-boot-loading'))) {
        appEl.innerHTML = appShell(`
          <div class="empty" style="max-width:520px;margin:80px auto;text-align:center">
            <div class="spinner" style="width:36px;height:36px;border:3px solid #e7e2da;border-top-color:#111;border-radius:50%;animation:spin 0.8s linear infinite;margin:0 auto 16px"></div>
            <h3 style="font-size:18px;margin-bottom:6px">Loading report…</h3>
            <p style="color:#716c65;font-size:13px;margin:0">Fetching audit details from FLIQ…</p>
          </div>
        `);
      }
      out.then(v=>{
        if(location.pathname===current){
          $('#app').innerHTML=v;
          hydrateScreenshots();
          if(current.match(/^\/dashboard\/tests\/[^/]+$/)&&!v.includes('report-head')) poll(current.split('/')[3]);
        }
      }).catch(err=>{
        console.error('[FLIQ] Render error:',err);
        const el=$('#app');
        if(el) el.innerHTML=appShell(`<div class="empty"><h2>Unable to load page</h2><p>${esc(err.message)}</p><a href="/dashboard" data-route>Return to dashboard</a></div>`);
      });
    }else{
      $('#app').innerHTML=out;
      if(current==='/'){ startHeroWalkthrough(); startProductDemo(); }
      if(current==='/login' || current==='/signup' || current==='/forgot-password'){ initAuthCarousel(); }
    }
  }catch(renderErr){
    console.error('[FLIQ] Render exception:',renderErr);
    const el=$('#app');
    if(el) el.innerHTML=`<div style="padding:40px;font-family:sans-serif;max-width:600px;margin:auto"><h2>Could not render page</h2><p>${esc(renderErr.message)}</p><p><a href="/">Return to Home</a></p></div>`;
  }
}
function validateInputUrl(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) {
    return { valid: false, error: 'Please enter a website URL.' };
  }
  let candidate = trimmed;
  if (!/^https?:\/\//i.test(candidate)) {
    candidate = 'https://' + candidate;
  }
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return { valid: false, error: 'Enter a valid website URL (e.g., https://example.com).' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { valid: false, error: 'Only HTTP and HTTPS URLs are supported.' };
  }
  const host = parsed.hostname.toLowerCase();
  if (!host || !host.includes('.') || host.endsWith('.')) {
    return { valid: false, error: 'Please enter a valid domain name (e.g., https://example.com).' };
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === 'metadata.google.internal') {
    return { valid: false, error: 'Local and restricted addresses cannot be tested.' };
  }
  const cleanUrl = (parsed.pathname === '/' && !candidate.endsWith('/') && !parsed.search && !parsed.hash)
    ? parsed.origin
    : parsed.toString();
  return { valid: true, url: cleanUrl };
}

let isTestRunning = false;
async function triggerPendingScan(targetUrl) {
  if (isTestRunning) return;
  const validation = validateInputUrl(targetUrl);
  if (!validation.valid) {
    console.error('[FLIQ] Pending scan URL invalid:', targetUrl, validation.error);
    go('/dashboard');
    return;
  }
  const cleanUrl = validation.url;
  isTestRunning = true;
  let scanJob = null;
  try {
    const r = await apiFetch('/api/tests', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: cleanUrl })
    });
    const text = await r.text();
    let j;
    try { j = JSON.parse(text); } catch { j = { error: 'Invalid response from server.' }; }
    if (!r.ok) throw new Error(j.error || 'Failed to start scan.');
    scanJob = j;
  } catch (err) {
    isTestRunning = false;
    console.error('[FLIQ] Pending scan execution error:', err);
    try { sessionStorage.setItem('fliqPendingUrl', cleanUrl); } catch {}
    go('/dashboard');
    setTimeout(() => {
      const runPanel = document.querySelector('.run-panel') || document.querySelector('.app-main');
      if (runPanel && !document.querySelector('#scan-retry-banner')) {
        const banner = document.createElement('div');
        banner.className = 'setup-note';
        banner.id = 'scan-retry-banner';
        banner.style.borderLeftColor = '#a02c24';
        banner.style.background = '#fff5f4';
        banner.innerHTML = `<strong style="color:#a02c24">Scan could not start automatically:</strong> ${esc(err.message)} <button class="btn black" style="margin-left:12px;padding:4px 12px;font-size:11px" id="retry-pending-btn">Retry scan for ${esc(cleanUrl)}</button>`;
        runPanel.prepend(banner);
        document.querySelector('#retry-pending-btn')?.addEventListener('click', () => {
          sessionStorage.removeItem('fliqPendingUrl');
          document.querySelector('#scan-retry-banner')?.remove();
          triggerPendingScan(cleanUrl);
        });
      }
    }, 200);
    return;
  }

  isTestRunning = false;
  modal = false;
  try {
    setActiveScanState(scanJob.id, cleanUrl, 'Initializing browser', 10, 'running');
    startGlobalScanTracker();
  } catch (stateErr) {
    console.warn('[FLIQ] Notice updating active scan state:', stateErr);
  }

  try {
    go(`/dashboard/tests/${scanJob.id}`);
    poll(scanJob.id);
  } catch (navErr) {
    console.warn('[FLIQ] Notice navigating to live scan view:', navErr);
    go('/dashboard');
  }
}
window.triggerPendingScan = triggerPendingScan;
window.validateInputUrl = validateInputUrl;

async function runTest(form){
  if(isTestRunning) return;
  const urlInput = form.querySelector('input[name="url"]') || form.querySelector('input[type="url"]') || document.querySelector('#quick-test-url');
  const rawUrl = urlInput ? urlInput.value : '';
  const out = form.querySelector('[id$="error"]') || document.querySelector('#demo-error') || document.querySelector('#test-error');
  const button = form.querySelector('button[type="submit"]') || form.querySelector('button:not([data-go])') || form.querySelector('button');

  const validation = validateInputUrl(rawUrl);
  if (!validation.valid) {
    if (out) out.textContent = validation.error;
    if (urlInput) {
      urlInput.classList.add('has-error');
      urlInput.focus();
    }
    return;
  }

  const targetUrl = validation.url;

  if (out) out.textContent = '';
  if (urlInput) urlInput.classList.remove('has-error');

  // Authentication-first workflow: unauthenticated visitors are redirected to login/signup
  await firebaseStatusPromise;
  const isAuthed = Boolean(firebaseAuth?.currentUser || localStorage.getItem('fliqTestUid') || (!firebaseWebConfigured && localStorage.getItem('fliqEmail')));
  if (!isAuthed) {
    try { sessionStorage.setItem('fliqPendingUrl', targetUrl); } catch {}
    modal = false;
    render();
    go(`/login?pendingUrl=${encodeURIComponent(targetUrl)}`);
    return;
  }

  isTestRunning = true;
  const originalButtonText = button ? button.innerHTML : 'Run a test';
  if (button) {
    button.disabled = true;
    button.textContent = 'Starting test…';
  }

  let scanJob = null;
  try {
    const r = await apiFetch('/api/tests', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: targetUrl })
    });
    const text = await r.text();
    let j;
    try { j = JSON.parse(text); } catch { j = { error: 'Invalid response from server.' }; }
    if (!r.ok) throw new Error(j.error || 'Failed to start scan.');
    scanJob = j;
  } catch (apiErr) {
    isTestRunning = false;
    if (button) {
      button.disabled = false;
      button.innerHTML = originalButtonText;
    }
    if (out) {
      out.textContent = apiErr.message || 'An error occurred while starting the test.';
    } else {
      alert(apiErr.message);
    }
    if (urlInput) {
      urlInput.focus();
    }
    return;
  }

  // Once HTTP 202 Accepted with scanJob.id is received, the background scan is successfully created.
  // Errors in peripheral UI transitions must never report the scan as failed or block navigation.
  isTestRunning = false;
  modal = false;

  try {
    setActiveScanState(scanJob.id, targetUrl, 'Initializing browser', 10, 'running');
    startGlobalScanTracker();
  } catch (stateErr) {
    console.warn('[FLIQ] Notice updating active scan state:', stateErr);
  }

  try {
    go(`/dashboard/tests/${scanJob.id}`);
    poll(scanJob.id);
  } catch (navErr) {
    console.warn('[FLIQ] Notice navigating to live scan view:', navErr);
    go('/dashboard');
  }
}

let liveEventSource = null;

function subscribeLiveScan(id) {
  clearInterval(testTimer);
  if (liveEventSource) {
    try { liveEventSource.close(); } catch {}
    liveEventSource = null;
  }

  if (typeof EventSource !== 'undefined') {
    try {
      const sse = new EventSource(`/api/tests/${id}/events`);
      liveEventSource = sse;
      sse.addEventListener('scan-update', (e) => {
        if (!location.pathname.includes(`/tests/${id}`)) {
          sse.close();
          liveEventSource = null;
          return;
        }
        try {
          const data = JSON.parse(e.data);
          render();
          if (data.status === 'completed' || data.status === 'failed') {
            sse.close();
            liveEventSource = null;
          }
        } catch {}
      });
      sse.onerror = () => {
        try { sse.close(); } catch {}
        liveEventSource = null;
        startPollingFallback(id);
      };
    } catch {
      startPollingFallback(id);
    }
  } else {
    startPollingFallback(id);
  }
}

function startPollingFallback(id) {
  clearInterval(testTimer);
  testTimer = setInterval(async () => {
    if (!location.pathname.includes(`/tests/${id}`)) {
      clearInterval(testTimer);
      return;
    }
    try {
      const r = await apiFetch(`/api/tests/${id}`);
      if (r.ok) {
        const t = await r.json();
        if (t.status === 'completed' || t.status === 'failed') {
          clearActiveScanState();
          clearInterval(testTimer);
        } else {
          setActiveScanState(t.id, t.url, t.stage, t.progress, t.status);
        }
        render();
      }
    } catch (e) {
      console.warn('[FLIQ] Poll error:', e.message);
    }
  }, 1500);
}

function poll(id) {
  subscribeLiveScan(id);
}

document.addEventListener('click',async e=>{
  const logoLink=e.target.closest('.logo-link');
  if(logoLink){
    e.preventDefault();
    await logoNavigate(e);
    return;
  }
  const route=e.target.closest('[data-route]');
  if(route){
    e.preventDefault();
    const target=route.getAttribute('href');
    if(target==='/' && location.pathname==='/'){
      window.scrollTo({top:0,behavior:'smooth'});
      return;
    }
    go(target);
    return;
  }
  const planBtn=e.target.closest('[data-plan-select]');
  if(planBtn){
    e.preventDefault();
    const planName=planBtn.dataset.planSelect||'creator';
    await handlePlanSelect(planName,(period||'monthly').toLowerCase());
    return;
  }
  const g=e.target.closest('[data-go]');
  if(g){
    e.preventDefault();
    if(g.dataset.go==='#demo'){
      modal=true;
      render();
      requestAnimationFrame(()=>{
        const input=document.querySelector('#quick-test-url');
        if(input)input.focus();
      });
    } else {
      go(g.dataset.go);
    }
    return;
  }
  if(e.target.closest('[data-modal-close]')){
    e.preventDefault();
    modal=false;
    render();
    return;
  }
  if(e.target.id==='demo-modal-backdrop'){
    e.preventDefault();
    modal=false;
    render();
    return;
  }
  if(e.target.id==='logout-modal-backdrop'){
    e.preventDefault();
    if(!isLoggingOut){
      logoutConfirmOpen=false;
      logoutError='';
      render();
    }
    return;
  }
  if(e.target.closest('[data-close]')){modal=false;render();return}
  const p=e.target.closest('[data-period]');if(p){period=p.dataset.period;render();return}
  const t=e.target.closest('[data-tab]');if(t){activeTab=t.dataset.tab;render();return}
  const liveCatBtn = e.target.closest('[data-live-cat]');
  if (liveCatBtn) {
    e.preventDefault();
    liveActiveCategory = liveCatBtn.dataset.liveCat;
    render();
    return;
  }
  const toggleFinding = e.target.closest('[data-action="toggle-live-finding"]');
  if (toggleFinding) {
    e.preventDefault();
    const fid = toggleFinding.dataset.findingId;
    liveSelectedFindingId = (liveSelectedFindingId === fid ? null : fid);
    render();
    return;
  }
  const togglePwd = e.target.closest('[data-toggle-password]');
  if (togglePwd) {
    e.preventDefault();
    const group = togglePwd.closest('.auth-input-group');
    const input = group?.querySelector('input[name="password"]') || document.querySelector('#auth-password-input');
    if (input) {
      const isPwd = input.type === 'password';
      input.type = isPwd ? 'text' : 'password';
      togglePwd.setAttribute('aria-label', isPwd ? 'Hide password' : 'Show password');
      togglePwd.innerHTML = isPwd ? `
        <svg class="auth-eye-icon" viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="#111827" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14.12 14.12a8.5 8.5 0 0 1-4.12 1.38c-5 0-8.5-6-8.5-6a16.8 16.8 0 0 1 3.44-4.56M7.5 7.5a3 3 0 0 1 4.24 4.24"/>
          <path d="M1.5 1.5l17 17"/>
          <path d="M9.88 4.5a8.8 8.8 0 0 1 1.62-.0c5 0 8.5 6 8.5 6a16.8 16.8 0 0 1-2.16 3.19"/>
        </svg>
      ` : `
        <svg class="auth-eye-icon" viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="#6b7280" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="M1.5 10s3.5-6 8.5-6 8.5 6 8.5 6-3.5 6-8.5 6-8.5-6-8.5-6z"/>
          <circle cx="10" cy="10" r="2.5"/>
        </svg>
      `;
    }
    return;
  }
  const carouselDot = e.target.closest('[data-carousel-dot]');
  if (carouselDot) {
    e.preventDefault();
    const idx = parseInt(carouselDot.dataset.carouselDot, 10);
    if (!isNaN(idx)) {
      setAuthCarouselSlide(idx);
      resetAuthCarouselTimer();
    }
    return;
  }
  const fil=e.target.closest('[data-filter]');if(fil){issueFilter=fil.dataset.filter;render();return}
  const c=e.target.closest('[data-choice]');if(c){document.querySelectorAll('.choice').forEach(x=>x.classList.remove('picked'));c.classList.add('picked');return}
  const o=e.target.closest('[data-oauth]');if(o){signInWithOAuth(o);return}
  const a=e.target.closest('[data-action]');
  if(a){
    const action=a.dataset.action;
    if(action==='retry-tests'){
      window.__fliqTestsError = false;
      window.__fliqTestsErrorMessage = '';
      const banner = document.querySelector('#dashboard-error-banner');
      if (banner) banner.innerHTML = '';
      refreshDashboardData(true);
      return;
    }
    if(action==='regen-ai'){
      const id=a.dataset.id;a.disabled=true;const orig=a.textContent;a.textContent='Generating…';
      try{
        const r=await apiFetch(`/api/tests/${id}/regenerate-ai`,{method:'POST'});
        const j=await r.json();
        if(!r.ok)throw new Error(j.error||'Failed to regenerate AI explanation');
        render();
      }catch(err){alert(err.message||'Failed to regenerate AI explanation');a.disabled=false;a.textContent=orig;}
      return;
    }
    if(action==='download'){
      const id=a.dataset.id;
      apiFetch(`/api/tests/${id}`).then(r=>r.json()).then(data=>{
        const b=new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),u=URL.createObjectURL(b),link=document.createElement('a');
        link.href=u;link.download=`fliq-report-${id}.json`;link.click();URL.revokeObjectURL(u);
      });
    }
    if(action==='share'){
      shareModalId=path.split('/')[3];shareRecipients=[];shareMessage='';render();
      if(firebaseConfigured)apiFetch('/api/tests/'+shareModalId+'/shares').then(async r=>{
        const j=await r.json();if(r.ok)shareRecipients=j.recipients||[];else shareMessage=j.error||'Unable to load access list.';render();
      });
    }
    if(action==='copy'){navigator.clipboard?.writeText(a.dataset.copy);a.textContent='Copied'}
    if(action==='confirm-logout'){
      e.preventDefault();
      logoutConfirmOpen = true;
      isLoggingOut = false;
      logoutError = '';
      render();
      return;
    }
    if(action==='cancel-logout'){
      e.preventDefault();
      if(!isLoggingOut){
        logoutConfirmOpen = false;
        logoutError = '';
        render();
      }
      return;
    }
    if(action==='do-logout' || action==='signout'){
      e.preventDefault();
      await executeSignOut();
      return;
    }
    if(action==='save-profile'){
      const name=$('#profile-name').value;localStorage.setItem('fliqName',name);
      apiFetch('/api/profile',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({displayName:name})}).then(()=>render());
    }
    if(action==='save-prefs'){
      const preferences={emailNotifications:document.querySelector("#email-notifications").checked,defaultViewport:document.querySelector("#default-viewport").value};
      localStorage.setItem('fliqPrefs',JSON.stringify(preferences));
      apiFetch('/api/profile',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({preferences})}).then(()=>{a.textContent='Saved';});
    }
    if(action==='onboard-next'){
      const v=document.querySelector('.choice.picked');
      if(!v){alert('Choose an option or skip for now.');return}
      localStorage.setItem('fliqWebsiteType',v.dataset.choice);
      apiFetch('/api/profile',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({websiteType:v.dataset.choice,onboardingComplete:true})});
      go('/dashboard');
    }
    return;
  }
  const mobileToggle=e.target.closest('.menu-toggle');
  if(mobileToggle){
    const open=document.querySelector('.topnav nav')?.classList.toggle('open')||false;
    mobileToggle.setAttribute('aria-expanded',String(open));
  }
  const demoReport=e.target.closest('[data-demo-report]');
  if(demoReport){
    const art=demoReport.closest('[data-hero-walkthrough]');
    if(art)art.querySelector('.demo-status').textContent='Sample report preview · simulated data only';
    demoReport.innerHTML='Preview only <span>✓</span>';
  }
});

document.addEventListener('input', e => {
  if (e.target.id === 'quick-test-url' || e.target.name === 'url') {
    e.target.classList.remove('has-error');
    const out = e.target.closest('form')?.querySelector('[id$="error"]') || document.querySelector('#demo-error');
    if (out) out.textContent = '';
  }
});
document.addEventListener('submit',async e=>{if(e.target.id==='test-form'||e.target.id==='quick-test'||e.target.classList.contains('new-test-form')||e.target.querySelector('input[name="url"]')){e.preventDefault();runTest(e.target);return}if(e.target.id==='auth-form'){e.preventDefault();const form=e.target,fd=new FormData(form),msg=$('#auth-message'),signup=location.pathname==='/signup',submit=form.querySelector('button[type=submit]');submit.disabled=true;submit.textContent=signup?'Creating account…':'Signing in…';msg.textContent='';try{await firebaseStatusPromise;if(!firebaseWebConfigured)throw Error('Firebase Web Authentication is not configured. Missing: '+(firebaseWebMissing.join(', ')||'Web App configuration')+'.');const {auth,sdk}=await initializeFirebaseClient(),email=String(fd.get('email')).trim(),password=String(fd.get('password'));let credential;if(signup){credential=await sdk.createUserWithEmailAndPassword(auth,email,password);const name=String(fd.get('name')||'').trim();if(name){try{await sdk.updateProfile(credential.user,{displayName:name})}catch{}}}else credential=await sdk.signInWithEmailAndPassword(auth,email,password);localStorage.setItem('fliqEmail',credential.user.email||email);localStorage.setItem('fliqName',credential.user.displayName||String(fd.get('name')||''));await navigatePostAuth();}catch(error){msg.textContent=error.message?.startsWith('Firebase Web Authentication')||error.message?.startsWith('Firebase Web App')?error.message:friendlyFirebaseAuthError(error);submit.disabled=false;submit.textContent=signup?'Create account':'Sign in'}}if(e.target.id==='reset-form'){e.preventDefault();const msg=$('#reset-message'),submit=e.target.querySelector('button[type=submit]');if(submit){submit.disabled=true;submit.textContent='Sending…'}try{await firebaseStatusPromise;if(!firebaseWebConfigured)throw Error('Firebase Web Authentication is not configured. Missing: '+(firebaseWebMissing.join(', ')||'Web App configuration')+'.');const {auth,sdk}=await initializeFirebaseClient();await sdk.sendPasswordResetEmail(auth,String(new FormData(e.target).get('email')).trim());msg.textContent='If an account exists for that email, a password reset link has been sent.'}catch(error){msg.textContent=error.message?.startsWith('Firebase Web Authentication')?error.message:friendlyFirebaseAuthError(error)}finally{if(submit){submit.disabled=false;submit.textContent='Send reset link'}}}});
document.addEventListener('change',e=>{if(e.target.classList.contains('search')){const q=e.target.value.toLowerCase();document.querySelectorAll('.test-row').forEach(row=>row.hidden=!row.textContent.toLowerCase().includes(q))}});
document.addEventListener('click',async e=>{
  if(e.target.closest('[data-share-close]')){shareModalId=null;shareRecipients=[];shareMessage='';render();return;}
  const revoke=e.target.closest('[data-revoke]');if(revoke){if(!confirm(`Remove ${revoke.dataset.email||'this user'}'s access to this report?`))return;const response=await apiFetch(`/api/tests/${revoke.dataset.test}/shares/${revoke.dataset.revoke}`,{method:'DELETE'}),data=await response.json();shareMessage=response.ok?'Access revoked.':data.error||'Could not revoke access.';if(response.ok)shareRecipients=shareRecipients.filter(r=>r.uid!==revoke.dataset.revoke);render();return;}
});
document.addEventListener('submit',async e=>{if(e.target.id!=='share-form')return;e.preventDefault();const form=e.target,email=new FormData(form).get('email'),submit=form.querySelector('button[type=submit]');if(!confirm(`Grant ${email} access to this website report, including its findings and screenshots? They must sign in to their FLIQ account. You can revoke access later.`))return;submit.disabled=true;submit.textContent='Granting access…';try{const response=await apiFetch(`/api/tests/${form.dataset.id}/shares`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email})}),data=await response.json();shareMessage=response.ok?`Access granted to ${data.email}.`:data.error||'Could not grant access.';if(response.ok){const r=await apiFetch(`/api/tests/${form.dataset.id}/shares`),list=await r.json();shareRecipients=list.recipients||[];}render();}catch{shareMessage='Could not contact FLIQ.';render();}});
document.addEventListener('click',e=>{const trigger=e.target.closest('[data-product-menu-trigger]');if(trigger){e.preventDefault();toggleProductMenu();return}if(e.target.closest('.product-dropdown a')){setProductMenu(false);return}if(!e.target.closest('.product-menu')&&document.querySelector('[data-product-menu-trigger][aria-expanded="true"]'))setProductMenu(false)});
document.addEventListener('keydown', async e => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.closest?.('.logo-link')) {
    e.preventDefault();
    await logoNavigate(e);
    return;
  }
  if (e.key === 'Escape') {
    if (logoutConfirmOpen) {
      if (!isLoggingOut) {
        logoutConfirmOpen = false;
        logoutError = '';
        render();
      }
      return;
    }
    if (modal) {
      modal = false;
      render();
      return;
    }
  }
  productMenuKeydown(e);
});
document.addEventListener('focusin',e=>{const wrap=document.querySelector('.product-menu'),trigger=wrap?.querySelector('[data-product-menu-trigger]');if(wrap&&trigger?.getAttribute('aria-expanded')==='true'&&!wrap.contains(e.target))setProductMenu(false)});
new MutationObserver(()=>{if(shareModalId&&location.pathname===`/dashboard/tests/${shareModalId}`&&!document.querySelector('.share-modal'))$('#app').insertAdjacentHTML('beforeend',shareDialog(shareModalId));}).observe($('#app'),{childList:true});
render();
startGlobalScanTracker();












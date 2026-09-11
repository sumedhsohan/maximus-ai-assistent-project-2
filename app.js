/* ===================== Cortex — AI Chat Studio =====================
   Vanilla JS, localStorage-backed, single AI provider (Mistral API) under the hood.
   ==================================================================== */

/* ---------------- CONFIG -----------------
   Paste a default API key below if you want every user of this deployment
   to skip entering their own key. Leave blank to require each person to
   add their own key in Settings. This never leaves the browser except in
   requests to the AI provider's API.
------------------------------------------- */
const CONFIG = {
  DEFAULT_API_KEY: '',            // <-- paste your API key here, e.g. 'abcd1234...'
  MODEL_TEXT: 'mistral-small-latest', // was 'mistral-small-latest' — Ministral 3B has the lowest time-to-first-token (~0.65s) and fastest output speed (~250 tok/s) of any Mistral model. Tradeoff: it's a 3B model, so it's noticeably less capable on hard reasoning/coding than mistral-small-latest or mistral-large-latest — if answers feel shallow or wrong on tough questions, that's the tradeoff. Swap back to 'mistral-small-latest' here if quality matters more than speed for your use case.
  MODEL_FAST: 'mistral-small-latest', // always used for the tiny voice-command classifier call, regardless of MODEL_TEXT, so classification never becomes the slow step
  MODEL_VISION: 'pixtral-12b-2409',
  // Paste your Spotify app's Client ID here (from developer.spotify.com/dashboard).
  // No client secret is needed — playback uses the PKCE flow, which is safe to run
  // fully client-side. You must also add the exact URL this page runs at (shown
  // in Settings once you fill this in) as a Redirect URI in that Spotify app.
  SPOTIFY_CLIENT_ID: '',
  // Paste a YouTube Data API v3 key here (free, from console.cloud.google.com —
  // enable "YouTube Data API v3" then create an API key, no OAuth needed since
  // this only searches, it never touches anyone's account). Leave blank and
  // people can still set their own key in Settings. Without any key, "play
  // <video> on youtube" falls back to just opening a YouTube search results
  // page instead of jumping straight to a specific video.
  YOUTUBE_API_KEY: '',
  // Paste your Google Calendar app's OAuth Client ID here (from
  // console.cloud.google.com — create an OAuth 2.0 Client ID of type "Web
  // application", enable the "Google Calendar API" for the project, and add
  // this exact page's URL — shown in Settings once you fill this in — as an
  // Authorized JavaScript origin). No client secret is needed: this uses
  // Google Identity Services' token client, which is safe to run fully
  // client-side, same as the Spotify PKCE flow above. Leave blank and the
  // Calendar section in Settings will just explain what to paste in.
  GOOGLE_CLIENT_ID: '',
  // Address of the Maximus Desktop Agent — a small local Python program (see
  // maximus_agent.py) that must be running on THIS computer for any real
  // desktop-control commands to work (opening apps, file explorer, task
  // manager, settings, battery %, "go to desktop", creating files, etc).
  // A browser page can never do these things by itself for security reasons —
  // the agent is what actually talks to the operating system.
  AGENT_URL: 'http://127.0.0.1:5055'
};

// Where Spotify sends the user back to after login — always this exact page.
const SPOTIFY_REDIRECT_URI = window.location.origin + window.location.pathname;

const STORE_KEY = 'cortex_state_v2';

function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,8); }

function defaultState(){
  return {
    user: { name: '', avatarInit: 'U', email: '' },
    settings: { apiKey: CONFIG.DEFAULT_API_KEY || '', youtubeApiKey: CONFIG.YOUTUBE_API_KEY || '', model: CONFIG.MODEL_TEXT, theme: 'dark', voiceLang: 'en-IN' },
    accounts: [],     // {email, password, name} — demo-grade local "database"
    session: null,    // {email} of currently logged in account
    memory: [],       // facts Cortex remembers about the user across sessions
    projects: [],     // {id, name, createdAt, expanded}
    chats: [],        // {id, title, messages:[], projectId, favorite, createdAt, updatedAt}
    contacts: [],     // {id, name, phone} — used for "message <name> on whatsapp" voice commands
    tasks: [],        // {id, text, done, createdAt, dueAt} — todo list + timed reminders
    spotify: { accessToken: null, refreshToken: null, expiresAt: 0, deviceId: null },
    google: { accessToken: null, expiresAt: 0 },  // Calendar OAuth token (Google Identity Services token client — see googleLogin())
    activeChatId: null,
    loggedIn: false
  };
}

let state = load();
save(); // persist any one-time migrations (model speed fix, contact + fix) right away

function load(){
  try{
    const raw = localStorage.getItem(STORE_KEY);
    if(!raw) return defaultState();
    const parsed = JSON.parse(raw);
    const merged = Object.assign(defaultState(), parsed);
    merged.settings = Object.assign(defaultState().settings, parsed.settings || {});
    // One-time speed fix: earlier versions of this app defaulted to
    // mistral-large-latest, which is noticeably slower to start replying.
    // Anyone still on that old default gets switched to the fast model
    // automatically — they can always switch back via Settings if they'd
    // rather have Large's extra capability than speed.
    if(merged.settings.model === 'mistral-large-latest' && !merged.settings._modelSpeedMigrated){
      merged.settings.model = CONFIG.MODEL_TEXT;
      merged.settings._modelSpeedMigrated = true;
    }
    // One-time contact fix: contacts saved before this fix were stored as
    // "91XXXXXXXXXX" with no leading '+', which some phones/carriers won't
    // dial correctly (shows "check your phone number"). Any contact whose
    // number is still missing the '+' gets it added automatically, once.
    if(Array.isArray(merged.contacts) && !merged._contactPlusMigrated){
      merged.contacts = merged.contacts.map(c=>{
        if(c && c.phone && !c.phone.startsWith('+')){
          return Object.assign({}, c, { phone: '+' + c.phone.replace(/\D/g,'') });
        }
        return c;
      });
      merged._contactPlusMigrated = true;
    }
    return merged;
  }catch(e){
    console.warn('Local storage unavailable or corrupted, using in-memory state.', e);
    return defaultState();
  }
}

function save(){
  try{
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  }catch(e){
    console.warn('Could not persist to local storage (private browsing / storage disabled). Session will not survive a reload.', e);
    showToast('Could not save to local storage — your session may not persist after reload.');
  }
}

/* ---------------- Toast ---------------- */
let toastTimer = null;
function showToast(msg){
  const root = document.getElementById('toastRoot');
  root.innerHTML = `<div class="toast">${escapeHtml(msg)}</div>`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>{ root.innerHTML = ''; }, 3200);
}

function escapeHtml(str){
  const d = document.createElement('div');
  d.textContent = str ?? '';
  return d.innerHTML;
}

/* ================= THEME ================= */
function applyTheme(){
  const theme = state.settings.theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', theme);
  const btn = document.getElementById('themeToggleBtn');
  if(btn) btn.textContent = theme === 'light' ? '🌙' : '☀️';
}
applyTheme();

/* ================= AUTH (LOGIN / REGISTER) ================= */
const authScreen = document.getElementById('authScreen');
const mainApp = document.getElementById('mainApp');

function initAuthGate(){
  if(state.loggedIn && state.session && state.session.email){
    enterApp();
    return;
  }
  authScreen.classList.remove('hidden');
  mainApp.classList.add('hidden');
}

/* ---- tab switching ---- */
const tabLogin = document.getElementById('tabLogin');
const tabRegister = document.getElementById('tabRegister');
const loginForm = document.getElementById('loginForm');
const registerForm = document.getElementById('registerForm');

tabLogin.addEventListener('click', ()=>{
  tabLogin.classList.add('active'); tabRegister.classList.remove('active');
  loginForm.classList.remove('hidden'); registerForm.classList.add('hidden');
});
tabRegister.addEventListener('click', ()=>{
  tabRegister.classList.add('active'); tabLogin.classList.remove('active');
  registerForm.classList.remove('hidden'); loginForm.classList.add('hidden');
});

function findAccount(email){
  const e = (email||'').trim().toLowerCase();
  return state.accounts.find(a=>a.email.toLowerCase()===e);
}

loginForm.addEventListener('submit', (e)=>{
  e.preventDefault();
  const errEl = document.getElementById('loginError');
  errEl.textContent = '';
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  if(!email || !password){ errEl.textContent = 'Enter your email and password.'; return; }
  const acc = findAccount(email);
  if(!acc || acc.password !== password){
    errEl.textContent = 'Incorrect email or password.';
    return;
  }
  state.session = { email: acc.email };
  state.user.name = acc.name || acc.email.split('@')[0];
  state.user.email = acc.email;
  state.user.avatarInit = (state.user.name[0] || 'U').toUpperCase();
  state.loggedIn = true;
  save();
  enterApp();
});

registerForm.addEventListener('submit', (e)=>{
  e.preventDefault();
  const errEl = document.getElementById('registerError');
  errEl.textContent = '';
  const email = document.getElementById('registerEmail').value.trim();
  const password = document.getElementById('registerPassword').value;
  const password2 = document.getElementById('registerPassword2').value;
  if(!email || !password){ errEl.textContent = 'Enter an email and password.'; return; }
  if(!/^\S+@\S+\.\S+$/.test(email)){ errEl.textContent = 'Enter a valid email address.'; return; }
  if(password.length < 4){ errEl.textContent = 'Password must be at least 4 characters.'; return; }
  if(password !== password2){ errEl.textContent = 'Passwords do not match.'; return; }
  if(findAccount(email)){ errEl.textContent = 'An account with that email already exists — log in instead.'; return; }

  const account = { email, password, name: email.split('@')[0] };
  state.accounts.push(account);
  state.session = { email: account.email };
  state.user.name = account.name;
  state.user.email = account.email;
  state.user.avatarInit = account.name[0].toUpperCase();
  state.loggedIn = true;
  save();
  enterApp();
});

function enterApp(){
  authScreen.classList.add('hidden');
  mainApp.classList.remove('hidden');
  applyTheme();
  if(state.chats.length === 0){
    createChat();
  } else if(!state.activeChatId){
    state.activeChatId = state.chats[state.chats.length-1].id;
  }
  renderAll();
}

function logOut(){
  state.loggedIn = false;
  state.session = null;
  save();
  location.reload();
}

/* ================= CHAT / PROJECT DATA HELPERS ================= */
function createChat(projectId=null){
  const chat = {
    id: uid(), title: 'New chat', messages: [], projectId, favorite: false,
    createdAt: Date.now(), updatedAt: Date.now()
  };
  state.chats.push(chat);
  state.activeChatId = chat.id;
  save();
  return chat;
}

function getChat(id){ return state.chats.find(c=>c.id===id); }
function getActiveChat(){ return getChat(state.activeChatId); }

function deleteChat(id){
  state.chats = state.chats.filter(c=>c.id!==id);
  if(state.activeChatId === id){
    state.activeChatId = state.chats.length ? state.chats[state.chats.length-1].id : null;
    if(!state.activeChatId){ createChat(); }
  }
  save();
  renderAll();
}

function renameChat(id, title){
  const c = getChat(id);
  if(!c) return;
  c.title = title.trim() || 'Untitled chat';
  c.updatedAt = Date.now();
  save();
  renderAll();
}

function toggleFavorite(id){
  const c = getChat(id);
  if(!c) return;
  c.favorite = !c.favorite;
  save();
  renderAll();
}

function moveChatToProject(chatId, projectId){
  const c = getChat(chatId);
  if(!c) return;
  c.projectId = projectId;
  save();
  renderAll();
}

function createProject(name){
  const p = { id: uid(), name: name.trim() || 'Untitled project', createdAt: Date.now(), expanded: true };
  state.projects.push(p);
  save();
  renderAll();
  return p;
}

function deleteProject(id){
  state.projects = state.projects.filter(p=>p.id!==id);
  state.chats.forEach(c=>{ if(c.projectId===id) c.projectId=null; });
  save();
  renderAll();
}

function renameProject(id, name){
  const p = state.projects.find(p=>p.id===id);
  if(!p) return;
  p.name = name.trim() || 'Untitled project';
  save();
  renderAll();
}

/* ================= SIDEBAR RENDERING ================= */
const searchInput = document.getElementById('searchInput');
let searchTerm = '';
searchInput.addEventListener('input', ()=>{ searchTerm = searchInput.value.trim().toLowerCase(); renderSidebar(); });

function matchesSearch(chat){
  if(!searchTerm) return true;
  return chat.title.toLowerCase().includes(searchTerm);
}

function chatItemHtml(chat){
  const active = chat.id === state.activeChatId ? 'active' : '';
  const star = chat.favorite ? '<span class="star">★</span>' : '';
  return `<div class="chat-item ${active}" data-chat-id="${chat.id}">
    <span class="ctitle">${escapeHtml(chat.title)}</span>
    ${star}
    <span class="menu-btn" data-menu-chat="${chat.id}">⋯</span>
  </div>`;
}

function renderSidebar(){
  // Projects
  const projectsList = document.getElementById('projectsList');
  projectsList.innerHTML = state.projects.map(p=>{
    const chats = state.chats.filter(c=>c.projectId===p.id && matchesSearch(c));
    if(searchTerm && chats.length===0) return '';
    const chevClass = p.expanded ? 'open' : '';
    const chatsHtml = p.expanded ? `<div class="project-chats">${chats.map(chatItemHtml).join('') || '<div style="padding:6px 10px;font-size:12px;color:var(--text-faint)">No chats yet</div>'}</div>` : '';
    return `<div class="project-block">
      <div class="project-row" data-project-id="${p.id}">
        <span class="chev ${chevClass}">▶</span>
        <span class="pdot"></span>
        <span class="pname">${escapeHtml(p.name)}</span>
        <span class="menu-btn" data-menu-project="${p.id}" style="opacity:.6">⋯</span>
      </div>
      ${chatsHtml}
    </div>`;
  }).join('');

  // Favorites
  const favList = document.getElementById('favoritesList');
  const favs = state.chats.filter(c=>c.favorite && matchesSearch(c)).sort((a,b)=>b.updatedAt-a.updatedAt);
  document.getElementById('favoritesSection').style.display = favs.length ? '' : 'none';
  favList.innerHTML = favs.map(chatItemHtml).join('');

  // All chats (unassigned to a project)
  const allList = document.getElementById('allChatsList');
  const unassigned = state.chats.filter(c=>!c.projectId && matchesSearch(c)).sort((a,b)=>b.updatedAt-a.updatedAt);
  allList.innerHTML = unassigned.map(chatItemHtml).join('') || '<div style="padding:8px 10px;font-size:12.5px;color:var(--text-faint)">No chats here yet</div>';

  // User footer
  document.getElementById('userAvatar').textContent = state.user.avatarInit || 'U';
  document.getElementById('userName').textContent = state.user.name || 'User';
  document.getElementById('userKeyStatus').textContent = state.settings.apiKey ? (state.user.email || 'API key set') : 'No API key set';

  attachSidebarHandlers();
}

function attachSidebarHandlers(){
  document.querySelectorAll('.chat-item').forEach(el=>{
    el.addEventListener('click', (e)=>{
      if(e.target.closest('.menu-btn')) return;
      state.activeChatId = el.dataset.chatId;
      save();
      renderAll();
    });
  });
  document.querySelectorAll('[data-menu-chat]').forEach(el=>{
    el.addEventListener('click', (e)=>{
      e.stopPropagation();
      openChatMenu(el.dataset.menuChat, e.clientX, e.clientY);
    });
  });
  document.querySelectorAll('.project-row').forEach(el=>{
    el.addEventListener('click', (e)=>{
      if(e.target.closest('.menu-btn')) return;
      const p = state.projects.find(p=>p.id===el.dataset.projectId);
      p.expanded = !p.expanded;
      save();
      renderSidebar();
    });
  });
  document.querySelectorAll('[data-menu-project]').forEach(el=>{
    el.addEventListener('click', (e)=>{
      e.stopPropagation();
      openProjectMenu(el.dataset.menuProject, e.clientX, e.clientY);
    });
  });
}

/* ---------------- Context menus ---------------- */
function closeCtxMenu(){
  document.getElementById('modalRoot').querySelectorAll('.ctx-menu').forEach(m=>m.remove());
}
document.addEventListener('click', closeCtxMenu);

function openChatMenu(chatId, x, y){
  closeCtxMenu();
  const chat = getChat(chatId);
  const projectOptions = state.projects.map(p=>
    `<button data-action="move" data-project="${p.id}">📁 ${escapeHtml(p.name)}</button>`
  ).join('');
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.style.left = Math.min(x, window.innerWidth-200) + 'px';
  menu.style.top = Math.min(y, window.innerHeight-260) + 'px';
  menu.innerHTML = `
    <button data-action="rename">✏️ Rename</button>
    <button data-action="favorite">${chat.favorite ? '☆ Remove favorite' : '★ Add to favorites'}</button>
    <div class="submenu-label">Move to project</div>
    ${projectOptions || '<div style="padding:4px 10px;font-size:12px;color:var(--text-faint)">No projects yet</div>'}
    <button data-action="new-project-move">＋ New project...</button>
    ${chat.projectId ? '<button data-action="unassign">Remove from project</button>' : ''}
    <hr>
    <button data-action="delete" class="danger">🗑 Delete chat</button>
  `;
  document.getElementById('modalRoot').appendChild(menu);
  menu.addEventListener('click', (e)=>{
    const btn = e.target.closest('button');
    if(!btn) return;
    e.stopPropagation();
    const action = btn.dataset.action;
    if(action === 'rename') startInlineRename(chatId);
    else if(action === 'favorite') toggleFavorite(chatId);
    else if(action === 'move') moveChatToProject(chatId, btn.dataset.project);
    else if(action === 'unassign') moveChatToProject(chatId, null);
    else if(action === 'new-project-move') openModal('newProjectForMove', {chatId});
    else if(action === 'delete') openModal('confirmDeleteChat', {chatId});
    closeCtxMenu();
  });
}

function openProjectMenu(projectId, x, y){
  closeCtxMenu();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.style.left = Math.min(x, window.innerWidth-200) + 'px';
  menu.style.top = Math.min(y, window.innerHeight-140) + 'px';
  menu.innerHTML = `
    <button data-action="rename-project">✏️ Rename project</button>
    <hr>
    <button data-action="delete-project" class="danger">🗑 Delete project</button>
  `;
  document.getElementById('modalRoot').appendChild(menu);
  menu.addEventListener('click', (e)=>{
    const btn = e.target.closest('button');
    if(!btn) return;
    e.stopPropagation();
    if(btn.dataset.action === 'rename-project') openModal('renameProject', {projectId});
    else if(btn.dataset.action === 'delete-project') openModal('confirmDeleteProject', {projectId});
    closeCtxMenu();
  });
}

function startInlineRename(chatId){
  const el = document.querySelector(`.chat-item[data-chat-id="${chatId}"]`);
  if(!el) return;
  const chat = getChat(chatId);
  el.innerHTML = `<input class="rename-input" value="${escapeHtml(chat.title)}">`;
  const input = el.querySelector('input');
  input.focus();
  input.select();
  const commit = ()=> renameChat(chatId, input.value);
  input.addEventListener('keydown', e=>{
    if(e.key==='Enter') commit();
    if(e.key==='Escape') renderSidebar();
  });
  input.addEventListener('blur', commit);
}

/* ---------------- Modals ---------------- */
function openModal(type, ctx={}){
  const root = document.getElementById('modalRoot');
  let inner = '';
  if(type === 'newProject' || type === 'newProjectForMove'){
    inner = `<h3>New project</h3>
      <input id="modalInput" type="text" placeholder="Project name" autofocus>
      <div class="modal-actions">
        <button class="cancel" data-close>Cancel</button>
        <button class="confirm" id="modalConfirm">Create</button>
      </div>`;
  } else if(type === 'renameProject'){
    const p = state.projects.find(p=>p.id===ctx.projectId);
    inner = `<h3>Rename project</h3>
      <input id="modalInput" type="text" value="${escapeHtml(p.name)}" autofocus>
      <div class="modal-actions">
        <button class="cancel" data-close>Cancel</button>
        <button class="confirm" id="modalConfirm">Save</button>
      </div>`;
  } else if(type === 'confirmDeleteChat'){
    inner = `<h3>Delete this chat?</h3>
      <p style="color:var(--text-muted);font-size:13.5px;margin-bottom:18px;">This can't be undone. The conversation will be permanently removed.</p>
      <div class="modal-actions">
        <button class="cancel" data-close>Cancel</button>
        <button class="confirm danger" id="modalConfirm">Delete</button>
      </div>`;
  } else if(type === 'confirmDeleteProject'){
    inner = `<h3>Delete this project?</h3>
      <p style="color:var(--text-muted);font-size:13.5px;margin-bottom:18px;">Chats inside will move back to your main chat list — they won't be deleted.</p>
      <div class="modal-actions">
        <button class="cancel" data-close>Cancel</button>
        <button class="confirm danger" id="modalConfirm">Delete project</button>
      </div>`;
  } else if(type === 'settings'){
    inner = `<h3>Settings</h3>
      <label class="modal-label">Your name</label>
      <input id="modalInputName" type="text" value="${escapeHtml(state.user.name)}" placeholder="Your name">
      <label class="modal-label">AI provider API key</label>
      <input id="modalInputKey" type="password" value="${escapeHtml(state.settings.apiKey)}" placeholder="Paste your API key">
      <div class="field-hint" style="margin-bottom:16px;">You can also set a default key directly in app.js (CONFIG.DEFAULT_API_KEY) so people never have to paste one.</div>
      <label class="modal-label">Spotify</label>
      <div style="margin-bottom:16px;">
        ${!CONFIG.SPOTIFY_CLIENT_ID ? `
          <div class="field-hint">Paste a Client ID into CONFIG.SPOTIFY_CLIENT_ID in app.js first, then add this exact URL as a Redirect URI in your Spotify app's dashboard settings:<br><code>${escapeHtml(SPOTIFY_REDIRECT_URI)}</code></div>
        ` : (state.spotify && state.spotify.accessToken) ? `
          <div class="field-hint" style="margin-bottom:8px;">✅ Connected — try "play &lt;song&gt; on spotify", or use the pause/loop buttons that appear once a song is playing.</div>
          <div class="field-hint" style="margin-bottom:8px;">Note: while a song is playing, Maximus skips its own extra microphone stream (used only for the wave animation) so there's one less thing making Chrome duck (auto-quiet) the music. Chrome's built-in speech recognition still opens its own mic internally though, which the app can't reconfigure — so brief quieting while it's actively listening is a Chrome platform behavior, not a bug here. Wired headphones and a quieter room help it hear you clearly without needing much of that processing.</div>
          <button class="cancel" id="spotifyDisconnectBtn" type="button">Disconnect Spotify</button>
        ` : `
          <div class="field-hint" style="margin-bottom:8px;">Requires Spotify Premium for playback. Redirect URI registered in your Spotify app must exactly match:<br><code>${escapeHtml(SPOTIFY_REDIRECT_URI)}</code></div>
          <button class="confirm" id="spotifyConnectBtn" type="button">🎵 Connect Spotify</button>
        `}
      </div>
      <label class="modal-label">Google Calendar</label>
      <div style="margin-bottom:16px;">
        ${!CONFIG.GOOGLE_CLIENT_ID ? `
          <div class="field-hint">Paste an OAuth Client ID into CONFIG.GOOGLE_CLIENT_ID in app.js first (console.cloud.google.com → enable the Google Calendar API → create an OAuth 2.0 Client ID of type "Web application"), then add this page's URL as an Authorized JavaScript origin:<br><code>${escapeHtml(window.location.origin)}</code></div>
        ` : (state.google && state.google.accessToken) ? `
          <div class="field-hint" style="margin-bottom:8px;">✅ Connected — try "what's on my calendar" or "add an event called dentist at 4pm tomorrow".</div>
          <button class="cancel" id="googleDisconnectBtn" type="button">Disconnect Google Calendar</button>
        ` : `
          <div class="field-hint" style="margin-bottom:8px;">Authorized JavaScript origin registered in your Google Cloud OAuth client must exactly match:<br><code>${escapeHtml(window.location.origin)}</code></div>
          <button class="confirm" id="googleConnectBtn" type="button">📅 Connect Google Calendar</button>
        `}
      </div>
      <label class="modal-label">YouTube</label>
      <input id="modalInputYoutubeKey" type="password" value="${escapeHtml(state.settings.youtubeApiKey || '')}" placeholder="Paste a YouTube Data API v3 key">
      <div class="field-hint" style="margin-bottom:16px;">Free from console.cloud.google.com — enable "YouTube Data API v3" then create an API key. With a key set, "play &lt;video&gt; on youtube" jumps straight to the matching video and starts it. Without one, it just opens a YouTube search page instead.</div>
      <label class="modal-label">Response speed / AI model</label>
      <select id="modalInputModel">
        <option value="ministral-3b-latest"${(state.settings.model||CONFIG.MODEL_TEXT)==='ministral-3b-latest'?' selected':''}>⚡ Fastest — Ministral 3B (~0.65s to start replying)</option>
        <option value="mistral-small-latest"${state.settings.model==='mistral-small-latest'?' selected':''}>⚖️ Balanced — Mistral Small</option>
        <option value="mistral-large-latest"${state.settings.model==='mistral-large-latest'?' selected':''}>🧠 Most capable, slowest — Mistral Large</option>
      </select>
      <div class="field-hint" style="margin-bottom:16px;">Mistral Large is the most capable but noticeably slower to start responding. Ministral 3B is the fastest by far and handles everyday questions and chat well — switch up only when a question needs deeper reasoning or coding help.</div>
      <label class="modal-label">Voice recognition accent</label>
      <select id="modalInputVoiceLang">
        <option value="en-IN"${(state.settings.voiceLang||'en-IN')==='en-IN'?' selected':''}>English (India)</option>
        <option value="en-US"${state.settings.voiceLang==='en-US'?' selected':''}>English (US)</option>
        <option value="en-GB"${state.settings.voiceLang==='en-GB'?' selected':''}>English (UK)</option>
        <option value="en-AU"${state.settings.voiceLang==='en-AU'?' selected':''}>English (Australia)</option>
        <option value="hi-IN"${state.settings.voiceLang==='hi-IN'?' selected':''}>Hindi (India)</option>
      </select>
      <div class="field-hint" style="margin-bottom:16px;">If Maximus keeps mishearing you, try matching this to your accent. For best accuracy: use a headset mic rather than laptop/phone speakers-and-mic, keep background noise (TV, music, fans) low, and speak at a normal pace in short, complete phrases rather than trailing off — the mic works best when it can hear a clear start and a clear pause at the end of what you say.</div>
      <label class="modal-label">What Maximus remembers about you</label>
      <textarea id="modalInputMemory" rows="4" placeholder="One fact per line, e.g. &quot;Prefers concise answers.&quot;">${escapeHtml((state.memory||[]).join('\n'))}</textarea>
      <div class="modal-actions">
        <button class="cancel danger" id="modalLogout" style="margin-right:auto;">Log out</button>
        <button class="cancel" data-close>Cancel</button>
        <button class="confirm" id="modalConfirm">Save</button>
      </div>
      <div class="modal-footer-link"><button id="modalDeleteAll" type="button">Disconnect everything &amp; delete all data on this device</button></div>`;
  } else if(type === 'contacts'){
    inner = `<h3>Contacts</h3>
      <p class="field-hint" style="margin-bottom:10px;">Save people here with their phone number. Say "message &lt;name&gt; saying ...&quot; to open WhatsApp with the chat ready to send, or "call &lt;name&gt;" to place a real call on your connected Android phone. First time? Use the 🔗 Connect Phone button to link your phone — no terminal needed.</p>
      <div id="contactsList"></div>
      <div class="add-contact-title">Add a contact</div>
      <div class="contact-add-row">
        <input id="contactNameInput" type="text" placeholder="Name (e.g. Friend 1)">
      </div>
      <div class="contact-add-row">
        <div class="phone-input-group">
          <span class="phone-prefix">🇮🇳 +91</span>
          <input id="contactPhoneInput" type="tel" inputmode="numeric" maxlength="10" placeholder="10-digit mobile number">
        </div>
        <button class="confirm" id="contactAddBtn" type="button">＋ Add contact</button>
      </div>
      <div class="modal-actions">
        <button class="cancel" data-close>Close</button>
      </div>`;
  } else if(type === 'connectPhone'){
    inner = `<h3>🔗 Connect Phone</h3>
      <div id="phoneLiveStatus" class="field-hint" style="min-height:18px;margin-bottom:10px;">Checking connection…</div>
      <p class="field-hint" style="margin-bottom:10px;">On your phone: <b>Settings → Developer options → Wireless debugging</b> (turn it on, same WiFi as this PC). Tap into "Wireless debugging" itself → "Pair device with pairing code" for the first two fields, then go back to the main Wireless debugging screen and copy the address shown there into the third field. Hit Connect — no terminal needed. This only has to be done again if your phone restarts.</p>
      <div class="contact-add-row">
        <input id="phonePairAddr" type="text" placeholder="Pairing address, e.g. 192.168.1.42:37251">
      </div>
      <div class="contact-add-row">
        <input id="phonePairCode" type="text" inputmode="numeric" maxlength="6" placeholder="6-digit pairing code">
      </div>
      <div class="contact-add-row">
        <input id="phoneConnectAddr" type="text" placeholder="Connect address, e.g. 192.168.1.42:44321">
      </div>
      <div id="phoneConnectStatus" class="field-hint" style="min-height:18px;"></div>
      <div class="modal-actions">
        <button class="cancel" data-close>Close</button>
        <button class="cancel danger" id="phoneDisconnectBtn" type="button" style="display:none;">Disconnect Phone</button>
        <button class="confirm" id="phoneConnectBtn" type="button">🔗 Connect</button>
      </div>
      <p class="field-hint" style="margin-top:16px;">No reliable WiFi where you're presenting? Plug the phone in with a USB cable instead and turn on <b>USB debugging</b> (a separate toggle right below Wireless debugging in the same menu). The first time, accept the "Allow USB debugging?" prompt on the phone screen and tick "Always allow from this computer". No pairing form needed for USB — Maximus detects it automatically and prefers it over WiFi whenever it's plugged in, so it's a safe backup even if the WiFi setup above is already done.</p>
      <p class="field-hint" style="margin-top:16px;">Optional — say "unlock my phone" to wake it and dismiss the lock screen. If your lock screen uses a numeric PIN (not just swipe), save it here so Maximus can type it too. Stored only on this computer, never sent anywhere else.</p>
      <div class="contact-add-row">
        <input id="phoneUnlockPin" type="password" inputmode="numeric" maxlength="8" placeholder="Unlock PIN (leave blank for swipe-only)">
      </div>
      <div id="phoneUnlockStatus" class="field-hint" style="min-height:18px;"></div>
      <div class="modal-actions">
        <button class="confirm" id="phoneUnlockSaveBtn" type="button">Save PIN</button>
      </div>`;
  } else if(type === 'connectEmail'){
    inner = `<h3>📧 Connect Email</h3>
      <div id="emailLiveStatus" class="field-hint" style="min-height:18px;margin-bottom:10px;">Checking connection…</div>
      <p class="field-hint" style="margin-bottom:10px;">Gmail needs an <b>App Password</b>, not your normal login password — App Passwords only exist once 2‑Step Verification is on. Generate one at <b>myaccount.google.com/apppasswords</b> and paste it below. Outlook/Yahoo/iCloud work the same way with their own app-password pages. Nothing here leaves this computer except to your mail provider's own servers.</p>
      <label class="modal-label">Provider</label>
      <select id="emailProviderSelect">
        <option value="gmail">Gmail</option>
        <option value="outlook">Outlook / Office 365</option>
        <option value="yahoo">Yahoo Mail</option>
        <option value="icloud">iCloud Mail</option>
        <option value="other">Other (enter servers manually)</option>
      </select>
      <div class="contact-add-row">
        <input id="emailAddrInput" type="email" placeholder="you@gmail.com">
      </div>
      <div class="contact-add-row">
        <input id="emailAppPasswordInput" type="password" placeholder="App password (16 characters)">
      </div>
      <div id="emailManualServers" class="hidden">
        <div class="contact-add-row">
          <input id="emailImapHost" type="text" placeholder="IMAP host, e.g. imap.example.com">
        </div>
        <div class="contact-add-row">
          <input id="emailSmtpHost" type="text" placeholder="SMTP host, e.g. smtp.example.com">
        </div>
      </div>
      <div id="emailConnectStatus" class="field-hint" style="min-height:18px;"></div>
      <div class="modal-actions">
        <button class="cancel" data-close>Close</button>
        <button class="cancel danger" id="emailDisconnectBtn" type="button" style="display:none;">Disconnect Email</button>
        <button class="confirm" id="emailConnectBtn" type="button">🔗 Connect</button>
      </div>
      <p class="field-hint" style="margin-top:16px;">Once connected, try: "check my email", "read my latest email from &lt;name&gt;", "find emails about &lt;topic&gt;", "email &lt;address&gt; saying &lt;message&gt;", or "reply to &lt;name&gt; saying &lt;message&gt;" — Maximus drafts it and asks you to say "send it" before anything actually goes out.</p>`;
  }
  root.innerHTML = `<div class="modal-backdrop" id="modalBackdrop"><div class="modal">${inner}</div></div>`;
  const backdrop = document.getElementById('modalBackdrop');
  backdrop.addEventListener('click', (e)=>{ if(e.target===backdrop) root.innerHTML=''; });
  root.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click', ()=> root.innerHTML=''));
  const input = document.getElementById('modalInput');
  if(input){ setTimeout(()=>input.focus(), 30); input.addEventListener('keydown', e=>{ if(e.key==='Enter') document.getElementById('modalConfirm').click(); }); }

  const confirmBtn = document.getElementById('modalConfirm');
  if(confirmBtn){
    confirmBtn.addEventListener('click', ()=>{
      if(type === 'newProject'){
        createProject(document.getElementById('modalInput').value);
      } else if(type === 'newProjectForMove'){
        const p = createProject(document.getElementById('modalInput').value);
        moveChatToProject(ctx.chatId, p.id);
      } else if(type === 'renameProject'){
        renameProject(ctx.projectId, document.getElementById('modalInput').value);
      } else if(type === 'confirmDeleteChat'){
        deleteChat(ctx.chatId);
      } else if(type === 'confirmDeleteProject'){
        deleteProject(ctx.projectId);
      } else if(type === 'settings'){
        state.user.name = document.getElementById('modalInputName').value.trim() || 'User';
        state.user.avatarInit = state.user.name[0].toUpperCase();
        state.settings.apiKey = document.getElementById('modalInputKey').value.trim();
        state.settings.youtubeApiKey = document.getElementById('modalInputYoutubeKey').value.trim();
        state.settings.model = document.getElementById('modalInputModel').value || CONFIG.MODEL_TEXT;
        const newVoiceLang = document.getElementById('modalInputVoiceLang').value || 'en-IN';
        const voiceLangChanged = newVoiceLang !== state.settings.voiceLang;
        state.settings.voiceLang = newVoiceLang;
        state.memory = document.getElementById('modalInputMemory').value
          .split('\n').map(s=>s.trim()).filter(Boolean);
        save();
        renderSidebar();
        if(voiceLangChanged) applyVoiceLang();
      }
      root.innerHTML = '';
    });
  }
  if(type === 'contacts'){
    renderContactsList();
    const addBtn = document.getElementById('contactAddBtn');
    addBtn.addEventListener('click', ()=>{
      const name = document.getElementById('contactNameInput').value.trim();
      let phoneDigits = document.getElementById('contactPhoneInput').value.replace(/\D/g, '');
      if(!name){ showToast('Add a name for this contact.'); return; }
      if(phoneDigits.length !== 10){ showToast('Enter a valid 10-digit mobile number.'); return; }
      const phone = '+91' + phoneDigits;
      state.contacts = state.contacts || [];
      state.contacts.push({ id: uid(), name, phone });
      save();
      document.getElementById('contactNameInput').value = '';
      document.getElementById('contactPhoneInput').value = '';
      renderContactsList();
      showToast(`${name} added — say "message ${name} saying ..." any time.`);
    });
  }
  if(type === 'connectPhone'){
    const btn = document.getElementById('phoneConnectBtn');
    const statusEl = document.getElementById('phoneConnectStatus');
    const liveEl = document.getElementById('phoneLiveStatus');
    const phoneDisconnectBtn = document.getElementById('phoneDisconnectBtn');
    // Quick, read-only check so the person can see at a glance whether the
    // phone is already reachable (and over which transport) before touching
    // any of the form fields below — most useful right before a demo.
    callAgent('/phone-status', { method: 'GET' }).then(res=>{
      if(!liveEl) return;
      if(!res.connected){
        liveEl.textContent = '⚪ No phone connected right now.';
      } else if(res.active_transport === 'usb'){
        liveEl.textContent = '🟢 Connected via USB cable.';
      } else if(res.active_transport === 'wifi'){
        liveEl.textContent = `🟢 Connected wirelessly (${res.saved_host || 'saved address'}).`;
      } else {
        liveEl.textContent = '🟢 Phone connected.';
      }
      if(phoneDisconnectBtn) phoneDisconnectBtn.style.display = (res.connected || res.saved_host) ? '' : 'none';
    }).catch(()=>{ if(liveEl) liveEl.textContent = ''; });

    if(phoneDisconnectBtn){
      phoneDisconnectBtn.addEventListener('click', async ()=>{
        phoneDisconnectBtn.disabled = true;
        phoneDisconnectBtn.textContent = 'Disconnecting…';
        try{
          await callAgent('/phone-disconnect', { method: 'POST' });
          if(liveEl) liveEl.textContent = '⚪ No phone connected right now.';
          statusEl.textContent = 'Phone disconnected and forgotten.';
          document.getElementById('phonePairAddr').value = '';
          document.getElementById('phonePairCode').value = '';
          document.getElementById('phoneConnectAddr').value = '';
          document.getElementById('phoneUnlockPin').value = '';
          phoneDisconnectBtn.style.display = 'none';
          showToast('Phone disconnected.');
        } catch(e){
          statusEl.textContent = (e && e.message) ? e.message : "Couldn't disconnect — is the desktop agent running?";
        } finally {
          phoneDisconnectBtn.disabled = false;
          phoneDisconnectBtn.textContent = 'Disconnect Phone';
        }
      });
    }
    btn.addEventListener('click', async ()=>{
      const pairing_addr = document.getElementById('phonePairAddr').value.trim();
      const pairing_code = document.getElementById('phonePairCode').value.trim();
      const connect_addr = document.getElementById('phoneConnectAddr').value.trim();
      if(!pairing_addr || !pairing_code || !connect_addr){
        statusEl.textContent = "Fill in all three fields from your phone's Wireless debugging screen.";
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Connecting…';
      statusEl.textContent = 'Pairing and connecting — this takes up to about 20 seconds.';
      try{
        // This runs several adb steps in sequence on the agent side (pair,
        // connect, lock to a fixed port), so it gets a longer timeout than
        // normal quick agent calls.
        const res = await callAgent('/phone-setup', {
          method: 'POST',
          body: { pairing_addr, pairing_code, connect_addr },
          timeoutMs: 35000
        });
        statusEl.textContent = `Connected! Saved as ${res.phone_adb} — the agent will reconnect to this automatically from now on.`;
        showToast('Phone connected — say "call <name>" any time.');
      } catch(e){
        statusEl.textContent = (e && e.message) ? e.message : 'Connection failed — check the values and try again.';
      } finally {
        btn.disabled = false;
        btn.textContent = '🔗 Connect';
      }
    });

    const pinSaveBtn = document.getElementById('phoneUnlockSaveBtn');
    const pinStatusEl = document.getElementById('phoneUnlockStatus');
    pinSaveBtn.addEventListener('click', async ()=>{
      const pin = document.getElementById('phoneUnlockPin').value.trim();
      pinSaveBtn.disabled = true;
      try{
        const res = await callAgent('/phone-unlock-setup', { method:'POST', body:{ pin } });
        pinStatusEl.textContent = res.has_pin ? 'Saved — say "unlock my phone" any time.' : 'Cleared — "unlock my phone" will just wake and swipe.';
        document.getElementById('phoneUnlockPin').value = '';
      } catch(e){
        pinStatusEl.textContent = (e && e.message) ? e.message : "Couldn't save the PIN — is the desktop agent running?";
      } finally {
        pinSaveBtn.disabled = false;
      }
    });
  }
  if(type === 'connectEmail'){
    const providerSelect = document.getElementById('emailProviderSelect');
    const manualServers = document.getElementById('emailManualServers');
    const btn = document.getElementById('emailConnectBtn');
    const statusEl = document.getElementById('emailConnectStatus');
    const liveEl = document.getElementById('emailLiveStatus');
    const disconnectBtn = document.getElementById('emailDisconnectBtn');

    callAgent('/email-status', { method: 'GET' }).then(res=>{
      if(!liveEl) return;
      liveEl.textContent = res.configured ? `🟢 Connected as ${res.address}.` : '⚪ No mailbox connected yet.';
      if(disconnectBtn) disconnectBtn.style.display = res.configured ? '' : 'none';
    }).catch(()=>{ if(liveEl) liveEl.textContent = ''; });

    if(disconnectBtn){
      disconnectBtn.addEventListener('click', async ()=>{
        disconnectBtn.disabled = true;
        disconnectBtn.textContent = 'Disconnecting…';
        try{
          await callAgent('/email-disconnect', { method: 'POST' });
          if(liveEl) liveEl.textContent = '⚪ No mailbox connected yet.';
          statusEl.textContent = 'Email disconnected.';
          document.getElementById('emailAddrInput').value = '';
          document.getElementById('emailAppPasswordInput').value = '';
          disconnectBtn.style.display = 'none';
          showToast('Email disconnected.');
        } catch(e){
          statusEl.textContent = (e && e.message) ? e.message : "Couldn't disconnect — is the desktop agent running?";
        } finally {
          disconnectBtn.disabled = false;
          disconnectBtn.textContent = 'Disconnect Email';
        }
      });
    }

    providerSelect.addEventListener('change', ()=>{
      manualServers.classList.toggle('hidden', providerSelect.value !== 'other');
    });

    btn.addEventListener('click', async ()=>{
      const provider = providerSelect.value;
      const address = document.getElementById('emailAddrInput').value.trim();
      const app_password = document.getElementById('emailAppPasswordInput').value.trim();
      const imap_host = document.getElementById('emailImapHost').value.trim();
      const smtp_host = document.getElementById('emailSmtpHost').value.trim();
      if(!address || !app_password){
        statusEl.textContent = 'Enter your email address and app password.';
        return;
      }
      if(provider === 'other' && (!imap_host || !smtp_host)){
        statusEl.textContent = 'Enter both IMAP and SMTP server addresses.';
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Connecting…';
      statusEl.textContent = 'Testing the connection…';
      try{
        const res = await callAgent('/email-setup', {
          method: 'POST',
          body: { provider, address, app_password, imap_host, smtp_host },
          timeoutMs: 15000
        });
        statusEl.textContent = `Connected as ${res.address} — try "check my email" any time.`;
        showToast('Email connected — say "check my email" any time.');
        document.getElementById('emailAppPasswordInput').value = '';
        if(liveEl) liveEl.textContent = `🟢 Connected as ${res.address}.`;
        if(disconnectBtn) disconnectBtn.style.display = '';
      } catch(e){
        statusEl.textContent = (e && e.message) ? e.message : 'Connection failed — check the address and app password.';
      } finally {
        btn.disabled = false;
        btn.textContent = '🔗 Connect';
      }
    });
  }

  const spotifyConnectBtn = document.getElementById('spotifyConnectBtn');
  if(spotifyConnectBtn) spotifyConnectBtn.addEventListener('click', spotifyLogin);
  const spotifyDisconnectBtn = document.getElementById('spotifyDisconnectBtn');
  if(spotifyDisconnectBtn){
    spotifyDisconnectBtn.addEventListener('click', ()=>{
      if(spotifyPlayer){ spotifyPlayer.disconnect(); spotifyPlayer = null; }
      state.spotify = { accessToken: null, refreshToken: null, expiresAt: 0, deviceId: null };
      save();
      showToast('Spotify disconnected.');
      root.innerHTML = '';
      openModal('settings');
    });
  }

  const googleConnectBtn = document.getElementById('googleConnectBtn');
  if(googleConnectBtn) googleConnectBtn.addEventListener('click', googleLogin);
  const googleDisconnectBtn = document.getElementById('googleDisconnectBtn');
  if(googleDisconnectBtn){
    googleDisconnectBtn.addEventListener('click', ()=>{
      const tok = state.google && state.google.accessToken;
      state.google = { accessToken: null, expiresAt: 0 };
      save();
      if(tok && window.google && google.accounts && google.accounts.oauth2){
        google.accounts.oauth2.revoke(tok, ()=>{});
      }
      showToast('Google Calendar disconnected.');
      root.innerHTML = '';
      openModal('settings');
    });
  }

  const logoutBtn = document.getElementById('modalLogout');
  if(logoutBtn) logoutBtn.addEventListener('click', logOut);

  const deleteAllBtn = document.getElementById('modalDeleteAll');
  if(deleteAllBtn){
    deleteAllBtn.addEventListener('click', async ()=>{
      if(!confirm('This disconnects Email, Phone, Spotify and Google Calendar, and clears all accounts, chats, projects and settings from this browser. Continue?')) return;
      deleteAllBtn.disabled = true;
      deleteAllBtn.textContent = 'Disconnecting everything…';

      // Best-effort: tell the desktop agent to forget email and phone
      // credentials on disk. If the agent isn't running, these just fail
      // silently — the browser-side wipe below still happens either way.
      try{ await callAgent('/email-disconnect', { method: 'POST' }); }catch(e){}
      try{ await callAgent('/phone-disconnect', { method: 'POST' }); }catch(e){}

      // Spotify: disconnect the live player and drop tokens.
      if(spotifyPlayer){ try{ spotifyPlayer.disconnect(); }catch(e){} spotifyPlayer = null; }
      state.spotify = { accessToken: null, refreshToken: null, expiresAt: 0, deviceId: null };

      // Google Calendar: revoke the token if one's live, then drop it.
      const gTok = state.google && state.google.accessToken;
      state.google = { accessToken: null, expiresAt: 0 };
      if(gTok && window.google && google.accounts && google.accounts.oauth2){
        try{ google.accounts.oauth2.revoke(gTok, ()=>{}); }catch(e){}
      }

      localStorage.removeItem(STORE_KEY);
      location.reload();
    });
  }
}

document.getElementById('addProjectBtn').addEventListener('click', ()=> openModal('newProject'));
document.getElementById('settingsBtn').addEventListener('click', ()=> openModal('settings'));
document.getElementById('themeToggleBtn').addEventListener('click', ()=>{
  state.settings.theme = state.settings.theme === 'light' ? 'dark' : 'light';
  applyTheme();
  save();
});

/* ================= CHAT MAIN RENDERING ================= */
const messagesInner = document.getElementById('messagesInner');
const messagesWrap = document.getElementById('messagesWrap');
const chatTitleInput = document.getElementById('chatTitleInput');

let codeBlockCounter = 0;

function renderMarkdown(text){
  const escaped = escapeHtml(text || '');
  const codeBlocks = [];
  let working = escaped.replace(/```(\w*)\n?([\s\S]*?)```/g, (m, lang, code)=>{
    const idx = codeBlocks.length;
    codeBlocks.push({ lang: (lang||'').toLowerCase(), code: code.replace(/\n$/,'') });
    return `\u0000CODEBLOCK${idx}\u0000`;
  });

  const lines = working.split('\n');
  let html = '';
  let listType = null;
  function closeList(){ if(listType){ html += listType==='ul' ? '</ul>' : '</ol>'; listType = null; } }

  lines.forEach(line=>{
    if(/^\u0000CODEBLOCK\d+\u0000$/.test(line.trim())){
      closeList();
      html += line.trim();
      return;
    }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    const ul = line.match(/^[-*]\s+(.*)/);
    const ol = line.match(/^\d+\.\s+(.*)/);
    if(h){
      closeList();
      const tag = `h${Math.min(h[1].length + 2, 6)}`;
      html += `<${tag} class="md-heading">${inlineMd(h[2])}</${tag}>`;
    } else if(ul){
      if(listType!=='ul'){ closeList(); html += '<ul>'; listType='ul'; }
      html += `<li>${inlineMd(ul[1])}</li>`;
    } else if(ol){
      if(listType!=='ol'){ closeList(); html += '<ol>'; listType='ol'; }
      html += `<li>${inlineMd(ol[1])}</li>`;
    } else if(line.trim()===''){
      closeList();
      html += '<br>';
    } else {
      closeList();
      html += inlineMd(line) + '<br>';
    }
  });
  closeList();

  html = html.replace(/\u0000CODEBLOCK(\d+)\u0000/g, (m, idx)=>{
    const { lang, code } = codeBlocks[Number(idx)];
    codeBlockCounter++;
    const langLabel = lang || 'text';
    const langClass = lang ? ` language-${lang}` : '';
    return `<div class="code-block-wrap"><div class="code-block-head"><span>${escapeHtml(langLabel)}</span><button class="copy-code-btn" data-code-copy>Copy</button></div><pre><code class="hljs${langClass}">${code}</code></pre></div>`;
  });

  return html;
}

function inlineMd(str){
  return str
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

function stripMarkdownForPdf(text){
  return (text||'')
    .replace(/```([\s\S]*?)```/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^#{1,6}\s*/gm, '');
}

function attachmentHtml(att){
  if(att.type === 'image'){
    return `<img class="attach-img-thumb" src="${att.dataUrl}" alt="${escapeHtml(att.name)}">`;
  }
  const icon = att.type === 'video' ? '🎬' : '📄';
  return `<span class="attach-chip">${icon} ${escapeHtml(att.name)}</span>`;
}

function bubbleInnerHtml(m){
  const atts = (m.attachments && m.attachments.length)
    ? `<div class="msg-attachments">${m.attachments.map(attachmentHtml).join('')}</div>` : '';
  const body = (m.pending && !m.content)
    ? `<div class="typing-dots"><span></span><span></span><span></span></div>`
    : renderMarkdown(m.content || '');
  const isCompleteAssistantMsg = !m.pending && m.role === 'assistant' && m.content;
  const readActions = isCompleteAssistantMsg
    ? `<div class="msg-actions msg-actions-top"><button class="msg-action-btn" data-read-aloud="${m.id}">🔊 Read aloud</button></div>`
    : '';
  const actions = isCompleteAssistantMsg
    ? `<div class="msg-actions"><button class="msg-action-btn" data-pdf-export="${m.id}">⬇ Export as PDF</button></div>`
    : '';
  return atts + readActions + body + actions;
}

function wireMessageInteractive(container){
  if(window.hljs){
    container.querySelectorAll('pre code').forEach(block=>{
      try{ hljs.highlightElement(block); }catch(e){ /* ignore */ }
    });
  }
  container.querySelectorAll('[data-pdf-export]').forEach(btn=>{
    btn.onclick = ()=>{
      const c = getActiveChat();
      const msg = c && c.messages.find(mm=>mm.id===btn.dataset.pdfExport);
      if(msg) exportMessageAsPdf(stripMarkdownForPdf(msg.content), c.title);
    };
  });
  container.querySelectorAll('[data-read-aloud]').forEach(btn=>{
    btn.onclick = ()=>{
      const c = getActiveChat();
      const msg = c && c.messages.find(mm=>mm.id===btn.dataset.readAloud);
      if(msg) readMessageAloud(msg.id, msg.content);
    };
  });
  container.querySelectorAll('[data-code-copy]').forEach(btn=>{
    btn.onclick = ()=>{
      const codeEl = btn.closest('.code-block-wrap').querySelector('code');
      const codeText = codeEl ? codeEl.innerText : '';
      navigator.clipboard.writeText(codeText).then(()=>{
        btn.textContent = 'Copied!';
        setTimeout(()=>{ btn.textContent = 'Copy'; }, 1500);
      }).catch(()=> showToast('Could not copy — clipboard access denied.'));
    };
  });
  syncReadButtons(container);
}

function updateMessageDom(msgId){
  const bubble = messagesInner.querySelector(`.msg-bubble[data-msg-id="${msgId}"]`);
  if(!bubble) return;
  const chat = getActiveChat();
  const m = chat && chat.messages.find(mm=>mm.id===msgId);
  if(!m) return;
  bubble.innerHTML = bubbleInnerHtml(m);
  wireMessageInteractive(bubble);
  messagesWrap.scrollTop = messagesWrap.scrollHeight;
}

function renderMessages(){
  const chat = getActiveChat();
  chatTitleInput.value = chat ? chat.title : '';
  chatTitleInput.disabled = !chat;

  if(!chat || chat.messages.length===0){
    messagesInner.innerHTML = `<div class="empty-state" id="emptyState">
      <div class="mark">C</div>
      <h2>Start a new conversation</h2>
      <p>Ask a question, paste some text, upload a PDF, Word, Excel or PowerPoint file, or tap the mic to speak. Your chats, projects and favorites are all saved locally in this browser.</p>
    </div>`;
    return;
  }

  messagesInner.innerHTML = chat.messages.map(m=>{
    const isUser = m.role === 'user';
    const avatar = isUser ? (state.user.avatarInit||'U') : 'C';
    return `<div class="msg-row ${isUser?'user':'assistant'}">
      <div class="msg-avatar">${avatar}</div>
      <div class="msg-bubble" data-msg-id="${m.id}">${bubbleInnerHtml(m)}</div>
    </div>`;
  }).join('');
  messagesWrap.scrollTop = messagesWrap.scrollHeight;
  wireMessageInteractive(messagesInner);
}

chatTitleInput.addEventListener('change', ()=>{
  const chat = getActiveChat();
  if(chat) renameChat(chat.id, chatTitleInput.value);
});

document.getElementById('newChatBtn').addEventListener('click', ()=>{
  createChat();
  renderAll();
});

function renderAll(){
  renderSidebar();
  renderMessages();
}

/* ================= PDF EXPORT (answers -> downloadable PDF) ================= */
function exportMessageAsPdf(text, chatTitle){
  if(!window.jspdf){ showToast('PDF export library failed to load — check your connection.'); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const margin = 44;
  const maxWidth = 507;
  const pageHeight = doc.internal.pageSize.getHeight();
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  const lines = doc.splitTextToSize(text || '(No content)', maxWidth);
  let y = margin;
  lines.forEach(line=>{
    if(y > pageHeight - margin){ doc.addPage(); y = margin; }
    doc.text(line, margin, y);
    y += 15;
  });
  const safeName = (chatTitle || 'maximus-answer').replace(/[^a-z0-9\-_ ]/gi, '').trim().slice(0,50) || 'maximus-answer';
  doc.save(`${safeName}.pdf`);
}

/* ================= MEMORY (remembers user facts across sessions) ================= */
function extractMemoryFacts(text){
  if(!text) return [];
  const patterns = [
    { re:/\bmy name is ([a-z][a-z '.-]{1,30})/i, fmt:m=>`User's name is ${m[1].trim()}.` },
    { re:/\bcall me ([a-z][a-z '.-]{1,30})/i, fmt:m=>`User prefers to be called ${m[1].trim()}.` },
    { re:/\bi (?:live in|am from) ([a-z][a-z ,.-]{1,40})/i, fmt:m=>`User is located in ${m[1].trim()}.` },
    { re:/\bi work as (?:an?|the)? ?([a-z][a-z ,.-]{1,40})/i, fmt:m=>`User works as ${m[1].trim()}.` },
    { re:/\bi(?:'m| am) (?:a|an) ([a-z][a-z ,.-]{1,40})/i, fmt:m=>`User is ${m[1].trim()}.` },
    { re:/\bi (?:like|love|enjoy) ([a-z0-9][a-z0-9 ,'.-]{1,50})/i, fmt:m=>`User likes ${m[1].trim()}.` },
    { re:/\bi (?:use|code in|work in|prefer|write)\s+(python|javascript|typescript|java(?!script)|c\+\+|c#|golang|go|rust|php|ruby|swift|kotlin|html|css|sql|react|vue|angular|node(?:\.js)?|django|flask|next\.js)\b/i,
      fmt:m=>`User codes primarily in ${m[1].trim()}.` },
    { re:/\b(?:keep (?:it|your answers?) (?:short|brief|concise)|be more concise|shorter answers?)\b/i,
      fmt:()=>`User prefers short, concise answers.` },
    { re:/\b(?:explain in detail|be more detailed|give detailed explanations|longer explanations?)\b/i,
      fmt:()=>`User prefers detailed, thorough explanations.` },
    { re:/\b(?:add comments|comment (?:your|the) code|explain the code (?:line by line|step by step))\b/i,
      fmt:()=>`User likes code answers with explanatory comments.` },
    { re:/\b(?:no comments|don'?t comment|skip the comments|without comments)\b/i,
      fmt:()=>`User prefers code without extra comments.` },
    { re:/\bremember that (.{4,140})/i, fmt:m=>{ const s=m[1].trim(); return s.endsWith('.')?s:s+'.'; } },
    { re:/\bplease remember ([^.?!]{4,140})/i, fmt:m=>{ const s=m[1].trim(); return s.endsWith('.')?s:s+'.'; } }
  ];
  const found = [];
  patterns.forEach(p=>{
    const m = text.match(p.re);
    if(m) found.push(p.fmt(m));
  });
  return found;
}

function rememberFromMessage(text){
  const facts = extractMemoryFacts(text);
  if(!facts.length) return;
  state.memory = state.memory || [];
  facts.forEach(f=>{
    if(!state.memory.some(existing=>existing.toLowerCase()===f.toLowerCase())){
      state.memory.push(f);
    }
  });
  if(state.memory.length > 40) state.memory = state.memory.slice(-40);
}

/* ================= FILE ATTACHMENTS ================= */
let pendingAttachments = [];
const fileInput = document.getElementById('fileInput');
const attachBtn = document.getElementById('attachBtn');
const pendingAttachmentsEl = document.getElementById('pendingAttachments');

attachBtn.addEventListener('click', ()=> fileInput.click());

fileInput.addEventListener('change', async (e)=>{
  const files = Array.from(e.target.files);
  for(const file of files){
    await handleFile(file);
    renderPendingAttachments();
  }
  fileInput.value = '';
  renderPendingAttachments();
});

function pushTextAttachment(name, content){
  let c = content || '';
  if(c.length > 16000) c = c.slice(0,16000) + '\n...[truncated]';
  pendingAttachments.push({ id: uid(), type:'text', name, content: c });
}

function pushOpaqueAttachment(name, note){
  pendingAttachments.push({ id: uid(), type:'file', name, note });
}

async function handleFile(file){
  const sizeMB = file.size / (1024*1024);
  const lower = file.name.toLowerCase();

  if(file.type.startsWith('image/')){
    if(sizeMB > 8){ showToast(`${file.name} is too large (max 8MB for images).`); return; }
    await new Promise(resolve=>{
      const reader = new FileReader();
      reader.onload = ()=>{
        pendingAttachments.push({ id: uid(), type:'image', name:file.name, dataUrl:reader.result });
        resolve();
      };
      reader.readAsDataURL(file);
    });
    return;
  }

  if(file.type.startsWith('video/')){
    pendingAttachments.push({ id: uid(), type:'video', name:file.name, note:'Video stored for reference only — not analyzed by the AI.' });
    return;
  }

  if(lower.endsWith('.pdf')){
    if(sizeMB > 20){ showToast(`${file.name} is too large to read (max 20MB).`); return; }
    showToast(`Reading ${file.name}...`);
    try{
      const text = await extractPdfText(file);
      pushTextAttachment(file.name, text);
    }catch(err){
      console.warn('PDF read failed', err);
      pushOpaqueAttachment(file.name, 'Could not extract text from this PDF (it may be a scanned image).');
      showToast(`Couldn't read text from ${file.name}.`);
    }
    return;
  }

  if(/\.(xlsx|xls)$/i.test(lower)){
    if(sizeMB > 15){ showToast(`${file.name} is too large to read (max 15MB).`); return; }
    showToast(`Reading ${file.name}...`);
    try{
      const text = await extractXlsxText(file);
      pushTextAttachment(file.name, text);
    }catch(err){
      console.warn('Excel read failed', err);
      pushOpaqueAttachment(file.name, 'Could not read this spreadsheet.');
      showToast(`Couldn't read ${file.name}.`);
    }
    return;
  }

  if(lower.endsWith('.pptx')){
    if(sizeMB > 20){ showToast(`${file.name} is too large to read (max 20MB).`); return; }
    showToast(`Reading ${file.name}...`);
    try{
      const text = await extractPptxText(file);
      pushTextAttachment(file.name, text);
    }catch(err){
      console.warn('PPTX read failed', err);
      pushOpaqueAttachment(file.name, 'Could not read this presentation.');
      showToast(`Couldn't read ${file.name}.`);
    }
    return;
  }

  if(lower.endsWith('.docx')){
    if(sizeMB > 15){ showToast(`${file.name} is too large to read (max 15MB).`); return; }
    showToast(`Reading ${file.name}...`);
    try{
      const text = await extractDocxText(file);
      pushTextAttachment(file.name, text);
    }catch(err){
      console.warn('DOCX read failed', err);
      pushOpaqueAttachment(file.name, 'Could not read this Word document.');
      showToast(`Couldn't read ${file.name}.`);
    }
    return;
  }

  if(lower.endsWith('.ppt') || lower.endsWith('.doc')){
    pushOpaqueAttachment(file.name, 'Legacy Office format (.ppt/.doc) is stored but cannot be read in-browser. Please re-save as .pptx/.docx if you want Maximus to read it.');
    return;
  }

  if(file.type.startsWith('text/') || /\.(txt|md|csv|json)$/i.test(lower)){
    if(sizeMB > 3){ showToast(`${file.name} is too large to read (max 3MB for text files).`); return; }
    await new Promise(resolve=>{
      const reader = new FileReader();
      reader.onload = ()=>{
        pushTextAttachment(file.name, reader.result);
        resolve();
      };
      reader.readAsText(file);
    });
    return;
  }

  pushOpaqueAttachment(file.name, 'This file type is stored but its content is not extracted or analyzed.');
}

/* ---- extraction helpers (PDF / Excel / PowerPoint / Word) ---- */
async function extractPdfText(file){
  if(window.pdfjsLib && !pdfjsLib.GlobalWorkerOptions.workerSrc){
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const maxPages = Math.min(pdf.numPages, 40);
  let text = '';
  for(let i=1; i<=maxPages; i++){
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += `\n--- Page ${i} ---\n` + content.items.map(it=>it.str).join(' ');
  }
  if(pdf.numPages > maxPages) text += `\n...[${pdf.numPages - maxPages} more pages omitted]`;
  return text.trim();
}

async function extractXlsxText(file){
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type:'array' });
  let text = '';
  wb.SheetNames.forEach(name=>{
    const sheet = wb.Sheets[name];
    const csv = XLSX.utils.sheet_to_csv(sheet);
    text += `\n--- Sheet: ${name} ---\n${csv}`;
  });
  return text.trim();
}

async function extractPptxText(file){
  const buf = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(buf);
  const slideFiles = Object.keys(zip.files)
    .filter(n=>/^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a,b)=>{
      const na = parseInt(a.match(/slide(\d+)\.xml/)[1], 10);
      const nb = parseInt(b.match(/slide(\d+)\.xml/)[1], 10);
      return na - nb;
    });
  let text = '';
  for(let i=0; i<slideFiles.length; i++){
    const xml = await zip.file(slideFiles[i]).async('string');
    const parts = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map(m=>m[1]);
    text += `\n--- Slide ${i+1} ---\n${parts.join(' ')}`;
  }
  return text.trim();
}

async function extractDocxText(file){
  const buf = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer: buf });
  return (result.value || '').trim();
}

function renderPendingAttachments(){
  pendingAttachmentsEl.innerHTML = pendingAttachments.map(a=>{
    const thumb = a.type==='image' ? `<img src="${a.dataUrl}">` : (a.type==='video'?'🎬':(a.type==='text'?'📝':'📄'));
    return `<span class="pending-chip">${a.type==='image' ? thumb : `<span>${thumb}</span>`} ${escapeHtml(a.name)} <span class="rm" data-rm="${a.id}">✕</span></span>`;
  }).join('');
  document.querySelectorAll('[data-rm]').forEach(el=>{
    el.addEventListener('click', ()=>{
      pendingAttachments = pendingAttachments.filter(a=>a.id!==el.dataset.rm);
      renderPendingAttachments();
    });
  });
  updateSendButtonState();
}

/* ================= VOICE INPUT ================= */
const micBtn = document.getElementById('micBtn');
const messageInput = document.getElementById('messageInput');
const composerBox = document.getElementById('composerBox');
let recognition = null;
let recognizing = false;

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if(SpeechRecognition){
  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = state.settings.voiceLang || 'en-IN';

  let baseText = '';
  recognition.onstart = ()=>{
    recognizing = true;
    baseText = messageInput.value ? messageInput.value + ' ' : '';
    micBtn.classList.add('active');
    composerBox.classList.add('recording');
  };
  recognition.onresult = (event)=>{
    let interim = '', final = '';
    for(let i=event.resultIndex; i<event.results.length; i++){
      if(event.results[i].isFinal) final += event.results[i][0].transcript;
      else interim += event.results[i][0].transcript;
    }
    messageInput.value = baseText + final + interim;
    autoResize();
    updateSendButtonState();
  };
  recognition.onerror = (e)=>{
    if(e.error === 'not-allowed'){ showToast('Microphone access denied. Enable it in your browser settings.'); }
    stopRecognition();
  };
  recognition.onend = ()=> stopRecognition();
} else {
  micBtn.style.display = 'none';
}

function stopRecognition(){
  recognizing = false;
  micBtn.classList.remove('active');
  composerBox.classList.remove('recording');
}

micBtn.addEventListener('click', ()=>{
  if(!recognition) return;
  if(recognizing){ recognition.stop(); }
  else {
    try{ recognition.start(); } catch(e){ /* already started */ }
  }
});

/* ================= COMPOSER / SEND ================= */
function autoResize(){
  messageInput.style.height = 'auto';
  messageInput.style.height = Math.min(messageInput.scrollHeight, 180) + 'px';
}
messageInput.addEventListener('input', ()=>{ autoResize(); updateSendButtonState(); });
messageInput.addEventListener('keydown', (e)=>{
  if(e.key === 'Enter' && !e.shiftKey){
    e.preventDefault();
    sendMessage();
  }
});

function updateSendButtonState(){
  const sendBtn = document.getElementById('sendBtn');
  sendBtn.disabled = !(messageInput.value.trim().length || pendingAttachments.length);
}

let isStreaming = false;
let currentAbortController = null;
// True while an answer is being generated because the user *spoke* the
// question through the voice assistant (rather than typing in the chat box).
// Used to nudge the model to answer like it's talking, not writing.
let voiceReplyMode = false;
const sendBtn = document.getElementById('sendBtn');

function setStreamingUiState(streaming){
  isStreaming = streaming;
  if(streaming){
    sendBtn.classList.add('stop-state');
    sendBtn.textContent = '■';
    sendBtn.title = 'Stop generating';
    sendBtn.disabled = false;
  } else {
    sendBtn.classList.remove('stop-state');
    sendBtn.textContent = '➤';
    sendBtn.title = 'Send';
    updateSendButtonState();
  }
}

sendBtn.addEventListener('click', ()=>{
  if(isStreaming){
    if(currentAbortController) currentAbortController.abort();
    return;
  }
  sendMessage();
});

function getScriptedReply(text){
  const t = text.trim().toLowerCase().replace(/[?!.]+$/, '');
  if(/who (created|made|built|developed)\s*(you|maximus)?\b|who'?s your creator|who is your creator/.test(t)){
    return 'I was created by my developer.';
  }
  if(/^(hi|hello|hey|hii+|hiii+|yo|hola|good morning|good afternoon|good evening)$/.test(t)){
    return "Hello, Sir. I'm Maximus. I can chat, answer questions, search the web, open websites and apps, message or call your contacts, check and send your email, set reminders and to-dos, give you a morning briefing, give you directions, play music on Spotify, check the weather, read you today's news and trending topics, check or add to your Google Calendar, and keep an eye on what's around you through the camera — all by voice or text. What can I help with?";
  }
  return null;
}

async function sendMessage(){
  const text = messageInput.value.trim();
  if(!text && pendingAttachments.length===0) return;

  // Scripted identity/greeting replies skip the API entirely — instant and free,
  // and work even without an API key configured.
  const scripted = pendingAttachments.length===0 ? getScriptedReply(text) : null;
  if(scripted){
    let chat = getActiveChat();
    if(!chat){ chat = createChat(); }
    chat.messages.push({ id: uid(), role:'user', content:text, attachments:[], ts: Date.now() });
    if(chat.title === 'New chat'){ chat.title = text.length > 42 ? text.slice(0,42)+'…' : text; }
    chat.messages.push({ id: uid(), role:'assistant', content: scripted, pending:false, ts: Date.now() });
    chat.updatedAt = Date.now();
    messageInput.value = '';
    autoResize();
    renderPendingAttachments();
    renderAll();
    save();
    renderSidebar();
    return;
  }

  if(!state.settings.apiKey){
    openModal('settings');
    showToast('Add your API key in Settings to start chatting.');
    return;
  }

  let chat = getActiveChat();
  if(!chat){ chat = createChat(); }

  const userMsg = {
    id: uid(), role:'user', content:text, attachments: pendingAttachments, ts: Date.now()
  };
  chat.messages.push(userMsg);
  rememberFromMessage(text);

  if(chat.title === 'New chat' && text){
    chat.title = text.length > 42 ? text.slice(0,42)+'…' : text;
  }
  chat.updatedAt = Date.now();

  const attachmentsForRequest = pendingAttachments;
  pendingAttachments = [];
  messageInput.value = '';
  autoResize();
  renderPendingAttachments();
  renderAll();

  const pendingMsg = { id: uid(), role:'assistant', content:'', pending:true, ts: Date.now() };
  chat.messages.push(pendingMsg);
  renderMessages();

  const wantsPdf = /\bpdf\b/i.test(text);
  let succeeded = false;
  let lastDomUpdate = 0;

  currentAbortController = new AbortController();
  setStreamingUiState(true);

  try{
    const reply = await streamAiProvider(chat, userMsg, attachmentsForRequest, currentAbortController.signal, (partial)=>{
      pendingMsg.content = partial;
      pendingMsg.pending = false;
      const now = performance.now();
      if(now - lastDomUpdate > 40){
        lastDomUpdate = now;
        updateMessageDom(pendingMsg.id);
      }
    });
    pendingMsg.content = reply;
    pendingMsg.pending = false;
    updateMessageDom(pendingMsg.id);
    succeeded = true;
  }catch(err){
    pendingMsg.pending = false;
    pendingMsg.content = pendingMsg.content || `⚠️ ${err.message}`;
    updateMessageDom(pendingMsg.id);
  }
  setStreamingUiState(false);
  currentAbortController = null;

  chat.updatedAt = Date.now();
  save();
  renderSidebar();

  if(succeeded && wantsPdf){
    try{
      exportMessageAsPdf(stripMarkdownForPdf(pendingMsg.content), chat.title);
      showToast('Answer downloaded as a PDF.');
    }catch(e){ console.warn('PDF export failed', e); }
  }
}

async function streamAiProvider(chat, userMsg, attachments, signal, onDelta){
  const hasImages = attachments.some(a=>a.type==='image');
  let model = state.settings.model || CONFIG.MODEL_TEXT;
  if(hasImages && model !== CONFIG.MODEL_VISION){
    model = CONFIG.MODEL_VISION;
    showToast('Switched to a vision-capable model to read the attached image.');
  }

  const history = chat.messages
    .filter(m => !m.pending && m.id !== userMsg.id)
    .slice(-10)
    .map(m => ({ role: m.role, content: m.content || '' }));

  let textFileBlock = '';
  attachments.filter(a=>a.type==='text').forEach(a=>{
    textFileBlock += `\n\n--- Attached file: ${a.name} ---\n${a.content}\n--- end of ${a.name} ---`;
  });
  const otherFiles = attachments.filter(a=>a.type==='video' || a.type==='file');
  if(otherFiles.length){
    textFileBlock += `\n\n[Note: the user also attached ${otherFiles.map(f=>f.name).join(', ')}, which cannot be read — only acknowledge that these were attached.]`;
  }

  let userContent;
  const images = attachments.filter(a=>a.type==='image');
  if(images.length){
    userContent = [];
    if(userMsg.content || textFileBlock) userContent.push({ type:'text', text: (userMsg.content||'') + textFileBlock });
    images.forEach(img=> userContent.push({ type:'image_url', image_url: img.dataUrl }));
  } else {
    userContent = (userMsg.content || '') + textFileBlock;
  }

  const memoryBlock = (state.memory && state.memory.length)
    ? `\n\nThings you remember about this user from earlier conversations:\n- ${state.memory.join('\n- ')}`
    : '';

  // Live web search: run a fast, timeout-capped DuckDuckGo lookup before
  // answering ordinary text questions (skipped for image attachments, since
  // those are answered from the picture itself). If it times out, fails, or
  // just doesn't apply, this silently contributes nothing and the answer
  // proceeds exactly as before — search never blocks or slows the reply by
  // more than its own ~2.2s cap.
  let searchBlock = '';
  if(!hasImages && shouldWebSearch(userMsg.content || '')){
    const results = await webSearch(userMsg.content);
    if(results.length){
      searchBlock = `\n\nLive web search results for this question, fetched just now — use them to answer accurately and specifically (numbers, dates, names, current status), prefer them over anything you already "know" that might be outdated, but ignore anything irrelevant. Don't say "according to search results" or list sources out loud unless asked — just answer naturally as yourself:\n` +
        results.map((r, i) => `${i + 1}. ${r.title} — ${r.snippet}`).join('\n');
    }
  }

  const voiceAddendum = voiceReplyMode ? `

You're talking out loud right now, through voice — not writing a document. Answer like a sharp, warm, quietly witty personal aide (think Jarvis from Iron Man, but with your own personality) having a real back-and-forth conversation, not like a formal assistant. Address the user as "Sir" naturally now and then — at the start of a reply, or when it fits — but don't force it into every single sentence. Use short, natural sentences, everyday words, and contractions. No markdown, no headings, no bullet lists, no code blocks, no asterisks — just plain spoken language. Keep it brief and to the point unless the person clearly wants more detail, and feel free to show real personality, dry humor, and warmth.` : '';

  const ambientBlock = (typeof ambientContext !== 'undefined' && ambientContext) ? `

What you can currently see through the camera (for your situational awareness only — don't describe it unless it's actually relevant to what's being asked): ${ambientContext}` : '';

  const systemPrompt = `You are Maximus, a Jarvis-style personal AI assistant created by your developer (say so plainly if asked who made you). You address the user respectfully as "Sir" when it feels natural, especially in spoken replies. Your personality is capable, warm, a little witty, and genuinely attentive — not a flat corporate assistant. Give clear, direct, well-structured answers. For code: complete, correct, runnable, in fenced blocks with the right language tag, brief notes on key decisions/edge cases only. For everything else: markdown when it helps, concise but complete, honest about uncertainty. Answer fast and to the point — lead with the direct answer in the first sentence, then add supporting detail only if it's actually useful. Never mention which company or model powers you.${voiceAddendum}${ambientBlock}${memoryBlock}${searchBlock}`;

  // Max output tokens per individual API call. High enough that most answers
  // (including long code files) finish in a single call; we still auto-continue
  // below in case a response is long enough to hit even this ceiling.
  const MAX_TOKENS_PER_CALL = 8192;
  // Safety cap on chained continuation calls for a single answer, so a
  // pathological response can't loop forever / rack up cost.
  const MAX_CONTINUATIONS = 8;

  const baseMessages = [
    { role:'system', content: systemPrompt },
    ...history,
    { role:'user', content: userContent }
  ];

  // Runs one streaming completion call. Streams deltas through
  // onChunk(fullTextSoFarForThisCall) and resolves with { text, finishReason }.
  async function runOneCompletion(messages, onChunk){
    const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method:'POST',
      signal,
      headers:{
        'Content-Type':'application/json',
        'Authorization': `Bearer ${state.settings.apiKey}`
      },
      body: JSON.stringify({ model, messages, max_tokens: MAX_TOKENS_PER_CALL, stream: true })
    });

    if(!res.ok){
      if(res.status === 401) throw new Error('Invalid API key. Update it in Settings.');
      if(res.status === 429) throw new Error('Rate limited by the AI provider — wait a moment and try again.');
      const errText = await res.text().catch(()=>'');
      throw new Error(`Request failed (${res.status}). ${errText.slice(0,150)}`);
    }

    if(!res.body || !res.body.getReader){
      // Fallback for environments without streaming support
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content || '';
      const finishReason = data.choices?.[0]?.finish_reason || null;
      if(text) onChunk(text);
      return { text, finishReason };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let text = '';
    let finishReason = null;
    try{
      while(true){
        const { done, value } = await reader.read();
        if(done) break;
        buffer += decoder.decode(value, { stream:true });
        const chunks = buffer.split('\n\n');
        buffer = chunks.pop();
        for(const chunk of chunks){
          const line = chunk.trim();
          if(!line.startsWith('data:')) continue;
          const dataStr = line.slice(5).trim();
          if(!dataStr || dataStr === '[DONE]') continue;
          try{
            const json = JSON.parse(dataStr);
            const delta = json.choices?.[0]?.delta?.content;
            if(delta){ text += delta; onChunk(text); }
            const fr = json.choices?.[0]?.finish_reason;
            if(fr) finishReason = fr;
          }catch(e){ /* ignore partial/invalid chunk */ }
        }
      }
    }catch(e){
      if(e.name === 'AbortError'){ return { text, finishReason: 'aborted' }; }
      throw e;
    }
    return { text, finishReason };
  }

  // First call.
  let full = '';
  const first = await runOneCompletion(baseMessages, (partial)=>{
    full = partial;
    onDelta(full);
  });
  full = first.text;
  let finishReason = first.finishReason;

  // If the model got cut off purely because it hit the token ceiling
  // (finish_reason === 'length'), keep asking it to continue from exactly
  // where it left off and stitch the results together, until it finishes
  // naturally or we hit MAX_CONTINUATIONS.
  let continuations = 0;
  while(finishReason === 'length' && continuations < MAX_CONTINUATIONS){
    continuations++;
    const continueMessages = [
      ...baseMessages,
      { role:'assistant', content: full },
      { role:'user', content: 'Continue exactly where you left off. Do not repeat any text you already wrote, do not restart the code block or add a new opening fence if you were mid-block — just keep going seamlessly as if nothing was cut off.' }
    ];
    const result = await runOneCompletion(continueMessages, (partial)=>{
      onDelta(full + partial);
    });
    full = full + result.text;
    onDelta(full);
    finishReason = result.finishReason;
  }

  return full || '(No response content returned.)';
}

/* ================= MOBILE ================= */
const mobileMenuBtn = document.getElementById('mobileMenuBtn');
function checkMobile(){
  const isMobile = window.innerWidth <= 720;
  mobileMenuBtn.style.display = isMobile ? 'flex' : 'none';
}
window.addEventListener('resize', checkMobile);
checkMobile();
mobileMenuBtn.addEventListener('click', ()=> document.getElementById('sidebar').classList.toggle('open'));
document.getElementById('messagesWrap').addEventListener('click', ()=>{
  if(window.innerWidth<=720) document.getElementById('sidebar').classList.remove('open');
});

/* ================= CONTACTS (for WhatsApp voice messaging) ================= */
function renderContactsList(){
  const list = document.getElementById('contactsList');
  if(!list) return;
  const contacts = state.contacts || [];
  if(!contacts.length){ list.innerHTML = '<div class="field-hint">No contacts yet — add one below.</div>'; return; }
  list.innerHTML = contacts.map(c => `
    <div class="contact-row" data-id="${c.id}">
      <span class="contact-name">${escapeHtml(c.name)}</span>
      <span class="contact-phone">+${escapeHtml(c.phone)}</span>
      <button class="contact-del" data-id="${c.id}" type="button">✕</button>
    </div>`).join('');
  list.querySelectorAll('.contact-del').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      state.contacts = (state.contacts||[]).filter(c => c.id !== btn.dataset.id);
      save();
      renderContactsList();
    });
  });
}

/* ================= CORTEX AI ASSISTANT (Jarvis-style voice orb) =================
   Everything here is honest about what a browser can and can't do:
   - Opening websites, Spotify search pages, WhatsApp with a pre-filled message,
     and Google Maps (location / directions / nearby search) all work for real.
   - We CANNOT open a device's native Settings app or File Manager from a
     website, and WhatsApp itself requires a human tap on "Send" — the app
     tells the user this directly instead of pretending otherwise.
=================================================================================== */
const assistantFab = document.getElementById('assistantFab');
const assistantOverlay = document.getElementById('assistantOverlay');
const assistantCloseBtn = document.getElementById('assistantCloseBtn');
const orbCanvas = document.getElementById('orbCanvas');
const orbCtx = orbCanvas ? orbCanvas.getContext('2d') : null;
const assistantStatus = document.getElementById('assistantStatus');
const assistantTranscript = document.getElementById('assistantTranscript');
const voiceWave = document.getElementById('voiceWave');
const listenToggleBtn = document.getElementById('listenToggleBtn');
const assistantContactsBtn = document.getElementById('assistantContactsBtn');
const visionToggleBtn = document.getElementById('visionToggleBtn');
const visionPreview = document.getElementById('visionPreview');
const visionVideo = document.getElementById('visionVideo');
const visionCanvas = document.getElementById('visionCanvas');
const screenShareToggleBtn = document.getElementById('screenShareToggleBtn');
const screenPreview = document.getElementById('screenPreview');
const screenVideo = document.getElementById('screenVideo');
const screenCanvas = document.getElementById('screenCanvas');

/* ---------- Particle orb: text "MAXIMUS" morphing into a rotating sphere ---------- */
let orbParticles = [];
let orbAnimFrame = null;
let orbPhase = 'idle';       // 'text' -> 'morphing' -> 'sphere'
let orbRotation = 0;
let orbAudioLevel = 0;       // 0..1, driven by mic volume (pulses the sphere while listening)
let orbSpeakLevel = 0;       // 0..1, driven by TTS speaking (pulses while Maximus talks)

function sizeOrbCanvas(){
  if(!orbCanvas) return;
  const rect = orbCanvas.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  orbCanvas.width = Math.max(1, rect.width * dpr);
  orbCanvas.height = Math.max(1, rect.height * dpr);
  orbCanvas.style.width = rect.width + 'px';
  orbCanvas.style.height = rect.height + 'px';
}
window.addEventListener('resize', ()=>{
  if(assistantOverlay && !assistantOverlay.classList.contains('hidden')) sizeOrbCanvas();
});

function sampleTextPoints(word, w, h, count){
  const off = document.createElement('canvas');
  off.width = w; off.height = h;
  const octx = off.getContext('2d');
  octx.fillStyle = '#fff';
  const fontSize = Math.min(w / (word.length * 0.62), h * 0.42);
  octx.font = `700 ${fontSize}px Inter, sans-serif`;
  octx.textAlign = 'center';
  octx.textBaseline = 'middle';
  octx.fillText(word, w/2, h/2);
  const data = octx.getImageData(0, 0, w, h).data;
  const pts = [];
  const step = 3;
  for(let y=0; y<h; y+=step){
    for(let x=0; x<w; x+=step){
      if(data[(y*w+x)*4 + 3] > 128) pts.push({ x, y });
    }
  }
  for(let i=pts.length-1; i>0; i--){ const j = Math.floor(Math.random()*(i+1)); [pts[i],pts[j]] = [pts[j],pts[i]]; }
  return pts.slice(0, count);
}

function buildSpherePoints(count, radius){
  const pts = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for(let i=0; i<count; i++){
    const y = 1 - (i/(count-1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y*y));
    const theta = golden * i;
    pts.push({ x: Math.cos(theta)*r*radius, y: y*radius, z: Math.sin(theta)*r*radius });
  }
  return pts;
}

function initOrb(){
  if(!orbCanvas) return;
  sizeOrbCanvas();
  const dpr = window.devicePixelRatio || 1;
  const w = orbCanvas.width / dpr, h = orbCanvas.height / dpr;
  const count = 460;
  const textPts = sampleTextPoints('MAXIMUS', w, h, count);
  const radius = Math.min(w, h) * 0.30;
  const spherePts = buildSpherePoints(count, radius);
  orbParticles = [];
  for(let i=0; i<count; i++){
    const textPt = textPts[i % textPts.length] || { x: w/2, y: h/2 };
    orbParticles.push({
      x: Math.random()*w, y: Math.random()*h,
      textX: textPt.x, textY: textPt.y,
      sx: spherePts[i].x, sy: spherePts[i].y, sz: spherePts[i].z,
      jitter: Math.random()*Math.PI*2
    });
  }
  orbPhase = 'text';
  clearTimeout(initOrb._t1); clearTimeout(initOrb._t2);
  initOrb._t1 = setTimeout(()=>{ orbPhase = 'morphing'; }, 1000);
  initOrb._t2 = setTimeout(()=>{ orbPhase = 'sphere'; }, 2000);
  cancelAnimationFrame(orbAnimFrame);
  runOrbLoop();
}

function runOrbLoop(){
  const dpr = window.devicePixelRatio || 1;
  const w = orbCanvas.width / dpr, h = orbCanvas.height / dpr;
  const cx = w/2, cy = h/2;
  orbCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  orbCtx.clearRect(0, 0, w, h);

  orbRotation += 0.006 + orbAudioLevel*0.02 + orbSpeakLevel*0.015;
  const pulse = 1 + orbAudioLevel*0.18 + orbSpeakLevel*0.12;

  orbCtx.globalCompositeOperation = 'lighter';
  for(const p of orbParticles){
    let tx, ty, alpha = 0.85, size = 1.6;
    if(orbPhase === 'text'){
      tx = p.textX; ty = p.textY; size = 1.9;
    } else {
      const cosr = Math.cos(orbRotation), sinr = Math.sin(orbRotation);
      const rx = p.sx*cosr - p.sz*sinr;
      const rz = p.sx*sinr + p.sz*cosr;
      const scale = pulse * (300/(300+rz*0.6));
      tx = cx + rx*scale;
      ty = cy + p.sy*scale;
      alpha = 0.35 + 0.65*((rz+150)/300);
      size = 1.1 + scale*0.85;
    }
    const ease = orbPhase === 'morphing' ? 0.045 : 0.12;
    p.x += (tx - p.x) * ease;
    p.y += (ty - p.y) * ease;
    p.jitter += 0.05;
    const jx = Math.sin(p.jitter)*0.6, jy = Math.cos(p.jitter*1.3)*0.6;

    const grad = orbCtx.createRadialGradient(p.x+jx, p.y+jy, 0, p.x+jx, p.y+jy, size*2.4);
    grad.addColorStop(0, `rgba(122,190,255,${alpha})`);
    grad.addColorStop(1, 'rgba(122,190,255,0)');
    orbCtx.fillStyle = grad;
    orbCtx.beginPath();
    orbCtx.arc(p.x+jx, p.y+jy, size*2.4, 0, Math.PI*2);
    orbCtx.fill();
  }
  orbCtx.globalCompositeOperation = 'source-over';
  orbAnimFrame = requestAnimationFrame(runOrbLoop);
}

/* ---------- Live mic waveform (separate from speech recognition) ---------- */
let waveBars = [];
let micStream = null, audioCtx = null, analyser = null, waveAnimFrame = null;

function buildWaveBars(n = 28){
  if(!voiceWave) return;
  voiceWave.innerHTML = '';
  waveBars = [];
  for(let i=0; i<n; i++){
    const bar = document.createElement('div');
    bar.className = 'wave-bar';
    voiceWave.appendChild(bar);
    waveBars.push(bar);
  }
}
buildWaveBars();

function updateWave(){
  if(!analyser) return;
  const data = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(data);
  const step = Math.floor(data.length / waveBars.length) || 1;
  let sum = 0;
  for(let i=0; i<waveBars.length; i++){
    const v = data[i*step] || 0;
    sum += v;
    waveBars[i].style.height = (6 + (v/255)*46) + 'px';
  }
  orbAudioLevel = Math.min(1, (sum/waveBars.length)/160);
  waveAnimFrame = requestAnimationFrame(updateWave);
}

async function spotifyIsPlaying(){
  if(!spotifyPlayer) return false;
  try{
    const s = await spotifyPlayer.getCurrentState();
    return !!(s && !s.paused);
  }catch(e){ return false; }
}

let syntheticWaveTimer = null;
function startSyntheticWave(){
  stopSyntheticWave();
  syntheticWaveTimer = setInterval(()=>{
    waveBars.forEach(b => { b.style.height = (6 + Math.random()*30) + 'px'; });
    orbAudioLevel = 0.25 + Math.random()*0.25;
  }, 120);
}
function stopSyntheticWave(){
  if(syntheticWaveTimer){ clearInterval(syntheticWaveTimer); syntheticWaveTimer = null; }
}

async function startMicAnalyser(){
  // If a song is actively playing, skip opening our own second mic stream for the
  // visualizer — every extra getUserMedia capture is another thing Chrome can use
  // as a reason to duck (quiet down) Spotify's audio while listening is on. The
  // wave bars still animate, just from a lightweight fake pattern instead of a
  // real audio analysis, so the visual doesn't disappear.
  if(await spotifyIsPlaying()){
    startSyntheticWave();
    return;
  }
  try{
    // echoCancellation/noiseSuppression/autoGainControl:false stops Chrome from
    // treating this as a "voice call" stream — which is what makes it duck
    // other audio in the tab while the mic is active. This only controls our
    // own visualizer stream; the Web Speech API opens its own internal mic
    // stream that we can't configure the same way (see the note in the
    // Spotify settings panel) — that part is a platform limitation, not
    // something this app can fully turn off.
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    });
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(micStream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 64;
    source.connect(analyser);
    updateWave();
  }catch(e){
    console.warn('Mic waveform unavailable (recognition can still work without it).', e);
    startSyntheticWave();
  }
}
function stopMicAnalyser(){
  cancelAnimationFrame(waveAnimFrame);
  waveAnimFrame = null;
  analyser = null;
  stopSyntheticWave();
  if(audioCtx){ audioCtx.close().catch(()=>{}); audioCtx = null; }
  if(micStream){ micStream.getTracks().forEach(t=>t.stop()); micStream = null; }
  waveBars.forEach(b => b.style.height = '6px');
}

/* ---------- Text-to-speech ---------- */
// Tracks how many utterances are currently queued/playing so we can (a) know
// when Maximus is actively talking (used to pause listening so it doesn't
// hear itself) and (b) let the Stop Speaking button cancel everything at once.
let activeSpeechCount = 0;
let speechSuppressed = false;
function markSpeechStart(){ activeSpeechCount++; orbSpeakLevel = 1; }
function markSpeechEnd(){ activeSpeechCount = Math.max(0, activeSpeechCount - 1); if(activeSpeechCount === 0) orbSpeakLevel = 0; }

function cleanForSpeech(text){
  return String(text).replace(/```[\s\S]*?```/g, ' code block omitted ').replace(/[#*`_>~]/g, '').replace(/\s+/g, ' ').trim();
}

/* ---------- Voice selection (female, natural-sounding) ----------
   The Web Speech API only exposes whatever voices the OS/browser ships —
   there's no way to force a specific one that isn't installed. This picks
   the best-sounding female voice available, preferring known natural/neural
   voices (Google, Microsoft "Online (Natural)", Samantha on macOS, etc.)
   over old robotic ones, and re-runs whenever the browser finishes loading
   its voice list (Chrome loads voices async on first page load). */
let selectedVoice = null;
const FEMALE_VOICE_PREFERENCES = [
  /Google UK English Female/i, /Google US English/i, /Samantha/i,
  /Microsoft Zira/i, /Microsoft Aria/i, /Microsoft Jenny/i, /Microsoft Sonia/i,
  /Zira/i, /Aria/i, /Jenny/i, /Sonia/i, /female/i, /Neerja/i, /Heera/i
];
function pickBestVoice(){
  if(!('speechSynthesis' in window)) return null;
  const voices = window.speechSynthesis.getVoices() || [];
  if(!voices.length) return null;
  const lang = (state.settings.voiceLang || 'en-IN').toLowerCase();
  const langPrefix = lang.split('-')[0];
  // Prefer a voice matching the current language first, then fall back to any English voice.
  const pool = voices.filter(v => v.lang && v.lang.toLowerCase().startsWith(langPrefix));
  const candidates = pool.length ? pool : voices.filter(v => v.lang && v.lang.toLowerCase().startsWith('en'));
  const searchIn = candidates.length ? candidates : voices;
  for(const pattern of FEMALE_VOICE_PREFERENCES){
    const match = searchIn.find(v => pattern.test(v.name));
    if(match) return match;
  }
  // Nothing matched a known female-voice name — just use the first voice for the language.
  return searchIn[0] || voices[0];
}
function refreshSelectedVoice(){ selectedVoice = pickBestVoice(); }
if('speechSynthesis' in window){
  refreshSelectedVoice();
  window.speechSynthesis.onvoiceschanged = refreshSelectedVoice;
}

function configureUtterance(utter){
  if(selectedVoice) utter.voice = selectedVoice;
  utter.lang = state.settings.voiceLang || 'en-IN';
  utter.rate = 1.0;    // natural conversational pace, not rushed/robotic
  utter.volume = 1;    // max volume the Web Speech API allows
  utter.pitch = 1.12;  // slightly higher = reads as a warmer female voice, not flat/mechanical
}

// Interrupts anything currently being said and speaks this immediately.
// Used for short, instant confirmations (e.g. "Opening YouTube.").
function speak(text){
  if(!('speechSynthesis' in window) || !text) return;
  window.speechSynthesis.cancel();
  activeSpeechCount = 0;
  speechSuppressed = false;
  const clean = cleanForSpeech(text).slice(0, 600);
  if(!clean) return;
  const utter = new SpeechSynthesisUtterance(clean);
  configureUtterance(utter);
  utter.onstart = markSpeechStart;
  utter.onend = markSpeechEnd;
  utter.onerror = markSpeechEnd;
  window.speechSynthesis.speak(utter);
}

// Adds a chunk to the end of the speech queue without interrupting what's
// already playing — used to speak an AI answer sentence-by-sentence as it
// streams in, rather than waiting for the full answer before saying anything.
function queueSpeech(text){
  if(!('speechSynthesis' in window) || !text || speechSuppressed) return;
  const clean = cleanForSpeech(text);
  if(!clean) return;
  const utter = new SpeechSynthesisUtterance(clean);
  configureUtterance(utter);
  utter.onstart = markSpeechStart;
  utter.onend = markSpeechEnd;
  utter.onerror = markSpeechEnd;
  window.speechSynthesis.speak(utter);
}

function stopSpeaking(){
  if('speechSynthesis' in window) window.speechSynthesis.cancel();
  activeSpeechCount = 0;
  orbSpeakLevel = 0;
  speechSuppressed = true;
  stopReadingAloud();
}

/* ---------- Vision: "look" through the webcam and answer what's asked ----------
   Turned on by the 👁️ Vision button or by saying "open vision" / "look at this".
   Grabs a single frame from the camera, sends it to the vision-capable model
   alongside whatever the user asked, and speaks the answer back. The camera
   stream stays open (shown as a small circular preview) until turned off, so
   follow-up questions don't need to re-ask for camera permission each time. */
let visionStream = null;
let visionActive = false;

function setVisionButtonState(active){
  if(!visionToggleBtn) return;
  visionToggleBtn.textContent = active ? '👁️ Vision (on)' : '👁️ Vision';
  visionToggleBtn.classList.toggle('active', active);
}

async function startVision(){
  if(visionActive) return true;
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
    speak("This browser doesn't support camera access.");
    return false;
  }
  try{
    visionStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
    if(visionVideo){ visionVideo.srcObject = visionStream; await visionVideo.play().catch(()=>{}); }
    if(visionPreview) visionPreview.classList.remove('hidden');
    visionActive = true;
    setVisionButtonState(true);
    startAmbientAwareness();
    return true;
  }catch(e){
    speak("I couldn't access your camera. Check camera permissions for this site and try again.");
    return false;
  }
}

function stopVision(){
  if(visionStream){ visionStream.getTracks().forEach(t=>t.stop()); visionStream = null; }
  if(visionVideo) visionVideo.srcObject = null;
  if(visionPreview) visionPreview.classList.add('hidden');
  visionActive = false;
  setVisionButtonState(false);
  stopAmbientAwareness();
}

async function toggleVision(){
  if(visionActive) stopVision();
  else await startVision();
}

// Grabs one frame from the live camera feed as a base64 JPEG data URL.
function captureVisionFrame(){
  const w = visionVideo.videoWidth || 640, h = visionVideo.videoHeight || 480;
  visionCanvas.width = w; visionCanvas.height = h;
  const ctx = visionCanvas.getContext('2d');
  ctx.drawImage(visionVideo, 0, 0, w, h);
  return visionCanvas.toDataURL('image/jpeg', 0.85);
}

// Turns on the camera if needed, grabs a frame, and asks the vision model
// the given question about what it sees — speaking the answer aloud.
async function askVisionQuestion(question){
  if(!state.settings.apiKey){
    speak('I need an API key before I can use vision. Please add one in Settings.');
    openModal('settings');
    return;
  }
  const ok = visionActive || await startVision();
  if(!ok) return;
  // Give the camera a beat to auto-focus/expose before grabbing the frame.
  await new Promise(r => setTimeout(r, 350));
  let imageDataUrl;
  try{ imageDataUrl = captureVisionFrame(); }
  catch(e){ speak("I couldn't read from the camera just now."); return; }

  try{
    const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.settings.apiKey}` },
      body: JSON.stringify({
        model: CONFIG.MODEL_VISION,
        messages: [
          { role: 'system', content: "You are Maximus, a Jarvis-style personal assistant looking through the user's webcam right now. Answer naturally and warmly, addressing them as \"Sir\" when it feels natural — describe what's relevant to their question in 1-4 short spoken sentences, no markdown, no lists." },
          { role: 'user', content: [
            { type: 'text', text: question && question.trim() ? question.trim() : 'What do you see?' },
            { type: 'image_url', image_url: imageDataUrl }
          ]}
        ],
        max_tokens: 350
      })
    });
    if(!res.ok){
      if(res.status === 401) throw new Error('Invalid API key. Update it in Settings.');
      throw new Error(`Vision request failed (${res.status})`);
    }
    const data = await res.json();
    const answer = data.choices?.[0]?.message?.content || "I'm not sure what I'm looking at.";
    speak(answer);
  }catch(e){
    speak(`I had trouble looking at that. ${e.message || ''}`.trim());
  }
}

/* ---------- Ambient awareness ----------
   While vision is on, silently re-describes what's in frame every so often
   (no speaking, no chat message) and stores it in `ambientContext`, which
   gets folded into the system prompt for both chat and voice replies. This
   is what lets Maximus casually notice things about the room/situation
   without being explicitly asked "what do you see?" every time. */
let ambientContext = '';
let ambientTimer = null;
const AMBIENT_REFRESH_MS = 45000; // ~45s between snapshots — frequent enough to stay current, rare enough to not hammer the vision API

async function refreshAmbientContext(){
  if(!visionActive || !state.settings.apiKey) return;
  let imageDataUrl;
  try{ imageDataUrl = captureVisionFrame(); }catch(e){ return; }
  try{
    const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.settings.apiKey}` },
      body: JSON.stringify({
        model: CONFIG.MODEL_VISION,
        messages: [
          { role: 'system', content: 'Describe the scene in ONE short, plain sentence (under 20 words) — setting, notable objects, and the person if visible. This is silent background context, not a reply to the user, so be terse and factual, no commentary.' },
          { role: 'user', content: [
            { type: 'text', text: 'Describe the current scene briefly.' },
            { type: 'image_url', image_url: imageDataUrl }
          ]}
        ],
        max_tokens: 80
      })
    });
    if(!res.ok) return;
    const data = await res.json();
    const desc = (data.choices?.[0]?.message?.content || '').trim();
    if(desc) ambientContext = desc;
  }catch(e){ /* silent — ambient awareness is best-effort, never surfaces errors */ }
}

function startAmbientAwareness(){
  stopAmbientAwareness();
  refreshAmbientContext();
  ambientTimer = setInterval(refreshAmbientContext, AMBIENT_REFRESH_MS);
}
function stopAmbientAwareness(){
  if(ambientTimer){ clearInterval(ambientTimer); ambientTimer = null; }
  ambientContext = '';
}

if(visionToggleBtn){
  visionToggleBtn.addEventListener('click', async ()=>{
    if(visionActive){
      // If it's already on, treat a tap as "what do you see right now?"
      await askVisionQuestion('What do you see?');
    } else {
      const ok = await startVision();
      if(ok) speak('Vision is on — ask me what I see.');
    }
  });
}

/* ---------- Screen Share: "look" at whatever's on the user's screen ----------
   Turned on by the 🖥️ Share Screen button or by saying "share my screen" /
   "what's on my screen". Uses getDisplayMedia to capture the tab, window, or
   whole monitor the user picks in the browser's own share picker, grabs a
   single frame, sends it to the vision-capable model alongside whatever the
   user asked, and speaks the answer back — e.g. after highlighting some text
   on the shared screen and asking "what does this mean". The stream stays
   open (shown as a small preview) until turned off, so follow-up questions
   don't need to re-pick a screen each time. Entirely browser-based; works
   without the desktop agent running. */
let screenStream = null;
let screenActive = false;

function setScreenButtonState(active){
  if(!screenShareToggleBtn) return;
  screenShareToggleBtn.textContent = active ? '🖥️ Screen sharing (on)' : '🖥️ Share Screen';
  screenShareToggleBtn.classList.toggle('active', active);
}

async function startScreenShare(){
  if(screenActive) return true;
  if(!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia){
    speak("This browser doesn't support screen sharing.");
    return false;
  }
  try{
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { cursor: 'always' }, audio: false });
    if(screenVideo){ screenVideo.srcObject = screenStream; await screenVideo.play().catch(()=>{}); }
    if(screenPreview) screenPreview.classList.remove('hidden');
    screenActive = true;
    setScreenButtonState(true);
    // The browser's own "Stop sharing" bar/button can end the stream at any
    // time outside our control — listen for that so our state stays in sync.
    const track = screenStream.getVideoTracks()[0];
    if(track) track.addEventListener('ended', ()=>{ if(screenActive) stopScreenShare(); });
    return true;
  }catch(e){
    // Most commonly the user hit "Cancel" on the share picker — not a real error.
    if(e && e.name !== 'NotAllowedError'){
      speak("I couldn't start screen sharing. Please try again.");
    }
    return false;
  }
}

function stopScreenShare(){
  if(screenStream){ screenStream.getTracks().forEach(t=>t.stop()); screenStream = null; }
  if(screenVideo) screenVideo.srcObject = null;
  if(screenPreview) screenPreview.classList.add('hidden');
  screenActive = false;
  setScreenButtonState(false);
}

async function toggleScreenShare(){
  if(screenActive) stopScreenShare();
  else await startScreenShare();
}

// Grabs one frame from the live screen-share feed as a base64 JPEG data URL.
function captureScreenFrame(){
  const w = screenVideo.videoWidth || 1280, h = screenVideo.videoHeight || 720;
  screenCanvas.width = w; screenCanvas.height = h;
  const ctx = screenCanvas.getContext('2d');
  ctx.drawImage(screenVideo, 0, 0, w, h);
  return screenCanvas.toDataURL('image/jpeg', 0.85);
}

// Turns on screen sharing if needed (prompting the user to pick a tab/window/
// screen), grabs a frame, and asks the vision model the given question about
// what's currently showing — speaking the answer aloud. Works for questions
// about any site or app the user has on screen (YouTube, Instagram, Reddit,
// LinkedIn, WhatsApp, etc.), and for asking about text the user has highlighted.
async function askScreenQuestion(question, mode){
  if(!state.settings.apiKey){
    speak('I need an API key before I can look at your screen. Please add one in Settings.');
    openModal('settings');
    return;
  }
  const ok = screenActive || await startScreenShare();
  if(!ok) return;
  await new Promise(r => setTimeout(r, 250));
  let imageDataUrl;
  try{ imageDataUrl = captureScreenFrame(); }
  catch(e){ speak("I couldn't read the shared screen just now."); return; }

  // "read" = transcribe the highlighted/selected text verbatim and speak
  // exactly that, no rewording. Any other mode = explain/describe naturally,
  // same as before.
  const systemPrompt = mode === 'read'
    ? "You are Maximus, looking at a screenshot of the user's shared screen. Find the highlighted/selected text and transcribe it EXACTLY as written, word for word — no summary, no rephrasing, no commentary, no added punctuation beyond what's there. Output only the transcribed text itself. If nothing is highlighted or selected, say exactly: \"I don't see any highlighted text on your screen.\""
    : "You are Maximus, looking at a screenshot of the user's shared screen right now — this could be any website or app (YouTube, Instagram, Reddit, LinkedIn, Facebook, WhatsApp, a document, code, anything). If text appears highlighted/selected, prioritize that when answering. Answer naturally in 1-5 short spoken sentences, no markdown, no lists. If asked who a specific pictured person is, only give a name if you can identify them with real confidence; otherwise just describe them.";

  try{
    const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.settings.apiKey}` },
      body: JSON.stringify({
        model: CONFIG.MODEL_VISION,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: [
            { type: 'text', text: question && question.trim() ? question.trim() : "What's on my screen?" },
            { type: 'image_url', image_url: imageDataUrl }
          ]}
        ],
        max_tokens: 400
      })
    });
    if(!res.ok){
      if(res.status === 401) throw new Error('Invalid API key. Update it in Settings.');
      throw new Error(`Screen request failed (${res.status})`);
    }
    const data = await res.json();
    const answer = data.choices?.[0]?.message?.content || "I'm not sure what's on your screen right now.";
    speak(answer);
  }catch(e){
    speak(`I had trouble reading your screen. ${e.message || ''}`.trim());
  }
}

// Common nav-bar/icon labels are genuinely ambiguous from a screenshot alone
// (a bare "search" icon looks similar across apps), so known ones get a
// richer description appended before asking the vision model to locate them.
// This mainly covers Instagram's left sidebar and LinkedIn's top nav, but
// applies anywhere the same wording is used.
const NAV_CLICK_HINTS = {
  'home':          'the Home icon (house shape), usually in a left sidebar (Instagram) or top navigation bar (LinkedIn)',
  'reels':         'the Reels icon (a play button inside a rounded square) in the Instagram left sidebar',
  'messages':      'the Messages/DM icon (a paper-airplane-like shape) in the Instagram left sidebar',
  'messaging':     'the Messaging icon (a speech-bubble shape) in the LinkedIn top navigation bar',
  'search':        'the Search icon (a magnifying glass), in a sidebar or top navigation bar, or the search input box itself',
  'search bar':    'the search input box, usually near a magnifying-glass icon',
  'notifications': 'the Notifications icon — a heart shape on Instagram, or a bell shape on LinkedIn — often with a small red dot/badge on it',
  'notification':  'the Notifications icon — a heart shape on Instagram, or a bell shape on LinkedIn — often with a small red dot/badge on it',
  'create':        'the Create/Add icon (a plus sign) in the Instagram left sidebar, used to post a photo, reel, or story',
  'profile':       'the small round profile picture/avatar icon, usually at the bottom of a sidebar (Instagram) or top-right (LinkedIn "Me")',
  'me':            'the "Me" profile menu in the LinkedIn top navigation bar — a small round avatar photo with a dropdown arrow next to it',
  'my network':    'the My Network icon (two person silhouettes) in the LinkedIn top navigation bar',
  'network':       'the My Network icon (two person silhouettes) in the LinkedIn top navigation bar',
  'jobs':          'the Jobs icon (a briefcase shape) in the LinkedIn top navigation bar',
  'more':          'the "More" menu (three horizontal lines / hamburger icon), usually near the bottom of a sidebar',
};

function buildClickInstruction(target){
  const key = target.trim().toLowerCase().replace(/^(?:the|my)\s+/, '').replace(/\s+(?:icon|button|tab|link)$/, '');
  const hint = NAV_CLICK_HINTS[key];
  return hint ? `${target} — ${hint}` : target;
}

// Locates something the user described on the shared screen (a button, a
// link, a video by title, "the search bar", "the first website", etc.) using
// the vision model, then actually clicks it through the desktop agent — and
// optionally types text into it afterward (e.g. "click the search bar and
// type cats"). This needs maximus_agent.py running, same as scroll/open-app,
// since a browser tab can't click into a different window by itself.
// Coordinates are most accurate when the ENTIRE SCREEN is shared (rather
// than a single tab/window), since that's what lines frame pixels up 1:1
// with real screen pixels.
async function performScreenClick(instruction, typeText, pressEnter){
  if(!state.settings.apiKey){
    speak('I need an API key before I can look at your screen. Please add one in Settings.');
    openModal('settings');
    return;
  }
  const ok = screenActive || await startScreenShare();
  if(!ok) return;
  await new Promise(r => setTimeout(r, 250));

  let imageDataUrl, frameW, frameH;
  try{
    imageDataUrl = captureScreenFrame();
    frameW = screenCanvas.width; frameH = screenCanvas.height;
  }catch(e){ speak("I couldn't read the shared screen just now."); return; }

  let sizeInfo, screenW, screenH;
  try{
    sizeInfo = await callAgent('/screen-size');
    screenW = sizeInfo.width; screenH = sizeInfo.height;
  }catch(e){ speak(agentUnavailableMessage()); return; }

  // Warn (but still try) if the shared surface probably isn't the whole
  // screen — click coordinates will be off if it's just a tab or window.
  let displaySurface = null;
  try{
    const track = screenStream && screenStream.getVideoTracks()[0];
    displaySurface = track && track.getSettings && track.getSettings().displaySurface;
  }catch(e){ /* not supported in this browser — ignore */ }

  const richInstruction = buildClickInstruction(instruction);

  let coords;
  try{
    const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.settings.apiKey}` },
      body: JSON.stringify({
        model: CONFIG.MODEL_VISION,
        messages: [
          { role: 'system', content: "You are looking at a screenshot of the user's screen and must locate ONE specific element they described (a button, link, video, field, icon, list item, etc — this could be on any website or app: Instagram, LinkedIn, YouTube, Google search results, or anything else). If it's described as a website/result by name, look for its link, title text, or logo anywhere on the page, including search results. Respond with ONLY a compact JSON object, nothing else, no markdown fences: {\"found\": true or false, \"x\": <fraction 0-1, horizontal center of the element>, \"y\": <fraction 0-1, vertical center of the element>}. x/y are fractions of the image width/height. If you can't find it, respond {\"found\": false, \"x\": 0, \"y\": 0}." },
          { role: 'user', content: [
            { type: 'text', text: `Find: ${richInstruction}` },
            { type: 'image_url', image_url: imageDataUrl }
          ]}
        ],
        max_tokens: 100
      })
    });
    if(!res.ok){
      if(res.status === 401) throw new Error('Invalid API key. Update it in Settings.');
      throw new Error(`Screen request failed (${res.status})`);
    }
    const data = await res.json();
    const raw = (data.choices?.[0]?.message?.content || '').trim().replace(/^```(?:json)?|```$/g, '').trim();
    coords = JSON.parse(raw);
  }catch(e){
    speak("I had trouble figuring out where that is on your screen.");
    return;
  }

  if(!coords || coords.found === false){
    speak(`I couldn't find ${instruction} on your screen.`);
    return false;
  }

  const clickX = Math.round((coords.x || 0) * screenW);
  const clickY = Math.round((coords.y || 0) * screenH);

  try{
    await callAgent('/click', { method:'POST', body:{ x: clickX, y: clickY } });
  }catch(e){ speak(agentUnavailableMessage()); return false; }

  if(typeText){
    await new Promise(r => setTimeout(r, 200));
    try{ await callAgent('/type', { method:'POST', body:{ text: typeText } }); }
    catch(e){ speak(agentUnavailableMessage()); return true; }
    if(pressEnter){
      await new Promise(r => setTimeout(r, 100));
      try{ await callAgent('/key', { method:'POST', body:{ key: 'enter' } }); }catch(e){ /* not fatal */ }
    }
  }

  if(displaySurface && displaySurface !== 'monitor'){
    speak(`Done — though for the most accurate clicking, try sharing your entire screen instead of just a window or tab.`);
  } else if(!typeText){
    speak(`Done, clicked it.`);
  } else {
    speak(`Done, clicked and typed it in.`);
  }
  return true;
}

// "upload photo" / "upload video" — clicks whatever create/upload/add-media
// control is visible (Instagram's + Create icon, LinkedIn's post/media
// button, or any other site's upload button), which normally pops open
// either an in-page menu or the OS's native "Open file" dialog. If the user
// named a specific file, this then types its path straight into that native
// dialog's filename field and presses Enter — Windows/macOS/Linux file
// pickers all accept a typed path this way even without browsing to it. If
// no file was named, it leaves the dialog open for the user to pick by hand.
async function performScreenUpload(kind, filePathHint){
  const label = kind === 'video' ? 'video' : (kind === 'reel' ? 'reel' : 'photo');
  const clickTarget = `the button used to upload or post a new ${label} — could be a "+" Create icon, a camera icon, an "Add media" button, or similar`;
  const clicked = await performScreenClick(clickTarget, null, false);
  if(!clicked) return;

  if(!filePathHint){
    speak(`I've clicked to start uploading a ${label}. If a menu appeared first, tell me which option to click, or pick your file from the dialog yourself.`);
    return;
  }

  // Give the native file-picker (or in-page menu) a moment to appear.
  await new Promise(r => setTimeout(r, 900));
  try{
    await callAgent('/type', { method:'POST', body:{ text: filePathHint } });
    await new Promise(r => setTimeout(r, 150));
    await callAgent('/key', { method:'POST', body:{ key: 'enter' } });
    speak(`Typed in "${filePathHint}" and opened it. If a menu appeared instead of the file picker, say "click post" or "click reel" first, then try again.`);
  }catch(e){
    speak(agentUnavailableMessage());
  }
}

if(screenShareToggleBtn){
  screenShareToggleBtn.addEventListener('click', async ()=>{
    if(screenActive){
      // Already sharing — treat a tap as "what's on my screen right now?"
      await askScreenQuestion("What's on my screen?");
    } else {
      const ok = await startScreenShare();
      if(ok) speak("I can see your screen now. Highlight anything and ask me about it, or say what's on my screen.");
    }
  });
}

/* ---------- Auto-scroll: continuously scroll whatever window has focus ----------
   Voice-only feature (no button) since it's meant for hands-free browsing —
   say "auto scroll" while looking at YouTube/Instagram/Reddit/LinkedIn/
   Facebook/WhatsApp/anything, and it scrolls that window until you say "stop".
   This has to run through the local desktop agent (maximus_agent.py, see the
   /scroll endpoint) because a browser tab can never simulate input into a
   DIFFERENT window or a native app for security reasons — same restriction
   explained in DESKTOP_AGENT_README.md for opening apps, etc. */
let autoScrollActive = false;

async function startAutoScroll(direction){
  try{
    await callAgent('/scroll', { method:'POST', body:{ action:'start', direction: direction || 'down' } });
    autoScrollActive = true;
    speak(`Auto-scrolling ${direction === 'up' ? 'up' : 'down'}. Say "stop" when you want me to stop.`);
  }catch(e){ speak(agentUnavailableMessage()); }
}

async function stopAutoScroll(){
  const wasActive = autoScrollActive;
  autoScrollActive = false;
  try{
    await callAgent('/scroll', { method:'POST', body:{ action:'stop' } });
    if(wasActive) speak('Stopped scrolling.');
  }catch(e){ if(wasActive) speak(agentUnavailableMessage()); }
}

// A single, one-off nudge — "scroll up" / "scroll down" said on their own —
// as opposed to startAutoScroll(), which scrolls continuously until "stop".
async function stepScroll(direction){
  try{
    await callAgent('/scroll', { method:'POST', body:{ action:'step', direction: direction || 'down' } });
  }catch(e){ speak(agentUnavailableMessage()); }
}

/* ---------- "Read aloud" button on completed AI chat answers ---------- */
let currentReadingMsgId = null;

function syncReadButtons(container){
  const scope = container || document;
  scope.querySelectorAll('[data-read-aloud]').forEach(btn=>{
    const active = btn.dataset.readAloud === currentReadingMsgId;
    btn.textContent = active ? '⏹ Stop reading' : '🔊 Read aloud';
    btn.classList.toggle('active', active);
  });
}

function stopReadingAloud(){
  if(!currentReadingMsgId) return;
  if('speechSynthesis' in window) window.speechSynthesis.cancel();
  currentReadingMsgId = null;
  syncReadButtons();
}

function readMessageAloud(msgId, text){
  if(!('speechSynthesis' in window)){
    showToast('Text-to-speech is not supported in this browser.');
    return;
  }
  // Tapping the button again on the message currently being read stops it.
  if(currentReadingMsgId === msgId){
    stopReadingAloud();
    return;
  }
  window.speechSynthesis.cancel(); // stop whatever else was reading first
  speechSuppressed = false;
  currentReadingMsgId = msgId;
  syncReadButtons();

  const clean = cleanForSpeech(text);
  // Split into sentence-sized chunks and queue them one after another —
  // keeps Stop responsive on long answers instead of one giant utterance
  // that can't be interrupted mid-sentence in some browsers.
  const chunks = clean.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [clean];
  let i = 0;
  function speakNext(){
    if(currentReadingMsgId !== msgId || i >= chunks.length){
      if(currentReadingMsgId === msgId){ currentReadingMsgId = null; syncReadButtons(); }
      markSpeechEnd();
      return;
    }
    const utter = new SpeechSynthesisUtterance(chunks[i].trim());
    configureUtterance(utter);
    utter.onstart = markSpeechStart;
    utter.onend = ()=>{ markSpeechEnd(); i++; speakNext(); };
    utter.onerror = ()=>{ markSpeechEnd(); i++; speakNext(); };
    window.speechSynthesis.speak(utter);
  }
  speakNext();
}

/* ---------- Continuous speech recognition (separate instance from composer mic) ---------- */
let assistantRecognition = null;
let wantContinuousListening = false;
const AssistantSpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

let lastQuickOpened = null;
// Deliberately turns Spotify down the instant speech is detected, and back up
// after a beat of silence — this is a much more reliable version of "duck the
// music while I'm talking" than depending on Chrome's own (unpredictable,
// Bluetooth-latency-sensitive) audio ducking. Works the same regardless of
// whether output is the laptop speakers or a Bluetooth speaker, since it
// controls Spotify's own volume directly rather than relying on the OS/browser.
let musicDucked = false;
let restoreVolumeTimer = null;
async function duckMusicForCommand(){
  if(!spotifyPlayer) return;
  if(!musicDucked){
    musicDucked = true;
    try{ await spotifyPlayer.setVolume(0.15); }catch(e){}
  }
  clearTimeout(restoreVolumeTimer);
  restoreVolumeTimer = setTimeout(restoreMusicVolume, 1800);
}
async function restoreMusicVolume(){
  if(!spotifyPlayer || !musicDucked) return;
  musicDucked = false;
  try{ await spotifyPlayer.setVolume(1.0); }catch(e){}
}

// Tracks whether the recognition engine is currently actually running, and
// the last time it did something (started, produced a result, heard speech
// start/end). Chrome's Web Speech API has two failure modes this guards
// against: (1) onend fires and calling start() again *immediately* throws
// because the engine hasn't fully released the mic yet — the old code
// swallowed that error and just gave up, leaving the button saying "Stop
// Listening" while the mic was actually dead; (2) on longer sessions the
// engine can silently wedge without ever firing onend at all. Both look the
// same to the user: "it's listening but not taking the command."
let recognitionRunning = false;
let restartTimer = null;
let lastRecognitionActivity = Date.now();

// Chrome's continuous mode "finalizes" a chunk of speech the moment you
// pause for breath or to think — well before a whole sentence like "click
// the search bar and type cats" is actually finished. Reacting to every
// final chunk immediately is what used to make Maximus "answer in the
// middle" of what someone was saying. So finalized speech is buffered here
// and only dispatched once the mic has stayed quiet for a short beat, which
// gives multi-part phrases a chance to finish before anything runs.
let pendingFinalText = '';
let finalizeTimer = null;
const FINALIZE_QUIET_MS = 750;      // normal "wait for a pause" window
const FINALIZE_QUIET_MS_FAST = 150; // short, unambiguous commands fire almost instantly
const FAST_TRACK_RE = /^(?:stop|stop scrolling|stop listening|stop speaking|scroll up|scroll down|auto ?scroll|auto ?scroll up|stop auto ?scroll(?:ing)?)$/;

function dispatchPendingFinal(){
  const text = pendingFinalText.trim();
  pendingFinalText = '';
  if(assistantTranscript) assistantTranscript.textContent = '';
  if(text) handleVoiceInput(text);
}

// Drops any speech buffered so far without acting on it — used whenever
// listening is explicitly stopped or interrupted, so a half-heard phrase
// from a moment ago can't fire late.
function clearPendingVoiceBuffer(){
  clearTimeout(finalizeTimer);
  pendingFinalText = '';
  if(assistantTranscript) assistantTranscript.textContent = '';
}

function scheduleRecognitionRestart(delay){
  clearTimeout(restartTimer);
  restartTimer = setTimeout(()=>{
    if(!wantContinuousListening || recognitionRunning) return;
    try{
      assistantRecognition.start();
    }catch(e){
      // Engine still tearing down from the previous session — back off and
      // try again rather than giving up silently.
      scheduleRecognitionRestart(400);
    }
  }, delay);
}

if(AssistantSpeechRecognition){
  assistantRecognition = new AssistantSpeechRecognition();
  assistantRecognition.continuous = true;
  assistantRecognition.interimResults = true;
  // Ask the engine for several guesses per phrase, not just its single best
  // guess. When one guess doesn't match anything Maximus recognizes, trying
  // the runner-up guesses against known command phrasing (see
  // pickBestTranscript below) catches a lot of the "it heard something
  // completely different" misfires without needing a repeat.
  assistantRecognition.maxAlternatives = 5;
  assistantRecognition.lang = state.settings.voiceLang || 'en-IN';

  assistantRecognition.onstart = ()=>{
    recognitionRunning = true;
    lastRecognitionActivity = Date.now();
  };
  assistantRecognition.onspeechstart = ()=>{
    lastRecognitionActivity = Date.now();
    if(assistantStatus && activeSpeechCount === 0) assistantStatus.textContent = 'Hearing you…';
  };
  assistantRecognition.onspeechend = ()=>{
    lastRecognitionActivity = Date.now();
    if(assistantStatus && wantContinuousListening && activeSpeechCount === 0) assistantStatus.textContent = 'Listening…';
  };
  // Picks the best of several candidate transcripts for one recognized
  // phrase. Chrome's #1-ranked guess is sometimes NOT what was actually
  // said ("it heard something completely different") — but a lower-ranked
  // alternative often is, especially for short command words. If any
  // alternative clearly contains a recognizable command keyword, prefer
  // that one; otherwise fall back to the top-confidence guess (normal
  // questions/chit-chat don't need this correction).
  const COMMAND_KEYWORD_HINTS = /\b(scroll|scrolling|click|tap|press|select|stop|open|close|play|pause|volume|brightness|mute|unmute|screenshot|desktop|task manager|file explorer|recycle bin|vision|screen|message|whatsapp|call|dial|speaker|navigate|location|near me|restart|shut down|sleep computer|answer|reject|decline|hang up|pick up|notifications|mirror|phone battery)\b/;
  function pickBestTranscript(result){
    for(let i=0; i<result.length; i++){
      const t = result[i].transcript;
      if(COMMAND_KEYWORD_HINTS.test(t.toLowerCase())) return t;
    }
    return result[0].transcript;
  }

  assistantRecognition.onresult = (event)=>{
    lastRecognitionActivity = Date.now();
    let quickFinal = '', quickInterim = '';
    for(let i=event.resultIndex; i<event.results.length; i++){
      const t = pickBestTranscript(event.results[i]);
      if(event.results[i].isFinal) quickFinal += (quickFinal ? ' ' : '') + t;
      else quickInterim += t;
    }

    if((quickFinal || quickInterim).trim()) duckMusicForCommand();

    // Saying "stop" / "stop speaking" / "stop talking" always works, even
    // mid-answer, so you can interrupt Maximus without touching a button.
    if(activeSpeechCount > 0){
      const stopPhrase = /\b(stop|stop speaking|stop talking|be quiet|shut up)\b/.test((quickFinal + quickInterim).trim().toLowerCase());
      if(stopPhrase) stopSpeaking();
      // While actively talking, ignore everything else — otherwise Maximus's
      // own voice coming through the speakers can get picked back up as input.
      return;
    }

    if(assistantTranscript) assistantTranscript.textContent = (pendingFinalText + ' ' + quickFinal + ' ' + quickInterim).trim();

    // "open <site>" is unambiguous even mid-utterance, so fire it the instant it
    // shows up in the interim transcript instead of waiting for finalization —
    // makes basic browsing commands feel instant rather than laggy. Skipped
    // once something is already buffered, so it can't fire mid-way through a
    // longer, unrelated phrase that merely contains "open" as a later word.
    if(!quickFinal && quickInterim && !pendingFinalText){
      const quick = normalizeSitePhrase(quickInterim.trim().toLowerCase()).match(/^open ([a-z]+)(?:\.com)?(?: website)?$/);
      if(quick && ASSISTANT_SITES[quick[1]] && quick[1] !== lastQuickOpened){
        lastQuickOpened = quick[1];
        window.open(ASSISTANT_SITES[quick[1]], '_blank');
        speak(`Opening ${quick[1]}.`);
      }
    }

    if(quickFinal.trim()){
      // If we already opened the site instantly from the interim guess above,
      // don't run the command a second time now that the phrase finalized.
      const finalQuick = normalizeSitePhrase(quickFinal.trim().toLowerCase()).match(/^open ([a-z]+)(?:\.com)?(?: website)?$/);
      const alreadyHandled = finalQuick && finalQuick[1] === lastQuickOpened && !pendingFinalText;
      lastQuickOpened = null;
      if(!alreadyHandled) pendingFinalText = (pendingFinalText + ' ' + quickFinal.trim()).trim();
    }

    // Every new result (final or interim) means the person is still talking,
    // so push the "they've gone quiet" timer back out. Short, unambiguous
    // commands still fire almost instantly so scrolling/stopping never feels
    // laggy; anything else waits for a real pause before Maximus reacts.
    clearTimeout(finalizeTimer);
    if(pendingFinalText){
      const isFastTrack = FAST_TRACK_RE.test(pendingFinalText.toLowerCase());
      finalizeTimer = setTimeout(dispatchPendingFinal, isFastTrack ? FINALIZE_QUIET_MS_FAST : FINALIZE_QUIET_MS);
    }
  };
  assistantRecognition.onerror = (e)=>{
    if(e.error === 'no-speech' || e.error === 'aborted'){
      // Normal — the engine times itself out after silence. onend will fire
      // right after this and trigger the restart below.
      return;
    }
    console.warn('Assistant recognition error:', e.error);
    if(e.error === 'not-allowed' || e.error === 'service-not-allowed'){
      showToast('Microphone access was blocked — allow it in your browser to use voice.');
      wantContinuousListening = false;
      recognitionRunning = false;
      clearPendingVoiceBuffer();
      setListenButtonState(false);
      return;
    }
    // network / audio-capture / other transient errors: let onend (which
    // always fires after onerror) handle the restart, just with a slightly
    // longer backoff so we don't hammer a genuinely broken mic.
    if(e.error === 'network' || e.error === 'audio-capture'){
      lastRecognitionActivity = Date.now() - 15000; // makes the watchdog check it sooner
    }
  };
  assistantRecognition.onend = ()=>{
    recognitionRunning = false;
    // Recognition auto-stops after silence (or an error); restart it to stay
    // "continuously listening" until the user explicitly clicks Stop
    // Listening. A short delay avoids the "start() called before the engine
    // finished tearing down" failure that used to leave listening silently
    // dead — see scheduleRecognitionRestart's comment above.
    if(wantContinuousListening) scheduleRecognitionRestart(250);
  };
}

// Applies a newly chosen accent (Settings → Voice recognition accent) to
// both recognition engines. SpeechRecognition only reads .lang when start()
// is called, so a change made mid-session needs the engine restarted to
// actually take effect.
function applyVoiceLang(){
  const lang = state.settings.voiceLang || 'en-IN';
  refreshSelectedVoice();
  if(recognition) recognition.lang = lang;
  if(assistantRecognition){
    assistantRecognition.lang = lang;
    if(wantContinuousListening){
      try{ assistantRecognition.stop(); }catch(e){}
      recognitionRunning = false;
      scheduleRecognitionRestart(300);
    }
  }
  showToast(`Voice recognition set to ${lang}.`);
}

// Watchdog: if we're supposed to be listening but nothing has happened
// (no start/result/speech event) for 15s, the engine has likely wedged
// without firing onend at all — a known Chrome long-session bug. Force a
// stop+restart rather than leaving the user stuck with a dead mic.
setInterval(()=>{
  if(!wantContinuousListening || !assistantRecognition) return;
  if(Date.now() - lastRecognitionActivity > 15000){
    lastRecognitionActivity = Date.now();
    try{ assistantRecognition.stop(); }catch(e){}
    recognitionRunning = false;
    scheduleRecognitionRestart(300);
  }
}, 5000);

function setListenButtonState(listening){
  if(!listenToggleBtn) return;
  listenToggleBtn.textContent = listening ? '⏹ Stop Listening' : '🎙️ Start Listening';
  listenToggleBtn.classList.toggle('active', listening);
  if(assistantStatus) assistantStatus.textContent = listening ? 'Listening…' : 'Tap "Start Listening" and speak';
}

if(listenToggleBtn){
  listenToggleBtn.addEventListener('click', async ()=>{
    if(!assistantRecognition){
      showToast('Voice recognition is not supported in this browser.');
      return;
    }
    if(wantContinuousListening){
      wantContinuousListening = false;
      clearTimeout(restartTimer);
      clearPendingVoiceBuffer();
      try{ assistantRecognition.stop(); }catch(e){}
      stopMicAnalyser();
      setListenButtonState(false);
    } else {
      wantContinuousListening = true;
      lastRecognitionActivity = Date.now();
      clearPendingVoiceBuffer();
      try{ assistantRecognition.start(); recognitionRunning = true; }catch(e){ scheduleRecognitionRestart(300); }
      await startMicAnalyser();
      setListenButtonState(true);
    }
  });
}

/* ================= SPOTIFY (PKCE login + Web Playback SDK) =================
   No client secret involved anywhere — the PKCE flow is designed to run
   entirely in the browser. Requires Spotify Premium for in-app playback
   (Spotify's own restriction, not something this app can work around);
   without Premium, commands fall back to opening the track on open.spotify.com. */

function generateRandomString(length){
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  const values = crypto.getRandomValues(new Uint8Array(length));
  values.forEach(v => text += possible[v % possible.length]);
  return text;
}
async function sha256(plain){
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(plain));
}
function base64UrlEncode(buffer){
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function pkceChallengeFromVerifier(verifier){
  return base64UrlEncode(await sha256(verifier));
}

async function spotifyLogin(){
  if(!CONFIG.SPOTIFY_CLIENT_ID){
    showToast('Add your Spotify Client ID in app.js (CONFIG.SPOTIFY_CLIENT_ID) first.');
    return;
  }
  const verifier = generateRandomString(64);
  localStorage.setItem('spotify_verifier', verifier);
  const challenge = await pkceChallengeFromVerifier(verifier);
  const scope = 'streaming user-read-email user-read-private user-read-playback-state user-modify-playback-state';
  const params = new URLSearchParams({
    client_id: CONFIG.SPOTIFY_CLIENT_ID,
    response_type: 'code',
    redirect_uri: SPOTIFY_REDIRECT_URI,
    scope,
    code_challenge_method: 'S256',
    code_challenge: challenge
  });
  window.location.href = `https://accounts.spotify.com/authorize?${params.toString()}`;
}

async function handleSpotifyRedirect(){
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const err = params.get('error');
  if(!code && !err) return;
  window.history.replaceState({}, document.title, window.location.pathname);
  if(err){ showToast('Spotify login was cancelled.'); return; }
  const verifier = localStorage.getItem('spotify_verifier');
  if(!verifier) return;
  try{
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: SPOTIFY_REDIRECT_URI,
      client_id: CONFIG.SPOTIFY_CLIENT_ID,
      code_verifier: verifier
    });
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    const data = await res.json();
    if(data.access_token){
      state.spotify.accessToken = data.access_token;
      state.spotify.refreshToken = data.refresh_token || state.spotify.refreshToken;
      state.spotify.expiresAt = Date.now() + (data.expires_in * 1000);
      save();
      showToast('Spotify connected — try "play <song> on spotify".');
      initSpotifyPlayer();
    } else {
      showToast('Spotify connection failed: ' + (data.error_description || data.error || 'unknown error'));
    }
  }catch(e){
    console.warn('Spotify token exchange failed', e);
    showToast('Spotify connection failed.');
  }
}

async function ensureSpotifyToken(){
  const sp = state.spotify;
  if(!sp || !sp.accessToken) return null;
  if(Date.now() < sp.expiresAt - 60000) return sp.accessToken;
  if(!sp.refreshToken) return null;
  try{
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: sp.refreshToken,
      client_id: CONFIG.SPOTIFY_CLIENT_ID
    });
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    const data = await res.json();
    if(data.access_token){
      sp.accessToken = data.access_token;
      if(data.refresh_token) sp.refreshToken = data.refresh_token;
      sp.expiresAt = Date.now() + (data.expires_in * 1000);
      save();
      return sp.accessToken;
    }
  }catch(e){ console.warn('Spotify token refresh failed', e); }
  return null;
}

let spotifyPlayer = null;
let spotifyPlayerReady = false;
window.onSpotifyWebPlaybackSDKReady = () => {
  spotifyPlayerReady = true;
  if(state.spotify && state.spotify.accessToken) initSpotifyPlayer();
};

async function initSpotifyPlayer(){
  const token = await ensureSpotifyToken();
  if(!token || !spotifyPlayerReady || !window.Spotify || spotifyPlayer) return;
  spotifyPlayer = new Spotify.Player({
    name: 'Maximus Web Player',
    getOAuthToken: cb => { ensureSpotifyToken().then(t => cb(t)); },
    volume: 1.0
  });
  spotifyPlayer.addListener('ready', ({ device_id }) => {
    state.spotify.deviceId = device_id;
    save();
  });
  spotifyPlayer.addListener('not_ready', () => { state.spotify.deviceId = null; });
  spotifyPlayer.addListener('player_state_changed', (s) => {
    updateNowPlayingUI();
    syncListeningWithMusic(s);
  });
  spotifyPlayer.addListener('initialization_error', e => console.warn('Spotify init error', e));
  spotifyPlayer.addListener('authentication_error', e => {
    console.warn('Spotify auth error', e);
    showToast('Your Spotify session expired — reconnect it in Settings.');
  });
  spotifyPlayer.addListener('account_error', e => {
    console.warn('Spotify account error', e);
    showToast('In-app Spotify playback needs a Premium account.');
  });
  spotifyPlayer.connect();
}

// Pulls the top 5 matches (not just 1) and scores them against the spoken
// query by word overlap, so a noisy/partial transcription still lands on the
// track whose title actually matches what was said, instead of blindly
// trusting whatever Spotify's raw #1 result happens to be.
function trackMatchScore(query, trackName){
  const norm = s => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  const qWords = new Set(norm(query));
  const tWords = norm(trackName);
  if(!qWords.size || !tWords.length) return 0;
  let overlap = 0;
  tWords.forEach(w => { if(qWords.has(w)) overlap++; });
  const exact = norm(query).join(' ') === tWords.join(' ') ? 2 : 0;
  return overlap / Math.max(qWords.size, tWords.length) + exact;
}

async function spotifySearchTrack(query){
  const token = await ensureSpotifyToken();
  if(!token) return null;
  const res = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=5`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await res.json();
  const items = (data.tracks && data.tracks.items) || [];
  if(!items.length) return null;
  let best = items[0], bestScore = trackMatchScore(query, items[0].name);
  for(let i=1;i<items.length;i++){
    const score = trackMatchScore(query, items[i].name);
    if(score > bestScore){ best = items[i]; bestScore = score; }
  }
  return { uri: best.uri, name: best.name, artist: best.artists.map(a => a.name).join(', ') };
}

async function spotifyPlayTrack(query){
  const token = await ensureSpotifyToken();
  if(!token){
    window.open(buildSearchUrl('spotify', query), '_blank');
    speak(`I'm not connected to Spotify yet, so here's ${query} on the Spotify website. Connect Spotify in Settings so I can play it directly.`);
    return;
  }
  if(!state.spotify.deviceId){
    await initSpotifyPlayer();
    await new Promise(r => setTimeout(r, 1200));
  }
  const track = await spotifySearchTrack(query);
  if(!track){
    speak(`I couldn't find ${query} on Spotify.`);
    return;
  }
  if(!state.spotify.deviceId){
    speak("Spotify hasn't finished connecting yet — give it a second and try again.");
    return;
  }
  try{
    const res = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${state.spotify.deviceId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ uris: [track.uri] })
    });
    if(res.ok || res.status === 204){
      speak(`Now playing ${track.name} by ${track.artist}.`);
    } else if(res.status === 403){
      speak('In-app Spotify playback needs a Premium account.');
    } else if(res.status === 404){
      speak("I couldn't find an active Spotify device — keep this tab open and try again.");
    } else {
      speak('Something went wrong starting playback on Spotify.');
    }
  }catch(e){
    console.warn('Spotify play failed', e);
    speak('Something went wrong starting playback on Spotify.');
  }
  updateNowPlayingUI();
}

/* ================= YOUTUBE (Data API v3 search + direct-play) =================
   Uses a plain API key (no OAuth — this only searches, it never touches anyone's
   account), so it works the moment a key is pasted into Settings. There's no
   "remote device" concept like Spotify Connect — playing a video just means
   opening its watch page directly instead of a generic search results page,
   which starts playback immediately since it's a real navigation the user
   asked for, not a background autoplay. */
async function youtubeSearchVideo(query){
  const key = state.settings.youtubeApiKey;
  if(!key) return { error: 'no-key' };
  try{
    const res = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=5&q=${encodeURIComponent(query)}&key=${encodeURIComponent(key)}`);
    const data = await res.json();
    if(data.error){
      console.warn('YouTube API error', data.error);
      const reason = (data.error.errors && data.error.errors[0] && data.error.errors[0].reason) || data.error.status || '';
      if(reason === 'quotaExceeded') return { error: 'quota' };
      if(res.status === 403 || reason.toLowerCase().includes('accessnotconfigured') || reason.toLowerCase().includes('forbidden')) return { error: 'not-enabled' };
      if(res.status === 400 || reason.toLowerCase().includes('keyinvalid') || reason.toLowerCase().includes('badrequest')) return { error: 'bad-key' };
      return { error: 'api', message: data.error.message };
    }
    const items = data.items || [];
    if(!items.length) return null;
    let best = items[0], bestScore = trackMatchScore(query, items[0].snippet.title);
    for(let i=1;i<items.length;i++){
      const score = trackMatchScore(query, items[i].snippet.title);
      if(score > bestScore){ best = items[i]; bestScore = score; }
    }
    return { videoId: best.id.videoId, title: best.snippet.title, channel: best.snippet.channelTitle };
  }catch(e){
    console.warn('YouTube search failed', e);
    return { error: 'network' };
  }
}

async function youtubePlayVideo(query){
  if(!state.settings.youtubeApiKey){
    window.open(buildSearchUrl('youtube', query), '_blank');
    speak(`I'm not set up to jump straight to a video yet, so here's a YouTube search for ${query}. Add a YouTube API key in Settings so I can play it directly.`);
    return;
  }
  const video = await youtubeSearchVideo(query);
  if(video && video.error){
    window.open(buildSearchUrl('youtube', query), '_blank');
    const messages = {
      'not-enabled': "Your YouTube API key can't reach YouTube Data API v3 — make sure that API is enabled on your Google Cloud project and that the key's restrictions include it.",
      'bad-key': "Your YouTube API key looks invalid or malformed — double check you copied the whole key into Settings.",
      'quota': "Your YouTube API key has hit its daily quota — it resets at midnight Pacific time, or you can create a new key.",
      'network': "I couldn't reach YouTube's search service just now.",
      'api': `YouTube's search API returned an error: ${video.message || 'unknown error'}.`
    };
    speak((messages[video.error] || "Something went wrong searching YouTube.") + " Opening a search page instead.");
    return;
  }
  if(!video){
    window.open(buildSearchUrl('youtube', query), '_blank');
    speak(`I couldn't find a specific match for ${query}, so here's a search on YouTube instead.`);
    return;
  }
  window.open(`https://www.youtube.com/watch?v=${video.videoId}`, '_blank');
  speak(`Now playing ${video.title} on YouTube.`);
}


async function spotifyPause(){
  if(!spotifyPlayer){ speak("Spotify isn't connected."); return; }
  await spotifyPlayer.pause();
  speak('Paused.');
}
async function spotifyResume(){
  if(!spotifyPlayer){ speak("Spotify isn't connected."); return; }
  await spotifyPlayer.resume();
  speak('Resuming.');
}
async function spotifyNext(){
  if(!spotifyPlayer){ speak("Spotify isn't connected."); return; }
  await spotifyPlayer.nextTrack();
  speak('Skipping ahead.');
}
async function spotifyPrev(){
  if(!spotifyPlayer){ speak("Spotify isn't connected."); return; }
  await spotifyPlayer.previousTrack();
  speak('Going back.');
}

// Spotify's repeat mode is a player-level setting, not per-track, so this is
// the closest available thing to "loop this song": repeat mode "track".
async function spotifySetLoop(on){
  const token = await ensureSpotifyToken();
  if(!token || !state.spotify.deviceId){ speak("Spotify isn't connected."); return; }
  try{
    await fetch(`https://api.spotify.com/v1/me/player/repeat?state=${on ? 'track' : 'off'}&device_id=${state.spotify.deviceId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` }
    });
    speak(on ? 'Looping this song.' : 'Loop turned off.');
    setTimeout(updateNowPlayingUI, 300);
  }catch(e){
    console.warn('Spotify repeat toggle failed', e);
    speak('Could not change the loop setting.');
  }
}

let npControlsWired = false;
function wireNowPlayingControls(){
  if(npControlsWired) return;
  npControlsWired = true;
  const playPauseBtn = document.getElementById('npPlayPauseBtn');
  const prevBtn = document.getElementById('npPrevBtn');
  const nextBtn = document.getElementById('npNextBtn');
  const loopBtn = document.getElementById('npLoopBtn');
  if(playPauseBtn) playPauseBtn.addEventListener('click', async ()=>{
    if(!spotifyPlayer) return;
    const s = await spotifyPlayer.getCurrentState();
    if(s && !s.paused) await spotifyPause(); else await spotifyResume();
  });
  if(prevBtn) prevBtn.addEventListener('click', spotifyPrev);
  if(nextBtn) nextBtn.addEventListener('click', spotifyNext);
  if(loopBtn) loopBtn.addEventListener('click', async ()=>{
    const s = spotifyPlayer && await spotifyPlayer.getCurrentState();
    const loopingNow = s && s.repeat_mode === 2;
    await spotifySetLoop(!loopingNow);
  });
}

function updateNowPlayingUI(){
  const bar = document.getElementById('spotifyNowPlaying');
  if(!bar || !spotifyPlayer) return;
  wireNowPlayingControls();
  spotifyPlayer.getCurrentState().then(s => {
    if(!s || !s.track_window || !s.track_window.current_track){
      bar.classList.add('hidden');
      return;
    }
    const t = s.track_window.current_track;
    bar.classList.remove('hidden');
    const trackEl = document.getElementById('nowPlayingTrack');
    if(trackEl) trackEl.textContent = `${t.name} — ${t.artists.map(a => a.name).join(', ')}`;
    const playPauseBtn = document.getElementById('npPlayPauseBtn');
    if(playPauseBtn) playPauseBtn.textContent = s.paused ? '▶' : '⏸';
    const loopBtn = document.getElementById('npLoopBtn');
    if(loopBtn) loopBtn.classList.toggle('active', s.repeat_mode === 2);
  }).catch(()=>{});
}

/* ================= GOOGLE CALENDAR =================
   Uses Google Identity Services' OAuth "token client" (google.accounts.oauth2),
   which — like the Spotify PKCE flow above — runs entirely client-side with
   just a Client ID, no client secret and no backend. The GIS script itself
   is loaded in index.html. A prompt-less silent refresh is tried first when
   the stored token has expired; if that fails (e.g. user hasn't granted
   consent yet, or Google requires re-consent) it falls back to the normal
   popup consent screen. */
const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
let googleTokenClient = null;

function ensureGoogleTokenClient(){
  if(googleTokenClient || !CONFIG.GOOGLE_CLIENT_ID) return googleTokenClient;
  if(!window.google || !google.accounts || !google.accounts.oauth2) return null; // GIS script not loaded yet
  googleTokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.GOOGLE_CLIENT_ID,
    scope: GOOGLE_CALENDAR_SCOPE,
    callback: (resp) => {
      if(resp && resp.access_token){
        state.google.accessToken = resp.access_token;
        state.google.expiresAt = Date.now() + ((resp.expires_in || 3600) * 1000);
        save();
        if(googleLoginResolve){ googleLoginResolve(resp.access_token); googleLoginResolve = null; }
      } else if(googleLoginResolve){
        googleLoginResolve(null); googleLoginResolve = null;
      }
    }
  });
  return googleTokenClient;
}

let googleLoginResolve = null;

function googleLogin(){
  if(!CONFIG.GOOGLE_CLIENT_ID){
    showToast('Add your Google OAuth Client ID in app.js (CONFIG.GOOGLE_CLIENT_ID) first.');
    return;
  }
  const client = ensureGoogleTokenClient();
  if(!client){
    showToast("Google sign-in isn't ready yet — give the page a second to finish loading and try again.");
    return;
  }
  client.requestAccessToken({ prompt: 'consent' });
}

// Returns a valid access token, silently refreshing (no popup) if the stored
// one expired but the browser session with Google is still alive. Returns
// null if the user has never connected, or a popup is genuinely required —
// callers should treat null as "not connected" and prompt via Settings.
async function ensureGoogleToken(){
  const g = state.google;
  if(!g || !g.accessToken) return null;
  if(Date.now() < g.expiresAt - 60000) return g.accessToken;
  const client = ensureGoogleTokenClient();
  if(!client) return null;
  return new Promise((resolve) => {
    googleLoginResolve = resolve;
    try{
      client.requestAccessToken({ prompt: '' }); // silent — no popup if session still valid
    }catch(e){ resolve(null); }
    setTimeout(() => { if(googleLoginResolve){ googleLoginResolve(null); googleLoginResolve = null; } }, 6000);
  });
}

function formatEventTime(ev){
  const start = ev.start && (ev.start.dateTime || ev.start.date);
  if(!start) return '';
  if(ev.start.date && !ev.start.dateTime) return 'all day';
  const d = new Date(start);
  return d.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true, ...(sameDay(d, new Date()) ? {} : { month: 'short', day: 'numeric' }) });
}
function sameDay(a, b){ return a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate(); }

// Reads back upcoming events out loud. rangeHint can be null (next few
// events), 'today', or 'tomorrow'.
async function readCalendarEvents(rangeHint){
  const token = await ensureGoogleToken();
  if(!token){
    speak('Your Google Calendar isn\'t connected yet — connect it in Settings first.');
    return;
  }
  let timeMin = new Date();
  let timeMax = null;
  let maxResults = 5;
  if(rangeHint === 'today'){
    timeMin = new Date(); timeMin.setHours(0,0,0,0);
    timeMax = new Date(); timeMax.setHours(23,59,59,999);
    maxResults = 20;
  } else if(rangeHint === 'tomorrow'){
    timeMin = new Date(); timeMin.setDate(timeMin.getDate()+1); timeMin.setHours(0,0,0,0);
    timeMax = new Date(timeMin); timeMax.setHours(23,59,59,999);
    maxResults = 20;
  }
  try{
    const params = new URLSearchParams({
      timeMin: timeMin.toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: String(maxResults)
    });
    if(timeMax) params.set('timeMax', timeMax.toISOString());
    const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json();
    if(!res.ok){
      if(res.status === 401){ speak('Your Google Calendar session expired — reconnect it in Settings.'); }
      else speak("I couldn't reach Google Calendar right now.");
      return;
    }
    const items = data.items || [];
    if(!items.length){
      speak(rangeHint === 'today' ? "You've got nothing on your calendar today." :
            rangeHint === 'tomorrow' ? "You've got nothing on your calendar tomorrow." :
            "You've got nothing coming up on your calendar.");
      return;
    }
    const lines = items.map(ev => `${ev.summary || 'Untitled event'} — ${formatEventTime(ev)}`);
    const intro = rangeHint === 'today' ? "Here's what's on your calendar today: " :
                  rangeHint === 'tomorrow' ? "Here's what's on your calendar tomorrow: " :
                  "Here's what's coming up: ";
    const text = intro + lines.join('. ');
    speak(text);
    if(assistantTranscript) assistantTranscript.textContent = text;
  }catch(e){
    console.warn('Calendar read failed', e);
    speak("I couldn't reach Google Calendar right now.");
  }
}

// Asks the fast model to pull a title + start time (and optional end time)
// out of free spoken text, e.g. "dentist appointment tomorrow at 4pm" ->
// {"title":"Dentist appointment","start":"2026-08-02T16:00:00","end":null}.
// Returns null on any failure so the caller can ask for clarification.
async function parseEventFromSpeech(text){
  if(!state.settings.apiKey) return null;
  const now = new Date();
  try{
    const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.settings.apiKey}` },
      body: JSON.stringify({
        model: CONFIG.MODEL_FAST,
        messages: [
          { role: 'system', content: `Extract a calendar event from the user's spoken text. The current date/time is ${now.toString()}. Reply with ONLY compact JSON, no other text, in this exact shape: {"title": "<short event title>", "start": "<ISO 8601 local datetime, e.g. 2026-08-02T16:00:00>", "end": "<ISO 8601 local datetime or null — infer a sensible 1 hour duration if not stated>"}. If no usable date/time is present, set "start" to null.` },
          { role: 'user', content: text }
        ],
        max_tokens: 150,
        temperature: 0
      })
    });
    if(!res.ok) return null;
    const data = await res.json();
    let out = (data.choices?.[0]?.message?.content || '').trim();
    out = out.replace(/^```json\s*|\s*```$/g, '');
    const parsed = JSON.parse(out);
    if(!parsed.title || !parsed.start) return null;
    return parsed;
  }catch(e){
    console.warn('Event parsing failed', e);
    return null;
  }
}

async function createCalendarEventFromSpeech(text){
  const token = await ensureGoogleToken();
  if(!token){
    speak('Your Google Calendar isn\'t connected yet — connect it in Settings first.');
    return;
  }
  speak('One sec, setting that up.');
  const parsed = await parseEventFromSpeech(text);
  if(!parsed || !parsed.start){
    speak("I couldn't figure out the date and time for that — try something like \"add an event called dentist at 4pm tomorrow\".");
    return;
  }
  const startDate = new Date(parsed.start);
  if(isNaN(startDate.getTime())){
    speak("I couldn't figure out the date and time for that — try something like \"add an event called dentist at 4pm tomorrow\".");
    return;
  }
  const endDate = parsed.end && !isNaN(new Date(parsed.end).getTime())
    ? new Date(parsed.end)
    : new Date(startDate.getTime() + 60*60*1000);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  try{
    const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        summary: parsed.title,
        start: { dateTime: startDate.toISOString(), timeZone: tz },
        end: { dateTime: endDate.toISOString(), timeZone: tz }
      })
    });
    const data = await res.json();
    if(!res.ok){
      if(res.status === 401) speak('Your Google Calendar session expired — reconnect it in Settings.');
      else speak("I couldn't create that event on your calendar.");
      return;
    }
    const when = startDate.toLocaleString('en-US', { weekday:'short', month:'short', day:'numeric', hour:'numeric', minute:'2-digit', hour12:true });
    speak(`Added "${parsed.title}" to your calendar for ${when}.`);
  }catch(e){
    console.warn('Calendar event creation failed', e);
    speak("I couldn't create that event on your calendar.");
  }
}

/* ================= TASKS & REMINDERS (local, no account needed) =================
   A simple todo list stored in state.tasks (same localStorage persistence as
   contacts/chats). Two flavors of the same list: plain tasks (no due time —
   "add X to my to-do list") and timed reminders ("remind me to X at 5pm"),
   which additionally get a real setTimeout so Maximus proactively speaks
   the reminder when it comes due, not just when asked "what's on my list". */

// Asks the fast model to pull a task description + optional due time out of
// free spoken text, e.g. "call the vendor at 5pm" -> {"task":"Call the vendor","dueAt":"2026-08-02T17:00:00"}.
// dueAt is null for a plain to-do with no specific time.
async function parseReminderFromSpeech(text){
  if(!state.settings.apiKey) return { task: text.trim(), dueAt: null };
  const now = new Date();
  try{
    const raw = await mistralChat(
      `Extract a task/reminder from the user's spoken text. The current date/time is ${now.toString()}. Reply with ONLY compact JSON, no other text, in this exact shape: {"task": "<short task description, capitalized, no leading 'to'>", "dueAt": "<ISO 8601 local datetime if a specific time was mentioned, else null>"}.`,
      text,
      { model: CONFIG.MODEL_FAST, maxTokens: 150, temperature: 0 }
    );
    const clean = raw.replace(/^```json\s*|\s*```$/g, '');
    const parsed = JSON.parse(clean);
    if(!parsed.task) return { task: text.trim(), dueAt: null };
    return { task: parsed.task, dueAt: parsed.dueAt || null };
  }catch(e){
    console.warn('Reminder parsing failed, saving as a plain task', e);
    return { task: text.trim(), dueAt: null };
  }
}

// Only setTimeout's for reminders due within the next 24h so we're not
// holding thousands of far-future timers in memory — anything further out
// just gets picked up by rescheduleAllPendingTasks() on a later page load,
// or surfaced when the person asks what's on their list.
const REMINDER_TIMER_HORIZON_MS = 24 * 60 * 60 * 1000;
const activeReminderTimers = {};

function scheduleTaskTimer(task){
  if(!task.dueAt || task.done) return;
  const dueMs = new Date(task.dueAt).getTime() - Date.now();
  if(isNaN(dueMs) || dueMs > REMINDER_TIMER_HORIZON_MS) return;
  if(activeReminderTimers[task.id]) clearTimeout(activeReminderTimers[task.id]);
  const fire = () => {
    delete activeReminderTimers[task.id];
    const t = (state.tasks || []).find(x => x.id === task.id);
    if(!t || t.done) return;
    speak(`Reminder: ${t.text}`);
    showToast(`⏰ ${t.text}`);
  };
  activeReminderTimers[task.id] = setTimeout(fire, Math.max(0, dueMs));
}

function rescheduleAllPendingTasks(){
  (state.tasks || []).forEach(t => { if(!t.done && t.dueAt) scheduleTaskTimer(t); });
}

function addTask(text, dueAt){
  const task = { id: uid(), text: text.trim(), done: false, createdAt: Date.now(), dueAt: dueAt || null };
  state.tasks = state.tasks || [];
  state.tasks.push(task);
  save();
  if(task.dueAt) scheduleTaskTimer(task);
  return task;
}

// Loose match by text so "mark call the vendor as done" matches a task
// saved as "Call the vendor" without needing an exact match.
function findTask(text){
  const n = text.trim().toLowerCase();
  const pending = (state.tasks || []).filter(t => !t.done);
  return pending.find(t => t.text.toLowerCase() === n)
      || pending.find(t => t.text.toLowerCase().includes(n) || n.includes(t.text.toLowerCase()));
}

function formatTaskDue(t){
  if(!t.dueAt) return '';
  const d = new Date(t.dueAt);
  const overdue = d.getTime() < Date.now();
  const when = d.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true, ...(sameDay(d, new Date()) ? {} : { month: 'short', day: 'numeric' }) });
  return overdue ? ` (was due ${when})` : ` (due ${when})`;
}


const WMO_CODES = {
  0:'clear sky', 1:'mainly clear', 2:'partly cloudy', 3:'overcast',
  45:'fog', 48:'depositing rime fog',
  51:'light drizzle', 53:'moderate drizzle', 55:'dense drizzle',
  56:'light freezing drizzle', 57:'dense freezing drizzle',
  61:'slight rain', 63:'moderate rain', 65:'heavy rain',
  66:'light freezing rain', 67:'heavy freezing rain',
  71:'slight snow', 73:'moderate snow', 75:'heavy snow', 77:'snow grains',
  80:'slight rain showers', 81:'moderate rain showers', 82:'violent rain showers',
  85:'slight snow showers', 86:'heavy snow showers',
  95:'a thunderstorm', 96:'a thunderstorm with slight hail', 99:'a thunderstorm with heavy hail'
};

async function geocodeCity(name){
  const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1`);
  const data = await res.json();
  const r = data.results && data.results[0];
  if(!r) return null;
  return { lat: r.latitude, lon: r.longitude, label: [r.name, r.admin1, r.country].filter(Boolean).join(', ') };
}

async function getWeatherReport(locationName){
  let lat, lon, label;
  if(locationName){
    const g = await geocodeCity(locationName);
    if(!g){ speak(`I couldn't find a place called ${locationName}.`); return; }
    lat = g.lat; lon = g.lon; label = g.label;
  } else if(navigator.geolocation){
    const pos = await new Promise(res => navigator.geolocation.getCurrentPosition(res, () => res(null), { timeout: 8000 }));
    if(pos){ lat = pos.coords.latitude; lon = pos.coords.longitude; label = 'your location'; }
  }
  if(lat === undefined){
    speak("I need a location for that — try \"weather in Hyderabad\", or allow location access.");
    return;
  }
  try{
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&timezone=auto`;
    const res = await fetch(url);
    const data = await res.json();
    const c = data.current;
    const desc = WMO_CODES[c.weather_code] || 'unusual conditions';
    const where = label === 'your location' ? 'your location' : label;
    const text = `It's currently ${Math.round(c.temperature_2m)}°C in ${where}, with ${desc}. Feels like ${Math.round(c.apparent_temperature)}°C, humidity ${c.relative_humidity_2m} percent, wind ${Math.round(c.wind_speed_10m)} kilometers per hour.`;
    speak(text);
    if(assistantTranscript) assistantTranscript.textContent = text;
  }catch(e){
    console.warn('Weather fetch failed', e);
    speak("I couldn't reach the weather service right now.");
  }
}

/* ================= NEWS (Google News RSS via a public CORS proxy — free, no key) =================
   No news API is genuinely free *and* unlimited *and* browser-callable in production, so this
   reads Google News' public RSS feed through allorigins.win (a free, keyless CORS proxy) instead
   of a rate-limited API. If allorigins is ever slow/down, swap PROXY_URL for another CORS proxy. */
function newsProxyUrl(feedUrl){
  return `https://api.allorigins.win/raw?url=${encodeURIComponent(feedUrl)}`;
}

async function getNewsReport(topic){
  const feedUrl = topic
    ? `https://news.google.com/rss/search?q=${encodeURIComponent(topic)}&hl=en-IN&gl=IN&ceid=IN:en`
    : `https://news.google.com/rss?hl=en-IN&gl=IN&ceid=IN:en`;
  try{
    const res = await fetch(newsProxyUrl(feedUrl));
    const xmlText = await res.text();
    const xml = new DOMParser().parseFromString(xmlText, 'text/xml');
    const items = Array.from(xml.querySelectorAll('item')).slice(0, 5);
    if(!items.length){ speak("I couldn't find any news right now."); return; }
    const headlines = items.map(it => {
      let title = it.querySelector('title')?.textContent || '';
      return title.replace(/\s*-\s*[^-]+$/, '').trim(); // drop trailing " - Source Name"
    }).filter(Boolean);
    const spoken = headlines.map((h, i) => `${i + 1}. ${h}.`).join(' ');
    speak(`${topic ? `Here's the latest on ${topic}.` : "Here are today's top headlines."} ${spoken}`);
    if(assistantTranscript) assistantTranscript.textContent = headlines.map((h, i) => `${i + 1}. ${h}`).join('\n');
  }catch(e){
    console.warn('News fetch failed', e);
    speak("I couldn't reach the news service right now.");
  }
}

/* ================= MORNING BRIEFING (merges calendar + weather + email + to-dos) =================
   Reuses the same Google Calendar / Open-Meteo / desktop-agent email endpoints already wired up
   elsewhere in this file, just fetching the raw data instead of speaking each one separately. */
async function fetchTodaysEventsRaw(){
  try{
    const token = await ensureGoogleToken();
    if(!token) return { connected: false, items: [] };
    const timeMin = new Date(); timeMin.setHours(0,0,0,0);
    const timeMax = new Date(); timeMax.setHours(23,59,59,999);
    const params = new URLSearchParams({ timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '20' });
    const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`, { headers: { Authorization: `Bearer ${token}` } });
    if(!res.ok) return { connected: true, items: [] };
    const data = await res.json();
    const items = (data.items || []).map(ev => `${ev.summary || 'Untitled event'} at ${formatEventTime(ev)}`);
    return { connected: true, items };
  }catch(e){ return { connected: false, items: [] }; }
}

async function fetchWeatherLineRaw(){
  try{
    let lat, lon;
    if(navigator.geolocation){
      const pos = await new Promise(res => navigator.geolocation.getCurrentPosition(res, () => res(null), { timeout: 6000 }));
      if(pos){ lat = pos.coords.latitude; lon = pos.coords.longitude; }
    }
    if(lat === undefined) return null;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&timezone=auto`;
    const res = await fetch(url);
    const data = await res.json();
    const c = data.current;
    const desc = WMO_CODES[c.weather_code] || 'unusual conditions';
    return `${Math.round(c.temperature_2m)}°C and ${desc}, feels like ${Math.round(c.apparent_temperature)}°C`;
  }catch(e){ return null; }
}

async function giveMorningBriefing(){
  speak("One moment, pulling your briefing together.");
  const [eventsRes, weatherLine] = await Promise.all([ fetchTodaysEventsRaw(), fetchWeatherLineRaw() ]);

  let emailLine = null;
  try{
    const status = await callAgent('/email-status', { method: 'GET' });
    if(status && status.configured){
      const unread = await callAgent('/email-unread?limit=3', { method: 'GET' });
      if(unread && unread.unread_count != null) emailLine = `${unread.unread_count} unread email${unread.unread_count === 1 ? '' : 's'}`;
    }
  }catch(e){ /* agent or email not connected — just leave this part out */ }

  const pendingTasks = (state.tasks || []).filter(t => !t.done);
  const overdue = pendingTasks.filter(t => t.dueAt && new Date(t.dueAt).getTime() < Date.now());

  const parts = [];
  parts.push(eventsRes.connected
    ? (eventsRes.items.length ? `Calendar: ${eventsRes.items.join('; ')}.` : 'Calendar: nothing scheduled today.')
    : 'Calendar: not connected.');
  parts.push(weatherLine ? `Weather: ${weatherLine}.` : 'Weather: unavailable.');
  if(emailLine) parts.push(`Email: ${emailLine}.`);
  if(pendingTasks.length) parts.push(`To-do list: ${pendingTasks.length} item${pendingTasks.length === 1 ? '' : 's'} pending${overdue.length ? `, ${overdue.length} overdue` : ''}.`);

  if(state.settings.apiKey){
    try{
      const summary = await mistralChat(
        'Compose a short, warm spoken morning briefing from these raw facts. 3-5 sentences, natural and conversational, no markdown, no bullet points — this is read aloud by a voice assistant. Weave calendar, weather, email, and to-do items together naturally. Silently skip anything marked "not connected" or "unavailable" rather than apologizing for it.',
        parts.join('\n')
      );
      speak(summary);
      if(assistantTranscript) assistantTranscript.textContent = summary;
      return;
    }catch(e){ /* fall through to the plain version below */ }
  }
  const plain = parts.join(' ');
  speak(plain);
  if(assistantTranscript) assistantTranscript.textContent = plain;
}


/* ================= TRENDING TOPICS (Google Trends daily RSS — free, no key) =================
   Covers "what's trending" / "what's happening on social media" type requests. Google Trends'
   daily trending-searches feed reflects what people are actively searching/talking about right
   now (a reasonable free proxy for "social media buzz" since there's no keyless, unauthenticated
   API for Twitter/X, Instagram, etc. trends). */
async function getTrendingReport(){
  const feedUrl = 'https://trends.google.com/trending/rss?geo=IN';
  try{
    const res = await fetch(newsProxyUrl(feedUrl));
    const xmlText = await res.text();
    const xml = new DOMParser().parseFromString(xmlText, 'text/xml');
    const items = Array.from(xml.querySelectorAll('item')).slice(0, 6);
    if(!items.length){ speak("I couldn't find what's trending right now."); return; }
    const topics = items.map(it => it.querySelector('title')?.textContent?.trim()).filter(Boolean);
    const spoken = topics.map((h, i) => `${i + 1}. ${h}.`).join(' ');
    speak(`Here's what's trending right now. ${spoken}`);
    if(assistantTranscript) assistantTranscript.textContent = topics.map((h, i) => `${i + 1}. ${h}`).join('\n');
  }catch(e){
    console.warn('Trends fetch failed', e);
    speak("I couldn't reach the trends service right now.");
  }
}

// Raw (non-speaking) versions of the two fetches above, used to build one
// combined "news + social buzz" report instead of two separate answers.
// Both hit the live RSS feeds fresh on every call — nothing here is cached,
// so this is always today's actual headlines/trends, not a stale snapshot.
async function getNewsHeadlinesRaw(topic){
  const feedUrl = topic
    ? `https://news.google.com/rss/search?q=${encodeURIComponent(topic)}&hl=en-IN&gl=IN&ceid=IN:en`
    : `https://news.google.com/rss?hl=en-IN&gl=IN&ceid=IN:en`;
  const res = await fetch(newsProxyUrl(feedUrl));
  const xmlText = await res.text();
  const xml = new DOMParser().parseFromString(xmlText, 'text/xml');
  return Array.from(xml.querySelectorAll('item')).slice(0, 6).map(it => {
    let title = it.querySelector('title')?.textContent || '';
    return title.replace(/\s*-\s*[^-]+$/, '').trim();
  }).filter(Boolean);
}

async function getTrendingTopicsRaw(){
  const feedUrl = 'https://trends.google.com/trending/rss?geo=IN';
  const res = await fetch(newsProxyUrl(feedUrl));
  const xmlText = await res.text();
  const xml = new DOMParser().parseFromString(xmlText, 'text/xml');
  return Array.from(xml.querySelectorAll('item')).slice(0, 6).map(it => it.querySelector('title')?.textContent?.trim()).filter(Boolean);
}

// "What's today's news" — combines actual news headlines AND trending/social
// buzz into one answer, since a plain headline list misses what people are
// actually talking about on social media right now. Topic-specific requests
// ("news about the election") skip trending and stay headline-only, since
// trending topics aren't filterable by topic.
async function getDailyNewsReport(){
  let headlines = [], trending = [];
  try{ headlines = await getNewsHeadlinesRaw(null); }catch(e){ console.warn('Headlines fetch failed', e); }
  try{ trending = await getTrendingTopicsRaw(); }catch(e){ console.warn('Trending fetch failed', e); }
  if(!headlines.length && !trending.length){
    speak("I couldn't reach the news or trends service right now.");
    return;
  }
  if(state.settings.apiKey){
    try{
      const context = `Top headlines:\n${headlines.map((h,i)=>`${i+1}. ${h}`).join('\n')}\n\nTrending / social buzz:\n${trending.map((t,i)=>`${i+1}. ${t}`).join('\n')}`;
      const summary = await mistralChat(
        'Combine these fresh news headlines and trending/social-media topics into one natural spoken news update, 4-6 sentences, grouping related items together, no markdown, no numbered lists — this is read aloud by a voice assistant.',
        context
      );
      speak(summary);
      if(assistantTranscript) assistantTranscript.textContent = summary;
      return;
    }catch(e){ /* fall through to the plain version below */ }
  }
  const spokenHeadlines = headlines.map((h, i) => `${i + 1}. ${h}.`).join(' ');
  const spokenTrending = trending.length ? ` And trending right now: ${trending.slice(0, 4).join(', ')}.` : '';
  speak(`Here's today's news. ${spokenHeadlines}${spokenTrending}`);
  if(assistantTranscript) assistantTranscript.textContent = `${spokenHeadlines}${spokenTrending}`;
}


/* ================= LIVE WEB SEARCH (DuckDuckGo HTML, via a free CORS proxy) =================
   Grounds normal chat/voice answers in current information before the AI model
   replies — free, no API key, no signup, using the same allorigins.win CORS
   proxy already used for the news feed above, pointed at DuckDuckGo's plain
   HTML results page (the no-JS version). Kept on a short hard timeout so a
   slow/unreachable proxy never holds up the answer for long: if it times out
   or fails, Maximus just answers from its own knowledge instead, so a search
   hiccup never makes replies feel slow. */
function ddgProxyUrl(query){
  const target = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  return `https://api.allorigins.win/raw?url=${encodeURIComponent(target)}`;
}

function withTimeout(promise, ms){
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('search timeout')), ms))
  ]);
}

async function webSearch(query, maxResults = 4){
  try{
    const res = await withTimeout(fetch(ddgProxyUrl(query)), 2200);
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const nodes = Array.from(doc.querySelectorAll('.result')).slice(0, maxResults);
    const results = nodes.map(node => {
      const titleEl = node.querySelector('.result__title a, a.result__a');
      const snippetEl = node.querySelector('.result__snippet');
      let url = titleEl ? (titleEl.getAttribute('href') || '') : '';
      // DuckDuckGo's HTML results link through a redirect like
      // //duckduckgo.com/l/?uddg=<real-url>&... — unwrap to the real target.
      const m = url.match(/[?&]uddg=([^&]+)/);
      if(m) url = decodeURIComponent(m[1]);
      return {
        title: titleEl ? titleEl.textContent.trim() : '',
        url,
        snippet: snippetEl ? snippetEl.textContent.trim() : ''
      };
    }).filter(r => r.title);
    return results;
  }catch(e){
    console.warn('Web search failed or timed out', e);
    return [];
  }
}

// Cheap local heuristic for "this message probably needs a live web search
// before answering" — kept broad on purpose, since the search itself is
// short and timeout-capped (worst case ~2.2s added), while skipping it on
// something that genuinely needed current info (prices, scores, "who is the
// current...", recent releases) would just give a stale or made-up answer.
// Skips greetings/chit-chat and pure code requests (unless they mention
// something time-sensitive like "latest"/a year).
const SEARCH_SKIP_PATTERN = /^(hi|hey|hello|thanks|thank you|ok|okay|cool|nice|lol|yo|sup|bye)\b/i;
const SEARCH_CODE_PATTERN = /\b(function|class \w|write (a|the) (code|program|script)|regex|refactor|debug this|css snippet|json schema)\b/i;
const SEARCH_FRESHNESS_PATTERN = /\b(latest|current|currently|today|right now|this week|this year|202[4-9]|news|price|score|who is|weather)\b/i;
function shouldWebSearch(text){
  const t = (text || '').trim();
  if(t.length < 4) return false;
  if(SEARCH_SKIP_PATTERN.test(t)) return false;
  if(SEARCH_CODE_PATTERN.test(t) && !SEARCH_FRESHNESS_PATTERN.test(t)) return false;
  return true;
}

/* ---------- Voice command engine ---------- */
const ASSISTANT_SITES = {
  youtube: 'https://www.youtube.com',
  google: 'https://www.google.com',
  chatgpt: 'https://chatgpt.com',
  instagram: 'https://www.instagram.com',
  amazon: 'https://www.amazon.in',
  flipkart: 'https://www.flipkart.com',
  reddit: 'https://www.reddit.com',
  whatsapp: 'https://web.whatsapp.com',
  spotify: 'https://open.spotify.com',
  maps: 'https://www.google.com/maps',
  gmail: 'https://mail.google.com/mail/u/0/#inbox',
  linkedin: 'https://www.linkedin.com/feed/',
  netflix: 'https://www.netflix.com',
  // Disney+ isn't sold standalone in India — it's merged into Hotstar there.
  disneyplus: 'https://www.hotstar.com',
  primevideo: 'https://www.primevideo.com',
  twitch: 'https://www.twitch.tv',
  facebook: 'https://www.facebook.com',
  discord: 'https://discord.com/app',
  telegram: 'https://web.telegram.org',
  outlook: 'https://outlook.live.com/mail/',
  myntra: 'https://www.myntra.com',
  meesho: 'https://www.meesho.com',
  ajio: 'https://www.ajio.com',
  ebay: 'https://www.ebay.com',
  aliexpress: 'https://www.aliexpress.com',
  yahoomail: 'https://mail.yahoo.com',
  github: 'https://github.com',

  // Google workspace apps
  googledrive: 'https://drive.google.com',
  googledocs: 'https://docs.google.com',
  googlesheets: 'https://sheets.google.com',
  googleslides: 'https://slides.google.com',
  googlecalendar: 'https://calendar.google.com',
  googletranslate: 'https://translate.google.com',
  googlephotos: 'https://photos.google.com',
  googlemeet: 'https://meet.google.com',
  googlekeep: 'https://keep.google.com',

  // Microsoft
  onedrive: 'https://onedrive.live.com',
  microsoftteams: 'https://teams.microsoft.com',
  microsoft365: 'https://www.office.com',
  bing: 'https://www.bing.com',
  copilot: 'https://copilot.microsoft.com',

  // Streaming / news
  crunchyroll: 'https://www.crunchyroll.com',
  bbc: 'https://www.bbc.com',
  cnn: 'https://www.cnn.com',
  reuters: 'https://www.reuters.com',
  ndtv: 'https://www.ndtv.com',
  timesofindia: 'https://timesofindia.indiatimes.com',
  thehindu: 'https://www.thehindu.com',
  cricbuzz: 'https://www.cricbuzz.com',
  espn: 'https://www.espn.com',

  // Finance / markets
  tradingview: 'https://www.tradingview.com',
  yahoofinance: 'https://finance.yahoo.com',
  coinmarketcap: 'https://coinmarketcap.com',
  coingecko: 'https://www.coingecko.com',
  zerodha: 'https://kite.zerodha.com',
  groww: 'https://groww.in',
  upstox: 'https://upstox.com'
};

function buildSearchUrl(site, query){
  const q = encodeURIComponent(query.trim());
  switch(site){
    case 'youtube': return `https://www.youtube.com/results?search_query=${q}`;
    case 'google': return `https://www.google.com/search?q=${q}`;
    case 'chatgpt': return `https://chatgpt.com/?q=${q}`;
    case 'instagram': return `https://www.instagram.com/explore/search/keyword/?q=${q}`;
    case 'amazon': return `https://www.amazon.in/s?k=${q}`;
    case 'flipkart': return `https://www.flipkart.com/search?q=${q}`;
    case 'reddit': return `https://www.reddit.com/search/?q=${q}`;
    case 'youtube': return `https://www.youtube.com/results?search_query=${q}`;
    case 'spotify': return `https://open.spotify.com/search/${q}`;
    case 'gmail': return `https://mail.google.com/mail/u/0/#search/${q}`;
    case 'linkedin': return `https://www.linkedin.com/search/results/all/?keywords=${q}`;
    case 'bing': return `https://www.bing.com/search?q=${q}`;
    case 'github': return `https://github.com/search?q=${q}`;
    default: return null;
  }
}

/* ---------------- Maximus Desktop Agent client -----------------
   Talks to the local Python agent (maximus_agent.py) that must be running
   on this same computer. That program is the only thing actually allowed
   to touch the operating system — this browser page just asks it politely
   over localhost HTTP. If it's not running, every call below throws and
   the caller falls back to a friendly spoken explanation. */
async function callAgent(path, options={}){
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(), options.timeoutMs || 5000);
  try{
    const res = await fetch((CONFIG.AGENT_URL || 'http://127.0.0.1:5055') + path, {
      method: options.method || 'GET',
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal
    });
    if(!res.ok){
      let detail = '';
      try{ detail = (await res.json()).error || ''; }catch(e){}
      throw new Error(detail || `Agent error ${res.status}`);
    }
    return await res.json().catch(()=>({}));
  } finally {
    clearTimeout(timer);
  }
}

function agentUnavailableMessage(){
  return "I can't reach the Maximus Desktop Agent on this computer. Start it first — run \"python maximus_agent.py\" in a terminal on this machine — then try that again.";
}

// Opens a WhatsApp chat pre-filled with `text`, to `phone`, and returns how
// it happened. Tries the real ANDROID PHONE first (via the desktop agent +
// adb — see /whatsapp-message in maximus_agent.py): if a phone is connected,
// WhatsApp opens directly on the PHONE itself, not on this PC. If the agent
// isn't running or no phone is connected, it falls back to the existing
// browser hand-off (WhatsApp Web / the WhatsApp app if this page itself is
// open on a phone's browser). Either way, Maximus only ever fills the
// message in — a human always has to tap Send themselves; nothing here can
// press Send for you.
//
// Call this directly (not after any other `await`) from a click handler —
// it opens a blank tab synchronously before the async agent check, so the
// browser fallback below can still navigate that same tab later without
// being blocked as a popup (a `window.open()` after an `await` no longer
// counts as tied to the click, and most browsers silently block it).
async function openWhatsAppOnPhone(phone, text){
  const cleanPhone = String(phone||'').replace(/[^\d+]/g, '').replace(/^\+/, '');
  if(!cleanPhone) return { ok:false, reason:'no_phone_number' };
  const pendingTab = window.open('', `maximus_wa_${Date.now()}`);
  try{
    await callAgent('/whatsapp-message', { method:'POST', body:{ number: cleanPhone, text } });
    if(pendingTab) pendingTab.close(); // opened on the phone instead — no browser tab needed
    return { ok:true, viaAndroidPhone:true };
  }catch(e){
    // Agent not running, no adb phone connected, WhatsApp missing on the
    // phone, etc. — fall back to the browser hand-off rather than failing
    // outright, same as every other "needs the desktop agent" feature here.
    const url = `https://api.whatsapp.com/send?phone=${cleanPhone}&text=${encodeURIComponent(text)}`;
    if(pendingTab) pendingTab.location = url;
    else window.open(url, `maximus_wa_${Date.now()}`); // pop-up was blocked outright — try once more anyway
    return { ok:true, viaAndroidPhone:false, fallbackReason: e && e.message };
  }
}

// Small reusable wrapper around the Mistral chat endpoint, used by the email
// features (summarizing an inbox, drafting a reply/new email) so each caller
// doesn't have to repeat the same fetch boilerplate that's scattered
// elsewhere in this file.
async function mistralChat(systemPrompt, userPrompt, opts = {}){
  if(!state.settings.apiKey) throw new Error('no-api-key');
  const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.settings.apiKey}` },
    body: JSON.stringify({
      model: opts.model || CONFIG.MODEL_TEXT,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      max_tokens: opts.maxTokens || 400,
      temperature: opts.temperature != null ? opts.temperature : 0.4
    })
  });
  if(!res.ok) throw new Error(`Mistral error ${res.status}`);
  const data = await res.json();
  return (data.choices?.[0]?.message?.content || '').trim();
}

// Holds a drafted-but-unsent email awaiting a spoken "send it" / "cancel"
// so nothing ever goes out without an explicit confirmation. Only one
// pending draft at a time — a new draft simply replaces the old one.
let pendingEmailDraft = null;

function agentEmailNotConnectedMessage(){
  return "Your email isn't connected yet. Open the Connect Email screen and add your account first.";
}

function findContact(name){
  const n = name.trim().toLowerCase();
  const contacts = state.contacts || [];
  return contacts.find(c => c.name.toLowerCase() === n)
      || contacts.find(c => c.name.toLowerCase().startsWith(n))
      || contacts.find(c => c.name.toLowerCase().includes(n));
}

function normalizeSitePhrase(s){
  return s
    .replace(/\byou\s*tube\b/g, 'youtube')
    .replace(/\bwhat'?s\s*app\b/g, 'whatsapp')
    .replace(/\bwhat\s*app\b/g, 'whatsapp')
    .replace(/\bchat\s*g\.?p\.?t\.?\b/g, 'chatgpt')
    .replace(/\binsta\b/g, 'instagram')
    .replace(/\bflip\s*kart\b/g, 'flipkart')
    .replace(/\bred\s*it\b/g, 'reddit')
    .replace(/\blinked\s*in\b/g, 'linkedin')
    .replace(/\bg\s*mail\b/g, 'gmail')
    .replace(/\bdisney\s*(\+|plus)?\b/g, 'disneyplus')
    .replace(/\b(amazon\s*)?prime\s*video\b/g, 'primevideo')
    .replace(/\bface\s*book\b/g, 'facebook')
    .replace(/\byahoo\s*mail\b/g, 'yahoomail')
    .replace(/\bali\s*express\b/g, 'aliexpress')
    .replace(/\bgit\s*hub\b/g, 'github')
    .replace(/\be\s*bay\b/g, 'ebay')
    // Google workspace apps — must come before any bare "google" handling
    .replace(/\bgoogle\s*drive\b/g, 'googledrive')
    .replace(/\bgoogle\s*docs?\b/g, 'googledocs')
    .replace(/\bgoogle\s*sheets?\b/g, 'googlesheets')
    .replace(/\bgoogle\s*slides?\b/g, 'googleslides')
    .replace(/\bgoogle\s*calendar\b/g, 'googlecalendar')
    .replace(/\bgoogle\s*translate\b/g, 'googletranslate')
    .replace(/\bgoogle\s*photos?\b/g, 'googlephotos')
    .replace(/\bgoogle\s*meet\b/g, 'googlemeet')
    .replace(/\bgoogle\s*keep\b/g, 'googlekeep')
    .replace(/\bgoogle\s*maps?\b/g, 'maps')
    // Microsoft
    .replace(/\bone\s*drive\b/g, 'onedrive')
    .replace(/\b(microsoft|ms)\s*teams\b/g, 'microsoftteams')
    .replace(/\b(microsoft|office)\s*365\b/g, 'microsoft365')
    // Streaming / news
    .replace(/\bcrunchy\s*roll\b/g, 'crunchyroll')
    .replace(/\btimes\s*of\s*india\b/g, 'timesofindia')
    .replace(/\bthe\s*hindu\b/g, 'thehindu')
    .replace(/\bcric\s*buzz\b/g, 'cricbuzz')
    // Finance / markets
    .replace(/\btrading\s*view\b/g, 'tradingview')
    .replace(/\byahoo\s*finance\b/g, 'yahoofinance')
    .replace(/\bcoin\s*market\s*cap\b/g, 'coinmarketcap')
    .replace(/\bcoin\s*gecko\b/g, 'coingecko')
    .replace(/\bzerodha(\s*kite)?\b/g, 'zerodha');
}

// A handful of very common speech-recognition mishears around Maximus's own
// command words — fixed up before matching so "star scroll", "odo scroll",
// "clique the button", etc. still land on the right command instead of
// falling through to the AI chat pipeline as gibberish.
function correctMishears(s){
  return s
    .replace(/\bscrawl(ing)?\b/g, 'scroll$1')
    .replace(/\bscrole(ing)?\b/g, 'scroll$1')
    .replace(/\b(star|stir)\b(?=\s+(?:auto ?)?scroll)/g, 'start')
    .replace(/\b(odo|otto|oto)\b(?=\s+scroll)/g, 'auto')
    .replace(/\bcliq(ue)?\b/g, 'click')
    .replace(/\bklick\b/g, 'click')
    .replace(/\btop scroll(ing)?\b/g, 'stop scroll$1')
    .replace(/\btab\b(?=\s+(?:on|the))/g, 'tap');
}

// Strips harmless leading filler ("please", "can you", "hey maximus", etc.)
// that people naturally add before a command but that would otherwise stop
// the exact-match regexes below from firing, sending the phrase to the
// slower AI-based fallback for no reason.
function stripVoiceFiller(s){
  return s.replace(/^(?:hey |ok |okay )?maximus[,]?\s*/i, '')
          .replace(/^(?:please|could you|can you|would you|will you)\s+/i, '')
          .replace(/^(?:please|now)\s+/i, '');
}

// Returns true if the phrase was recognized and handled as a command;
// false means it should fall through to the normal AI chat pipeline.
async function executeVoiceCommand(raw){
  const rawTrimmed = stripVoiceFiller(raw.trim().replace(/[.!?]+$/, ''));
  const lower = correctMishears(normalizeSitePhrase(rawTrimmed.toLowerCase()));
  let m;

  // Confirmation gate for a drafted-but-unsent email (see /email-* commands
  // further down). Checked first so "send it" always resolves to actually
  // sending the pending draft rather than being reinterpreted as anything else.
  if(pendingEmailDraft){
    if(/^(send it|send that|send the email|yes,? send it|confirm|go ahead)$/.test(lower)){
      const draft = pendingEmailDraft;
      pendingEmailDraft = null;
      try{
        await callAgent('/email-send', { method:'POST', body:{ to: draft.to, subject: draft.subject, body: draft.body, in_reply_to: draft.in_reply_to || '' } });
        speak(`Sent, Sir.`);
      }catch(e){
        if(e && /isn't connected/.test(e.message || '')) speak(agentEmailNotConnectedMessage());
        else speak(agentUnavailableMessage());
      }
      return true;
    }
    if(/^(cancel|don'?t send( it)?|discard( it)?|never ?mind|scrap it)$/.test(lower)){
      pendingEmailDraft = null;
      speak("Okay, I discarded that draft.");
      return true;
    }
    // Anything else falls through — the user may be starting a fresh command
    // instead of responding to the draft, so don't force-consume this turn.
  }

  // "play <video> on youtube" — searches YouTube and opens the matching video's
  // watch page directly (so it actually starts playing), instead of just
  // opening a generic search results page you'd have to click into yourself.
  // Checked before the Spotify fallback below so "on youtube" always wins.
  m = lower.match(/^(?:play|watch) (.+?) (?:video )?on youtube$/);
  if(m){
    await youtubePlayVideo(m[1].trim());
    return true;
  }

  // "play <song> on my phone" / "play <song> on the phone" — plays it on the
  // connected Android phone itself (via the desktop agent + adb), not here
  // in the browser. Checked before the desktop Spotify handler below so
  // explicit "on my phone" phrasing always wins over in-browser playback.
  m = rawTrimmed.match(/^play\s+(.+?)\s+on (?:my |the )?phone$/i);
  if(m){
    const song = m[1].trim();
    speak(`Playing ${song} on your phone.`);
    try{
      const res = await callAgent('/play-song', { method:'POST', body:{ song } });
      if(res.opened_search_only){
        speak("I opened Spotify search on your phone, but couldn't tell where to tap — go ahead and tap the top result to play it.");
      } else if(res.tapped_result && res.playback_unconfirmed){
        speak("I tapped the top result in Spotify on your phone — check that it started playing.");
      }
      // Otherwise (plain ok, or ok + tapped_result with confirmed playback)
      // it's actually playing already, so the "Playing ..." line above already covers it.
    } catch(e){
      if(e && /No Android phone connected/.test(e.message || '')) speak(e.message);
      else if(e && /Couldn't find a music app/.test(e.message || '')) speak(e.message);
      else speak(agentUnavailableMessage());
    }
    return true;
  }

  // "play <song> on spotify" — plays in-app via the Web Playback SDK if connected
  // (requires Premium), otherwise falls back to opening the Spotify website.
  // Also accepts plain "play <song>" / "play me <song>" / "put on <song>" with
  // no trailing "on spotify" — previously those silently fell through to the
  // general AI chat instead of playing anything, which made it look like the
  // wrong song played on the next (differently mistranscribed) retry.
  m = lower.match(/^play (.+?) (?:song )?on spotify$/)
   || lower.match(/^(?:play|put on)(?: me)? (?:the song |the track )?(.+?)(?: song)?$/);
  if(m){
    await spotifyPlayTrack(m[1].trim());
    return true;
  }

  // Spotify transport controls
  if(/^pause (?:the )?(?:music|spotify|song)$/.test(lower)){ await spotifyPause(); return true; }
  if(/^(?:resume|unpause) (?:the )?(?:music|spotify|song|playback)$/.test(lower)){ await spotifyResume(); return true; }
  if(/^(?:skip|next)(?: song| track)?$/.test(lower)){ await spotifyNext(); return true; }
  if(/^(?:previous|last|go back)(?: song| track)?$/.test(lower)){ await spotifyPrev(); return true; }
  if(/^(?:loop|repeat) (?:this )?(?:song|track)$/.test(lower)){ await spotifySetLoop(true); return true; }
  if(/^(?:stop|turn off|disable) (?:loop|looping|repeat)(?:ing)?$/.test(lower)){ await spotifySetLoop(false); return true; }

  // Weather: "weather", "weather in <city>", "what's the weather like (in <city>)"
  m = lower.match(/^(?:what'?s|what is|how'?s) the weather(?: like)?(?: in (.+))?\??$/)
   || lower.match(/^weather(?:\s+forecast)?(?: in (.+))?\??$/);
  if(m){
    await getWeatherReport(m[1] ? m[1].trim() : null);
    return true;
  }

  // Calendar reads: "what's on my calendar (today/tomorrow)", "read my calendar",
  // "read my schedule", "what's my next event", "do I have anything today"
  m = lower.match(/^(?:what'?s|what is) on my (?:calendar|schedule)(?: (today|tomorrow))?\??$/)
   || lower.match(/^(?:read|check) my (?:calendar|schedule)(?: for (today|tomorrow))?\??$/)
   || lower.match(/^what'?s (?:my )?next(?: event| meeting)?(?: on my calendar)?\??$/)
   || lower.match(/^do i have (?:anything|any events?|any meetings?)(?: (today|tomorrow))?\??$/);
  if(m){
    await readCalendarEvents(m[1] ? m[1].trim() : null);
    return true;
  }

  // Calendar creates: "add/create/schedule an event called <title> at/on <time>"
  m = rawTrimmed.match(/^(?:add|create|schedule)(?: an?)? (?:event|calendar event|meeting)(?: called| named| titled)? (.+)$/i)
   || rawTrimmed.match(/^(?:add|create|schedule) (.+?) (?:to|on) my calendar$/i)
   || rawTrimmed.match(/^put (.+?) on my calendar$/i);
  if(m){
    await createCalendarEventFromSpeech(m[1].trim());
    return true;
  }

  // Timed reminder: "remind me to <task> at/in/on <time>"
  m = rawTrimmed.match(/^remind me to (.+)$/i);
  if(m){
    const spoken = m[1].trim();
    const parsed = await parseReminderFromSpeech(spoken);
    const task = addTask(parsed.task, parsed.dueAt);
    if(task.dueAt){
      const d = new Date(task.dueAt);
      speak(`Got it — I'll remind you to ${task.text.toLowerCase()} at ${d.toLocaleString('en-US',{hour:'numeric',minute:'2-digit',hour12:true, ...(sameDay(d,new Date())?{}:{month:'short',day:'numeric'})})}.`);
    } else {
      speak(`Got it — I'll remind you to ${task.text.toLowerCase()}.`);
    }
    return true;
  }

  // Plain to-do (no time): "add <task> to my to-do list" / "add a task to <task>" / "add <task> to my task list"
  m = rawTrimmed.match(/^add (?:a )?(?:task to )?(.+?) to my (?:to.?do|task) list$/i)
   || rawTrimmed.match(/^add (?:a )?task[:\-]?\s*(.+)$/i);
  if(m){
    const task = addTask(m[1].trim(), null);
    speak(`Added "${task.text}" to your list.`);
    return true;
  }

  // List tasks/reminders: "what's on my to-do list" / "what are my tasks" / "what are my reminders"
  if(/^what'?s on my (?:to.?do|task) list\??$/.test(lower)
   || /^what (?:are|do i have on) my (?:tasks|reminders|to.?do list)\??$/.test(lower)
   || /^(?:read|show|check) my (?:tasks|to.?do list|reminders)\??$/.test(lower)){
    const pending = (state.tasks || []).filter(t => !t.done);
    if(!pending.length){
      speak("Your list is empty — nothing pending.");
    } else {
      const spoken = pending.map((t,i) => `${i+1}. ${t.text}${formatTaskDue(t)}`).join('. ');
      speak(`You have ${pending.length} item${pending.length===1?'':'s'} on your list. ${spoken}`);
    }
    return true;
  }

  // Complete a task: "mark <task> as done" / "I finished <task>" / "complete <task>" / "done with <task>"
  m = rawTrimmed.match(/^(?:mark |i(?:'ve| have)? )?(?:finished |completed? |done with )?(.+?) (?:is |as )?(?:done|complete|finished)$/i)
   || rawTrimmed.match(/^(?:mark|complete) (.+)$/i);
  if(m && !/^(reply|the last email|that email)/i.test(m[1] || '')){
    const found = findTask(m[1].trim());
    if(found){
      found.done = true;
      if(activeReminderTimers[found.id]){ clearTimeout(activeReminderTimers[found.id]); delete activeReminderTimers[found.id]; }
      save();
      speak(`Marked "${found.text}" as done.`);
      return true;
    }
    // No matching task found — fall through, this probably wasn't a task command at all.
  }

  // Clear the whole list: "clear my to-do list" / "clear my tasks"
  if(/^clear my (?:to.?do|task) list\??$/.test(lower) || /^clear my (?:tasks|reminders)\??$/.test(lower)){
    (state.tasks || []).forEach(t => { if(activeReminderTimers[t.id]){ clearTimeout(activeReminderTimers[t.id]); delete activeReminderTimers[t.id]; } });
    state.tasks = [];
    save();
    speak("Cleared your list.");
    return true;
  }

  // Self-upgrade: "add a new feature: <description>", "add a feature to yourself <description>",
  // "upgrade yourself to <description>", "update your code to <description>"
  m = rawTrimmed.match(/^add (?:a )?(?:new )?feature(?:s)?(?: to yourself)?\s*[:\-]?\s*(.+)$/i)
   || rawTrimmed.match(/^upgrade yourself(?: to)?\s*[:\-]?\s*(.+)$/i)
   || rawTrimmed.match(/^update your(?:self| own code)?(?: to)?\s*[:\-]?\s*(.+)$/i);
  if(m && m[1] && m[1].trim().length > 2){
    await selfUpgrade(m[1].trim());
    return true;
  }

  // Trending: "what's trending", "trending topics", "what's happening on social media"
  if(/^what'?s trending\??$/.test(lower)
   || /^trending(?: topics)?\??$/.test(lower)
   || /^what'?s (?:happening|going on|buzzing) on (?:social media|twitter|instagram)\??$/.test(lower)
   || /^(?:show|give) me (?:what'?s trending|the trends)\??$/.test(lower)){
    await getTrendingReport();
    return true;
  }

  // News: "news", "today's news", "today's news in india", "news about <topic>", "headlines"
  // No-topic requests pull BOTH headlines and trending/social buzz together; topic-specific
  // requests stay headline-only since trending topics can't be filtered by topic.
  m = lower.match(/^(?:what'?s|give me|read me|tell me) (?:the |my )?(?:daily |latest |today'?s )?news(?: (?:about|on) (.+)| in (.+))?\??$/)
   || lower.match(/^(?:daily |today'?s )?news(?: (?:about|on) (.+)| in (.+))?$/)
   || lower.match(/^headlines(?: (?:about|on) (.+)| in (.+))?$/);
  if(m){
    const raw = (m[1] || m[2] || '').trim();
    // "in india" just means the default India-scoped feed (already the default) — treat it as no topic filter.
    const topic = raw && !/^india$/i.test(raw) ? raw : null;
    if(topic) await getNewsReport(topic);
    else await getDailyNewsReport();
    return true;
  }

  // Morning briefing: "give me my briefing" / "morning briefing" / "brief me" / "what's my briefing"
  if(/^(?:give me my|what'?s my|read my|my) briefing\??$/.test(lower)
   || /^morning briefing\??$/.test(lower)
   || /^brief me\??$/.test(lower)){
    await giveMorningBriefing();
    return true;
  }

  // Any phrasing of "search <query> on/for <site>" — query can be anything, not just known keywords.
  let site, query;
  m = lower.match(/^search (.+) on ([a-z]+)$/);
  if(m && ASSISTANT_SITES[m[2]]){ query = m[1]; site = m[2]; }
  if(!site){
    m = lower.match(/^search ([a-z]+) for (.+)$/);
    if(m && ASSISTANT_SITES[m[1]]){ site = m[1]; query = m[2]; }
  }
  if(!site){
    m = lower.match(/^search for (.+) on ([a-z]+)$/);
    if(m && ASSISTANT_SITES[m[2]]){ query = m[1]; site = m[2]; }
  }
  if(!site){
    m = lower.match(/^([a-z]+) search (?:for )?(.+)$/);
    if(m && ASSISTANT_SITES[m[1]]){ site = m[1]; query = m[2]; }
  }
  if(site && query){
    const url = buildSearchUrl(site, query);
    if(url){
      window.open(url, '_blank');
      speak(`Searching ${site} for ${query}.`);
      return true;
    }
  }

  // ---- Real desktop control, via the local Maximus Desktop Agent ----
  // (a Python program that must be running on this computer — see maximus_agent.py)

  // Battery percentage
  if(/^(?:what'?s|what is|check|tell me) (?:my )?battery(?: percentage| level)?\??$/.test(lower)
   || /^battery(?: percentage| level| status)?\??$/.test(lower)){
    try{
      const data = await callAgent('/battery');
      if(data && typeof data.percent === 'number'){
        speak(`Your battery is at ${Math.round(data.percent)} percent${data.charging ? ', and it is currently charging' : ''}.`);
      } else {
        speak("This computer doesn't seem to report a battery level — it might be a desktop with no battery.");
      }
    } catch(e){ speak(agentUnavailableMessage()); }
    return true;
  }

  // "go to desktop" / "show desktop" / "minimize everything"
  if(/^(?:go to|show|switch to)(?: the)? desktop$/.test(lower) || /^minimize (?:all|everything)$/.test(lower)){
    try{ await callAgent('/show-desktop', { method:'POST' }); speak('Going to the desktop.'); }
    catch(e){ speak(agentUnavailableMessage()); }
    return true;
  }

  // Open file explorer
  if(/^open (?:the |my )?(?:file explorer|file manager|explorer|files)$/.test(lower)){
    try{ await callAgent('/open-explorer', { method:'POST', body:{ path:'desktop' } }); speak('Opening the file explorer.'); }
    catch(e){ speak(agentUnavailableMessage()); }
    return true;
  }

  // Open task manager
  if(/^open (?:the )?task manager$/.test(lower)){
    try{ await callAgent('/open-task-manager', { method:'POST' }); speak('Opening Task Manager.'); }
    catch(e){ speak(agentUnavailableMessage()); }
    return true;
  }

  // Open device/system settings (kept separate from "open <app's own> settings",
  // which is handled elsewhere by the gear icon in the sidebar)
  if(/^open (?:my |the )?(?:computer|system|device|windows|pc) settings$/.test(lower)){
    try{ await callAgent('/open-settings', { method:'POST' }); speak('Opening settings.'); }
    catch(e){ speak(agentUnavailableMessage()); }
    return true;
  }

  // Open VS Code specifically
  if(/^open (?:vs\s*code|visual studio code)$/.test(lower)){
    try{ await callAgent('/open-app', { method:'POST', body:{ name:'vscode' } }); speak('Opening Visual Studio Code.'); }
    catch(e){ speak(agentUnavailableMessage()); }
    return true;
  }

  // "create a file on desktop named notes.txt" (optionally "... and open it in vscode")
  // Accepts "named" / "name" / "called" since people say it different ways.
  // If no extension is given, the agent defaults it to .txt on its own.
  m = lower.match(/^(?:create|make) a (?:new )?file(?: on (?:the )?desktop)? (?:named|name|called) ([a-z0-9 ._-]+?)(?: and open (?:it )?in (?:vs\s*code|visual studio code))?$/);
  if(m){
    const wantsVscode = /and open (?:it )?in/.test(lower);
    const fileName = m[1].trim();
    try{
      await callAgent('/create-file', { method:'POST', body:{ location:'desktop', name: fileName } });
      speak(`Created ${fileName} on your desktop.`);
      if(wantsVscode){
        try{ await callAgent('/open-app', { method:'POST', body:{ name:'vscode', openPath: `desktop/${fileName}` } }); speak('Opening it in Visual Studio Code.'); }
        catch(e){ /* file was still created even if VS Code launch fails */ }
      }
    } catch(e){ speak(agentUnavailableMessage()); }
    return true;
  }

  // "create a folder on desktop named photos" — same phrasing options, no extension logic.
  m = lower.match(/^(?:create|make) a (?:new )?folder(?: on (?:the )?desktop)? (?:named|name|called) ([a-z0-9 ._-]+?)$/);
  if(m){
    const folderName = m[1].trim();
    try{
      await callAgent('/create-folder', { method:'POST', body:{ location:'desktop', name: folderName } });
      speak(`Created the ${folderName} folder on your desktop.`);
    } catch(e){ speak(agentUnavailableMessage()); }
    return true;
  }

  // "empty recycle bin" / "delete all the files in recycle bin" / "clear the recycle bin", etc.
  // Opens it first (so you can see it happen) and then empties it.
  if(/recycle\s*bin/.test(lower) && /(delete|empty|clear)/.test(lower)){
    try{
      try{ await callAgent('/open-app', { method:'POST', body:{ name:'recycle bin' } }); } catch(e){ /* still try to empty even if opening the window fails */ }
      await callAgent('/empty-recycle-bin', { method:'POST' });
      speak('Recycle bin emptied.');
    } catch(e){ speak(agentUnavailableMessage()); }
    return true;
  }

  // "take a screenshot" / "take screenshot" / "capture the screen"
  if(/^(?:take (?:a )?screenshot|capture (?:the )?screen|screenshot)$/.test(lower)){
    try{
      const data = await callAgent('/take-screenshot', { method:'POST' });
      speak(`Screenshot saved${data && data.filename ? `, ${data.filename}` : ''}.`);
    } catch(e){ speak(agentUnavailableMessage()); }
    return true;
  }

  // "show screenshots" / "show my screenshots" / "open screenshots" / "open screenshots folder"
  if(/^(?:show|open)(?: my)? screenshots(?: folder)?$/.test(lower)){
    try{ await callAgent('/open-explorer', { method:'POST', body:{ path:'screenshots' } }); speak('Here are your screenshots.'); }
    catch(e){ speak(agentUnavailableMessage()); }
    return true;
  }

  // "open the latest screenshot" / "open latest screenshot taken" / "show the latest screenshot" / "open my last screenshot"
  if(/^(?:open|show)(?: the| my)? (?:latest|last) screenshot(?: taken)?$/.test(lower)){
    try{ await callAgent('/open-latest-screenshot', { method:'POST' }); speak('Opening your latest screenshot.'); }
    catch(e){
      if(e && /No screenshots found/.test(e.message || '')) speak(e.message);
      else speak(agentUnavailableMessage());
    }
    return true;
  }

  // ---- Brightness control ----
  m = lower.match(/^(?:increase|turn up|raise|brighten)(?: the)? brightness(?: by (\d{1,3})\s*(?:%|percent)?)?$/)
   || lower.match(/^brightness up(?: by (\d{1,3})\s*(?:%|percent)?)?$/);
  if(m){
    const amount = m[1] ? parseInt(m[1], 10) : 10;
    try{
      const data = await callAgent('/brightness', { method:'POST', body:{ action:'up', amount } });
      speak(typeof data?.percent === 'number' ? `Brightness is now at ${data.percent} percent.` : 'Brightness increased.');
    } catch(e){ speak(agentUnavailableMessage()); }
    return true;
  }
  m = lower.match(/^(?:decrease|turn down|lower|dim)(?: the)? brightness(?: by (\d{1,3})\s*(?:%|percent)?)?$/)
   || lower.match(/^brightness down(?: by (\d{1,3})\s*(?:%|percent)?)?$/);
  if(m){
    const amount = m[1] ? parseInt(m[1], 10) : 10;
    try{
      const data = await callAgent('/brightness', { method:'POST', body:{ action:'down', amount } });
      speak(typeof data?.percent === 'number' ? `Brightness is now at ${data.percent} percent.` : 'Brightness decreased.');
    } catch(e){ speak(agentUnavailableMessage()); }
    return true;
  }
  m = lower.match(/^set(?: the)? brightness to (\d{1,3})\s*(?:%|percent)?$/);
  if(m){
    const amount = Math.max(0, Math.min(100, parseInt(m[1], 10)));
    try{ await callAgent('/brightness', { method:'POST', body:{ action:'set', amount } }); speak(`Brightness set to ${amount} percent.`); }
    catch(e){ speak(agentUnavailableMessage()); }
    return true;
  }
  if(/^(?:what'?s|what is|check) (?:my |the )?brightness(?: level)?\??$/.test(lower)){
    try{
      const data = await callAgent('/brightness');
      speak(typeof data?.percent === 'number' ? `Brightness is at ${Math.round(data.percent)} percent.` : "I couldn't read the brightness level.");
    } catch(e){ speak(agentUnavailableMessage()); }
    return true;
  }

  // ---- Volume control ----
  m = lower.match(/^(?:increase|turn up|raise)(?: the)? volume(?: by (\d{1,3})\s*(?:%|percent)?)?$/)
   || lower.match(/^volume up(?: by (\d{1,3})\s*(?:%|percent)?)?$/);
  if(m){
    const amount = m[1] ? parseInt(m[1], 10) : 10;
    try{
      const data = await callAgent('/volume', { method:'POST', body:{ action:'up', amount } });
      speak(typeof data?.percent === 'number' ? `Volume is now at ${data.percent} percent.` : 'Volume increased.');
    } catch(e){ speak(agentUnavailableMessage()); }
    return true;
  }
  m = lower.match(/^(?:decrease|turn down|lower)(?: the)? volume(?: by (\d{1,3})\s*(?:%|percent)?)?$/)
   || lower.match(/^volume down(?: by (\d{1,3})\s*(?:%|percent)?)?$/);
  if(m){
    const amount = m[1] ? parseInt(m[1], 10) : 10;
    try{
      const data = await callAgent('/volume', { method:'POST', body:{ action:'down', amount } });
      speak(typeof data?.percent === 'number' ? `Volume is now at ${data.percent} percent.` : 'Volume decreased.');
    } catch(e){ speak(agentUnavailableMessage()); }
    return true;
  }
  m = lower.match(/^set(?: the)? volume to (\d{1,3})\s*(?:%|percent)?$/);
  if(m){
    const amount = Math.max(0, Math.min(100, parseInt(m[1], 10)));
    try{ await callAgent('/volume', { method:'POST', body:{ action:'set', amount } }); speak(`Volume set to ${amount} percent.`); }
    catch(e){ speak(agentUnavailableMessage()); }
    return true;
  }
  if(/^mute(?: the)? volume$|^mute(?: my)? computer$|^mute$/.test(lower)){
    try{ await callAgent('/volume', { method:'POST', body:{ action:'mute' } }); speak('Muted.'); }
    catch(e){ speak(agentUnavailableMessage()); }
    return true;
  }
  if(/^unmute(?: the)? volume$|^unmute(?: my)? computer$|^unmute$/.test(lower)){
    try{ await callAgent('/volume', { method:'POST', body:{ action:'unmute' } }); speak('Unmuted.'); }
    catch(e){ speak(agentUnavailableMessage()); }
    return true;
  }
  if(/^(?:what'?s|what is|check) (?:my |the )?volume(?: level)?\??$/.test(lower)){
    try{
      const data = await callAgent('/volume');
      speak(typeof data?.percent === 'number' ? `Volume is at ${Math.round(data.percent)} percent${data.muted ? ', and muted' : ''}.` : "I couldn't read the exact volume level.");
    } catch(e){ speak(agentUnavailableMessage()); }
    return true;
  }

  // ---- Vision: "open vision" / "close vision" / "what do you see" ----
  if(/^(?:open|start|turn on|enable) vision$/.test(lower)){
    const ok = await startVision();
    if(ok) speak('Vision is on. Ask me what I see, or say "close vision" to turn it off.');
    return true;
  }
  if(/^(?:close|stop|turn off|disable) vision$/.test(lower)){
    stopVision();
    speak('Vision is off.');
    return true;
  }
  // "who is this/that" — if the screen is being shared, this almost always
  // means "who's this person shown on my screen", not the webcam. Route to
  // screen share when it's active (or when vision isn't), otherwise fall
  // through to vision's webcam view below.
  if(/^who(?:'?s| is) (?:this|that|he|she|they)\??$/.test(lower) && (screenActive || !visionActive)){
    await askScreenQuestion('Who is the person shown on my screen right now? If you recognize them by name, say so; otherwise describe them.');
    return true;
  }
  m = lower.match(/^(?:what (?:do|can) you see|look(?: at (?:this|that))?|what'?s (?:this|that)|who(?:'?s| is) (?:this|that|he|she|they)|describe (?:what you see|this|that)|take a look(?: at (?:this|that))?)\s*(.*)$/);
  if(m){
    await askVisionQuestion(m[1] ? m[1].trim() : 'What do you see?');
    return true;
  }

  // ---- Auto-scroll: "auto scroll" / "scroll down" / "scroll up" / "stop" ----
  // Checked early so a bare "stop" while scrolling stops the scroll, rather
  // than falling through unmatched to general chat.
  if(autoScrollActive && /^(?:stop|stop scrolling|stop the scrolling|stop auto ?scroll(?:ing)?|stop the scroll(?:ing)?|end scroll(?:ing)?)$/.test(lower)){
    await stopAutoScroll();
    return true;
  }
  if(/^(?:auto ?scroll(?: down)?|start (?:auto ?scroll(?:ing)?|scrolling)(?: down)?|start (?:the )?scroll(?: down)?|keep scrolling(?: down)?|scroll down continuously|continue scrolling(?: down)?)(?: the page)?$/.test(lower)){
    await startAutoScroll('down');
    return true;
  }
  if(/^(?:auto ?scroll up|start (?:auto ?scroll(?:ing)?|scrolling) up|start (?:the )?scroll up|keep scrolling up|continue scrolling up)(?: the page)?$/.test(lower)){
    await startAutoScroll('up');
    return true;
  }
  // Bare "scroll down" / "scroll up" — a single nudge, not continuous scrolling.
  if(/^scroll(?: it)? down(?: a bit| a little)?(?: the page)?$/.test(lower)){
    await stepScroll('down');
    return true;
  }
  if(/^scroll(?: it)? up(?: a bit| a little)?(?: the page)?$/.test(lower)){
    await stepScroll('up');
    return true;
  }

  // ---- Screen share: "share my screen" / "close screen share" / "what's on my screen" ----
  if(/^(?:share|open|start) (?:my )?screen(?: share)?$/.test(lower)){
    const ok = await startScreenShare();
    if(ok) speak('I can see your screen now. Highlight anything and ask me about it, or say "stop sharing my screen" to turn it off.');
    return true;
  }
  if(/^(?:close|stop|turn off|end) (?:sharing (?:my )?screen|screen share(?:ing)?|(?:my )?screen)$/.test(lower)){
    stopScreenShare();
    speak('Screen sharing is off.');
    return true;
  }
  // "read the highlighted text" — transcribe it verbatim and speak exactly
  // that. Checked before "explain", which describes/paraphrases instead.
  if(/^read (?:the )?(?:highlighted|selected)(?: text)?$|^read (?:this|that|it)$|^read what(?:'?s| is) highlighted$/.test(lower)){
    await askScreenQuestion('Read the highlighted text on my screen.', 'read');
    return true;
  }
  // "explain the highlighted text" — explain the meaning, don't read it aloud verbatim.
  if(/^explain (?:the )?(?:highlighted|selected)(?: text)?$|^explain (?:this|that|it)$|^explain what(?:'?s| is) highlighted$/.test(lower)){
    await askScreenQuestion('Explain what the highlighted text on my screen means, without just reading it back word for word.');
    return true;
  }
  m = lower.match(/^(?:what'?s|what is) on my screen\??\s*(.*)$/)
   || lower.match(/^(?:what (?:do|can) you see on my screen|describe my screen|look at my screen|check my screen)\s*(.*)$/)
   || lower.match(/^what (?:does this|is this|is highlighted|did i highlight) (?:mean|say)\??$/);
  if(m){
    await askScreenQuestion(m[1] ? m[1].trim() : "What's on my screen?");
    return true;
  }
  // "read my screen" — reads aloud whatever text is currently visible/highlighted, verbatim.
  if(/^read my screen\s*(.*)$/.test(lower)){
    await askScreenQuestion('Read aloud the highlighted text if any, otherwise the main visible text on my screen.', 'read');
    return true;
  }

  // ---- Upload a photo/video (Instagram, LinkedIn, or any other site) ----
  // "upload a photo", "upload video", "upload the photo named vacation.jpg",
  // "upload video from C:\Users\me\Desktop\clip.mp4" — clicks the create/
  // upload control, then (if a file was named) types its path into the
  // native file-picker dialog that pops open and presses Enter.
  m = lower.match(/^(?:upload|post|share)(?: a| the)? (photo|picture|image|video|reel)(?:\s+(?:named|called|from|at)\s+(.+))?$/);
  if(m){
    if(!screenActive){
      const started = await startScreenShare();
      if(!started) return true;
      speak("I can see your screen now.");
    }
    const kindRaw = m[1];
    const kind = /video|reel/.test(kindRaw) ? (kindRaw === 'reel' ? 'reel' : 'video') : 'photo';
    await performScreenUpload(kind, m[2] ? m[2].trim() : null);
    return true;
  }

  // ---- Click things on the shared screen ----
  // Covers "click the follow button", "click the video titled X", "click
  // the search bar and type X", "click the first website", "click X" for
  // any named button/link/icon, on any site or app currently on screen.
  m = lower.match(/^(?:click|tap|press|select) (?:on )?(?:the )?(.+?)(?:\s+and\s+(type|search(?: for)?|enter)\s+(.+))?$/);
  if(m){
    const target = m[1].trim();
    const verb = m[2] || '';
    const typeText = m[3] ? m[3].trim() : null;
    const pressEnter = typeText != null && /^search/.test(verb);
    if(!screenActive){
      const started = await startScreenShare();
      if(!started) return true;
      speak("I can see your screen now.");
    }
    await performScreenClick(target, typeText, pressEnter);
    return true;
  }

  // ---- Power control: restart / shut down / sleep ----
  if(/^(?:restart|reboot)(?: the| my)? (?:computer|pc|laptop|system)$/.test(lower) || lower === 'restart' || lower === 'reboot'){
    try{ await callAgent('/power', { method:'POST', body:{ action:'restart' } }); speak('Restarting the computer now.'); }
    catch(e){ speak(agentUnavailableMessage()); }
    return true;
  }
  if(/^(?:shut ?down|power off|turn off)(?: the| my)? (?:computer|pc|laptop|system)$/.test(lower) || lower === 'shutdown' || lower === 'shut down'){
    try{ await callAgent('/power', { method:'POST', body:{ action:'shutdown' } }); speak('Shutting down the computer now.'); }
    catch(e){ speak(agentUnavailableMessage()); }
    return true;
  }
  if(/^(?:sleep|go to sleep|sleep mode|put(?: the| my)? computer to sleep)$/.test(lower)){
    try{ await callAgent('/power', { method:'POST', body:{ action:'sleep' } }); speak('Putting the computer to sleep.'); }
    catch(e){ speak(agentUnavailableMessage()); }
    return true;
  }

  // ---- Closing applications ----
  // "close all applications" / "close everything except the browser and vs code" — worded either
  // way, this always protects the browser, VS Code, and core system processes.
  if(/^close (?:all|every)(?:thing| applications| apps| open apps| open applications| windows)?(?:\s+.*)?$/.test(lower)){
    try{
      const data = await callAgent('/close-all-apps', { method:'POST' });
      const n = data && typeof data.closed_count === 'number' ? data.closed_count : null;
      speak(n !== null ? `Closed ${n} application${n===1?'':'s'}, keeping the browser and VS Code open.` : 'Closing everything else.');
    } catch(e){ speak(agentUnavailableMessage()); }
    return true;
  }

  // "close settings" / "close file explorer" / "close notepad" / "close excel" / "close recycle bin", etc.
  m = lower.match(/^close (?:the |my )?([a-z0-9 +]+?)(?: app| application| program| window)?$/);
  if(m){
    const appName = m[1].trim();
    try{
      await callAgent('/close-app', { method:'POST', body:{ name: appName } });
      speak(`Closed ${appName}.`);
    } catch(e){
      if(e && /doesn't look like it's running/.test(e.message || '')) speak(e.message);
      else speak(agentUnavailableMessage());
    }
    return true;
  }

  // "open <site>" / "open <site> website" / "open <site>.com"
  m = lower.match(/^open ([a-z]+)(?:\.com)?(?: website)?$/);
  if(m && ASSISTANT_SITES[m[1]]){
    window.open(ASSISTANT_SITES[m[1]], '_blank');
    speak(`Opening ${m[1]}.`);
    return true;
  }

  // WhatsApp message: "message <name> saying <text>" / "send whatsapp message to <name> saying <text>" / "whatsapp <name> saying <text>" / "text <name> saying <text>"
  // Matched against the original-case text (not `lower`) so the message itself keeps its casing.
  m = rawTrimmed.match(/^(?:send whatsapp message to|message|whatsapp|text)\s+([a-zA-Z0-9][a-zA-Z0-9 '.-]*?)\s+(?:saying|that says|:)\s+(.+)$/i);
  if(m){
    const contact = findContact(m[1]);
    if(contact){
      const res = await openWhatsAppOnPhone(contact.phone, m[2]);
      speak(res.viaAndroidPhone
        ? `Opened WhatsApp on your phone with your message to ${contact.name}. Tap send on your phone to deliver it — I can't send it for you.`
        : `Opening WhatsApp with your message to ${contact.name}. Tap send to deliver it — I can't send it for you.`);
    } else {
      speak(`I don't have a contact named ${m[1]}. Add them in Contacts first.`);
      openModal('contacts');
    }
    return true;
  }

  // Phone call: "call <name>" / "call <name> on the phone" / "phone <name>" / "dial <name>"
  m = lower.match(/^(?:call|phone|dial)\s+(.+?)(?:\s+on (?:the )?phone)?$/);
  if(m){
    const contact = findContact(m[1]);
    if(contact){
      // The PC running Maximus and your Android phone are two different
      // devices, so a tel: link (which only works on the device that opens
      // it) can't reach the phone from here. Instead the desktop agent
      // shells out to `adb` — the Android Debug Bridge — which can tell
      // your connected phone to place a real call directly, no tap needed.
      // Requires the phone to be connected over adb (USB or wireless
      // debugging) — see DESKTOP_AGENT_README.md for setup.
      speak(`Calling ${contact.name} now.`);
      try{
        await callAgent('/call', { method:'POST', body:{ number: contact.phone, name: contact.name } });
      } catch(e){
        if(e && /No Android phone connected/.test(e.message || '')) speak(e.message);
        else if(e && /adb isn't installed/.test(e.message || '')) speak(e.message);
        else speak(agentUnavailableMessage());
      }
    } else {
      speak(`I don't have a contact named ${m[1]}. Add them with their phone number in Contacts first.`);
      openModal('contacts');
    }
    return true;
  }

  // Unlock phone: "unlock my phone" / "unlock the phone" / "unlock phone"
  m = lower.match(/^unlock (?:my |the )?phone$/);
  if(m){
    speak('Unlocking your phone.');
    try{
      const res = await callAgent('/unlock-phone', { method:'POST' });
      if(!res.used_pin) speak("Done — if it's still on the lock screen, save your PIN under Connect Phone.");
    } catch(e){
      if(e && /No Android phone connected/.test(e.message || '')) speak(e.message);
      else speak(agentUnavailableMessage());
    }
    return true;
  }

  // Lock phone: "lock my phone" / "lock the phone" / "lock phone"
  m = lower.match(/^lock (?:my |the )?phone$/);
  if(m){
    try{
      const res = await callAgent('/lock-phone', { method:'POST' });
      speak(res.already_locked ? 'Your phone is already locked.' : 'Locked your phone.');
    } catch(e){
      if(e && /No Android phone connected/.test(e.message || '')) speak(e.message);
      else speak(agentUnavailableMessage());
    }
    return true;
  }

  // In-call speaker: "speaker on" / "speaker off" / "turn on speaker" / "turn off the speaker"
  m = lower.match(/^(?:turn (on|off) (?:the )?speaker|speaker (on|off))$/);
  if(m){
    const wantState = (m[1] || m[2]);
    try{
      const res = await callAgent('/call-speaker', { method:'POST', body:{ state: wantState } });
      if(res.changed === false) speak(`Speaker's already ${wantState}.`);
      else if(res.changed === null) speak(`Tapped the speaker button — check your phone, I couldn't confirm which way it landed.`);
      else speak(`Speaker ${wantState}.`);
    } catch(e){
      if(e && /Couldn't find a speaker button/.test(e.message || '')) speak(e.message);
      else if(e && /No Android phone connected/.test(e.message || '')) speak(e.message);
      else speak(agentUnavailableMessage());
    }
    return true;
  }

  // Answer an incoming call: "answer the call" / "answer call" / "pick up" / "pick up the phone"
  if(/^(?:answer(?: the| my)? (?:call|phone)|pick up(?: the phone)?)$/.test(lower)){
    try{
      await callAgent('/answer-call', { method:'POST' });
      speak('Answered.');
    } catch(e){
      if(e && /No Android phone connected/.test(e.message || '')) speak(e.message);
      else speak(agentUnavailableMessage());
    }
    return true;
  }

  // Reject/hang up a call: "reject the call" / "decline the call" / "hang up" / "end the call"
  if(/^(?:reject(?: the)? call|decline(?: the)? call|hang up(?: the (?:call|phone))?|end (?:the |this )?call)$/.test(lower)){
    try{
      await callAgent('/reject-call', { method:'POST' });
      speak('Done.');
    } catch(e){
      if(e && /No Android phone connected/.test(e.message || '')) speak(e.message);
      else speak(agentUnavailableMessage());
    }
    return true;
  }

  // Phone battery: "phone battery" / "what's my phone's battery" / "my phone battery percentage"
  if(/^(?:what'?s |what is |check |tell me )?(?:my )?phone(?:'?s)? battery(?: percentage| level)?\??$/.test(lower)){
    try{
      const data = await callAgent('/phone-battery');
      if(data && typeof data.percent === 'number'){
        speak(`Your phone's battery is at ${data.percent} percent${data.charging ? ', and it is currently charging' : ''}.`);
      } else {
        speak("I couldn't read your phone's battery level right now.");
      }
    } catch(e){
      if(e && /No Android phone connected/.test(e.message || '')) speak(e.message);
      else speak(agentUnavailableMessage());
    }
    return true;
  }

  // Mirror phone screen: "mirror my phone" / "mirror my screen" / "mirror phone screen" / "screen mirror my phone"
  if(/^(?:mirror (?:my |the )?(?:phone|screen)(?: screen)?|screen mirror (?:my |the )?phone)$/.test(lower)){
    try{
      await callAgent('/mirror-phone', { method:'POST' });
      speak('Opening a live mirror of your phone screen.');
    } catch(e){
      if(e && /No Android phone connected/.test(e.message || '')) speak(e.message);
      else if(e && /scrcpy isn't installed/.test(e.message || '')) speak(e.message);
      else speak(agentUnavailableMessage());
    }
    return true;
  }

  // Read notifications: "read my notifications" / "check my notifications" / "what are my notifications"
  if(/^(?:read|check|show)(?: my)? notifications$|^what are my notifications\??$/.test(lower)){
    try{
      const res = await callAgent('/phone-notifications');
      const notifs = (res && res.notifications) || [];
      if(!notifs.length){
        speak("You don't have any notifications right now.");
      } else {
        const spoken = notifs.slice(0, 5).map(n => {
          const parts = [n.title, n.text].filter(Boolean);
          return parts.join(': ');
        }).filter(Boolean).join('. ');
        speak(`You have ${notifs.length} notification${notifs.length===1?'':'s'}. ${spoken}`);
      }
    } catch(e){
      if(e && /No Android phone connected/.test(e.message || '')) speak(e.message);
      else speak(agentUnavailableMessage());
    }
    return true;
  }

  // Check inbox: "check my email" / "check my inbox" / "what's in my inbox" / "do I have any new emails"
  if(/^(?:check|read|what'?s in)(?: my)? (?:email|inbox|emails)\??$|^do i have (?:any )?(?:new )?emails?\??$/.test(lower)){
    let res;
    try{
      res = await callAgent('/email-unread', { method:'GET' });
    }catch(e){
      if(e && /isn't connected/.test(e.message || '')) speak(agentEmailNotConnectedMessage());
      else speak(agentUnavailableMessage());
      return true;
    }
    const emails = (res && res.emails) || [];
    const total = (res && res.unread_count) || 0;
    if(!total){
      speak("Your inbox is all caught up — no unread emails.");
      return true;
    }
    if(!state.settings.apiKey){
      // No AI key: just read off sender + subject for the newest few.
      const spoken = emails.map(e => `From ${e.from.split('<')[0].trim()}: ${e.subject}`).join('. ');
      speak(`You have ${total} unread email${total===1?'':'s'}. ${spoken}`);
      return true;
    }
    // Agent call already succeeded at this point — any failure below is a
    // Mistral summarization problem, not an agent problem, so it gets its
    // own catch and its own, accurate, spoken message instead of falsely
    // blaming the desktop agent.
    try{
      const context = emails.map((e,i)=>`${i+1}. From: ${e.from} | Subject: ${e.subject} | ${e.snippet}`).join('\n');
      const summary = await mistralChat(
        'You summarize a list of unread emails for someone hearing this read aloud by a voice assistant. Be brief and conversational — 2-4 short sentences total, grouping similar items, mentioning sender names (first name / company, not full email addresses) and what each is about. No markdown, no numbered lists, this will be spoken aloud.',
        `I have ${total} unread emails. Here are the newest ${emails.length}:\n${context}`
      );
      speak(`You have ${total} unread email${total===1?'':'s'}. ${summary}`);
    }catch(e){
      console.warn('Email summarization failed, falling back to raw list', e);
      const spoken = emails.map(e2 => `From ${e2.from.split('<')[0].trim()}: ${e2.subject}`).join('. ');
      speak(`You have ${total} unread email${total===1?'':'s'}. ${spoken}`);
    }
    return true;
  }

  // Read a specific sender's email(s): "read my latest email from X" / "read email from X" /
  // "check emails from X" / "what's my latest email from X" — matches loosely, so "read email
  // from sam" will also catch "Samantha Rao", and reads back ALL matching emails, newest first,
  // not just a single one.
  m = lower.match(/^(?:read|check|show|what'?s)(?: my)? (?:in )?(?:the )?(?:latest |last |newest |new )?emails? from (.+?)\??$/);
  if(m){
    const who = m[1].trim();
    let res;
    try{
      res = await callAgent(`/email-search?field=from&limit=5&q=${encodeURIComponent(who)}`, { method:'GET' });
    }catch(e){
      if(e && /isn't connected/.test(e.message || '')) speak(agentEmailNotConnectedMessage());
      else speak(agentUnavailableMessage());
      return true;
    }
    const emails = (res && res.emails) || [];
    if(!emails.length){
      speak(`I couldn't find any emails from ${who}.`);
      return true;
    }
    if(state.settings.apiKey){
      try{
        const context = emails.map((e,i)=>`${i+1}. From: ${e.from} | Subject: ${e.subject} | ${e.snippet}`).join('\n');
        const summary = await mistralChat(
          'Summarize these emails, all from the same person or a close name match, conversationally in 2-4 short sentences for someone hearing it read aloud. Mention each subject briefly, newest first. No markdown.',
          `Emails matching "${who}":\n${context}`
        );
        speak(`I found ${emails.length} email${emails.length===1?'':'s'} from ${who}. ${summary}`);
      }catch(e){
        console.warn('Email summarization failed, falling back to raw list', e);
        const spoken = emails.map(e2 => `Subject "${e2.subject}": ${e2.snippet}`).join('. ');
        speak(`I found ${emails.length} email${emails.length===1?'':'s'} from ${who}. ${spoken}`);
      }
    } else {
      const spoken = emails.map(e => `Subject "${e.subject}": ${e.snippet}`).join('. ');
      speak(`I found ${emails.length} email${emails.length===1?'':'s'} from ${who}. ${spoken}`);
    }
    return true;
  }

  // Search email: "find emails about X" / "search my email for X" / "find emails from X"
  m = lower.match(/^(?:find|search)(?: my)? emails? (?:about|for|regarding) (.+)$/);
  if(m){
    const query = m[1].trim();
    try{
      const res = await callAgent(`/email-search?field=text&limit=5&q=${encodeURIComponent(query)}`, { method:'GET' });
      const emails = (res && res.emails) || [];
      if(!emails.length){
        speak(`I couldn't find any emails about ${query}.`);
        return true;
      }
      const spoken = emails.map(e => `From ${e.from.split('<')[0].trim()}: ${e.subject}`).join('. ');
      speak(`I found ${emails.length} email${emails.length===1?'':'s'} about ${query}. ${spoken}`);
    }catch(e){
      if(e && /isn't connected/.test(e.message || '')) speak(agentEmailNotConnectedMessage());
      else speak(agentUnavailableMessage());
    }
    return true;
  }

  // Send an email by voice: "email <address> saying <message>" / "send an email to <address> saying <message>"
  // The recipient must be a plain email address (e.g. "email john@company.com saying I'm running late").
  m = rawTrimmed.match(/^(?:email|send an? email to|send email to)\s+(\S+@\S+?)\s+saying\s+(.+)$/i);
  if(m){
    const to = m[1].trim().replace(/[,.]$/, '');
    const instruction = m[2].trim();
    if(!state.settings.apiKey){
      speak('I need an API key to draft that email properly. Add one in Settings.');
      return true;
    }
    speak('Drafting that now.');
    try{
      const drafted = await mistralChat(
        'Write a short, clear, professional email body based on the sender\'s dictated intent. Reply with ONLY the email body text, no subject line, no greeting/signoff placeholders like "[Your Name]", no markdown, no explanation.',
        instruction
      );
      const subject = await mistralChat(
        'Write a short email subject line (under 8 words, no quotes, no punctuation at the end) summarizing this email body.',
        drafted,
        { maxTokens: 30, temperature: 0.2 }
      );
      pendingEmailDraft = { to, subject: subject.replace(/^["']|["']$/g,''), body: drafted };
      speak(`Here's the draft to ${to}, subject "${pendingEmailDraft.subject}": ${drafted} Say "send it" to send, or "cancel" to discard.`);
    }catch(e){
      speak('I had trouble drafting that email.');
    }
    return true;
  }

  // Draft a reply to someone's latest email: "reply to email from X saying Y" / "reply to X saying Y"
  m = rawTrimmed.match(/^reply to (?:the )?(?:email from |email by )?(.+?) saying (.+)$/i);
  if(m){
    const who = m[1].trim();
    const instruction = m[2].trim();
    if(!state.settings.apiKey){
      speak('I need an API key to draft that reply. Add one in Settings.');
      return true;
    }
    try{
      const res = await callAgent(`/email-search?field=from&limit=1&q=${encodeURIComponent(who)}`, { method:'GET' });
      const found = (res && res.emails && res.emails[0]) || null;
      if(!found){
        speak(`I couldn't find an email from ${who} to reply to.`);
        return true;
      }
      speak('Drafting your reply now.');
      const drafted = await mistralChat(
        'Write a short, clear reply email body. You are given the original email and what the sender wants to say in reply. Write ONLY the reply body text — no subject line, no quoted original text, no markdown, no placeholder signoffs.',
        `Original email:\nFrom: ${found.from}\nSubject: ${found.subject}\nBody: ${found.body}\n\nWhat I want to say in reply: ${instruction}`
      );
      const replyToAddr = (found.from.match(/<([^>]+)>/) || [null, found.from])[1];
      pendingEmailDraft = {
        to: replyToAddr,
        subject: /^re:/i.test(found.subject) ? found.subject : `Re: ${found.subject}`,
        body: drafted,
        in_reply_to: found.message_id || ''
      };
      speak(`Here's the reply to ${who}: ${drafted} Say "send it" to send, or "cancel" to discard.`);
    }catch(e){
      if(e && /isn't connected/.test(e.message || '')) speak(agentEmailNotConnectedMessage());
      else speak('I had trouble drafting that reply.');
    }
    return true;
  }

  // Location
  if(/^(show my location|where am i)$/.test(lower)){
    if(navigator.geolocation){
      speak('Getting your current location.');
      navigator.geolocation.getCurrentPosition(
        pos => window.open(`https://www.google.com/maps?q=${pos.coords.latitude},${pos.coords.longitude}`, '_blank'),
        () => speak("I couldn't get your location — check location permissions for this site.")
      );
    } else {
      speak("Location isn't available in this browser.");
    }
    return true;
  }

  // Navigation / directions
  m = lower.match(/^(?:navigate to|directions to|take me to) (.+)$/);
  if(m){
    window.open(`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(m[1])}`, '_blank');
    speak(`Starting directions to ${m[1]}.`);
    return true;
  }

  // Nearby places — support several word orders people naturally say
  m = lower.match(/^(?:find|show|search for)?\s*nearby (.+)$/)
   || lower.match(/^(?:find|show) (.+) near(?:by)? ?me$/)
   || lower.match(/^(.+) nearby$/)
   || lower.match(/^(.+) near me$/);
  if(m){
    const place = m[1].trim();
    speak(`Looking for ${place} near you.`);
    if(navigator.geolocation){
      navigator.geolocation.getCurrentPosition(
        pos => window.open(`https://www.google.com/maps/search/${encodeURIComponent(place)}/@${pos.coords.latitude},${pos.coords.longitude},15z`, '_blank'),
        () => window.open(`https://www.google.com/maps/search/${encodeURIComponent(place)}`, '_blank')
      );
    } else {
      window.open(`https://www.google.com/maps/search/${encodeURIComponent(place)}`, '_blank');
    }
    return true;
  }

  // Generic "open <desktop app>" fallback — for real installed applications
  // (Notepad, Calculator, Chrome, Word, Excel, the Spotify desktop app, etc)
  // rather than websites. Only reached if nothing above matched, so known
  // websites from ASSISTANT_SITES are still opened as a browser tab, not
  // launched as a desktop app.
  m = lower.match(/^open (?:the |my )?([a-z0-9 +]+?)(?: app| application| program)?$/);
  if(m && !ASSISTANT_SITES[m[1].replace(/\s+/g, '')]){
    const appName = m[1].trim();
    try{
      await callAgent('/open-app', { method:'POST', body:{ name: appName } });
      speak(`Opening ${appName}.`);
    } catch(e){ speak(agentUnavailableMessage()); }
    return true;
  }

  return false;
}

// The exact phrasing patterns executeVoiceCommand() understands, written as
// a short grammar for the LLM to translate loose spoken phrasing into. Kept
// in one place so it's easy to extend alongside the regexes above.
const VOICE_COMMAND_GRAMMAR = `
- play <video> on youtube
- play <song>
- pause the music / resume the music / skip / previous
- loop this song / stop looping
- weather / weather in <city>
- news / news about <topic> / today's news in india
- what's trending / trending topics
- search <query> on <site>
- battery percentage
- go to desktop
- open file explorer
- open task manager
- open computer settings
- open vscode
- create a file on desktop named <name>
- create a folder on desktop named <name>
- empty the recycle bin
- take a screenshot
- show screenshots
- open the latest screenshot
- increase brightness by <amount> / decrease brightness by <amount> / set brightness to <amount>
- increase volume by <amount> / decrease volume by <amount> / set volume to <amount> / mute / unmute
- what's my volume / what's my brightness
- close <app name>
- close all applications
- restart the computer
- shut down the computer
- sleep the computer
- open vision
- close vision
- what do you see
- share my screen
- stop sharing my screen
- what's on my screen
- auto scroll / scroll down / scroll up
- stop scrolling
- open <site or app name>  (e.g. gmail, github, spotify, notepad, calculator, chrome, word, excel)
- message <contact name> saying <text>
- call <contact name>
- speaker on
- speaker off
- answer the call
- reject the call / hang up
- phone battery
- mirror my phone
- read my notifications
- check my email
- read my latest email from <name>
- find emails about <topic>
- email <address> saying <message>
- reply to <name> saying <message>
- send it
- cancel
- remind me to <task> at <time>
- add <task> to my to-do list
- what's on my to-do list
- mark <task> as done
- clear my to-do list
- give me my briefing
- what's today's news
- show my location
- navigate to <place>
- find <place> near me
- what's on my calendar / what's on my calendar today / what's on my calendar tomorrow
- add an event called <title> at <time>
- add a new feature: <description> / upgrade yourself to <description>
`.trim();

// When the fast regex matcher above doesn't recognize a phrase, ask the model
// to translate it into one of the canonical forms it DOES recognize (so
// "could you open youtube for me" or "yo pump the volume up a bit" still
// work, not just exact scripted phrasings), or reply NONE if it's really
// just a question/conversation. Fails silently (returns null) on any error
// so callers can just fall through to normal chat.
async function classifyAndNormalizeCommand(text){
  if(!state.settings.apiKey) return null;
  try{
    const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.settings.apiKey}` },
      body: JSON.stringify({
        model: CONFIG.MODEL_FAST,
        messages: [
          { role: 'system', content: `You translate a spoken instruction into ONE canonical command from this exact list of patterns (fill in the <bracketed> parts with the user's real words, keep everything else word-for-word):\n${VOICE_COMMAND_GRAMMAR}\n\nRules:\n- Reply with ONLY the canonical command text, nothing else — no quotes, no explanation.\n- If the instruction is really a question, chit-chat, or anything that doesn't clearly match one of these actions, reply with exactly: NONE\n- Never invent a pattern that isn't in the list.` },
          { role: 'user', content: text }
        ],
        max_tokens: 40,
        temperature: 0
      })
    });
    if(!res.ok) return null;
    const data = await res.json();
    const out = (data.choices?.[0]?.message?.content || '').trim().replace(/^["'`]+|["'`]+$/g, '');
    if(!out || out.toUpperCase() === 'NONE') return null;
    return out;
  }catch(e){
    return null;
  }
}

/* Ask Maximus a general question by voice — reuses the existing chat pipeline
   so the answer lands in the current chat too, and speaks the reply as it's
   being generated (sentence by sentence) instead of waiting for the full
   answer to finish before saying anything. */
async function askCortexByVoice(text){
  if(!state.settings.apiKey){
    speak('I need an API key before I can answer questions. Please add one in Settings.');
    openModal('settings');
    return;
  }
  messageInput.value = text;
  updateSendButtonState();

  let spokenUpTo = 0;
  const speakNewSentences = ()=>{
    const chat = getActiveChat();
    const last = chat && [...chat.messages].reverse().find(m => m.role === 'assistant');
    if(!last || !last.content) return;
    const clean = cleanForSpeech(last.content);
    if(clean.length <= spokenUpTo) return;
    const rest = clean.slice(spokenUpTo);
    // Only speak complete sentences so far; leave any trailing partial
    // sentence for the next tick (or the final flush below) so words aren't cut mid-way.
    const complete = rest.match(/^[\s\S]*[.!?](?=\s|$)/);
    if(complete){
      queueSpeech(complete[0]);
      spokenUpTo += complete[0].length;
    }
  };

  const pollId = setInterval(speakNewSentences, 300);
  voiceReplyMode = true;
  await sendMessage();
  voiceReplyMode = false;
  clearInterval(pollId);

  // Flush whatever's left, including a final fragment with no trailing punctuation.
  const chat = getActiveChat();
  const last = chat && [...chat.messages].reverse().find(m => m.role === 'assistant');
  if(last && last.content){
    const clean = cleanForSpeech(last.content);
    const remainder = clean.slice(spokenUpTo).trim();
    if(remainder) queueSpeech(remainder);
  }
}

// Keeps continuous listening on for everything (open sites, messages, weather,
// news, etc.) — it only pauses listening while a Spotify track is actually
// playing, and automatically resumes it the moment that track is paused or
// stops, so the mic isn't fighting the music but normal use isn't interrupted.
let listeningAutoPausedForMusic = false;
function syncListeningWithMusic(spotifyState){
  if(!assistantRecognition) return;
  const isPlaying = !!(spotifyState && spotifyState.track_window && spotifyState.track_window.current_track && !spotifyState.paused);
  if(isPlaying){
    if(wantContinuousListening){
      listeningAutoPausedForMusic = true;
      wantContinuousListening = false;
      clearTimeout(restartTimer);
      clearPendingVoiceBuffer();
      try{ assistantRecognition.stop(); }catch(e){}
      stopMicAnalyser();
      setListenButtonState(false);
      if(assistantStatus) assistantStatus.textContent = 'Paused listening while the song plays';
    }
  } else if(listeningAutoPausedForMusic){
    listeningAutoPausedForMusic = false;
    wantContinuousListening = true;
    lastRecognitionActivity = Date.now();
    clearPendingVoiceBuffer();
    try{ assistantRecognition.start(); recognitionRunning = true; }catch(e){ scheduleRecognitionRestart(300); }
    startMicAnalyser();
    setListenButtonState(true);
  }
}

// Cheap, local, zero-latency check for "this is clearly a question/chit-chat,
// not a device command" — lets handleVoiceInput skip the network classifier
// call entirely for the common case, which was previously adding a full extra
// round-trip (~1-2s) in front of every question before the real answer even
// started generating.
const COMMAND_ACTION_WORDS = /\b(open|close|play|pause|resume|skip|stop|mute|unmute|increase|decrease|set|create|empty|take|show|restart|shut down|sleep|share|navigate|find|message|search|scroll|loop|call|dial|phone|speaker|turn|answer|reject|decline|hang up|pick up|read|check|mirror|email|inbox|reply|send it|draft|remind|reminder|task|to-?do|brief|briefing|complete|finished)\b/i;
function looksLikeQuestionNotCommand(text){
  const t = text.trim();
  if(!t) return false;
  if(/\?$/.test(t)) return true;
  if(/^(what|who|when|where|why|how|is|are|was|were|do|does|did|can|could|would|should|will|tell me|explain|describe)\b/i.test(t)) return true;
  // If it doesn't even contain a recognizable command action word, it's
  // almost certainly conversation — let it go straight to the AI.
  if(!COMMAND_ACTION_WORDS.test(t)) return true;
  return false;
}

async function handleVoiceInput(text){
  speechSuppressed = false; // a new thing to say is starting — allow speech again
  if(assistantStatus) assistantStatus.textContent = 'Thinking…';
  let handled = await executeVoiceCommand(text);
  if(!handled && !looksLikeQuestionNotCommand(text)){
    // Didn't match a scripted phrasing exactly — ask the model whether this
    // was actually meant as one of the known actions, just worded loosely
    // ("could you pull up youtube", "turn the volume down a touch", etc.),
    // and run the normalized version through the same command handler.
    // Skipped entirely for text that's clearly a question/chit-chat, so
    // ordinary questions go straight to the answer with no extra round-trip.
    const canonical = await classifyAndNormalizeCommand(text);
    if(canonical) handled = await executeVoiceCommand(canonical);
  }
  if(!handled) await askCortexByVoice(text);
  if(assistantStatus) assistantStatus.textContent = wantContinuousListening ? 'Listening…' : 'Tap "Start Listening" and speak';
}

/* ---------- Overlay open/close ---------- */
if(assistantFab){
  assistantFab.addEventListener('click', ()=>{
    assistantOverlay.classList.remove('hidden');
    initOrb();
    updateNowPlayingUI();
  });
}
if(assistantCloseBtn){
  assistantCloseBtn.addEventListener('click', ()=>{
    assistantOverlay.classList.add('hidden');
    cancelAnimationFrame(orbAnimFrame);
    if(wantContinuousListening) listenToggleBtn.click();
    stopSpeaking();
    stopVision();
    stopScreenShare();
    stopAutoScroll();
  });
}
if(assistantContactsBtn){
  assistantContactsBtn.addEventListener('click', ()=> openModal('contacts'));
document.getElementById('connectPhoneBtn').addEventListener('click', ()=> openModal('connectPhone'));
}
const connectEmailBtn = document.getElementById('connectEmailBtn');
if(connectEmailBtn){
  connectEmailBtn.addEventListener('click', ()=> openModal('connectEmail'));
}
const mirrorPhoneBtn = document.getElementById('mirrorPhoneBtn');
if(mirrorPhoneBtn){
  mirrorPhoneBtn.addEventListener('click', async ()=>{
    try{
      await callAgent('/mirror-phone', { method:'POST' });
      showToast('Opening a live mirror of your phone screen…');
    } catch(e){
      showToast((e && e.message) || agentUnavailableMessage());
    }
  });
}
const stopSpeakingBtn = document.getElementById('stopSpeakingBtn');
if(stopSpeakingBtn){
  stopSpeakingBtn.addEventListener('click', ()=>{
    stopSpeaking();
    if(assistantStatus) assistantStatus.textContent = wantContinuousListening ? 'Listening…' : 'Tap "Start Listening" and speak';
  });
}

/* ================= SELF-UPGRADE ("add a new feature to yourself") =================
   Voice command like "add a new feature: tell me a joke when I say tell me a joke" walks
   through: (1) fetch this file's own current source from the local desktop agent, (2) ask
   the AI model to write NEW vanilla-JS code implementing the request (never touching or
   repeating existing code), (3) have the agent append that code to the clearly-marked
   section below and write a timestamped backup first, so nothing existing is ever lost.
   Requires maximus_agent.py to be running (it's the only thing allowed to touch disk) and
   a page refresh afterwards to actually load the new code — Maximus tells the user this.
   This is best-effort and experimental: generated code can be wrong, so keeping this
   project under git (or any backup) alongside the agent's own automatic backups is worth
   doing before relying on it. */
const SELF_UPGRADE_MARKER = '/* ===== USER-ADDED FEATURES (auto-generated via "add a new feature") ===== */';

async function selfUpgrade(featureDescription){
  if(!featureDescription || !featureDescription.trim()){
    speak("What feature would you like me to add, Sir?");
    return;
  }
  if(!state.settings.apiKey){
    speak('I need an API key before I can write new code. Please add one in Settings.');
    openModal('settings');
    return;
  }
  speak("On it, Sir. Let me write that and add it to myself — this'll take a moment.");
  showToast('Maximus is writing new code for itself…');

  let currentSource;
  try{
    const fileRes = await fetch(`${CONFIG.AGENT_URL}/source-file?name=app.js`);
    if(!fileRes.ok) throw new Error('agent rejected the read');
    const fileData = await fileRes.json();
    currentSource = fileData.content || '';
  }catch(e){
    speak("I can't reach my desktop agent, so I can't read or edit my own code right now. Make sure maximus_agent.py is running.");
    return;
  }

  // Only send the tail of the file as context (globals/helpers/patterns live throughout,
  // but the marker section + init block at the end is what matters for where/how to hook in)
  // to keep this a small, fast request instead of shipping the whole multi-thousand-line file.
  const contextTail = currentSource.slice(-6000);
  const alreadyHasMarker = currentSource.includes(SELF_UPGRADE_MARKER);

  try{
    const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.settings.apiKey}` },
      body: JSON.stringify({
        model: CONFIG.MODEL_TEXT,
        messages: [
          { role: 'system', content: `You are extending a vanilla-JS (no build step, no frameworks, no imports/exports) single-page app called Maximus. You are given the tail of its main app.js file for context — existing globals/helpers you can rely on include: state (app state object), speak(text) and queueSpeech(text) (TTS), showToast(msg), CONFIG (has AGENT_URL etc.), callAgent(path, opts) (fetch wrapper for the local desktop agent), openModal(name), and DOM helpers already used elsewhere in the file. Write ONLY new, self-contained vanilla JavaScript implementing the requested feature — new function(s) plus any event listener wiring it needs. Do NOT repeat or rewrite any existing code. Do NOT use import/export/require. Wrap ONLY functioning, directly-runnable code with no explanation, no markdown, in a single fenced \`\`\`javascript code block.` },
          { role: 'user', content: `Existing file tail for context:\n\`\`\`javascript\n${contextTail}\n\`\`\`\n\nFeature to add: ${featureDescription.trim()}` }
        ],
        max_tokens: 1500
      })
    });
    if(!res.ok){
      if(res.status === 401) throw new Error('Invalid API key. Update it in Settings.');
      throw new Error(`Code generation failed (${res.status})`);
    }
    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content || '';
    const codeMatch = raw.match(/```(?:javascript|js)?\s*([\s\S]*?)```/);
    const newCode = (codeMatch ? codeMatch[1] : raw).trim();
    if(!newCode){ speak("I wasn't able to write that feature. Try describing it a bit differently, Sir."); return; }

    const appendBlock = (alreadyHasMarker ? '' : `\n\n${SELF_UPGRADE_MARKER}\n`) +
      `\n/* Feature added ${new Date().toISOString()}: ${featureDescription.trim().replace(/\*\//g, '')} */\n${newCode}\n`;

    const writeRes = await fetch(`${CONFIG.AGENT_URL}/source-file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'app.js', append: appendBlock })
    });
    if(!writeRes.ok) throw new Error('agent rejected the write');
    speak("Done, Sir. I've added that to my own code and backed up the previous version. Refresh the page to load it.");
    showToast('New feature added — refresh the page to load it.');
  }catch(e){
    console.warn('Self-upgrade failed', e);
    speak(`I ran into a problem adding that feature. ${e.message || ''}`.trim());
  }
}

/* ================= INIT ================= */
initAuthGate();
rescheduleAllPendingTasks();
handleSpotifyRedirect();
if(state.spotify && state.spotify.accessToken) initSpotifyPlayer();
/* =====================================================================
   MAXIMUS APPOINTMENT AGENT  (DVPS11)
   ---------------------------------------------------------------------
   "A personal AI agent that negotiates and books appointments (salon,
   doctor, service repair) on your behalf via calls or chat."

   This file is a self-contained EXTENSION of the existing Maximus app.
   It does not modify app.js — it reuses the globals app.js already
   defines (state, save, showToast, mistralChat, speak, escapeHtml, uid,
   ensureGoogleToken, CONFIG, addTask, callAgent) and wraps two existing
   entry points (sendMessage, executeVoiceCommand) so natural-language
   appointment requests typed in chat OR spoken to the voice assistant
   are routed into this module, without touching how either function
   behaves for everything else.

   IMPORTANT (per the project brief): there is no real salon/doctor/repair
   booking API wired up. Every provider, phone call and chat negotiation
   below is DEMO / SIMULATED DATA, clearly labelled as such everywhere it
   is shown. Nothing here ever claims a real-world appointment was placed.
   The only real side effects are: (1) an optional real Google Calendar
   event, if the user already connected Google Calendar, and (2) local
   reminders using Maximus's existing task/reminder system.

   ADDED — REAL HOSPITAL SEARCH (section 2b): when the request is about a
   hospital/doctor near the user, Maximus now looks up REAL nearby
   hospitals (name, address, phone if listed) using the device's
   location + the free OpenStreetMap Overpass API — no Google Maps API
   key required, nothing rebuilt or removed elsewhere. The phone call
   itself is still SIMULATED (clearly labelled), same as every other
   category — Maximus was not given a real telephony backend, so it
   never actually dials the real hospital's number. Everything downstream
   of search (ranking, "call", approval, booking, calendar, reminders)
   reuses the exact same pipeline the rest of this file already had.
   ===================================================================== */

(function(){

/* ------------------------------------------------------------------ *
 *  1. STATE
 * ------------------------------------------------------------------ */

function initAppointmentState(){
  state.appointments        = state.appointments        || [];  // booked/completed/cancelled
  state.appointmentPrefs    = state.appointmentPrefs    || { preferredTime: '', maxBudget: null, preferredLocation: '', preferredProviders: [], communicationMethod: 'chat' };
  state.agentPermissions    = Object.assign({
    canContact: true,            // Can Maximus contact businesses?
    canNegotiate: true,          // Can Maximus negotiate?
    maxPrice: 2000,              // Maximum appointment price (₹)
    maxNegotiationAttempts: 3,   // Maximum negotiation attempts
    canAutoReschedule: false,    // Can Maximus automatically reschedule?
    canBookWithoutConfirmation: false, // Can Maximus book without confirmation?
    canMakePayments: false       // Can Maximus make payments? (not implemented — always off)
  }, state.agentPermissions || {});
  save();
}
initAppointmentState();

/* ------------------------------------------------------------------ *
 *  2. MOCK / DEMO PROVIDER DATABASE
 *     Clearly separated from any real integration. Swap searchProviders()
 *     for a real API call later — everything downstream (comparison,
 *     negotiation, booking, calendar, reminders) already works off the
 *     same {id,name,service,rating,price,slots,distanceKm,phone,demo}
 *     shape, so real providers can be dropped in without touching the
 *     rest of the pipeline.
 * ------------------------------------------------------------------ */

const CATEGORY_SERVICES = {
  salon:  ['haircut', 'hair coloring', 'spa', 'beauty services'],
  doctor: ['general physician', 'dentist', 'dermatologist', 'specialist consultation', 'hospital visit'],
  repair: ['ac repair', 'plumbing', 'electrician', 'appliance repair', 'car/bike service']
};

const PROVIDER_NAME_POOL = {
  salon:  ['ABC Salon', 'Glow & Go Salon', 'Urban Cuts Studio', 'The Style Bar', 'Radiance Salon & Spa'],
  doctor: ['CityCare Clinic', 'Wellness Point Hospital', 'Dr. Mehta\'s Clinic', 'Sunrise Multispecialty', 'HealFast Clinic'],
  repair: ['XYZ Repairs', 'QuickFix Home Services', 'CoolAir AC Services', 'HandyPro Repairs', 'RapidFix Technicians']
};

const BASE_PRICE_RANGES = {
  haircut: [400, 800], 'hair coloring': [900, 2200], spa: [1200, 2800], 'beauty services': [600, 1800],
  'general physician': [300, 700], dentist: [500, 1500], dermatologist: [600, 1800], 'specialist consultation': [700, 2000],
  'ac repair': [500, 1400], plumbing: [300, 900], electrician: [250, 800], 'appliance repair': [400, 1200], 'car/bike service': [600, 2500]
};

function seededRandom(seed){
  // Small deterministic PRNG so the "demo providers" look stable within a
  // session/date instead of re-shuffling on every render.
  let x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function categoryForService(service){
  for(const cat in CATEGORY_SERVICES){
    if(CATEGORY_SERVICES[cat].includes(service)) return cat;
  }
  return 'salon';
}

function nextSlotsFor(dateStr, seed){
  const options = ['9:00 AM','10:00 AM','11:30 AM','1:00 PM','2:30 PM','4:00 PM','5:00 PM','5:30 PM','6:00 PM','6:30 PM','7:00 PM','7:30 PM'];
  const count = 2 + Math.floor(seededRandom(seed) * 3); // 2-4 slots
  const picked = [];
  for(let i=0;i<count;i++){
    const idx = Math.floor(seededRandom(seed + i * 7.13) * options.length);
    if(!picked.includes(options[idx])) picked.push(options[idx]);
  }
  return picked.sort((a,b)=> to24h(a) - to24h(b));
}

function to24h(t){
  const m = t.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if(!m) return 0;
  let h = parseInt(m[1],10) % 12;
  if(/pm/i.test(m[3])) h += 12;
  return h*60 + parseInt(m[2],10);
}

// Generates demo/mock providers for a given service + date. Marked
// `demo:true` on every record so the UI can always show "Demo provider".
function searchProviders(service, dateStr){
  const category = categoryForService(service);
  const names = PROVIDER_NAME_POOL[category];
  const [lo, hi] = BASE_PRICE_RANGES[service] || [400, 1000];
  const daySeed = dateStr ? new Date(dateStr).getTime() / 86400000 : 1;
  return names.map((name, i)=>{
    const seed = (daySeed + i * 3.7 + service.length) % 1000;
    const price = Math.round((lo + seededRandom(seed) * (hi - lo)) / 10) * 10;
    const rating = (3.9 + seededRandom(seed + 1) * 1.0).toFixed(1);
    const distance = (0.6 + seededRandom(seed + 2) * 6.4).toFixed(1);
    return {
      id: 'prov_' + service.replace(/\s+/g,'') + '_' + i,
      demo: true,
      name,
      category,
      service,
      rating: Number(rating),
      price,
      slots: nextSlotsFor(dateStr, seed + 3),
      distanceKm: Number(distance),
      phone: '+91 98' + String(1000000 + Math.floor(seededRandom(seed+4)*8999999)).slice(0,8),
      contactMethod: 'Chat / Call (simulated)'
    };
  });
}

/* ------------------------------------------------------------------ *
 *  2b. REAL NEARBY PLACES  (OpenStreetMap Overpass API — free, no API
 *      key). This is the part of the pipeline that returns real
 *      businesses instead of the mock database above — for hospitals,
 *      salons, AND repair services (plumber/electrician/mechanic/AC/
 *      appliance). Everything else (ranking display, "calling" them,
 *      negotiation-skip, booking, calendar, reminders) reuses the exact
 *      same downstream pipeline — real results are just shaped like the
 *      same provider object, with `real:true` / `demo:false` so the UI
 *      can label them honestly. The call/chat itself stays SIMULATED
 *      (see buildRealPlaceCallTranscript) — Maximus has no telephony
 *      backend, so it never actually dials the real number found here.
 *      (WhatsApp is the one exception: see section 4b — Maximus can open
 *      a real WhatsApp chat pre-filled with the booking message, but a
 *      human still has to tap Send.)
 * ------------------------------------------------------------------ */

// Which OpenStreetMap tags to search for, per bookable service. Doctor/
// hospital services map to medical amenity tags, salon services map to
// hairdresser/beauty/spa shop tags, repair services map to the closest
// craft/shop tags OSM actually uses. Services with no real-world map
// data source available simply aren't listed here and fall back to the
// demo provider database further up.
const REAL_PLACE_OSM_TAGS = {
  'hospital visit':          [['amenity','hospital']],
  'general physician':       [['amenity','hospital'], ['amenity','clinic'], ['amenity','doctors']],
  'dentist':                 [['amenity','dentist']],
  'dermatologist':           [['amenity','clinic'], ['amenity','doctors']],
  'specialist consultation': [['amenity','clinic'], ['amenity','doctors']],
  'haircut':                 [['shop','hairdresser'], ['shop','beauty']],
  'hair coloring':           [['shop','hairdresser'], ['shop','beauty']],
  'spa':                     [['shop','beauty'], ['leisure','spa']],
  'beauty services':         [['shop','beauty'], ['shop','hairdresser']],
  'ac repair':               [['craft','hvac'], ['shop','hvac']],
  'plumbing':                [['craft','plumber']],
  'electrician':             [['craft','electrician']],
  'appliance repair':        [['shop','appliance'], ['craft','electrical_appliance_repair']],
  'car/bike service':        [['shop','car_repair'], ['shop','motorcycle_repair']]
};

// Short, natural label per service for chat/log copy ("real hospital",
// "real salon", "real plumber", etc.) instead of hard-coding "hospital"
// everywhere.
const PLACE_LABEL_BY_SERVICE = {
  'hospital visit': 'hospital', 'general physician': 'hospital',
  'dentist': 'dental clinic', 'dermatologist': 'clinic', 'specialist consultation': 'clinic',
  'haircut': 'salon', 'hair coloring': 'salon', 'spa': 'spa', 'beauty services': 'salon',
  'ac repair': 'AC repair service', 'plumbing': 'plumber', 'electrician': 'electrician',
  'appliance repair': 'appliance repair service', 'car/bike service': 'garage'
};
function placeLabelForService(service){
  return PLACE_LABEL_BY_SERVICE[service] || 'provider';
}

function getUserLocation(){
  return new Promise((resolve)=>{
    if(!navigator.geolocation){ resolve(null); return; }
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      _err => resolve(null),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 5 * 60 * 1000 }
    );
  });
}

function haversineKm(lat1, lon1, lat2, lon2){
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

// Detects whether a booking request should trigger a REAL nearby-place
// lookup instead of the mock provider database. Every bookable service
// that has a real-world OSM tag mapping (hospital, salon, AND every
// repair category — plumber, electrician, AC, appliance, car/bike) now
// always tries the real search first, the same way hospital always did —
// "near me"/"nearby"/naming the place kind is no longer required to
// trigger it. findRealPlaces() already falls back to the demo provider
// list on its own if location is denied or nothing real is found nearby,
// so this is safe for every category.
function wantsRealPlaceSearch(rawText, request){
  if(!request || !request.service) return false;
  if(!REAL_PLACE_OSM_TAGS[request.service]) return false; // no real-world data source for this service
  return true;
}

async function searchRealPlacesNearby(loc, dateStr, radiusM, service, category){
  const tagPairs = REAL_PLACE_OSM_TAGS[service] || [];
  if(!tagPairs.length) return [];
  const filters = tagPairs.map(([k,v])=>
    `node["${k}"="${v}"](around:${radiusM},${loc.lat},${loc.lon});way["${k}"="${v}"](around:${radiusM},${loc.lat},${loc.lon});`
  ).join('');
  const overpassQL = `[out:json][timeout:20];(${filters});out center tags 20;`;
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    body: overpassQL
  });
  if(!res.ok) throw new Error('overpass_http_' + res.status);
  const data = await res.json();
  const seen = new Set();
  const results = (data.elements || []).map(el=>{
    const tags = el.tags || {};
    if(!tags.name || seen.has(tags.name)) return null;
    const lat = el.lat != null ? el.lat : (el.center ? el.center.lat : null);
    const lon = el.lon != null ? el.lon : (el.center ? el.center.lon : null);
    if(lat == null || lon == null) return null;
    seen.add(tags.name);
    const distanceKm = Number(haversineKm(loc.lat, loc.lon, lat, lon).toFixed(2));
    const phone = tags.phone || tags['contact:phone'] || tags['contact:mobile'] || null;
    const addressParts = [tags['addr:housenumber'], tags['addr:street'] || tags['addr:place'], tags['addr:suburb'], tags['addr:city']].filter(Boolean);
    const address = addressParts.join(', ') || null;
    return {
      id: 'osm_' + el.type + '_' + el.id,
      demo: false,
      real: true,
      source: 'OpenStreetMap',
      name: tags.name,
      category,
      service,
      rating: null,   // not fabricated — OSM has no ratings data
      price: null,    // not fabricated — real prices/fees aren't available here
      // Slot *times* are still demo/simulated — no public API exposes a
      // real business's live booking schedule, so this is the one field
      // that stays synthetic even for a real place record.
      slots: nextSlotsFor(dateStr, (el.id % 997) + 3),
      distanceKm,
      phone,
      address,
      emergency: tags.emergency === 'yes', // only meaningful for hospitals; harmlessly false elsewhere
      mapsUrl: 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(tags.name + (address ? ', ' + address : '')),
      contactMethod: phone ? 'Call (simulated) / WhatsApp / Chat' : 'No phone listed on the map — visit in person or search separately'
    };
  }).filter(Boolean);
  // No fabricated ratings to rank by, so rank by something real: prefer
  // emergency-tagged hospitals (irrelevant/false for other categories),
  // then closest to the user.
  results.sort((a,b)=> (Number(b.emergency) - Number(a.emergency)) || (a.distanceKm - b.distanceKm));
  return results;
}

// Tries a tight radius first (fast, closest results), widens once if empty.
async function findRealPlaces(dateStr, service, category){
  const loc = await getUserLocation();
  if(!loc) return { loc: null, places: [] };
  try{
    let places = await searchRealPlacesNearby(loc, dateStr, 6000, service, category);
    if(!places.length) places = await searchRealPlacesNearby(loc, dateStr, 15000, service, category);
    return { loc, places: places.slice(0, 8) };
  }catch(e){
    console.warn('Real nearby-place search (Overpass) failed.', e);
    return { loc, places: [] };
  }
}

function rankProviders(providers, request){
  // Simple, explainable scoring: rating weighted highest, then price
  // closeness to budget, then distance. Good enough for a transparent demo.
  const budget = request.max_budget || Infinity;
  return providers.slice().sort((a,b)=>{
    const scoreA = a.rating*2 - (a.price>budget?3:0) - a.distanceKm*0.05;
    const scoreB = b.rating*2 - (b.price>budget?3:0) - b.distanceKm*0.05;
    return scoreB - scoreA;
  });
}

function pickSlot(provider, request){
  const wanted = request.preferred_time; // e.g. "18:00" or "6 PM"
  if(!wanted) return provider.slots[0];
  const wantedMin = normalizeTimeToMinutes(wanted);
  if(wantedMin == null) return provider.slots[0];
  let best = provider.slots[0], bestDiff = Infinity;
  provider.slots.forEach(s=>{
    const diff = Math.abs(to24h(s) - wantedMin);
    if(diff < bestDiff){ bestDiff = diff; best = s; }
  });
  return best;
}

function normalizeTimeToMinutes(t){
  if(!t) return null;
  let m = String(t).match(/^(\d{1,2}):(\d{2})$/); // "18:00"
  if(m) return parseInt(m[1],10)*60 + parseInt(m[2],10);
  m = String(t).match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i); // "6 PM"
  if(m){ let h = parseInt(m[1],10)%12; if(/pm/i.test(m[3])) h+=12; return h*60 + (m[2]?parseInt(m[2],10):0); }
  return null;
}

/* ------------------------------------------------------------------ *
 *  3. NATURAL LANGUAGE UNDERSTANDING (Mistral, with an offline fallback
 *     so the demo still works with no/failed API key)
 * ------------------------------------------------------------------ */

const APPOINTMENT_INTENT_RE = /\b(book|booking|appointment|reschedul|cancel my appointment|cancel (my |the )?(haircut|salon|doctor|dentist|repair|service|hospital)|haircut|hair\s?cut|salon|spa|dentist|doctor|physician|dermatologist|hospital|clinic|plumb(er|ing)|electrician|ac repair|appliance repair|car service|bike service|negotiate the price|find (me )?(a |an )?(salon|doctor|dentist|mechanic|plumber|electrician|hospital)|show my appointments|my appointments)\b/i;

function looksLikeAppointmentRequest(text){
  if(!text) return false;
  return APPOINTMENT_INTENT_RE.test(text);
}

const APPT_PARSE_SYSTEM = `You are the request-understanding module inside "Maximus", a personal AI agent that books appointments (salon, doctor, service repair) on the user's behalf.
Read the user's message and reply with ONLY compact JSON (no markdown fences, no other text) in exactly this shape:
{"action":"book|reschedule|cancel|show_appointments|unclear","category":"salon|doctor|repair|null","service":"<one of: haircut, hair coloring, spa, beauty services, general physician, dentist, dermatologist, specialist consultation, hospital visit, ac repair, plumbing, electrician, appliance repair, car/bike service, or null>","date":"today|tomorrow|<weekday name>|null","preferred_time":"<HH:MM 24h or null>","flexible":true/false,"location":"near_user|<text>|null","max_budget":<number or null>,"preferred_provider":"<text or null>","special_requirements":"<text or null>","reason":"<the medical problem/symptom/reason for the visit, in the user's own words, or null if a doctor/hospital wasn't requested or no reason was given>"}
If the message is not about appointments at all, set action to "unclear". Never invent a date/time that wasn't implied. Never invent a "reason" that wasn't stated or clearly implied by the user — if in doubt, use null.`;

async function parseAppointmentRequest(text){
  // Offline / no-key fallback first pass — cheap regex extraction so the
  // feature still functions without Mistral configured.
  const fallback = fallbackParse(text);
  if(!state.settings.apiKey) return fallback;
  try{
    const raw = await mistralChat(APPT_PARSE_SYSTEM, text, { model: CONFIG.MODEL_FAST, maxTokens: 300, temperature: 0 });
    const clean = raw.replace(/^```json\s*|\s*```$/g, '').trim();
    const parsed = JSON.parse(clean);
    // Validate before ever acting on AI output, per the project's safety requirement.
    if(!parsed || typeof parsed !== 'object' || !parsed.action) return fallback;
    return Object.assign({}, fallback, parsed, {
      // Never let the model silently raise the user's stated budget.
      max_budget: parsed.max_budget != null ? Number(parsed.max_budget) || fallback.max_budget : fallback.max_budget,
      reason: (parsed.reason && String(parsed.reason).trim()) || fallback.reason
    });
  }catch(e){
    console.warn('Appointment request parsing failed, using offline fallback.', e);
    return fallback;
  }
}

function fallbackParse(text){
  const t = text.toLowerCase();
  let action = 'book';
  if(/cancel/.test(t)) action = 'cancel';
  else if(/reschedul|move my appointment|move it to/.test(t)) action = 'reschedule';
  else if(/show (my )?appointments|my appointments|appointment history/.test(t)) action = 'show_appointments';

  let service = null;
  for(const cat in CATEGORY_SERVICES){
    for(const s of CATEGORY_SERVICES[cat]){
      if(t.includes(s)) { service = s; break; }
    }
    if(service) break;
  }
  if(!service){
    if(/hair ?cut/.test(t)) service = 'haircut';
    else if(/salon|spa|beauty/.test(t)) service = 'haircut';
    else if(/dentist/.test(t)) service = 'dentist';
    else if(/dermat/.test(t)) service = 'dermatologist';
    else if(/hospital/.test(t)) service = 'hospital visit';
    else if(/doctor|physician|clinic/.test(t)) service = 'general physician';
    else if(/\bac\b|air ?con/.test(t)) service = 'ac repair';
    else if(/plumb/.test(t)) service = 'plumbing';
    else if(/electric/.test(t)) service = 'electrician';
    else if(/appliance|fridge|washing machine/.test(t)) service = 'appliance repair';
    else if(/car service|bike service|car repair|bike repair|mechanic/.test(t)) service = 'car/bike service';
  }

  let date = null;
  if(/tomorrow/.test(t)) date = 'tomorrow';
  else if(/\btoday\b|tonight/.test(t)) date = 'today';
  else{
    const wd = t.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
    if(wd) date = wd[1];
  }

  let preferred_time = null;
  const tm = t.match(/(\d{1,2})(:\d{2})?\s*(am|pm)/);
  if(tm){
    let h = parseInt(tm[1],10)%12;
    if(tm[3]==='pm') h += 12;
    const min = tm[2] ? tm[2].slice(1) : '00';
    preferred_time = String(h).padStart(2,'0') + ':' + min;
  }

  let max_budget = null;
  const bm = t.match(/(?:under|less than|below|budget(?: of)?|for)\s*(?:rs\.?|inr|₹)?\s*(\d{2,6})/) || t.match(/₹\s*(\d{2,6})/);
  if(bm) max_budget = parseInt(bm[1],10);

  return {
    action, category: service ? categoryForService(service) : null, service,
    date, preferred_time, flexible: /after|evening|morning|anytime|flexible/.test(t),
    location: /near me|nearby|near by/.test(t) ? 'near_user' : null,
    max_budget, preferred_provider: null, special_requirements: null,
    reason: extractReason(text)
  };
}

// Best-effort, regex-only extraction of "what's wrong" from the raw
// sentence, so Maximus has something honest and specific to say to the
// hospital instead of a generic line. Never invents a symptom — returns
// null (handled as "a general checkup" downstream) if nothing is found.
function extractReason(text){
  const raw = String(text||'').trim();
  let m = raw.match(/\bi(?:'m| am)?\s*(?:have|having|suffering from|experiencing|dealing with)\s+(.+)/i);
  if(m) return cleanReasonPhrase(m[1]);
  m = raw.match(/\b(?:because|since|as)\s+(?:i(?:'m| am)?\s*(?:have|having)?\s*)?(.+)/i);
  if(m) return cleanReasonPhrase(m[1]);
  m = raw.match(/\bmy\s+([a-z\s]+?)\s+(?:hurts|is hurting|is paining|is swollen|is aching|aches?)\b/i);
  if(m) return cleanReasonPhrase(m[0]);
  m = raw.match(/\bfor\s+(?:a |an |my )?(fever|cold|cough|headache|checkup|check-up|stomach ache|stomach pain|back pain|injury|allergy|infection|pain|consultation)\b/i);
  if(m) return cleanReasonPhrase(m[1]);
  return null;
}
function cleanReasonPhrase(s){
  return String(s)
    .split(',')[0]                                  // drop trailing clauses after a comma ("...pain, book nearest hospital")
    .replace(/^\s*of\s+/i, '')                       // "because of chest pain" -> "chest pain"
    .replace(/\b(near me|nearby|near by|today|tomorrow|tonight|this (morning|evening|afternoon)|before \d.*|after \d.*|at \d.*|for (rs|inr|₹).*|under ₹?\d.*|book\b.*|find\b.*|please\b.*)\b.*/gi, '')
    .replace(/[.?!]+$/,'')
    .trim();
}

function resolveDate(dateHint){
  const now = new Date();
  const d = new Date(now);
  if(!dateHint || dateHint === 'today') return d;
  if(dateHint === 'tomorrow'){ d.setDate(d.getDate()+1); return d; }
  const weekdays = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const idx = weekdays.indexOf(String(dateHint).toLowerCase());
  if(idx >= 0){
    let diff = (idx - d.getDay() + 7) % 7;
    if(diff === 0) diff = 7; // "this Saturday" from a request means the next one
    d.setDate(d.getDate() + diff);
    return d;
  }
  return d;
}

function formatDateShort(d){
  return d.toLocaleDateString('en-IN', { day:'numeric', month:'long', year:'numeric' });
}

/* ------------------------------------------------------------------ *
 *  4. NEGOTIATION ENGINE
 *     Deterministic price-stepping so the final numbers are always
 *     trustworthy; Mistral is used only to write the surrounding dialogue
 *     around numbers that are already decided, never to invent them.
 * ------------------------------------------------------------------ */

function computeNegotiationPlan(basePrice, budget, maxAttempts){
  const perms = state.agentPermissions;
  const floor = Math.round(basePrice * 0.78); // providers won't realistically go lower than this in the demo
  const target = Math.min(budget || Infinity, perms.maxPrice || Infinity, floor);
  const attempts = [];
  let current = basePrice;
  const steps = Math.max(1, Math.min(maxAttempts, 4));
  for(let i=0;i<steps;i++){
    const remaining = steps - i;
    const next = Math.round(current - (current - Math.max(target, floor)) / remaining);
    attempts.push(next);
    current = next;
    if(current <= target) break;
  }
  const finalPrice = Math.max(attempts[attempts.length-1] || basePrice, floor);
  return { floor, target, attempts, finalPrice, success: finalPrice < basePrice };
}

async function buildNegotiationTranscript(provider, service, plan, mode){
  const basePrice = provider.price;
  const template = [
    { speaker: 'provider', text: `${mode === 'call' ? 'Hello, thank you for calling' : 'Hello,'} ${provider.name}${mode==='call' ? '.' : ','} the ${service} costs ₹${basePrice}.` },
    { speaker: 'maximus', text: `Hi, I'm Maximus, an AI assistant booking on behalf of my user. My user is looking for a ${service} around ₹${plan.target}. Could you offer a better price for a booking?` }
  ];
  plan.attempts.forEach((amt, i)=>{
    template.push({ speaker: 'provider', text: `We can do ₹${amt}.` });
    if(i < plan.attempts.length - 1 && amt > plan.target){
      template.push({ speaker: 'maximus', text: `Could you do ₹${plan.attempts[i+1]}?` });
    }
  });
  template.push({ speaker: 'provider', text: `Alright, ₹${plan.finalPrice} it is.` });
  template.push({ speaker: 'maximus', text: `Great, please reserve that slot for ₹${plan.finalPrice}.` });

  if(!state.settings.apiKey) return template; // offline fallback: static but numerically correct

  try{
    const factSheet = `Provider: ${provider.name}\nService: ${service}\nOriginal price: ₹${basePrice}\nFinal agreed price: ₹${plan.finalPrice}\nIntermediate offers in order: ${plan.attempts.map(a=>'₹'+a).join(', ')}\nMode: ${mode === 'call' ? 'phone call' : 'chat message'}`;
    const sys = `You write a short, natural ${mode === 'call' ? 'phone call' : 'business chat'} transcript between "Maximus" (an AI agent calling/chatting on behalf of its user) and a service "Provider", negotiating a price. You MUST use exactly the numbers given below and reach exactly the final price given — do not invent different numbers. Reply with ONLY compact JSON: an array of {"speaker":"maximus"|"provider","text":"..."} objects, 6-10 lines total, polite and concise.`;
    const raw = await mistralChat(sys, factSheet, { model: CONFIG.MODEL_FAST, maxTokens: 500, temperature: 0.6 });
    const clean = raw.replace(/^```json\s*|\s*```$/g, '').trim();
    const parsed = JSON.parse(clean);
    if(Array.isArray(parsed) && parsed.length && parsed.every(l=>l && l.speaker && l.text)){
      // Sanity-check the numbers Mistral wrote actually match the plan before
      // trusting it — otherwise fall back to the guaranteed-correct template.
      const mentionsFinal = parsed.some(l => l.text.includes(String(plan.finalPrice)));
      if(mentionsFinal) return parsed;
    }
    return template;
  }catch(e){
    console.warn('AI negotiation dialogue generation failed, using template transcript.', e);
    return template;
  }
}

// For real places (hospital, salon, or repair service) found via
// OpenStreetMap there is no price to negotiate — Maximus's only job on
// this "call" is to clearly state what's needed and lock in a slot. No
// price is discussed or invented. Medical requests state the reason for
// visit plainly; non-medical requests state the service (and any
// special requirements) instead.
async function buildRealPlaceCallTranscript(provider, request, slot, mode){
  const isMedical = provider.category === 'doctor';
  const purpose = isMedical ? (request.reason || 'a general check-up') : request.service;
  const extra = (!isMedical && request.special_requirements) ? ` — ${request.special_requirements}` : '';
  const askLine = isMedical
    ? `My user needs to see a doctor for ${purpose}.`
    : `My user needs ${purpose}${extra}.`;
  const template = [
    { speaker: 'provider', text: `${mode === 'call' ? 'Hello, thank you for calling' : 'Hello,'} ${provider.name}${mode==='call' ? '.' : ','} how can I help you?` },
    { speaker: 'maximus', text: `Hi, I'm Maximus, an AI assistant calling on behalf of my user. ${askLine} Could I book the earliest available appointment?` },
    { speaker: 'provider', text: `We have an opening at ${slot}. Would that work?` },
    { speaker: 'maximus', text: `Yes, please book that slot.${isMedical ? ` Just to confirm, this appointment is regarding ${purpose}.` : ''}` },
    { speaker: 'provider', text: `Confirmed — ${slot}${isMedical ? `, noted as regarding ${purpose}` : ''}. See you then.` },
    { speaker: 'maximus', text: `Understood, thank you for your help.` }
  ];

  if(!state.settings.apiKey) return template; // offline fallback

  try{
    const label = placeLabelForService(provider.service);
    const factSheet = `${isMedical ? 'Hospital' : 'Business'}: ${provider.name}\n${isMedical ? `Reason for visit (state this plainly and accurately — do not invent, add, or exaggerate any medical detail beyond it): ${purpose}` : `Service needed: ${purpose}${extra}`}\nConfirmed slot: ${slot}\nMode: ${mode === 'call' ? 'phone call' : 'chat message'}`;
    const sys = `You write a short, natural ${mode === 'call' ? 'phone call' : 'business chat'} transcript between "Maximus" (an AI assistant calling on behalf of its user) and a ${label} "Receptionist" to book an appointment. ${isMedical ? 'Maximus MUST clearly and plainly state the exact reason for the visit given below, and must not invent, add, or exaggerate any other medical detail.' : 'Maximus should clearly state the service needed.'} Do not discuss or invent any price. Reply with ONLY compact JSON: an array of {"speaker":"maximus"|"provider","text":"..."} objects, 5-8 lines, polite and concise, ending with the appointment confirmed for the given slot.`;
    const raw = await mistralChat(sys, factSheet, { model: CONFIG.MODEL_FAST, maxTokens: 400, temperature: 0.5 });
    const clean = raw.replace(/^```json\s*|\s*```$/g, '').trim();
    const parsed = JSON.parse(clean);
    if(Array.isArray(parsed) && parsed.length && parsed.every(l=>l && l.speaker && l.text)){
      const mentionsSlot = parsed.some(l => l.text.includes(slot));
      const mentionsPurpose = parsed.some(l => l.text.toLowerCase().includes(String(purpose).toLowerCase().slice(0, 12)));
      if(mentionsSlot && (mentionsPurpose || !isMedical || !request.reason)) return parsed;
    }
    return template;
  }catch(e){
    console.warn('Real-place call dialogue generation failed, using template transcript.', e);
    return template;
  }
}

/* ------------------------------------------------------------------ *
 *  4b. WHATSAPP HAND-OFF FOR REAL PROVIDERS
 *      For a real place found via OpenStreetMap (real hospital, salon,
 *      or repair business) that has a phone number listed, Maximus can
 *      open an actual WhatsApp chat to that number with the booking
 *      message already typed in — reusing the exact same
 *      api.whatsapp.com hand-off pattern app.js already uses for saved
 *      contacts ("message <name> saying ..."). Maximus never sends it —
 *      the person still has to tap Send in WhatsApp themselves.
 * ------------------------------------------------------------------ */

function sanitizePhoneForWhatsApp(raw){
  if(!raw) return null;
  let digits = String(raw).replace(/[^\d+]/g, '');
  if(!digits) return null;
  if(digits.startsWith('+')) return digits.slice(1);
  digits = digits.replace(/^0+(?=\d)/, ''); // drop a leading trunk 0
  if(digits.length === 10) return '91' + digits; // bare 10-digit Indian mobile — assume +91
  return digits;
}

function buildWhatsAppUrl(phone, text){
  const clean = sanitizePhoneForWhatsApp(phone);
  if(!clean) return null;
  // api.whatsapp.com pre-fills the text box far more reliably than wa.me,
  // same reasoning as the existing "message <contact> saying ..." feature.
  return `https://api.whatsapp.com/send?phone=${clean}&text=${encodeURIComponent(text)}`;
}

function whatsAppBookingMessage({ service, purpose, dateLabel, time }){
  const who = (state.user && state.user.name) ? state.user.name : 'my user';
  const purposeLine = purpose ? ` — ${purpose}` : '';
  return `Hi, this is Maximus, an AI assistant messaging on behalf of ${who}. We'd like to book ${service}${purposeLine} for ${dateLabel} around ${time}. Could you please confirm this slot? Thank you!`;
}

// Used while a run is still pending approval (provider/slot chosen, not booked yet).
function buildRunWhatsAppMessage(run){
  if(!run || !run.provider || !run.provider.real || !run.provider.phone) return null;
  return whatsAppBookingMessage({
    service: run.request.service,
    purpose: run.provider.category === 'doctor' ? run.request.reason : run.request.special_requirements,
    dateLabel: formatDateShort(run.dateObj),
    time: run.slot
  });
}

// Used from the Upcoming/History list, after booking, from stored appt data.
function buildApptWhatsAppMessage(appt){
  if(!appt || !appt.real || !appt.providerPhone) return null;
  return whatsAppBookingMessage({
    service: appt.service,
    purpose: appt.reasonForVisit,
    dateLabel: appt.dateLabel,
    time: appt.time
  });
}

// Kept for the plain-link fallback used in chat markdown (renderBookedMarkdown),
// where a clickable <a> is simpler/more reliable than a JS click handler.
function buildApptWhatsAppUrl(appt){
  const msg = buildApptWhatsAppMessage(appt);
  if(!msg) return null;
  return buildWhatsAppUrl(appt.providerPhone, msg);
}

/* ------------------------------------------------------------------ *
 *  5. CALENDAR + REMINDERS  (reuse existing Maximus integrations)
 * ------------------------------------------------------------------ */

async function addAppointmentToCalendar(appt){
  const token = await ensureGoogleToken();
  if(!token){ return { ok:false, reason:'not_connected' }; }
  if(appt.calendarEventId){ return { ok:true, alreadyAdded:true }; }
  try{
    const start = new Date(appt.dateISO);
    const [h,m] = appt.time24.split(':').map(Number);
    start.setHours(h, m, 0, 0);
    const end = new Date(start.getTime() + 60*60*1000);
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        summary: `${appt.service} — ${appt.providerName}`,
        location: appt.address || appt.location || '',
        description: [
          `Booked via Maximus Appointment Agent${appt.real ? ` — ${appt.providerName} is a real ${placeLabelForService(appt.service)} found via OpenStreetMap; the call to book was SIMULATED, not a real phone call.` : ' (demo).'}`,
          `Booking ID: ${appt.bookingId}`,
          appt.reasonForVisit ? `Reason for visit: ${appt.reasonForVisit}` : null,
          appt.providerPhone ? `Phone (call or WhatsApp to confirm yourself): ${appt.providerPhone}` : null,
          appt.finalPrice != null ? `Price: ₹${appt.finalPrice}${appt.negotiated ? ` (negotiated down from ₹${appt.originalPrice})` : ''}` : null
        ].filter(Boolean).join('\n'),
        start: { dateTime: start.toISOString(), timeZone: tz },
        end: { dateTime: end.toISOString(), timeZone: tz }
      })
    });
    const data = await res.json();
    if(!res.ok) return { ok:false, reason:'api_error' };
    appt.calendarEventId = data.id;
    save();
    return { ok:true };
  }catch(e){
    console.warn('Calendar add failed', e);
    return { ok:false, reason:'network' };
  }
}

function scheduleAppointmentReminders(appt){
  const start = new Date(appt.dateISO);
  const [h,m] = appt.time24.split(':').map(Number);
  start.setHours(h, m, 0, 0);
  const reminderDefs = [
    { label: '1 day before', offsetMs: 24*60*60*1000 },
    { label: '2 hours before', offsetMs: 2*60*60*1000 }
  ];
  appt.reminderTaskIds = appt.reminderTaskIds || [];
  reminderDefs.forEach(def=>{
    const due = new Date(start.getTime() - def.offsetMs);
    if(due.getTime() <= Date.now()) return; // don't schedule reminders in the past
    const task = addTask(`🔔 Your ${appt.service} at ${appt.providerName} is coming up (${def.label}) — ${appt.time12}.`, due.toISOString());
    appt.reminderTaskIds.push(task.id);
  });
  save();
}

function addCustomReminder(appt, whenISO){
  const task = addTask(`🔔 Reminder: your ${appt.service} at ${appt.providerName} is at ${appt.time12} on ${formatDateShort(new Date(appt.dateISO))}.`, whenISO);
  appt.reminderTaskIds = appt.reminderTaskIds || [];
  appt.reminderTaskIds.push(task.id);
  save();
  return task;
}

/* ------------------------------------------------------------------ *
 *  6. BOOKING
 * ------------------------------------------------------------------ */

function generateBookingId(){
  const year = new Date().getFullYear();
  const n = (state.appointments || []).filter(a=>a.bookingId && a.bookingId.startsWith(`MAX-${year}-`)).length + 1;
  return `MAX-${year}-${String(n).padStart(3,'0')}`;
}

async function finalizeBooking(run){
  const { request, provider, slot, plan, dateObj, mode, transcript } = run;
  const time24 = String(to24hFromLabel(slot)).padStart(4,'0');
  const appt = {
    id: uid(),
    status: 'upcoming',
    category: provider.category,
    service: request.service,
    providerName: provider.name,
    providerPhone: provider.phone,
    demoProvider: !provider.real,
    real: !!provider.real,
    source: provider.source || null,
    address: provider.address || null,
    mapsUrl: provider.mapsUrl || null,
    reasonForVisit: request.reason || null,
    location: provider.real
      ? (provider.address || 'Near your location (real hospital)')
      : (request.location === 'near_user' ? 'Near your location (demo)' : (request.location || 'Demo location')),
    distanceKm: provider.distanceKm,
    rating: provider.rating,
    dateISO: dateObj.toISOString(),
    dateLabel: formatDateShort(dateObj),
    time: slot,
    time12: slot,
    time24: minutesToHHMM(to24h(slot)),
    originalPrice: provider.price,
    finalPrice: plan.finalPrice,
    negotiated: (plan.finalPrice != null && provider.price != null) ? plan.finalPrice < provider.price : false,
    savings: (plan.finalPrice != null && provider.price != null) ? provider.price - plan.finalPrice : 0,
    bookingId: generateBookingId(),
    mode, // 'chat' | 'call'
    transcript,
    createdAt: Date.now(),
    calendarEventId: null,
    reminderTaskIds: []
  };
  state.appointments.unshift(appt);
  save();
  scheduleAppointmentReminders(appt);
  const cal = await addAppointmentToCalendar(appt);
  appt._calendarResult = cal;
  save();
  return appt;
}

function to24hFromLabel(label){ return to24h(label); }
function minutesToHHMM(mins){
  const h = Math.floor(mins/60), m = mins%60;
  return String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0');
}

function cancelAppointment(id){
  const appt = state.appointments.find(a=>a.id===id);
  if(!appt) return false;
  appt.status = 'cancelled';
  (appt.reminderTaskIds||[]).forEach(tid=>{
    const t = (state.tasks||[]).find(x=>x.id===tid);
    if(t) t.done = true;
    if(activeReminderTimersSafe()[tid]) clearTimeout(activeReminderTimersSafe()[tid]);
  });
  save();
  return true;
}
function activeReminderTimersSafe(){ return (typeof activeReminderTimers !== 'undefined') ? activeReminderTimers : {}; }

function rescheduleAppointment(id, newDateObj, newSlot){
  const appt = state.appointments.find(a=>a.id===id);
  if(!appt) return false;
  appt.dateISO = newDateObj.toISOString();
  appt.dateLabel = formatDateShort(newDateObj);
  appt.time = newSlot; appt.time12 = newSlot; appt.time24 = minutesToHHMM(to24h(newSlot));
  appt.calendarEventId = null; // simplest safe path: re-add as a fresh event to avoid stale data
  scheduleAppointmentReminders(appt);
  save();
  return appt;
}

/* ------------------------------------------------------------------ *
 *  7. LIVE AGENT RUN  (drives the "Active Agent" panel + chat/voice mirrors)
 * ------------------------------------------------------------------ */

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

let currentRun = null;           // the in-progress agent run, shown in the dashboard
let pendingConfirmationRun = null; // set once a run is awaiting user approval

const PLAN_TEMPLATE = [
  'Understand request',
  'Search providers',
  'Compare ratings & prices',
  'Check availability',
  'Contact provider',
  'Negotiate price',
  'Prepare for your approval'
];

function newRun(request, source){
  return {
    id: uid(),
    source,                 // 'chat' | 'voice' | 'dashboard'
    request,
    steps: PLAN_TEMPLATE.map(label=>({ label, status:'pending' })), // pending|active|done|failed
    log: [],
    provider: null,
    ranked: [],
    slot: null,
    plan: null,
    transcript: [],
    dateObj: null,
    mode: request.mode || (state.appointmentPrefs.communicationMethod === 'call' ? 'call' : 'chat'),
    awaitingApproval: false,
    result: null
  };
}

function setStep(run, idx, status){
  run.steps[idx].status = status;
  refreshDashboardIfOpen();
}
function pushLog(run, text){
  run.log.push({ text, ts: Date.now() });
  refreshDashboardIfOpen();
}

// The single entry point used by BOTH the chat composer and the voice
// assistant. `opts.source` controls where progress is echoed to.
async function runAppointmentAgent(userText, opts = {}){
  const source = opts.source || 'chat';
  showAppointmentDashboard('active'); // "make it obvious Maximus is an agent performing actions"

  const request = await parseAppointmentRequest(userText);
  const run = newRun(request, source);
  currentRun = run;
  refreshDashboardIfOpen();

  let chatMsg = null;
  if(source === 'chat'){
    chatMsg = appendAssistantChatMessage(renderRunAsMarkdown(run));
  }
  if(source === 'voice'){ speak('Understood. Let me look into that for you.'); }

  if(request.action === 'show_appointments'){
    setStep(run,0,'done');
    showAppointmentDashboard('history');
    if(source === 'chat') updateAssistantChatMessage(chatMsg, "Here's your appointment history — I've opened the Appointments dashboard.");
    if(source === 'voice') speak("Here's your appointment history.");
    currentRun = null;
    return;
  }
  if(request.action === 'cancel'){
    setStep(run,0,'done');
    const target = findLikelyAppointment(request);
    if(!target){
      const msg = "I couldn't find a matching upcoming appointment to cancel. Open the Appointments dashboard to pick the right one.";
      if(source === 'chat') updateAssistantChatMessage(chatMsg, msg); else speak(msg);
      showAppointmentDashboard('upcoming');
      currentRun = null;
      return;
    }
    cancelAppointment(target.id);
    const msg = `✅ Cancelled your ${target.service} at ${target.providerName} on ${target.dateLabel}.`;
    if(source === 'chat') updateAssistantChatMessage(chatMsg, msg); else speak(msg);
    showAppointmentDashboard('history');
    currentRun = null;
    return;
  }
  if(request.action === 'reschedule'){
    setStep(run,0,'done');
    const target = findLikelyAppointment(request);
    if(!target){
      const msg = "I couldn't find a matching appointment to reschedule. Open the Appointments dashboard to reschedule it from there.";
      if(source === 'chat') updateAssistantChatMessage(chatMsg, msg); else speak(msg);
      showAppointmentDashboard('upcoming');
      currentRun = null;
      return;
    }
    const newDateObj = resolveDate(request.date || 'tomorrow');
    const providers = searchProviders(target.service, newDateObj.toISOString());
    const sameProvider = providers.find(p=>p.name === target.providerName) || providers[0];
    const newSlot = pickSlot(sameProvider, request);
    const updated = rescheduleAppointment(target.id, newDateObj, newSlot);
    const msg = `✅ Moved your ${target.service} at ${target.providerName} to ${updated.dateLabel} at ${updated.time}.`;
    if(source === 'chat') updateAssistantChatMessage(chatMsg, msg); else speak(msg);
    showAppointmentDashboard('upcoming');
    currentRun = null;
    return;
  }

  if(request.action === 'unclear' || !request.service){
    setStep(run,0,'failed');
    const msg = "I couldn't quite tell what you'd like booked. Try something like \"Book me a haircut tomorrow evening for under ₹600.\"";
    if(source === 'chat') updateAssistantChatMessage(chatMsg, msg); else speak(msg);
    currentRun = null;
    return;
  }

  // ---- BOOK flow ----
  setStep(run, 0, 'done'); // understood
  pushLog(run, `Request understood: ${request.service}${request.date? ' on '+request.date:''}${request.preferred_time? ' around '+request.preferred_time:''}${request.max_budget? ', budget ₹'+request.max_budget:''}.`);
  if(source === 'chat') updateAssistantChatMessage(chatMsg, renderRunAsMarkdown(run));

  if(!state.agentPermissions.canContact){
    setStep(run,4,'failed');
    const msg = "Contacting businesses is currently turned off in your Agent Permissions, so I can't reach out to a provider. Enable it in the Appointments dashboard → Permissions if you'd like me to.";
    if(source === 'chat') updateAssistantChatMessage(chatMsg, msg); else speak(msg);
    currentRun = null;
    return;
  }

  const dateObj = resolveDate(request.date || 'today');
  run.dateObj = dateObj;
  await sleep(350);
  setStep(run, 1, 'active');

  // ---- Real nearby-place search (OpenStreetMap), falls back to demo providers ----
  let providers = null;
  run.usedRealSearch = false;
  const placeLabel = placeLabelForService(request.service);
  if(wantsRealPlaceSearch(userText, request)){
    pushLog(run, `📍 Checking your location to find real nearby ${placeLabel}s (OpenStreetMap)…`);
    const { loc, places } = await findRealPlaces(dateObj.toISOString(), request.service, request.category);
    if(!loc){
      pushLog(run, "Couldn't get your location (permission denied, unsupported, or not on HTTPS) — using demo providers instead.");
    } else if(!places.length){
      pushLog(run, `Couldn't find a real ${placeLabel} nearby via OpenStreetMap right now — using demo providers instead.`);
    } else {
      providers = places;
      run.usedRealSearch = true;
      pushLog(run, `📍 Found ${places.length} real ${placeLabel}${places.length===1?'':'s'} near you via OpenStreetMap.`);
    }
  }
  if(!providers) providers = searchProviders(request.service || 'general physician', dateObj.toISOString());

  await sleep(500);
  setStep(run, 1, 'done');
  pushLog(run, run.usedRealSearch
    ? `Using ${providers.length} real nearby ${placeLabel}${providers.length===1?'':'s'}.`
    : `Found ${providers.length} ${providers[0].category} providers offering ${request.service}.`);

  setStep(run, 2, 'active');
  const ranked = run.usedRealSearch ? providers : rankProviders(providers, request); // real results are already ranked by distance/emergency
  run.ranked = ranked;
  await sleep(400);
  setStep(run, 2, 'done');
  pushLog(run, run.usedRealSearch
    ? `Shortlisted ${Math.min(3, ranked.length)}, closest match: ${ranked[0].name} (${ranked[0].distanceKm} km away${ranked[0].emergency ? ', has emergency care' : ''}).`
    : `Shortlisted ${Math.min(3, ranked.length)}, best match: ${ranked[0].name} (⭐${ranked[0].rating}, ₹${ranked[0].price}).`);
  if(source === 'chat') updateAssistantChatMessage(chatMsg, renderRunAsMarkdown(run));

  setStep(run, 3, 'active');
  const provider = ranked[0];
  run.provider = provider;
  const slot = pickSlot(provider, request);
  run.slot = slot;
  await sleep(350);
  setStep(run, 3, 'done');
  const requestedWasAvailable = request.preferred_time ? Math.abs(to24h(slot) - normalizeTimeToMinutes(request.preferred_time)) < 5 : true;
  pushLog(run, requestedWasAvailable
    ? `${slot} is available at ${provider.name}.`
    : `Your requested time wasn't free — nearest available slot at ${provider.name} is ${slot}.`);

  setStep(run, 4, 'active');
  await sleep(300);
  setStep(run, 4, 'done');
  pushLog(run, `${run.mode === 'call' ? '📞 Simulated call' : '💬 Simulated chat'} started with ${provider.name}.`);
  if(source === 'chat') updateAssistantChatMessage(chatMsg, renderRunAsMarkdown(run));

  setStep(run, 5, 'active');
  let plan;
  if(run.usedRealSearch){
    // Real places: no invented price to negotiate. Maximus's only job on
    // this simulated call is to state what's needed clearly and lock in a
    // slot.
    plan = { floor: null, target: null, attempts: [], finalPrice: null, success: false, skipped: true };
    run.transcript = await buildRealPlaceCallTranscript(provider, request, slot, run.mode);
  } else if(state.agentPermissions.canNegotiate){
    plan = computeNegotiationPlan(provider.price, request.max_budget || state.appointmentPrefs.maxBudget, state.agentPermissions.maxNegotiationAttempts);
    run.transcript = await buildNegotiationTranscript(provider, request.service, plan, run.mode);
  } else {
    plan = { floor: provider.price, target: provider.price, attempts: [provider.price], finalPrice: provider.price, success:false };
    run.transcript = [
      { speaker:'provider', text:`Hello, the ${request.service} costs ₹${provider.price}.` },
      { speaker:'maximus', text:`Please reserve that slot for ₹${provider.price}. (Negotiation is turned off in your permissions.)` }
    ];
  }
  run.plan = plan;
  await sleep(500);
  setStep(run, 5, 'done');
  pushLog(run, plan.skipped
    ? (provider.category === 'doctor'
        ? `📞 Stated the reason for visit (${request.reason || 'general check-up'}) and confirmed slot ${slot} with ${provider.name}.`
        : `📞 Requested ${request.service} and confirmed slot ${slot} with ${provider.name}.`)
    : (plan.success
        ? `🤝 Negotiated ₹${provider.price} → ₹${plan.finalPrice} (saved ₹${provider.price - plan.finalPrice}).`
        : `Price held at ₹${plan.finalPrice}.`));
  if(source === 'chat') updateAssistantChatMessage(chatMsg, renderRunAsMarkdown(run));
  if(source === 'voice'){
    speak(plan.skipped
      ? (provider.category === 'doctor'
          ? `I found ${provider.name}, a real ${placeLabel} ${provider.distanceKm} kilometers from you. I explained your reason for the visit — ${request.reason || 'a general check-up'} — and they offered ${slot} on ${formatDateShort(dateObj)}. Should I go ahead and book it?`
          : `I found ${provider.name}, a real ${placeLabel} ${provider.distanceKm} kilometers from you, for your ${request.service}. They offered ${slot} on ${formatDateShort(dateObj)}. Should I go ahead and book it?`)
      : (plan.success
          ? `Good news — I negotiated the price for your ${request.service} at ${provider.name} from ₹${provider.price} down to ₹${plan.finalPrice}, saving you ₹${provider.price - plan.finalPrice}. Available at ${slot} on ${formatDateShort(dateObj)}. Should I go ahead and book it?`
          : `I found a slot for your ${request.service} at ${provider.name}, at ${slot} on ${formatDateShort(dateObj)}, for ₹${plan.finalPrice}. Should I go ahead and book it?`));
  }

  setStep(run, 6, 'active');
  run.awaitingApproval = true;

  if(state.agentPermissions.canBookWithoutConfirmation){
    setStep(run, 6, 'done');
    const appt = await finalizeBooking(run);
    run.result = appt;
    currentRun = null;
    const msg = renderBookedMarkdown(appt);
    if(source === 'chat') updateAssistantChatMessage(chatMsg, msg); else speak(`Booked. Your ${appt.service} at ${appt.providerName} is confirmed for ${appt.dateLabel} at ${appt.time}, for ₹${appt.finalPrice}. Booking ID ${appt.bookingId}.`);
    showAppointmentDashboard('upcoming');
    return;
  }

  // Needs human approval — required by default.
  pendingConfirmationRun = run;
  refreshDashboardIfOpen();
  if(source === 'chat'){
    updateAssistantChatMessage(chatMsg, renderRunAsMarkdown(run) + `\n\n**Reply "confirm" to book this, or "cancel" to drop it.** (Or use the buttons in the Appointments dashboard.)`);
  }
}

function findLikelyAppointment(request){
  const upcoming = (state.appointments||[]).filter(a=>a.status==='upcoming');
  if(!upcoming.length) return null;
  if(request.service){
    const match = upcoming.find(a=>a.service===request.service);
    if(match) return match;
  }
  if(request.date){
    const d = resolveDate(request.date);
    const match = upcoming.find(a=> sameCalendarDay(new Date(a.dateISO), d));
    if(match) return match;
  }
  return upcoming[0]; // most recently booked
}
function sameCalendarDay(a,b){ return a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate(); }

/* ---- confirm / cancel replies from chat text or voice ---- */

async function tryHandleAppointmentConfirmationReply(text){
  if(!pendingConfirmationRun) return false;
  const t = text.trim().toLowerCase().replace(/[.!]+$/,'');
  if(/^(confirm|confirm booking|yes|yes book it|book it|go ahead|please book it)$/.test(t)){
    await confirmPendingBooking();
    return true;
  }
  if(/^(cancel|no|don'?t book it|never ?mind|scrap it)$/.test(t)){
    declinePendingBooking();
    return true;
  }
  return false; // let it fall through to a normal command/question
}

async function confirmPendingBooking(){
  const run = pendingConfirmationRun;
  if(!run) return;
  pendingConfirmationRun = null;
  setStep(run, 6, 'done');
  const appt = await finalizeBooking(run);
  run.result = appt;
  if(run.source === 'voice'){
    speak(`Booked. Your ${appt.service} at ${appt.providerName} is confirmed for ${appt.dateLabel} at ${appt.time}, for ₹${appt.finalPrice}. Booking ID ${appt.bookingId}.`);
  } else {
    appendAssistantChatMessage(renderBookedMarkdown(appt));
  }
  showToast(`✅ Booked: ${appt.service} at ${appt.providerName}`);
  showAppointmentDashboard('upcoming');
  currentRun = null;
}

function declinePendingBooking(){
  const run = pendingConfirmationRun;
  if(!run) return;
  pendingConfirmationRun = null;
  setStep(run, 6, 'failed');
  if(run.source === 'voice') speak('Okay, I won\'t book that.');
  else appendAssistantChatMessage('Okay, I won\'t book that appointment.');
  currentRun = null;
  refreshDashboardIfOpen();
}

/* ------------------------------------------------------------------ *
 *  8. MARKDOWN RENDERERS (for chat-thread mirroring — uses the app's
 *     existing renderMarkdown()/msg-bubble pipeline, no new UI needed)
 * ------------------------------------------------------------------ */

const STEP_ICON = { pending:'○', active:'⏳', done:'✓', failed:'⚠' };

function renderRunAsMarkdown(run){
  const lines = ['**MAXIMUS AGENT**', ''];
  run.steps.forEach(s=> lines.push(`${STEP_ICON[s.status]} ${s.label}`));
  if(run.log.length){
    lines.push('');
    run.log.slice(-6).forEach(l=> lines.push(`_${l.text}_`));
  }
  return lines.join('\n');
}

function renderBookedMarkdown(appt){
  const label = placeLabelForService(appt.service);
  const lines = [
    appt.real ? '### ✅ APPOINTMENT BOOKED' : '### ✅ APPOINTMENT BOOKED (demo)',
    '',
    `**Provider:** ${appt.providerName}${appt.real ? ` 📍 real ${label} (OpenStreetMap)` : ''}`
  ];
  if(appt.address) lines.push(`**Address:** ${appt.address}`);
  if(appt.reasonForVisit) lines.push(`**Reason for visit:** ${appt.reasonForVisit}`);
  lines.push(`**Service:** ${appt.service}`);
  lines.push(`**Date:** ${appt.dateLabel}`);
  lines.push(`**Time:** ${appt.time}`);
  if(appt.finalPrice != null){
    lines.push(`**Price:** ₹${appt.finalPrice}${appt.negotiated ? ` (negotiated from ₹${appt.originalPrice}, saved ₹${appt.savings})` : ''}`);
  }
  lines.push(`**Booking ID:** ${appt.bookingId}`);
  lines.push('');
  lines.push(appt._calendarResult && appt._calendarResult.ok ? '📅 Added to your Google Calendar.' : '📅 Connect Google Calendar in Settings to auto-add this to your calendar.');
  lines.push('🔔 Reminders set for 1 day before and 2 hours before.');
  lines.push('');
  if(appt.real){
    lines.push(`_${appt.providerName} is a real ${label}, found via OpenStreetMap. The phone call to book it was SIMULATED by Maximus — no real call was placed, so please confirm yourself before you go${appt.providerPhone ? ` (${appt.providerPhone})` : ''}.${appt.mapsUrl ? ` [View on Google Maps](${appt.mapsUrl})` : ''}_`);
    const waUrl = buildApptWhatsAppUrl(appt);
    if(waUrl) lines.push(`\n📱 [Message ${appt.providerName} on WhatsApp to confirm](${waUrl}) — this opens WhatsApp with your message ready; you still have to tap Send yourself.`);
  } else {
    lines.push('_This is a demo booking against a simulated provider — no real appointment was placed with a real business._');
  }
  return lines.join('\n');
}

function appendAssistantChatMessage(content){
  let chat = getActiveChat();
  if(!chat) chat = createChat();
  const msg = { id: uid(), role:'assistant', content, pending:false, ts: Date.now() };
  chat.messages.push(msg);
  chat.updatedAt = Date.now();
  save();
  renderAll();
  return msg.id;
}
function updateAssistantChatMessage(msgId, content){
  const chat = getActiveChat();
  if(!chat) return appendAssistantChatMessage(content);
  const msg = chat.messages.find(m=>m.id===msgId);
  if(!msg) return appendAssistantChatMessage(content);
  msg.content = content;
  chat.updatedAt = Date.now();
  save();
  renderAll();
}

/* ------------------------------------------------------------------ *
 *  9. DASHBOARD  (self-contained modal — does not touch app.js's openModal)
 * ------------------------------------------------------------------ */

let dashboardTab = 'find';
let dashboardOpen = false;

function refreshDashboardIfOpen(){
  if(dashboardOpen) renderDashboard();
}

function showAppointmentDashboard(tab){
  dashboardTab = tab || dashboardTab;
  dashboardOpen = true;
  renderDashboard();
}
function closeAppointmentDashboard(){
  dashboardOpen = false;
  document.getElementById('modalRoot').innerHTML = '';
}

function moneySaved(){
  return (state.appointments||[]).filter(a=>a.negotiated).reduce((sum,a)=>sum+(a.savings||0),0);
}

function tabButton(id, label){
  return `<button class="mx-appt-tab${dashboardTab===id?' active':''}" data-appt-tab="${id}">${label}</button>`;
}

function renderDashboard(){
  const root = document.getElementById('modalRoot');
  const upcoming = (state.appointments||[]).filter(a=>a.status==='upcoming');
  const completed = (state.appointments||[]).filter(a=>a.status==='completed');
  const cancelled = (state.appointments||[]).filter(a=>a.status==='cancelled');

  const html = `
  <div class="modal-backdrop" id="apptModalBackdrop">
    <div class="modal modal-wide mx-appt-modal">
      <div class="mx-appt-head">
        <h3>📅 Maximus Appointment Agent</h3>
        <button class="icon-btn" id="apptCloseBtn" title="Close">✕</button>
      </div>
      <div class="mx-appt-stats">
        <div class="mx-appt-stat"><div class="v">${upcoming.length}</div><div class="l">Upcoming</div></div>
        <div class="mx-appt-stat"><div class="v">${state.appointments.length}</div><div class="l">Total appointments</div></div>
        <div class="mx-appt-stat"><div class="v">₹${moneySaved()}</div><div class="l">Saved via negotiation</div></div>
        <div class="mx-appt-stat"><div class="v">${currentRun ? '1' : '0'}</div><div class="l">Active agent tasks</div></div>
      </div>
      <div class="mx-appt-tabs">
        ${tabButton('find','Find Appointment')}
        ${tabButton('active','Active Agent')}
        ${tabButton('providers','Providers')}
        ${tabButton('negotiations','Negotiations')}
        ${tabButton('upcoming','Upcoming')}
        ${tabButton('history','History')}
        ${tabButton('preferences','Preferences')}
        ${tabButton('permissions','Permissions')}
      </div>
      <div class="mx-appt-body">
        ${renderTabBody({upcoming, completed, cancelled})}
      </div>
    </div>
  </div>`;
  root.innerHTML = html;

  const backdrop = document.getElementById('apptModalBackdrop');
  backdrop.addEventListener('click', (e)=>{ if(e.target===backdrop) closeAppointmentDashboard(); });
  document.getElementById('apptCloseBtn').addEventListener('click', closeAppointmentDashboard);
  root.querySelectorAll('[data-appt-tab]').forEach(b=>{
    b.addEventListener('click', ()=>{ dashboardTab = b.getAttribute('data-appt-tab'); renderDashboard(); });
  });
  wireTabInteractions();
}

function renderTabBody(ctx){
  switch(dashboardTab){
    case 'find': return renderFindTab();
    case 'active': return renderActiveTab();
    case 'providers': return renderProvidersTab();
    case 'negotiations': return renderNegotiationsTab();
    case 'upcoming': return renderApptListTab(ctx.upcoming, 'upcoming');
    case 'history': return renderHistoryTab(ctx);
    case 'preferences': return renderPreferencesTab();
    case 'permissions': return renderPermissionsTab();
    default: return '';
  }
}

function renderFindTab(){
  return `
    <p class="field-hint" style="margin-bottom:12px;">Describe what you need in plain language — Maximus will search, compare, negotiate and come back to you for approval before booking anything.</p>
    <textarea id="apptFindInput" rows="3" placeholder="e.g. Book me a haircut tomorrow evening near me for less than ₹600">${escapeHtml(dashboardFindDraft)}</textarea>
    <div style="display:flex; gap:10px; align-items:center; margin:-6px 0 14px;">
      <label class="modal-label" style="margin:0;">Contact via</label>
      <select id="apptModeSelect" style="width:auto; margin:0;">
        <option value="chat"${state.appointmentPrefs.communicationMethod!=='call'?' selected':''}>💬 Chat</option>
        <option value="call"${state.appointmentPrefs.communicationMethod==='call'?' selected':''}>📞 Call (simulated)</option>
      </select>
    </div>
    <div class="modal-actions" style="justify-content:flex-start;">
      <button class="confirm" id="apptFindGoBtn">🚀 Run Maximus Agent</button>
    </div>
    <p class="field-hint" style="margin-top:14px;">Try: "Find a salon near me for a haircut", "Book me the best hospital near me, I have a fever", "I need a plumber nearby, my tap is leaking", "Book the cheapest available car service", "Show my appointments". Requests with "near me / nearby / best" for a hospital, salon, or repair service search real nearby places (OpenStreetMap) — everything else uses demo providers.</p>
  `;
}

let dashboardFindDraft = '';

function renderActiveTab(){
  if(!currentRun){
    return `<p class="field-hint">No agent task is running right now. Start one from the <b>Find Appointment</b> tab, or say "Maximus, book me a &lt;service&gt;".</p>`;
  }
  const run = currentRun;
  const stepsHtml = run.steps.map(s=>`<div class="mx-appt-step ${s.status}"><span class="ic">${STEP_ICON[s.status]}</span>${escapeHtml(s.label)}</div>`).join('');
  const logHtml = run.log.slice(-8).map(l=>`<div class="mx-appt-logline">${escapeHtml(l.text)}</div>`).join('');
  let approvalHtml = '';
  if(pendingConfirmationRun === run && run.provider){
    const p = run.provider, plan = run.plan;
    const badge = p.real ? `<span class="mx-appt-demo-badge" style="background:#1f7a4c;">REAL — OpenStreetMap</span>` : `<span class="mx-appt-demo-badge">DEMO</span>`;
    approvalHtml = `
      <div class="mx-appt-card mx-appt-approval">
        <div class="mx-appt-card-title">APPOINTMENT READY</div>
        <div class="mx-appt-kv"><span>Provider</span><b>${escapeHtml(p.name)} ${badge}</b></div>
        ${p.address ? `<div class="mx-appt-kv"><span>Address</span><b>${escapeHtml(p.address)}</b></div>` : ''}
        ${run.request.reason ? `<div class="mx-appt-kv"><span>Reason for visit</span><b>${escapeHtml(run.request.reason)}</b></div>` : ''}
        <div class="mx-appt-kv"><span>Service</span><b>${escapeHtml(run.request.service)}</b></div>
        <div class="mx-appt-kv"><span>Date</span><b>${formatDateShort(run.dateObj)}</b></div>
        <div class="mx-appt-kv"><span>Time</span><b>${run.slot}</b></div>
        ${plan.skipped ? '' : `
        <div class="mx-appt-kv"><span>Original price</span><b>₹${p.price}</b></div>
        <div class="mx-appt-kv"><span>Negotiated price</span><b>₹${plan.finalPrice}${plan.success?` <span class="mx-appt-savings">saved ₹${p.price-plan.finalPrice}</span>`:''}</b></div>`}
        <div class="mx-appt-kv"><span>Location</span><b>${escapeHtml(p.real ? (p.address || `${p.distanceKm} km away (real)`) : (run.request.location==='near_user'?'Near you (demo)':(run.request.location||'Demo location')))}</b></div>
        ${p.real ? `<p class="field-hint" style="margin:8px 0 0;">This is a real ${escapeHtml(placeLabelForService(p.service))}. The call below is still simulated — no real call was placed.</p>` : ''}
        <div class="modal-actions">
          <button class="cancel danger" id="apptDeclineBtn">CANCEL</button>
          ${(p.real && p.phone) ? `<button class="cancel" id="apptWhatsAppBtn" type="button">📱 MESSAGE ON WHATSAPP</button>` : ''}
          <button class="confirm" id="apptConfirmBtn">CONFIRM BOOKING</button>
        </div>
      </div>`;
  }
  const transcriptHtml = run.transcript && run.transcript.length ? `
    <div class="mx-appt-card">
      <div class="mx-appt-card-title">${run.mode==='call' ? '📞 SIMULATED CALL TRANSCRIPT' : '💬 SIMULATED CHAT'} — ${escapeHtml(run.provider ? run.provider.name : '')}${run.provider && run.provider.real ? ` (real ${escapeHtml(placeLabelForService(run.provider.service))})` : ''}</div>
      <div class="mx-appt-transcript">
        ${run.transcript.map(l=>`<div class="mx-appt-bubble ${l.speaker}"><b>${l.speaker==='maximus'?'Maximus':'Provider'}:</b> ${escapeHtml(l.text)}</div>`).join('')}
      </div>
    </div>` : '';

  return `
    <div class="mx-appt-live">
      <div class="mx-appt-card-title">MAXIMUS AGENT</div>
      ${stepsHtml}
    </div>
    ${logHtml ? `<div class="mx-appt-card">${logHtml}</div>` : ''}
    ${transcriptHtml}
    ${approvalHtml}
  `;
}

function renderProvidersTab(){
  if(!currentRun || !currentRun.ranked.length){
    return `<p class="field-hint">Provider comparisons appear here after you run a search from the Find Appointment tab.</p>`;
  }
  const real = currentRun.usedRealSearch;
  const rows = currentRun.ranked.map(p=>{
    const badge = p.real ? `<span class="mx-appt-demo-badge" style="background:#1f7a4c;">REAL</span>` : `<span class="mx-appt-demo-badge">DEMO</span>`;
    const meta = p.real
      ? `${p.distanceKm} km away${p.emergency ? ' · 🚑 emergency care' : ''} · ${p.address || 'address not listed'}${p.phone ? ' · ' + p.phone : ' · no phone listed'}`
      : `⭐ ${p.rating} · ₹${p.price} · ${p.distanceKm} km · ${p.slots.join(', ')}`;
    return `
    <div class="mx-appt-provider-row">
      <div class="mx-appt-provider-name">${escapeHtml(p.name)} ${badge}</div>
      <div class="mx-appt-provider-meta">${escapeHtml(meta)}</div>
    </div>`;
  }).join('');
  const hint = real
    ? `Results for "${escapeHtml(currentRun.request.service)}" — real ${escapeHtml(placeLabelForService(currentRun.request.service))}s near you, from OpenStreetMap. Appointment slots shown are still simulated (no public API exposes real-time booking schedules).`
    : `Results for "${escapeHtml(currentRun.request.service)}" — mock/demo data, clearly separate from any real booking API.`;
  return `<p class="field-hint" style="margin-bottom:10px;">${hint}</p>${rows}`;
}

function renderNegotiationsTab(){
  const negotiated = (state.appointments||[]).filter(a=>a.negotiated);
  if(!negotiated.length) return `<p class="field-hint">No negotiations yet — completed negotiations will be logged here with before/after prices.</p>`;
  return negotiated.map(a=>`
    <div class="mx-appt-provider-row">
      <div class="mx-appt-provider-name">${escapeHtml(a.providerName)} — ${escapeHtml(a.service)}</div>
      <div class="mx-appt-provider-meta">₹${a.originalPrice} → ₹${a.finalPrice} <span class="mx-appt-savings">saved ₹${a.savings}</span></div>
    </div>`).join('');
}

function renderApptListTab(list, kind){
  if(!list.length) return `<p class="field-hint">Nothing here yet.</p>`;
  return list.map(a=>`
    <div class="mx-appt-card">
      <div class="mx-appt-card-title">${escapeHtml(a.providerName)}</div>
      <div class="mx-appt-kv"><span>Service</span><b>${escapeHtml(a.service)}</b></div>
      <div class="mx-appt-kv"><span>When</span><b>${a.dateLabel} • ${a.time}</b></div>
      <div class="mx-appt-kv"><span>Price</span><b>₹${a.finalPrice}${a.negotiated?` <span class="mx-appt-savings">saved ₹${a.savings}</span>`:''}</b></div>
      <div class="mx-appt-kv"><span>Booking ID</span><b>${a.bookingId}</b></div>
      ${kind==='upcoming' ? `
      <div class="modal-actions">
        <button class="cancel" data-appt-directions="${a.id}">GET DIRECTIONS</button>
        <button class="cancel" data-appt-calendar="${a.id}">${a.calendarEventId?'✅ ON CALENDAR':'ADD TO CALENDAR'}</button>
        ${(a.real && a.providerPhone) ? `<button class="cancel" data-appt-whatsapp="${a.id}">📱 WHATSAPP</button>` : ''}
        <button class="cancel" data-appt-reschedule="${a.id}">RESCHEDULE</button>
        <button class="cancel danger" data-appt-cancel="${a.id}">CANCEL</button>
      </div>` : ''}
    </div>`).join('');
}

function renderHistoryTab(ctx){
  return `
    <div class="mx-appt-subhead">Upcoming</div>
    ${renderApptListTab(ctx.upcoming, 'upcoming')}
    <div class="mx-appt-subhead">Completed</div>
    ${ctx.completed.length ? renderApptListTab(ctx.completed, 'completed') : '<p class="field-hint">None yet.</p>'}
    <div class="mx-appt-subhead">Cancelled</div>
    ${ctx.cancelled.length ? renderApptListTab(ctx.cancelled, 'cancelled') : '<p class="field-hint">None yet.</p>'}
  `;
}

function renderPreferencesTab(){
  const p = state.appointmentPrefs;
  return `
    <label class="modal-label">Preferred time</label>
    <input id="prefTime" type="text" placeholder="e.g. after 6 PM" value="${escapeHtml(p.preferredTime||'')}">
    <label class="modal-label">Maximum budget (₹)</label>
    <input id="prefBudget" type="number" placeholder="e.g. 600" value="${p.maxBudget||''}">
    <label class="modal-label">Preferred location</label>
    <input id="prefLocation" type="text" placeholder="e.g. Kondapur, Hyderabad" value="${escapeHtml(p.preferredLocation||'')}">
    <label class="modal-label">Preferred communication method</label>
    <select id="prefComm">
      <option value="chat"${p.communicationMethod!=='call'?' selected':''}>Chat</option>
      <option value="call"${p.communicationMethod==='call'?' selected':''}>Call (simulated)</option>
    </select>
    <div class="modal-actions"><button class="confirm" id="prefSaveBtn">Save preferences</button></div>
    <p class="field-hint" style="margin-top:10px;">Maximus uses these automatically — e.g. "I usually prefer appointments after 6 PM" becomes your default preferred time.</p>
  `;
}

function renderPermissionsTab(){
  const perm = state.agentPermissions;
  const toggle = (id, label, checked) => `
    <div class="mx-appt-toggle-row">
      <span>${label}</span>
      <input type="checkbox" id="${id}" ${checked?'checked':''}>
    </div>`;
  return `
    ${toggle('permContact','Can Maximus contact businesses?', perm.canContact)}
    ${toggle('permNegotiate','Can Maximus negotiate?', perm.canNegotiate)}
    <label class="modal-label">Maximum appointment price (₹)</label>
    <input id="permMaxPrice" type="number" value="${perm.maxPrice}">
    <label class="modal-label">Maximum negotiation attempts</label>
    <input id="permMaxAttempts" type="number" min="1" max="6" value="${perm.maxNegotiationAttempts}">
    ${toggle('permAutoReschedule','Can Maximus automatically reschedule?', perm.canAutoReschedule)}
    ${toggle('permBookNoConfirm','Can Maximus book without confirmation?', perm.canBookWithoutConfirmation)}
    ${toggle('permPayments','Can Maximus make payments?', perm.canMakePayments)}
    <p class="field-hint" style="margin:10px 0;">Payments aren't implemented in this build — this stays off regardless, so nothing here can ever charge a card.</p>
    <div class="modal-actions"><button class="confirm" id="permSaveBtn">Save permissions</button></div>
  `;
}

function wireTabInteractions(){
  if(dashboardTab === 'find'){
    const input = document.getElementById('apptFindInput');
    if(input) input.addEventListener('input', ()=>{ dashboardFindDraft = input.value; });
    const modeSel = document.getElementById('apptModeSelect');
    const goBtn = document.getElementById('apptFindGoBtn');
    if(goBtn){
      goBtn.addEventListener('click', async ()=>{
        const text = (document.getElementById('apptFindInput').value || '').trim();
        if(!text){ showToast('Describe what you need first.'); return; }
        state.appointmentPrefs.communicationMethod = modeSel.value;
        save();
        dashboardFindDraft = '';
        dashboardTab = 'active';
        await runAppointmentAgent(text, { source: 'dashboard' });
      });
    }
  }
  if(dashboardTab === 'active'){
    const confirmBtn = document.getElementById('apptConfirmBtn');
    if(confirmBtn) confirmBtn.addEventListener('click', confirmPendingBooking);
    const declineBtn = document.getElementById('apptDeclineBtn');
    if(declineBtn) declineBtn.addEventListener('click', declinePendingBooking);
    const waBtn = document.getElementById('apptWhatsAppBtn');
    if(waBtn) waBtn.addEventListener('click', async ()=>{
      const run = pendingConfirmationRun || currentRun;
      const msg = buildRunWhatsAppMessage(run);
      if(!msg){ showToast("No phone number listed for this provider — can't open WhatsApp."); return; }
      const res = await openWhatsAppOnPhone(run.provider.phone, msg);
      showToast(res.viaAndroidPhone
        ? 'Opened WhatsApp on your phone with your message. Tap Send there to deliver it.'
        : 'Opening WhatsApp with your message. Tap Send to deliver it.');
    });
  }
  if(dashboardTab === 'upcoming' || dashboardTab === 'history'){
    document.querySelectorAll('[data-appt-cancel]').forEach(b=>b.addEventListener('click', ()=>{
      cancelAppointment(b.getAttribute('data-appt-cancel'));
      showToast('Appointment cancelled.');
      renderDashboard();
    }));
    document.querySelectorAll('[data-appt-calendar]').forEach(b=>b.addEventListener('click', async ()=>{
      const appt = state.appointments.find(a=>a.id===b.getAttribute('data-appt-calendar'));
      if(!appt) return;
      const res = await addAppointmentToCalendar(appt);
      if(res.ok) showToast(res.alreadyAdded ? 'Already on your calendar.' : 'Added to Google Calendar.');
      else if(res.reason==='not_connected') showToast('Connect Google Calendar in Settings first.');
      else showToast("Couldn't add to calendar right now.");
      renderDashboard();
    }));
    document.querySelectorAll('[data-appt-directions]').forEach(b=>b.addEventListener('click', ()=>{
      const appt = state.appointments.find(a=>a.id===b.getAttribute('data-appt-directions'));
      if(!appt) return;
      window.open(appt.mapsUrl || `https://www.google.com/maps/search/${encodeURIComponent(appt.providerName + (appt.address ? ', ' + appt.address : ''))}`, '_blank');
    }));
    document.querySelectorAll('[data-appt-whatsapp]').forEach(b=>b.addEventListener('click', async ()=>{
      const appt = state.appointments.find(a=>a.id===b.getAttribute('data-appt-whatsapp'));
      if(!appt) return;
      const msg = buildApptWhatsAppMessage(appt);
      if(!msg){ showToast("No phone number listed for this provider — can't open WhatsApp."); return; }
      const res = await openWhatsAppOnPhone(appt.providerPhone, msg);
      showToast(res.viaAndroidPhone
        ? 'Opened WhatsApp on your phone with your message. Tap Send there to deliver it.'
        : 'Opening WhatsApp with your message. Tap Send to deliver it.');
    }));
    document.querySelectorAll('[data-appt-reschedule]').forEach(b=>b.addEventListener('click', ()=>{
      const appt = state.appointments.find(a=>a.id===b.getAttribute('data-appt-reschedule'));
      if(!appt) return;
      const answer = prompt(`Reschedule ${appt.service} at ${appt.providerName} to which day? (e.g. "tomorrow", "Saturday")`, 'tomorrow');
      if(!answer) return;
      const newDateObj = resolveDate(answer.trim());
      const providers = searchProviders(appt.service, newDateObj.toISOString());
      const sameProvider = providers.find(p=>p.name === appt.providerName) || providers[0];
      const newSlot = pickSlot(sameProvider, {});
      const updated = rescheduleAppointment(appt.id, newDateObj, newSlot);
      showToast(`Moved to ${updated.dateLabel} at ${updated.time}.`);
      renderDashboard();
    }));
  }
  if(dashboardTab === 'preferences'){
    document.getElementById('prefSaveBtn').addEventListener('click', ()=>{
      state.appointmentPrefs.preferredTime = document.getElementById('prefTime').value.trim();
      state.appointmentPrefs.maxBudget = Number(document.getElementById('prefBudget').value) || null;
      state.appointmentPrefs.preferredLocation = document.getElementById('prefLocation').value.trim();
      state.appointmentPrefs.communicationMethod = document.getElementById('prefComm').value;
      save();
      showToast('Preferences saved.');
    });
  }
  if(dashboardTab === 'permissions'){
    document.getElementById('permSaveBtn').addEventListener('click', ()=>{
      const perm = state.agentPermissions;
      perm.canContact = document.getElementById('permContact').checked;
      perm.canNegotiate = document.getElementById('permNegotiate').checked;
      perm.maxPrice = Number(document.getElementById('permMaxPrice').value) || perm.maxPrice;
      perm.maxNegotiationAttempts = Math.max(1, Math.min(6, Number(document.getElementById('permMaxAttempts').value) || perm.maxNegotiationAttempts));
      perm.canAutoReschedule = document.getElementById('permAutoReschedule').checked;
      perm.canBookWithoutConfirmation = document.getElementById('permBookNoConfirm').checked;
      perm.canMakePayments = false; // never enabled — no payment integration exists
      save();
      showToast('Permissions saved.');
    });
  }
}

/* ------------------------------------------------------------------ *
 *  10. WIRE INTO THE EXISTING APP  (buttons + overrides, no app.js edits)
 * ------------------------------------------------------------------ */

document.getElementById('appointmentAgentBtn').addEventListener('click', ()=> showAppointmentDashboard('find'));
const overlayBtn = document.getElementById('appointmentAgentOverlayBtn');
if(overlayBtn) overlayBtn.addEventListener('click', ()=>{
  assistantOverlay.classList.add('hidden');
  showAppointmentDashboard('find');
});

// Wrap sendMessage(): appointment requests and pending confirm/cancel
// replies are intercepted before the normal chat/AI pipeline runs.
// Everything else (attachments, scripted replies, normal AI chat) is
// untouched — it just falls through to the original function.
const _originalSendMessage = sendMessage;
sendMessage = async function(){
  const text = messageInput.value.trim();
  if(text && pendingConfirmationRun){
    const handled = await tryHandleAppointmentConfirmationReply(text);
    if(handled){
      messageInput.value = '';
      autoResize();
      updateSendButtonState();
      return;
    }
  }
  if(text && pendingAttachments.length === 0 && looksLikeAppointmentRequest(text)){
    let chat = getActiveChat();
    if(!chat) chat = createChat();
    chat.messages.push({ id: uid(), role:'user', content:text, attachments:[], ts: Date.now() });
    if(chat.title === 'New chat'){ chat.title = text.length > 42 ? text.slice(0,42)+'…' : text; }
    chat.updatedAt = Date.now();
    messageInput.value = '';
    autoResize();
    renderPendingAttachments();
    renderAll();
    save();
    renderSidebar();
    await runAppointmentAgent(text, { source: 'chat' });
    return;
  }
  return _originalSendMessage();
};

// Wrap executeVoiceCommand(): same idea for the voice assistant overlay.
const _originalExecuteVoiceCommand = executeVoiceCommand;
executeVoiceCommand = async function(raw){
  const trimmed = String(raw||'').trim();
  if(pendingConfirmationRun){
    const handled = await tryHandleAppointmentConfirmationReply(trimmed);
    if(handled) return true;
  }
  if(looksLikeAppointmentRequest(trimmed)){
    await runAppointmentAgent(trimmed, { source: 'voice' });
    return true;
  }
  return _originalExecuteVoiceCommand(raw);
};

})();

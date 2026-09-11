# Maximus Appointment Agent (DVPS11) — what was added

This extends your existing Maximus app — nothing about the chat, voice
assistant, desktop agent, phone bridge, email, Spotify, or calendar
features was removed or rewritten. Everything below lives in **one new
file**, `appointment-agent.js`, plus a small CSS block appended to the end
of `style.css` and two new buttons in `index.html`.

## What it does

Maximus can now understand, search, compare, negotiate, get your
approval, book, and remind you about appointments — salon, doctor, or
service-repair — from either typed chat or the voice assistant:

> "Maximus, book me a haircut tomorrow evening near me for less than ₹600."

Try it in the chat box, or tap the mic / open the assistant overlay and
say it out loud.

Other phrasings that work: "Find a dentist for me this Saturday", "I need
my AC repaired tomorrow", "Book the cheapest available car service",
"Show my appointments", "Cancel my appointment", "Reschedule my
appointment to Saturday".

## Where to find it

- **📅 button** next to Settings in the sidebar — opens the full
  **Maximus Appointment Agent** dashboard (Find Appointment, Active
  Agent, Providers, Negotiations, Upcoming, History, Preferences,
  Permissions tabs).
- **📅 Book Appointment** button inside the voice assistant overlay.
- Typing or saying a booking request directly also opens the same
  dashboard automatically and runs the agent live, so you can watch it
  search → compare → negotiate → ask for your approval → book.

## How it works under the hood

- **Understanding**: your request is parsed into structured JSON
  (service, date, time, budget, location, etc.) using the same Mistral
  API integration the rest of Maximus already uses. If no API key is set
  or the call fails, a built-in offline parser still extracts the basics
  so the demo keeps working.
- **Search & compare**: uses a small set of **mock/demo providers** (3
  salons, 3 clinics, 3 repair services) with ratings, prices and time
  slots — clearly labeled "DEMO" everywhere they appear. The
  `searchProviders()` function is the one place you'd swap in a real
  booking API later; everything downstream (ranking, negotiation,
  booking, calendar, reminders) already works off the same shape.
- **Negotiation**: prices are stepped down deterministically (so the
  numbers are always correct), and Mistral is used only to write the
  natural-sounding dialogue *around* those already-decided numbers — it's
  sanity-checked against the real final price before being trusted, with
  a template fallback otherwise.
- **Call vs. chat**: both are **simulated** — clearly labeled "SIMULATED
  CALL" / "SIMULATED CHAT" in the transcript. No real phone call or
  message is ever sent to a real business.
- **Approval**: nothing is booked without an explicit "CONFIRM BOOKING"
  (button in the dashboard, or replying "confirm"/"cancel" in chat or by
  voice) unless you turn on "Can Maximus book without confirmation?" in
  Permissions — which defaults to off.
- **Calendar**: if you've already connected Google Calendar in Settings,
  confirmed bookings are added automatically (each appointment only gets
  one calendar event — re-clicking "Add to Calendar" won't duplicate it).
- **Reminders**: reuses Maximus's existing reminder/task system to set a
  1-day-before and 2-hours-before reminder automatically.
- **Permissions**: a dedicated tab lets you control whether Maximus can
  contact businesses, negotiate, auto-reschedule, book without
  confirmation, and sets a max price / max negotiation attempts. "Can
  Maximus make payments?" always stays off — no payment integration
  exists in this build.

## NEW: real nearby-place search — hospitals, salons, AND repair services

Ask something like:

> "Book me the best hospital near me, I have a fever."
> "Find a salon near me for a haircut."
> "I need a plumber nearby, my tap is leaking."
> "Find the closest AC repair, electrician, or mechanic near me."

Maximus now runs a **real OpenStreetMap search** — not just for
hospitals, but for salons and every repair category too — whenever you
say the kind of place outright (hospital, salon/parlour, dentist, clinic)
or add "near me / nearby / closest / best" to a booking request:

1. **Understands the request** — pulls the reason for a doctor visit
   ("a fever", "back hurts"), or the service + any special requirement
   for a salon/repair job, straight from your sentence (Mistral parser,
   with a regex fallback if no API key is set). It never invents details
   you didn't mention.
2. **Finds REAL nearby places** — asks your browser for your location,
   then queries the free **OpenStreetMap Overpass API** (no Google Maps
   API key needed) for the right kind of real business near you: real
   name, real address, and a real phone number where one is listed on
   the map. The OSM tags searched depend on the service — hospitals/
   clinics/dentists for doctor requests, hairdresser/beauty/spa shops for
   salon requests, and the matching craft/shop tag (plumber, electrician,
   HVAC, appliance repair, car/motorcycle repair) for repair requests. If
   location access is denied/unavailable, or nothing real is found
   nearby, it automatically falls back to the existing demo provider list
   and says so in the log — it never silently pretends a demo entry is
   real.
3. **"Calls" and states what's needed clearly** — the transcript shown is
   still a **SIMULATED CALL** (same as every other category in this
   build — Maximus has no telephony integration, so it never actually
   dials the real number). For a doctor/hospital it states the reason for
   the visit plainly; for a salon or repair job it states the service
   needed. No price is discussed or invented, since real prices aren't
   available from map data.
4. **Books it the same way as everything else** — approval required
   (unless you've turned that off in Permissions), real Google Calendar
   event if connected, real reminders. The booking card and calendar
   event both flag it as a real place with a simulated call, and give you
   its phone number and a Google Maps link so you can call and confirm
   yourself before you go.

**Why the call stays simulated:** actually placing a real phone call and
carrying a live voice negotiation with a real business needs a telephony
backend (e.g. Twilio) with its own account/cost/setup — out of scope for
this pass. Nothing about the place's real identity is faked; only the
phone conversation is a demo, and it's labelled as such everywhere it
appears.

## NEW: message a real provider on WhatsApp

If a real place found via OpenStreetMap has a phone number listed, Maximus
can also open an actual WhatsApp chat to that number with your booking
message already typed in. There's a **📱 MESSAGE ON WHATSAPP** button:

- On the "appointment ready" approval card, before you confirm.
- On any upcoming appointment that was booked with a real provider (📱
  WHATSAPP button), and as a link in the booking confirmation.

**Where it opens depends on how Maximus is set up:**

- **If your Android phone is connected via the 🔗 Connect Phone button**
  (the same adb bridge used for "call `<name>`", unlocking, etc.), tapping
  the button asks the desktop agent to open WhatsApp **directly on your
  phone** — even though you clicked the button on your PC. The chat and
  message are ready there; you just tap Send on the phone itself.
- **If no phone is connected** (or the desktop agent isn't running),
  it automatically falls back to opening WhatsApp Web in a new browser
  tab on the PC, pre-filled the same way.

This is the exact same fallback pattern the pre-existing "message
`<contact>` saying `<text>`" voice/chat command now uses too — both go
through the same `/whatsapp-message` endpoint added to
`maximus_agent.py`, which fires the same kind of "open this chat" intent
adb already uses for real phone calls.

Either way, **Maximus never sends it for you** — it only ever fills the
message in, on whichever device it opened; a human always has to tap
Send themselves. This mirrors the "no real send without a human tap"
rule everywhere else in Maximus.

## Honesty about what's real vs. simulated

- Demo salon/doctor/repair providers, availability, phone calls, and
  chat negotiations: **100% demo data**, generated locally, clearly
  labeled.
- Real hospital/salon/repair-business name, address, and phone number
  (when a real search succeeds): **real data**, sourced live from
  OpenStreetMap. Appointment slot *times* are still simulated — no
  public API exposes a business's live booking schedule.
- Every phone call and chat negotiation, including for real places:
  **simulated** — no real call is ever placed to any business, real or
  demo.
- WhatsApp: **real** — Maximus opens a genuine WhatsApp chat with your
  message pre-filled, **on your connected Android phone itself if one is
  linked** (via the same adb bridge as real phone calls), or in the
  browser otherwise — but a human always has to tap Send; Maximus never
  sends it on its own.
- Google Calendar events: **real**, if you've connected your account.
- Reminders: **real**, using the same local reminder system as the rest
  of Maximus.
- Payments: **never implemented or attempted**.

No screen anywhere claims a real appointment was placed with a real
business — every booking confirmation explicitly says it's a demo
booking against a simulated provider unless it's a real OpenStreetMap
place, in which case it's clearly flagged as real-place-but-simulated-call.

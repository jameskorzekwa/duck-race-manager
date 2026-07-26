import type { BrowserRegistration } from "./browser-registrations.ts";
import type { PublicRaceStatusRecord, RegistrationStatusRecord } from "./types.ts";

const escapeHtml = (value: string): string =>
  value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character] ?? character);

const duck = (className = "duck-mark"): string => `
<svg class="${className}" viewBox="0 0 96 76" role="img" aria-label="Rubber duck">
  <path d="M8 61c12 5 22 5 34 0 12-5 22-5 34 0 6 3 11 3 16 1" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>
  <ellipse cx="42" cy="47" rx="31" ry="20" fill="#ffd43b" stroke="#112b3c" stroke-width="3"/>
  <circle cx="61" cy="28" r="20" fill="#ffd43b" stroke="#112b3c" stroke-width="3"/>
  <circle cx="68" cy="23" r="3" fill="#112b3c"/>
  <path d="M78 29h14l-10 8H75z" fill="#ff7132" stroke="#112b3c" stroke-width="3" stroke-linejoin="round"/>
  <path d="M25 45c8-8 19-7 24 2-7 8-17 11-24 5" fill="#efad20" stroke="#112b3c" stroke-width="3" stroke-linecap="round"/>
</svg>`;

export const faviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#fff7d6"/>
  <ellipse cx="27" cy="41" rx="21" ry="14" fill="#ffd43b" stroke="#112b3c" stroke-width="3"/>
  <circle cx="40" cy="25" r="14" fill="#ffd43b" stroke="#112b3c" stroke-width="3"/>
  <circle cx="45" cy="21" r="2.5" fill="#112b3c"/>
  <path d="M51 26h12l-9 7h-7z" fill="#ff7132" stroke="#112b3c" stroke-width="3" stroke-linejoin="round"/>
  <path d="M15 40c6-6 14-5 18 2-5 6-12 8-18 4" fill="#efad20" stroke="#112b3c" stroke-width="2.5"/>
</svg>`;

const styles = `
:root { color-scheme: light; --ink:#112b3c; --cream:#fff7d6; --paper:#fffdf3; --yellow:#ffd43b; --orange:#ff7132; --water:#3294b0; --water-dark:#146780; --muted:#607078; font-family:ui-rounded,"Avenir Next Rounded","Arial Rounded MT Bold",system-ui,sans-serif; }
* { box-sizing:border-box; }
html { scroll-behavior:smooth; }
body { margin:0; min-width:320px; min-height:100vh; background:var(--cream); color:var(--ink); }
a { color:inherit; }
.shell { width:min(70rem,calc(100% - 2rem)); margin:0 auto; }
.site-head { display:flex; align-items:center; justify-content:space-between; gap:1rem; padding:1rem 0; }
.brand { display:inline-flex; align-items:center; gap:.55rem; color:var(--ink); text-decoration:none; font-size:1.12rem; font-weight:950; letter-spacing:-.03em; }
.brand svg { width:3rem; height:2.35rem; color:var(--water-dark); }
.nav { display:flex; gap:.35rem; }
.nav a { padding:.7rem .9rem; border:2px solid transparent; border-radius:999px; font-weight:850; text-decoration:none; }
.nav a:hover,.nav a:focus-visible { border-color:var(--ink); outline:none; }
.hero { position:relative; overflow:hidden; display:grid; align-items:center; min-height:34rem; padding:clamp(2rem,6vw,5rem); border:3px solid var(--ink); border-radius:2rem; background:var(--paper); box-shadow:9px 9px 0 var(--ink); }
.hero::after { content:""; position:absolute; z-index:0; right:-10%; bottom:-5rem; left:-10%; height:12rem; border-radius:50% 50% 0 0; background:var(--water); transform:rotate(-2deg); }
.hero::before { content:""; position:absolute; z-index:1; right:-20%; bottom:1rem; left:-20%; height:1.4rem; background-image:radial-gradient(ellipse 3.4rem .32rem at 3.4rem 50%,rgba(255,255,255,.92) 96%,transparent 100%); background-position:0 50%; background-repeat:repeat-x; background-size:10rem 1.4rem; opacity:.9; pointer-events:none; }
.hero-copy { position:relative; z-index:3; max-width:42rem; }
.eyebrow { display:inline-flex; margin:0 0 1rem; padding:.48rem .78rem; border:2px solid var(--ink); border-radius:999px; background:var(--yellow); font-size:.8rem; font-weight:950; letter-spacing:.09em; text-transform:uppercase; }
h1,h2,h3,p { margin-top:0; }
h1 { max-width:10ch; margin-bottom:1.15rem; font-size:clamp(3.2rem,12vw,7.8rem); line-height:.82; letter-spacing:-.075em; }
h2 { font-size:clamp(2rem,6vw,3.7rem); line-height:.95; letter-spacing:-.055em; }
h3 { font-size:1.3rem; letter-spacing:-.03em; }
.lede { max-width:38rem; margin-bottom:1.5rem; color:#314a57; font-size:clamp(1.05rem,2.5vw,1.35rem); line-height:1.55; }
.actions { display:flex; flex-wrap:wrap; gap:.8rem; }
.button { display:inline-flex; min-height:3.25rem; align-items:center; justify-content:center; padding:.85rem 1.15rem; border:3px solid var(--ink); border-radius:.8rem; background:var(--yellow); box-shadow:4px 4px 0 var(--ink); color:var(--ink); font:inherit; font-weight:950; text-decoration:none; cursor:pointer; }
.button:hover,.button:focus-visible { outline:none; box-shadow:2px 2px 0 var(--ink); transform:translate(2px,2px); }
.button.secondary { background:var(--paper); }
.hero-duck { --duck-center:0%; position:absolute; z-index:2; right:clamp(1rem,5vw,4rem); bottom:2.5rem; width:clamp(12rem,37vw,25rem); color:#fff; filter:drop-shadow(5px 7px 0 rgba(17,43,60,.22)); pointer-events:none; transform:translateX(var(--duck-center)) translateY(0) rotate(-4deg); }
.ticker { display:flex; flex-wrap:wrap; justify-content:center; gap:.2rem .7rem; padding:1.35rem 0; color:var(--water-dark); font-size:.8rem; font-weight:950; letter-spacing:.1em; text-transform:uppercase; }
.ticker span::after { content:"•"; margin-left:.7rem; color:var(--orange); }
.ticker span:last-child::after { content:""; margin:0; }
.home-tools { display:grid; gap:1rem; margin:1rem 0 2rem; }
.tool-panel { padding:1.4rem; border:3px solid var(--ink); border-radius:1.2rem; background:var(--paper); }
.tool-panel h2 { margin-bottom:.7rem; font-size:clamp(1.7rem,5vw,2.5rem); }
.registration-list { display:grid; gap:.7rem; margin:1rem 0; padding:0; list-style:none; }
.registration-item { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:.7rem; padding:.85rem; border:2px solid #b8c6c9; border-radius:.8rem; }
.registration-item a { font-weight:900; }
.mini-code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.85rem; font-weight:900; letter-spacing:.08em; }
.status-search { display:grid; grid-template-columns:1fr auto; gap:.7rem; align-items:end; }
.status-search label { min-width:0; }
.cards { display:grid; gap:1rem; margin:2rem 0 4rem; }
.card { padding:1.4rem; border:3px solid var(--ink); border-radius:1.2rem; background:var(--paper); }
.card strong { display:block; margin-bottom:.35rem; color:var(--water-dark); font-size:.76rem; letter-spacing:.09em; text-transform:uppercase; }
.card-link { display:inline-block; margin-top:.7rem; font-weight:900; }
.page-panel { max-width:49rem; margin:2rem auto 5rem; padding:clamp(1.2rem,5vw,3rem); border:3px solid var(--ink); border-radius:1.5rem; background:var(--paper); box-shadow:8px 8px 0 var(--ink); }
.page-panel > .duck-mark { float:right; width:8rem; color:var(--water-dark); }
.page-title { max-width:12ch; font-size:clamp(2.7rem,10vw,5.4rem); }
.muted { color:var(--muted); line-height:1.55; }
.notice { margin:1.2rem 0; padding:1rem; border-left:.5rem solid var(--orange); background:#fff0df; line-height:1.5; }
form { display:grid; gap:1.15rem; clear:both; }
.field-grid { display:grid; gap:1rem; }
label,legend { font-weight:900; }
label span,legend span { display:block; margin-top:.25rem; color:var(--muted); font-size:.86rem; font-weight:650; line-height:1.4; }
input { width:100%; min-height:3.2rem; margin-top:.45rem; padding:.7rem .8rem; border:2px solid var(--ink); border-radius:.65rem; background:#fff; color:var(--ink); font:inherit; }
input:focus { outline:4px solid #83d8ec; outline-offset:1px; }
.check { display:grid; grid-template-columns:1.4rem 1fr; gap:.7rem; align-items:start; font-weight:750; }
.check input { width:1.25rem; min-height:1.25rem; margin:.15rem 0 0; }
.turnstile-mock { display:grid; min-height:4.4rem; place-items:center; padding:.8rem; border:2px dashed #8da0a6; border-radius:.7rem; background:#f4f7f7; color:var(--muted); font-size:.82rem; font-weight:800; text-align:center; }
.code { display:inline-block; margin:.5rem 0; padding:.65rem .85rem; border:2px dashed var(--ink); border-radius:.6rem; background:var(--cream); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:clamp(1.4rem,7vw,2.4rem); font-weight:950; letter-spacing:.12em; }
.facts { display:grid; gap:.8rem; margin:1.5rem 0; }
.fact { padding:1rem; border:2px solid #b8c6c9; border-radius:.8rem; }
.fact dt { color:var(--muted); font-size:.75rem; font-weight:950; letter-spacing:.08em; text-transform:uppercase; }
.fact dd { margin:.25rem 0 0; font-size:1.08rem; font-weight:850; }
.privacy { display:flex; gap:.65rem; align-items:flex-start; padding:1rem; border-radius:.8rem; background:#e4f4f8; color:#245264; font-size:.9rem; line-height:1.5; }
.privacy strong { flex:none; }
.site-foot { padding:1rem 0 3rem; color:var(--muted); font-size:.85rem; text-align:center; }
@media (min-width:44rem) { .cards { grid-template-columns:repeat(3,1fr); } .field-grid { grid-template-columns:1fr 1fr; } .home-tools.has-registrations { grid-template-columns:1.15fr .85fr; } }
@media (max-width:43.99rem) { .shell { width:min(100% - 1rem,40rem); } .nav a:first-child { display:none; } .hero { min-height:0; padding:1.5rem 1.5rem 15.5rem; border-radius:1.35rem; box-shadow:6px 6px 0 var(--ink); } .actions { position:relative; z-index:4; } .hero-duck { --duck-center:50%; right:50%; bottom:1rem; width:13.5rem; } .hero::after { height:11rem; } .hero::before { bottom:1.3rem; } .ticker { font-size:.7rem; } .status-search { grid-template-columns:1fr; } .page-panel > .duck-mark { width:5.7rem; } .privacy { display:block; } .privacy strong { display:block; margin-bottom:.25rem; } }
@media (prefers-reduced-motion:no-preference) { .hero-duck { animation:duck-glide 3.1s ease-in-out infinite; } .hero::after { animation:water-swell 4.2s ease-in-out infinite; } .hero::before { animation:current 2.8s linear infinite; } @keyframes duck-glide { 0%,100% { transform:translateX(var(--duck-center)) translateY(0) rotate(-4deg); } 50% { transform:translateX(calc(var(--duck-center) + 6px)) translateY(-9px) rotate(1deg); } } @keyframes water-swell { 0%,100% { transform:translateY(0) rotate(-2deg); } 50% { transform:translateY(4px) rotate(-1deg); } } @keyframes current { to { background-position:-10rem 50%; } } }
`;

interface PageOptions {
  title: string;
  description: string;
  content: string;
  robots?: string;
}

const page = ({ title, description, content, robots = "index,follow" }: PageOptions): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="theme-color" content="#ffd43b">
    <meta name="description" content="${escapeHtml(description)}">
    <meta name="robots" content="${robots}">
    <link rel="icon" href="/favicon.svg" type="image/svg+xml">
    <link rel="manifest" href="/site.webmanifest">
    <title>${escapeHtml(title)} · QuickDucks</title>
    <style>${styles}</style>
  </head>
  <body>
    <header class="shell site-head">
      <a class="brand" href="/">${duck("brand-duck")}<span>QuickDucks</span></a>
      <nav class="nav" aria-label="Primary"><a href="/">Home</a><a href="/register">Register</a></nav>
    </header>
    <main class="shell">${content}</main>
    <footer class="shell site-foot">Built for quick check-ins, clear heats, and happy ducks.</footer>
  </body>
</html>`;

export const renderHome = (registrations: BrowserRegistration[] = []): string => page({
  title: "Race-day registration and results",
  description: "Register for the next QuickDucks race, check your heat, and follow race-day results.",
  content: `
    <section class="hero">
      <div class="hero-copy">
        <p class="eyebrow">Race-day, simplified</p>
        <h1>Find your duck. Follow the race.</h1>
        <p class="lede">A fast, friendly home for community duck races. Register, keep your private code, and follow your duck from check-in to finish.</p>
        <div class="actions"><a class="button" href="/register">Preview registration</a><a class="button secondary" href="#how-it-works">How it works</a></div>
      </div>
      ${duck("hero-duck")}
    </section>
    <div class="ticker" aria-label="QuickDucks features"><span>Tap the tag</span><span>Find your heat</span><span>Cheer loudly</span></div>
    <section class="home-tools ${registrations.length > 0 ? "has-registrations" : ""}" aria-label="Registration and race status">
      ${registrations.length === 0 ? "" : `<div class="tool-panel"><p class="eyebrow">Saved on this device</p><h2>Your registrations</h2><p class="muted">These registrations stay available on this browser after refreshes.</p><ul class="registration-list">${registrations.map((registration) => `<li class="registration-item"><span><strong>${escapeHtml(registration.name)}</strong><br><span class="mini-code">${escapeHtml(registration.lookupCode)}</span></span><a href="${escapeHtml(registration.statusPath)}">View status →</a></li>`).join("")}</ul><a class="button secondary" href="/register">Register another participant</a></div>`}
      <div class="tool-panel"><p class="eyebrow">Public race status</p><h2>Find a participant</h2><p class="muted">Search by participant name to see public duck, heat, and race progress. Contact information and staff codes are never shown.</p><form class="status-search" method="get" action="/status"><label>Participant name<input name="q" minlength="2" maxlength="161" required placeholder="Jamie Rivera"></label><button class="button" type="submit">Search status</button></form></div>
    </section>
    <section id="how-it-works" class="cards" aria-label="How QuickDucks works">
      <article class="card"><strong>Before the race</strong><h3>Register in under a minute</h3><p class="muted">You don’t need an account. Keep your private status link and short lookup code for race day.</p><a class="card-link" href="/register">Preview the form →</a></article>
      <article class="card"><strong>At check-in</strong><h3>Staff pair your selected duck</h3><p class="muted">A staff member scans the duck, then enters your code or finds your registration by name.</p><a class="card-link" href="/staff/mock/ducks/128/pair">Preview staff pairing →</a></article>
      <article class="card"><strong>On race day</strong><h3>One clear source of truth</h3><p class="muted">You can follow heat assignments, finalist progress, and results from check-in to finish.</p><a class="card-link" href="/r/mock">Preview status →</a></article>
    </section>`,
});

export const renderRegistration = (): string => page({
  title: "Register for the Summer Duck Race",
  description: "QuickDucks registration form mockup.",
  robots: "noindex,nofollow",
  content: `
    <section class="page-panel">
      ${duck()}
      <p class="eyebrow">Registration preview</p>
      <h1 class="page-title">Summer Duck Race</h1>
      <p class="lede">Sunday, August 30 · Registration takes about one minute.</p>
      <div class="privacy"><strong>Private by design.</strong><span>Your contact information never appears on the public NFC page.</span></div>
      <div class="notice"><strong>Registering more than one participant?</strong> Finish this form once for each person. You can use the same phone, email, or browser, and QuickDucks will keep their codes together on this device.</div>
      <form method="get" action="/r/mock">
        <div class="field-grid">
          <label>First name<input name="first_name" autocomplete="given-name" maxlength="80" required placeholder="Jamie"></label>
          <label>Last name<input name="last_name" autocomplete="family-name" maxlength="80" required placeholder="Rivera"></label>
        </div>
        <div class="field-grid">
          <label>Email (optional)<input name="email" type="email" autocomplete="email" maxlength="254" placeholder="jamie@example.com"><span>We’ll use this only for operational race updates.</span></label>
          <label>Phone (optional)<input name="phone" type="tel" autocomplete="tel" maxlength="32" placeholder="(555) 010-2040"></label>
        </div>
        <label class="check"><input name="email_notifications_enabled" type="checkbox" checked><span>Get duck assignment, heat, and result updates by email. You can disable these later.</span></label>
        <div class="turnstile-mock">Cloudflare anti-bot check appears here in the working registration flow.</div>
        <button class="button" type="submit">Preview confirmation</button>
      </form>
    </section>`,
});

export const renderStatus = (registration?: RegistrationStatusRecord): string => {
  const firstName = registration?.first_name ?? "Jamie";
  const lookupCode = registration?.lookup_code ?? "DUCK-824";
  const eventName = registration?.event_name ?? "Summer Duck Race";
  const registrationStatus = registration?.status === "ACTIVE"
    ? "Active — duck assigned"
    : "Submitted — waiting for duck assignment";
  return page({
  title: "Registration status",
  description: "Private QuickDucks registration status mockup.",
  robots: "noindex,nofollow",
  content: `
    <section class="page-panel">
      ${duck()}
      <p class="eyebrow">Private status preview</p>
      <h1 class="page-title">You’re in the queue, ${escapeHtml(firstName)}.</h1>
      <p class="lede">Keep this page private. This is your status link for ${escapeHtml(eventName)}.</p>
      <div class="notice"><strong>Staff lookup code</strong><br><span class="code">${escapeHtml(lookupCode)}</span><br><span class="muted">Save this code or bookmark this page.</span></div>
      <dl class="facts"><div class="fact"><dt>Status</dt><dd>${registrationStatus}</dd></div><div class="fact"><dt>Race date</dt><dd>Sunday, August 30</dd></div></dl>
      <p class="muted">You’ll see your duck and heat here after staff assigns them. Your contact details never appear on public duck pages.</p>
      <div class="actions"><a class="button" href="/register">Register another participant</a><a class="button secondary" href="/">Back to home</a></div>
    </section>`,
  });
};

const mockRaceStatus: PublicRaceStatusRecord = {
  first_name: "Jamie",
  last_name: "Rivera",
  registration_status: "ACTIVE",
  event_name: "Summer Duck Race",
  event_status: "ROUND_ONE",
  visible_number: 128,
  round_type: "ROUND_ONE",
  heat_number: 7,
  heat_status: "PLANNED",
  current_heat_number: 5,
  current_heat_round: "ROUND_ONE",
  result_position: null,
  advanced: 0,
};

const roundLabel = (round: string | null): string => round === "FINAL" ? "Final" : "Round one";

const publicStatusFacts = (status: PublicRaceStatusRecord, includeParticipant = true): string => {
  const assignment = status.visible_number === null
    ? "Waiting for duck assignment"
    : `Duck #${status.visible_number}`;
  const heat = status.heat_number === null
    ? "Heat not assigned yet"
    : `${roundLabel(status.round_type)} · Heat ${status.heat_number}`;
  const running = status.current_heat_number === null
    ? "Racing has not started"
    : `${roundLabel(status.current_heat_round)} · Heat ${status.current_heat_number}`;
  const outcome = status.result_position !== null
    ? `Finished in position ${status.result_position}`
    : status.advanced === 1
      ? "Advanced to the final"
      : status.heat_status === "COMPLETED"
        ? "Heat completed"
        : "Waiting to race";
  return `<dl class="facts">${includeParticipant ? `<div class="fact"><dt>Participant</dt><dd>${escapeHtml(status.first_name)} ${escapeHtml(status.last_name)}</dd></div>` : ""}<div class="fact"><dt>Duck</dt><dd>${assignment}</dd></div><div class="fact"><dt>Assigned heat</dt><dd>${heat}</dd></div><div class="fact"><dt>Currently running</dt><dd>${running}</dd></div><div class="fact"><dt>Race status</dt><dd>${outcome}</dd></div></dl>`;
};

export const renderDuck = (status: PublicRaceStatusRecord = mockRaceStatus): string => page({
  title: status.visible_number === null ? "Race status" : `Duck #${status.visible_number}`,
  description: "Public QuickDucks NFC duck-page mockup.",
  robots: "noindex,nofollow",
  content: `
    <section class="page-panel">
      ${duck()}
      <p class="eyebrow">Public race status</p>
      <h1 class="page-title">${status.visible_number === null ? "Waiting for a duck" : `Duck #${status.visible_number}`}</h1>
      <p class="lede">Follow this duck through ${escapeHtml(status.event_name)}.</p>
      ${publicStatusFacts(status)}
      <div class="privacy"><strong>Public, not personal.</strong><span>This page shows race progress but never contact information, staff codes, or private links.</span></div>
      <br><a class="button secondary" href="/">Visit QuickDucks</a>
    </section>`,
});

export const renderPublicStatusSearch = (
  query: string,
  statuses: PublicRaceStatusRecord[],
): string => page({
  title: "Find race status",
  description: "Search public QuickDucks race status by participant name.",
  robots: "noindex,nofollow",
  content: `<section class="page-panel"><p class="eyebrow">Public race status</p><h1 class="page-title">Find a participant</h1><p class="lede">Search by name. Results show only public duck, heat, and race progress.</p><form class="status-search" method="get" action="/status"><label>Participant name<input name="q" minlength="2" maxlength="161" required value="${escapeHtml(query)}" placeholder="Jamie Rivera"></label><button class="button" type="submit">Search status</button></form>${query.length < 2 ? "" : statuses.length === 0 ? '<div class="notice">No matching participant was found. Check the spelling or ask race staff for help.</div>' : `<div class="registration-list">${statuses.map((status) => `<article class="card"><h3>${escapeHtml(status.first_name)} ${escapeHtml(status.last_name)}</h3>${publicStatusFacts(status, false)}</article>`).join("")}</div>`}</section>`,
});

export const renderStaffPairing = (): string => page({
  title: "Pair Duck #128",
  description: "Protected staff duck-pairing mockup.",
  robots: "noindex,nofollow",
  content: `<section class="page-panel"><p class="eyebrow">Protected staff preview</p><h1 class="page-title">Pair Duck #128</h1><p class="lede">This duck is available. Find the participant before confirming the assignment.</p><div class="privacy"><strong>Staff authentication required.</strong><span>The working version will verify the staff session and event role before showing codes or accepting a pairing command.</span></div><div class="facts"><div class="fact"><dt>Duck</dt><dd>#128 · Available</dd></div><div class="fact"><dt>Event</dt><dd>Summer Duck Race</dd></div></div><form><label>Participant duck code<input name="lookup_code" autocomplete="off" maxlength="16" placeholder="ABCD2345"></label><button class="button" type="button">Find participant by code</button></form><hr style="margin:2rem 0;border:0;border-top:2px solid #b8c6c9"><form><label>Forgotten code? Search participant name<input name="participant_name" autocomplete="off" maxlength="161" placeholder="Jamie Rivera"></label><button class="button secondary" type="button">Search by name</button></form><div class="notice"><strong>Final confirmation required.</strong> Pairing will show participant and duck together before an authenticated command changes race data.</div></section>`,
});

export const renderNotFound = (): string => page({
  title: "Not found",
  description: "The requested QuickDucks page was not found.",
  robots: "noindex,nofollow",
  content: `<section class="page-panel">${duck()}<p class="eyebrow">Wrong part of the pond</p><h1 class="page-title">Nothing is swimming here.</h1><p class="lede">Check the link or return to the QuickDucks home page.</p><a class="button" href="/">Go home</a></section>`,
});

export const manifestJson = JSON.stringify({
  name: "QuickDucks",
  short_name: "QuickDucks",
  start_url: "/",
  display: "standalone",
  background_color: "#fff7d6",
  theme_color: "#ffd43b",
  icons: [{ src: "/favicon.svg", sizes: "any", type: "image/svg+xml" }],
});

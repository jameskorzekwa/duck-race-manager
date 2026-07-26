import type { PublicRaceStatus } from "./race-status.ts";
import type { RegistrationStatusRecord } from "./types.ts";

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
[hidden] { display:none !important; }
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
.button:disabled { opacity:.55; box-shadow:none; cursor:not-allowed; transform:none; }
.hero-duck { --duck-center:0%; position:absolute; z-index:2; right:clamp(1rem,5vw,4rem); bottom:2.5rem; width:clamp(12rem,37vw,25rem); color:#fff; filter:drop-shadow(5px 7px 0 rgba(17,43,60,.22)); pointer-events:none; transform:translateX(var(--duck-center)) translateY(0) rotate(-4deg); }
.ticker { display:flex; flex-wrap:wrap; justify-content:center; gap:.2rem .7rem; padding:1.35rem 0; color:var(--water-dark); font-size:.8rem; font-weight:950; letter-spacing:.1em; text-transform:uppercase; }
.ticker span::after { content:"•"; margin-left:.7rem; color:var(--orange); }
.ticker span:last-child::after { content:""; margin:0; }
.cards { display:grid; gap:1rem; margin:2rem 0 4rem; }
.card { padding:1.4rem; border:3px solid var(--ink); border-radius:1.2rem; background:var(--paper); }
.card strong { display:block; margin-bottom:.35rem; color:var(--water-dark); font-size:.76rem; letter-spacing:.09em; text-transform:uppercase; }
.card-link { display:inline-block; margin-top:.7rem; font-weight:900; }
.status-section { margin:2rem 0 4rem; padding:clamp(1.2rem,4vw,2rem); border:3px solid var(--ink); border-radius:1.2rem; background:var(--paper); }
.status-section h2 { margin-bottom:.7rem; }
.duck-list { display:grid; gap:1rem; margin-top:1.2rem; }
.duck-card { padding:1rem; border:2px solid #b8c6c9; border-radius:.8rem; background:#fff; }
.duck-card h3 { margin-bottom:.55rem; }
.duck-card p { margin-bottom:.35rem; line-height:1.45; }
.search-form { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:.75rem; align-items:end; margin-top:1rem; }
.search-form .button { min-height:3.2rem; }
.search-message { margin:.9rem 0 0; }
.page-panel { max-width:49rem; margin:2rem auto 5rem; padding:clamp(1.2rem,5vw,3rem); border:3px solid var(--ink); border-radius:1.5rem; background:var(--paper); box-shadow:8px 8px 0 var(--ink); }
.page-panel > .duck-mark { float:right; width:8rem; color:var(--water-dark); }
.page-title { max-width:12ch; font-size:clamp(2.7rem,10vw,5.4rem); }
.muted { color:var(--muted); line-height:1.55; }
.notice { margin:1.2rem 0; padding:1rem; border-left:.5rem solid var(--orange); background:#fff0df; line-height:1.5; }
form { display:grid; gap:1.15rem; clear:both; }
.field-grid { display:grid; gap:1rem; }
label,legend { font-weight:900; }
label span,legend span { display:block; margin-top:.25rem; color:var(--muted); font-size:.86rem; font-weight:650; line-height:1.4; }
.label-text { display:inline; margin:0; color:var(--ink); font-size:inherit; font-weight:900; }
input,select { width:100%; min-height:3.2rem; margin-top:.45rem; padding:.7rem .8rem; border:2px solid var(--ink); border-radius:.65rem; background:#fff; color:var(--ink); font:inherit; }
input:focus,select:focus { outline:4px solid #83d8ec; outline-offset:1px; }
fieldset { margin:0; padding:1rem; border:2px solid #b8c6c9; border-radius:.8rem; }
.check { display:grid; grid-template-columns:1.4rem 1fr; gap:.7rem; align-items:start; font-weight:750; }
.check input { width:1.25rem; min-height:1.25rem; margin:.15rem 0 0; }
.turnstile-mock { display:grid; min-height:4.4rem; place-items:center; padding:.8rem; border:2px dashed #8da0a6; border-radius:.7rem; background:#f4f7f7; color:var(--muted); font-size:.82rem; font-weight:800; text-align:center; }
.error-text { color:#9f261c; font-weight:850; }
.field-error { min-height:1.2em; color:#9f261c; font-size:.8rem; font-weight:800; }
.staff-bar { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:.8rem; margin-bottom:1.2rem; padding:.8rem 1rem; border:2px solid var(--ink); border-radius:.8rem; background:#e4f4f8; }
.staff-bar p { margin:0; }
.result-list { display:grid; gap:.6rem; margin:.8rem 0; }
.result-button { width:100%; padding:.8rem; border:2px solid var(--ink); border-radius:.65rem; background:#fff; color:var(--ink); font:inherit; font-weight:850; text-align:left; cursor:pointer; }
.result-button:hover,.result-button:focus-visible { outline:4px solid #83d8ec; outline-offset:1px; }
.result-button:disabled { opacity:.55; cursor:not-allowed; }
.pairing-review { margin:1rem 0; padding:1rem; border:2px solid var(--water-dark); border-radius:.8rem; background:#e4f4f8; }
.code { display:inline-block; margin:.5rem 0; padding:.65rem .85rem; border:2px dashed var(--ink); border-radius:.6rem; background:var(--cream); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:clamp(1.4rem,7vw,2.4rem); font-weight:950; letter-spacing:.12em; }
.facts { display:grid; gap:.8rem; margin:1.5rem 0; }
.fact { padding:1rem; border:2px solid #b8c6c9; border-radius:.8rem; }
.fact dt { color:var(--muted); font-size:.75rem; font-weight:950; letter-spacing:.08em; text-transform:uppercase; }
.fact dd { margin:.25rem 0 0; font-size:1.08rem; font-weight:850; }
.privacy { display:flex; gap:.65rem; align-items:flex-start; padding:1rem; border-radius:.8rem; background:#e4f4f8; color:#245264; font-size:.9rem; line-height:1.5; }
.privacy strong { flex:none; }
.site-foot { padding:1rem 0 3rem; color:var(--muted); font-size:.85rem; text-align:center; }
@media (min-width:44rem) { .cards { grid-template-columns:repeat(3,1fr); } .field-grid { grid-template-columns:1fr 1fr; } }
@media (max-width:43.99rem) { .shell { width:min(100% - 1rem,40rem); } .nav a:first-child { display:none; } .hero { min-height:0; padding:1.5rem 1.5rem 15.5rem; border-radius:1.35rem; box-shadow:6px 6px 0 var(--ink); } .actions { position:relative; z-index:4; } .hero-duck { --duck-center:50%; right:50%; bottom:1rem; width:13.5rem; } .hero::after { height:11rem; } .hero::before { bottom:1.3rem; } .ticker { font-size:.7rem; } .page-panel > .duck-mark { width:5.7rem; } .privacy { display:block; } .privacy strong { display:block; margin-bottom:.25rem; } .search-form { grid-template-columns:1fr; } }
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
      <nav class="nav" aria-label="Primary"><a href="/">Home</a><a href="/register">Register</a><a href="/staff">Staff</a></nav>
    </header>
    <main class="shell">${content}</main>
    <footer class="shell site-foot">Built for quick check-ins, clear heats, and happy ducks.</footer>
  </body>
</html>`;

export const renderHome = (): string => page({
  title: "Race-day registration and results",
  description: "Register for the next QuickDucks race, check your heat, and follow race-day results.",
  content: `
    <section class="hero">
      <div class="hero-copy">
        <p class="eyebrow">Race-day, simplified</p>
        <h1>Find your duck. Follow the race.</h1>
        <p class="lede">A fast, friendly home for community duck races. Register, keep your private code, and follow your duck from check-in to finish.</p>
        <div class="actions"><a class="button" href="/register">Register</a><a class="button secondary" href="#how-it-works">How it works</a></div>
      </div>
      ${duck("hero-duck")}
    </section>
    <div class="ticker" aria-label="QuickDucks features"><span>Tap the tag</span><span>Find your heat</span><span>Cheer loudly</span></div>
    <section id="how-it-works" class="cards" aria-label="How QuickDucks works">
      <article class="card"><strong>Before the race</strong><h3>Register in under a minute</h3><p class="muted">You don’t need an account. Keep your private status link and short lookup code for race day.</p><a class="card-link" href="/register">Open registration →</a></article>
      <article class="card"><strong>At check-in</strong><h3>Staff pair your selected duck</h3><p class="muted">A staff member scans the duck, then enters your code or finds your registration by name.</p><a class="card-link" href="/staff">Open staff tools →</a></article>
      <article class="card"><strong>On race day</strong><h3>One clear source of truth</h3><p class="muted">You can follow heat assignments, finalist progress, and results from check-in to finish.</p><a class="card-link" href="/r/mock">Preview status →</a></article>
    </section>
    <section class="status-section" data-my-ducks hidden>
      <p class="eyebrow">Saved on this device</p>
      <h2>My ducks</h2>
      <p class="muted">Every registration made in this browser stays separate, even when participants share an email address or phone number.</p>
      <div class="privacy"><strong>Private by design.</strong><span>Email and phone are visible only to logged-in authorized race staff. They never appear here or in public status.</span></div>
      <div class="duck-list" data-my-ducks-list></div>
    </section>
    <section class="status-section" aria-labelledby="find-status-title">
      <p class="eyebrow">Lost your saved list?</p>
      <h2 id="find-status-title">Find race status by name</h2>
      <p class="muted">Enter an exact first name, last name, or full name. Results show race status only, never email, phone, private links, lookup codes, or staff data.</p>
      <form class="search-form" data-status-search>
        <label>Participant name<input name="name" autocomplete="name" minlength="2" maxlength="161" required></label>
        <button class="button" type="submit">Find status</button>
      </form>
      <p class="search-message muted" data-search-message aria-live="polite"></p>
      <div class="duck-list" data-search-results></div>
      <div class="privacy"><strong>Your data is temporary.</strong><span>After duck return processing, QuickDucks permanently deletes the complete race, including participant, duck, tag, result, and audit data.</span></div>
    </section>
    <script src="/assets/home.js" defer></script>`,
});

export const renderRegistration = (turnstileSiteKey?: string): string => page({
  title: "Register for the duck race",
  description: "Register a participant for the current QuickDucks race.",
  robots: "noindex,nofollow",
  content: `
    <section class="page-panel">
      ${duck()}
      <p class="eyebrow">Participant registration</p>
      <h1 class="page-title" data-event-name>Loading race details…</h1>
      <p class="lede" data-event-date>Registration takes about one minute.</p>
      <div class="privacy"><strong>Private by design.</strong><span>Your email and phone number are visible only to logged-in authorized race staff. They are never shown in public search or race status. After duck return processing, QuickDucks permanently deletes the complete race, including participant, duck, tag, result, and audit data.</span></div>
      <div class="notice"><strong>Registering more than one participant?</strong> Finish this form once for each person. You can use the same phone, email, or browser, and QuickDucks will keep their codes together on this device.</div>
      <form method="post" action="/api/v1/registrations" data-registration-form data-protection-ready="${turnstileSiteKey === undefined ? "false" : "true"}">
        <div class="field-grid">
          <label>First name<input name="first_name" autocomplete="given-name" maxlength="80" required placeholder="Jamie"><span class="field-error" data-field-error="first_name"></span></label>
          <label>Last name<input name="last_name" autocomplete="family-name" maxlength="80" required placeholder="Rivera"><span class="field-error" data-field-error="last_name"></span></label>
        </div>
        <div class="field-grid">
          <label><span class="label-text" data-email-label>Email (optional)</span><input name="email" type="email" autocomplete="email" maxlength="254" placeholder="jamie@example.com"><span>Used only for operational race updates.</span><span class="field-error" data-field-error="email"></span></label>
          <label>Phone (optional)<input name="phone" type="tel" autocomplete="tel" maxlength="32" placeholder="(555) 010-2040"><span class="field-error" data-field-error="phone"></span></label>
        </div>
        <label class="check"><input name="email_notifications_enabled" type="checkbox" checked><span>Get duck assignment, heat, and result updates by email. You can disable these later.</span></label>
        <label>After the race<select name="duck_keep_preference"><option value="UNDECIDED">I’m not sure yet</option><option value="RETURN">I plan to return the duck</option><option value="KEEP">I plan to keep the duck</option></select><span>This preference helps staff plan. Physical return processing remains authoritative.</span></label>
        ${turnstileSiteKey === undefined
          ? '<div class="turnstile-mock">Registration protection is still being configured.</div>'
          : `<div class="cf-turnstile" data-sitekey="${escapeHtml(turnstileSiteKey)}"></div><script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`}
        <p class="muted" data-form-message aria-live="polite">Loading registration availability…</p>
        <button class="button" type="submit" disabled>Register participant</button>
      </form>
      <script src="/assets/register.js" defer></script>
    </section>`,
});

export const renderStatus = (registration?: RegistrationStatusRecord): string => {
  const firstName = registration?.first_name ?? "Jamie";
  const lookupCode = registration?.lookup_code ?? "DUCK8234";
  const eventName = registration?.event_name ?? "Summer Duck Race";
  const registrationStatus = ({
    ACTIVE: "Active — duck assigned",
    WITHDRAWN: "Withdrawn",
    DISQUALIFIED: "Disqualified",
    SUBMITTED: "Submitted — waiting for duck assignment",
  } as Record<string, string>)[registration?.status ?? "SUBMITTED"] ?? "Status unavailable";
  const heading = registration?.status === "ACTIVE"
    ? `Your duck is assigned, ${firstName}.`
    : registration?.status === "WITHDRAWN"
      ? `Registration withdrawn, ${firstName}.`
      : registration?.status === "DISQUALIFIED"
        ? `Race status updated, ${firstName}.`
        : `You’re in the queue, ${firstName}.`;
  const raceDate = registration?.event_date
    ? new Intl.DateTimeFormat("en-US", { dateStyle: "full", timeZone: "UTC" })
      .format(new Date(`${registration.event_date}T12:00:00Z`))
    : "To be announced";
  return page({
  title: "Registration status",
  description: "Private QuickDucks participant registration status.",
  robots: "noindex,nofollow",
  content: `
    <section class="page-panel">
      ${duck()}
      <p class="eyebrow">Private registration status</p>
      <h1 class="page-title">${escapeHtml(heading)}</h1>
      <p class="lede">Keep this page private. This is your status link for ${escapeHtml(eventName)}.</p>
      <div class="notice"><strong>Staff lookup code</strong><br><span class="code">${escapeHtml(lookupCode)}</span><br><span class="muted">Save this code or bookmark this page.</span></div>
      <dl class="facts"><div class="fact"><dt>Status</dt><dd>${registrationStatus}</dd></div><div class="fact"><dt>Race date</dt><dd>${escapeHtml(raceDate)}</dd></div></dl>
      <p class="muted">You’ll see your duck and heat here after staff assigns them. Email and phone stay staff-only, and the complete race dataset is deleted after return processing.</p>
      <div class="actions"><a class="button" href="/register">Register another participant</a><a class="button secondary" href="/">Back to home</a></div>
    </section>`,
  });
};

const mockRaceStatus: PublicRaceStatus = {
  event: {
    id: "event_mock",
    slug: "summer-duck-race",
    name: "Summer Duck Race",
    eventDate: "2026-08-30",
    status: "ROUND_ONE",
  },
  participantDisplayName: "Jamie R.",
  duck: { visibleNumber: 128 },
  assignedHeat: {
    roundOne: { number: 7, status: "PLANNED" },
    final: null,
  },
  currentHeat: { round: "ROUND_ONE", number: 5, status: "RUNNING" },
  outcome: "NOT_RACED",
};

const roundLabel = (round: string): string => round === "FINAL" ? "Final" : "Round one";
const outcomeLabel = (outcome: string): string =>
  outcome.replaceAll("_", " ").toLowerCase().replace(/^./, (character) => character.toUpperCase());

const publicStatusFacts = (status: PublicRaceStatus): string => {
  const assignment = status.duck === null
    ? "Waiting for duck assignment"
    : `Duck #${status.duck.visibleNumber}`;
  const heat = status.assignedHeat.final ?? status.assignedHeat.roundOne;
  const heatLabel = heat === null
    ? "Heat not assigned yet"
    : `${status.assignedHeat.final === null ? "Round one" : "Final"} · Heat ${heat.number}`;
  const running = status.currentHeat === null
    ? "Racing has not started"
    : `${roundLabel(status.currentHeat.round)} · Heat ${status.currentHeat.number}`;
  return `<dl class="facts"><div class="fact"><dt>Participant</dt><dd>${escapeHtml(status.participantDisplayName)}</dd></div><div class="fact"><dt>Duck</dt><dd>${assignment}</dd></div><div class="fact"><dt>Assigned heat</dt><dd>${heatLabel}</dd></div><div class="fact"><dt>Currently running</dt><dd>${running}</dd></div><div class="fact"><dt>Race status</dt><dd>${outcomeLabel(status.outcome)}</dd></div></dl>`;
};

export const renderDuck = (status: PublicRaceStatus = mockRaceStatus): string => page({
  title: status.duck === null ? "Race status" : `Duck #${status.duck.visibleNumber}`,
  description: "Public QuickDucks NFC duck race status.",
  robots: "noindex,nofollow",
  content: `
    <section class="page-panel">
      ${duck()}
      <p class="eyebrow">Public race status</p>
      <h1 class="page-title">${status.duck === null ? "Waiting for a duck" : `Duck #${status.duck.visibleNumber}`}</h1>
      <p class="lede">Follow this duck through ${escapeHtml(status.event.name)}.</p>
      ${publicStatusFacts(status)}
      <div class="privacy"><strong>Public, not personal.</strong><span>This page shows race progress but never contact information, staff codes, or private links.</span></div>
      <br><a class="button secondary" href="/">Visit QuickDucks</a>
    </section>`,
});

export const renderStaffLogin = (returnTo = "/staff"): string => page({
  title: "Staff sign in",
  description: "Sign in to protected QuickDucks race operations.",
  robots: "noindex,nofollow",
  content: `
    <section class="page-panel">
      ${duck()}
      <p class="eyebrow">Protected race operations</p>
      <h1 class="page-title">Staff sign in</h1>
      <p class="lede">Use your invited QuickDucks staff email. Cognito will send a one-time sign-in code.</p>
      <div class="privacy"><strong>Authorized staff only.</strong><span>Participant email and phone are available only after Cognito verifies your account and QuickDucks finds a matching staff profile.</span></div>
      <br><a class="button" href="${escapeHtml(`/staff/login/start?returnTo=${encodeURIComponent(returnTo)}`)}">Continue to secure sign in</a>
      <a class="button secondary" href="/">Back to public site</a>
    </section>`,
});

export const renderStaffHome = (displayName: string, isSystemAdmin: boolean): string => page({
  title: "Staff tools",
  description: "Protected QuickDucks staff race operations.",
  robots: "noindex,nofollow",
  content: `
    <section class="page-panel">
      <div class="staff-bar"><p><strong>Signed in as ${escapeHtml(displayName)}</strong></p><a href="/staff/logout">Sign out</a></div>
      ${duck()}
      <p class="eyebrow">Staff tools</p>
      <h1 class="page-title">Scan the selected duck first.</h1>
      <p class="lede">Open the duck’s NFC or QR tag. QuickDucks will take you to pairing when it is available, or inspection when it is already assigned.</p>
      <div class="notice"><strong>Pairing order matters.</strong> Let the participant choose a physical duck, scan that duck, then find the participant by their short code or name.</div>
      <section data-return-review data-system-admin="${isSystemAdmin ? "true" : "false"}" hidden>
        <hr style="margin:2rem 0;border:0;border-top:2px solid #b8c6c9">
        <p class="eyebrow">Return review</p>
        <h2 data-return-title>Loading return review…</h2>
        <p class="lede" data-return-message aria-live="polite"></p>
        <dl class="facts" data-return-summary></dl>
        <form data-numbered-disposition-form hidden>
          <div class="field-grid">
            <label>Duck number<input name="visibleNumber" type="number" min="1" max="999999999" inputmode="numeric" required placeholder="128"></label>
            <label>Confirmed disposition
              <select name="disposition" required>
                <option value="" selected disabled>Choose confirmed outcome</option>
                <option value="RETURNED">Returned, good condition</option>
                <option value="QUARANTINED">Returned, needs tag or inspection</option>
                <option value="DAMAGED">Damaged</option>
                <option value="RETIRED">Retired</option>
                <option value="KEPT">Participant keeping duck</option>
                <option value="MISSING">Missing</option>
                <option value="UNACCOUNTED_FOR">Unaccounted for</option>
              </select>
            </label>
          </div>
          <button class="button secondary" type="submit">Record by duck number</button>
        </form>
        <form data-purge-ready-form hidden>
          <label class="check"><input type="checkbox" name="review" required><span class="label-text">I reviewed every physical duck disposition and exception.</span></label>
          <label class="check"><input type="checkbox" name="deletion" required><span class="label-text">I understand that purge permanently deletes all participant, race, duck, tag, command, and audit data.</span></label>
          <button class="button" type="submit">Mark event purge-ready</button>
        </form>
        <form data-cancel-purge-ready-form hidden>
          <label>Correction reason<input name="reason" minlength="4" maxlength="500" required placeholder="Describe what needs correction"></label>
          <button class="button secondary" type="submit">Reopen return processing</button>
        </form>
      </section>
      <a class="button secondary" href="/mock/staff/ducks/128/pair">Preview pairing layout</a>
      <script src="/assets/staff-home.js" defer></script>
    </section>`,
});

export const renderStaffDuck = (token: string, displayName: string): string => page({
  title: "Staff duck scan",
  description: "Protected QuickDucks duck pairing and inspection.",
  robots: "noindex,nofollow",
  content: `
    <section class="page-panel" data-staff-duck data-token="${escapeHtml(token)}">
      <div class="staff-bar"><p><strong>${escapeHtml(displayName)}</strong> · Staff scan</p><span><a href="/staff">Staff home</a> · <a href="/staff/logout">Sign out</a></span></div>
      <p class="eyebrow">Protected duck record</p>
      <h1 class="page-title" data-staff-title>Checking this duck…</h1>
      <p class="lede" data-staff-message aria-live="polite">Verifying tag, inventory, and assignment state.</p>
      <dl class="facts" data-duck-summary></dl>
      <section data-pairing-work hidden>
        <div class="privacy"><strong>Current event</strong><span data-pairing-event></span></div>
        <form method="post" action="/staff" data-registration-search>
          <label>Participant code or name<input name="query" autocomplete="off" minlength="2" maxlength="80" required placeholder="ABCD2345 or Jamie Rivera"></label>
          <button class="button secondary" type="submit">Find participant</button>
        </form>
        <div class="result-list" data-registration-results></div>
        <div class="pairing-review" data-pairing-review><p class="muted">Choose one registration to review.</p></div>
        <button class="button" type="button" data-confirm-pairing disabled>Confirm duck pairing</button>
      </section>
      <section data-disposition-work hidden>
        <div class="privacy"><strong>Physical return</strong><span data-disposition-event></span></div>
        <form data-disposition-form>
          <label>Confirmed disposition
            <select name="disposition" required>
              <option value="RETURNED">Returned, good condition</option>
              <option value="QUARANTINED">Returned, needs tag or inspection</option>
              <option value="DAMAGED">Damaged</option>
              <option value="RETIRED">Retired</option>
              <option value="KEPT">Participant keeping duck</option>
              <option value="MISSING">Missing</option>
              <option value="UNACCOUNTED_FOR">Unaccounted for</option>
            </select>
          </label>
          <button class="button" type="submit" data-confirm-disposition>Record physical disposition</button>
        </form>
        <p class="muted" data-disposition-message aria-live="polite"></p>
      </section>
      <script src="/assets/staff-duck.js" defer></script>
    </section>`,
});

export const renderStaffAuthError = (message: string): string => page({
  title: "Staff sign-in problem",
  description: "QuickDucks staff authentication could not be completed.",
  robots: "noindex,nofollow",
  content: `<section class="page-panel">${duck()}<p class="eyebrow">Sign-in problem</p><h1 class="page-title">We couldn’t finish signing you in.</h1><div class="notice">${escapeHtml(message)}</div><a class="button" href="/staff">Try staff sign in again</a><a class="button secondary" href="/">Back to public site</a></section>`,
});

export const renderStaffPairing = (): string => page({
  title: "Pair Duck #128",
  description: "Protected staff duck-pairing mockup.",
  robots: "noindex,nofollow",
  content: `<section class="page-panel"><p class="eyebrow">Protected staff preview</p><h1 class="page-title">Pair Duck #128</h1><p class="lede">This duck is available. Find the participant before confirming the assignment.</p><div class="privacy"><strong>Staff authentication required.</strong><span>Live scans verify the Cognito session and matching staff profile before showing codes or accepting a pairing command.</span></div><div class="facts"><div class="fact"><dt>Duck</dt><dd>#128 · Available</dd></div><div class="fact"><dt>Event</dt><dd>Summer Duck Race</dd></div></div><form><label>Participant duck code<input name="lookup_code" autocomplete="off" maxlength="16" placeholder="ABCD2345"></label><button class="button" type="button">Find participant by code</button></form><hr style="margin:2rem 0;border:0;border-top:2px solid #b8c6c9"><form><label>Forgotten code? Search participant name<input name="participant_name" autocomplete="off" maxlength="161" placeholder="Jamie Rivera"></label><button class="button secondary" type="button">Search by name</button></form><div class="notice"><strong>Final confirmation required.</strong> Pairing shows participant and duck together before an authenticated command changes race data.</div></section>`,
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

export const homeScript = String.raw`
const createText = (tag, text, className) => {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
};

const describeStatus = (status) => {
  if (!status) return "Race status is not currently public.";
  const parts = [];
  if (status.duck) parts.push("Duck #" + status.duck.visibleNumber);
  if (status.assignedHeat.roundOne) parts.push("Heat " + status.assignedHeat.roundOne.number);
  else if (status.duck) parts.push("Heat assignment pending");
  parts.push(status.outcome.replaceAll("_", " ").toLowerCase());
  return parts.join(" · ");
};

const appendStatusCard = (container, title, status, lookupCode) => {
  const card = createText("article", "", "duck-card");
  card.append(createText("h3", title));
  if (lookupCode) card.append(createText("p", "Staff lookup code: " + lookupCode));
  card.append(createText("p", describeStatus(status), "muted"));
  if (status && status.currentHeat) {
    card.append(createText("p", "Currently running: " + status.currentHeat.round.replaceAll("_", " ").toLowerCase() + " heat " + status.currentHeat.number, "muted"));
  }
  container.append(card);
};

const myDucks = document.querySelector("[data-my-ducks]");
const myDucksList = document.querySelector("[data-my-ducks-list]");
fetch("/api/v1/registrations/mine", { headers: { accept: "application/json" } })
  .then((response) => response.ok ? response.json() : Promise.reject())
  .then(({ registrations }) => {
    if (!Array.isArray(registrations) || registrations.length === 0) return;
    for (const registration of registrations) {
      appendStatusCard(
        myDucksList,
        registration.firstName + " " + registration.lastName,
        registration.raceStatus,
        registration.lookupCode,
      );
    }
    myDucks.hidden = false;
  })
  .catch(() => {});

const searchForm = document.querySelector("[data-status-search]");
const searchMessage = document.querySelector("[data-search-message]");
const searchResults = document.querySelector("[data-search-results]");
searchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  searchResults.replaceChildren();
  searchMessage.textContent = "Searching…";
  const name = new FormData(searchForm).get("name");
  try {
    const eventResponse = await fetch("/api/v1/events/current", { headers: { accept: "application/json" } });
    if (!eventResponse.ok) throw new Error();
    const { event: currentEvent } = await eventResponse.json();
    if (!currentEvent) {
      searchMessage.textContent = "There is no public race to search right now.";
      return;
    }
    const parameters = new URLSearchParams({ eventId: currentEvent.id, name: String(name) });
    const response = await fetch("/api/v1/race-status/search?" + parameters, { headers: { accept: "application/json" } });
    if (response.status === 429) {
      searchMessage.textContent = "Too many searches. Please wait and try again.";
      return;
    }
    if (!response.ok) throw new Error();
    const { results } = await response.json();
    if (!Array.isArray(results) || results.length === 0) {
      searchMessage.textContent = "No matching public race status was found.";
      return;
    }
    for (const result of results) appendStatusCard(searchResults, result.participantDisplayName, result, null);
    searchMessage.textContent = results.length === 1 ? "1 match found." : results.length + " matches found.";
  } catch {
    searchMessage.textContent = "Status search is temporarily unavailable. Please try again.";
  }
});
`;

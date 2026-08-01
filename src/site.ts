import { operationalRoles, type OperationalRole } from "./authorization.ts";
import { localPreviewTurnstileToken } from "./local-preview.ts";
import { renderParticipantQrSvg } from "./participant-qr.ts";
import {
  homePhaseCta,
  phaseAllowsRaceStatus,
  phaseAllowsRegistration,
  phaseShowsMyDucks,
  phaseShowsRaceStatusNav,
  phaseShowsRegisterNav,
  registrationClosedMessage,
  registrationPreparingMessage,
  type PublicPhase,
  type PublicPhaseCta,
} from "./public-phase.ts";
import {
  publicHeatStatusLabel,
  publicOfficialResult,
  type PublicFollowState,
  type PublicRaceStatus,
} from "./race-status.ts";
import { DUCK_NAME_MAX_LENGTH } from "./registration.ts";
import type { RegistrationStatusRecord } from "./types.ts";

export const escapeHtml = (value: string): string =>
  value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character] ?? character);

const duck = (className = "duck-mark"): string => `
<svg class="${className}" viewBox="0 0 96 76" role="img" aria-label="Rubber duck">
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
:root { color-scheme: light; --ink:#112b3c; --cream:#fff7d6; --paper:#fffdf3; --yellow:#ffd43b; --orange:#ff7132; --water:#3294b0; --water-dark:#146780; --muted:#607078; --space-xs:.45rem; --space-sm:.75rem; --space-md:1rem; --space-lg:1.4rem; font-family:ui-rounded,"Avenir Next Rounded","Arial Rounded MT Bold",system-ui,sans-serif; letter-spacing:.005em; }
* { box-sizing:border-box; }
[hidden] { display:none !important; }
html { scroll-behavior:smooth; }
body { margin:0; min-height:100vh; background:var(--cream); color:var(--ink); overflow-wrap:anywhere; }
a { color:inherit; }
.shell { width:min(70rem,calc(100% - 2rem)); margin:0 auto; }
.site-head { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:1rem; padding:1rem 0; }
.brand { display:inline-flex; align-items:center; gap:.55rem; color:var(--ink); text-decoration:none; font-size:1.12rem; font-weight:950; letter-spacing:.005em; }
.brand svg { width:3rem; height:2.35rem; color:var(--water-dark); }
.nav { display:flex; gap:.35rem; }
.nav a { padding:.7rem .9rem; border:2px solid transparent; border-radius:999px; font-weight:850; text-decoration:none; }
.nav a:hover,.nav a:focus-visible { border-color:var(--ink); outline:none; }
.hero { position:relative; overflow:hidden; display:grid; align-items:center; min-height:34rem; padding:clamp(2rem,6vw,5rem); padding-bottom:13.5rem; border:3px solid var(--ink); border-radius:2rem; background:var(--paper); box-shadow:9px 9px 0 var(--ink); }
.hero-water { --wave-length:10rem; position:absolute; z-index:1; right:-2px; bottom:-1px; left:-2px; width:calc(100% + 4px); height:10.5rem; overflow:hidden; pointer-events:none; }
.hero-water::before { content:""; position:absolute; top:0; right:0; left:0; height:3rem; background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='48' viewBox='0 0 160 48'%3E%3Cpath fill='%233294b0' d='M0 24 C20 0 60 0 80 24 S140 48 160 24 V48 H0 Z'/%3E%3C/svg%3E"); background-position:0 0; background-repeat:repeat-x; background-size:var(--wave-length) 3rem; }
.hero-water::after { content:""; position:absolute; top:calc(3rem - 1px); right:0; bottom:0; left:0; background:var(--water); }
.hero-copy { position:relative; z-index:3; max-width:60rem; }
.eyebrow { display:inline-flex; margin:0 0 1rem; padding:.48rem .78rem; border:2px solid var(--ink); border-radius:999px; background:var(--yellow); font-size:.8rem; font-weight:950; letter-spacing:.09em; text-transform:uppercase; }
h1,h2,h3,p { margin-top:0; }
h1 { margin-bottom:1.15rem; font-size:clamp(3.2rem,9.4vw,6.75rem); line-height:.82; letter-spacing:.005em; }
.hero h1 > span { white-space:nowrap; }
h2 { font-size:clamp(2rem,6vw,3.7rem); line-height:.95; letter-spacing:.005em; }
h3 { font-size:1.3rem; letter-spacing:.005em; }
.lede { max-width:38rem; margin-bottom:1.5rem; color:#314a57; font-size:clamp(1.05rem,2.5vw,1.35rem); line-height:1.55; }
.actions { display:flex; flex-wrap:wrap; gap:.8rem; }
.actions > * { min-width:0; max-width:100%; }
button { min-width:0; max-width:100%; overflow-wrap:anywhere; white-space:normal; }
.button { display:inline-flex; min-width:0; max-width:100%; min-height:3.25rem; align-items:center; justify-content:center; padding:.85rem 1.15rem; border:3px solid var(--ink); border-radius:.8rem; background:var(--yellow); box-shadow:4px 4px 0 var(--ink); color:var(--ink); font:inherit; font-weight:950; overflow-wrap:anywhere; text-align:center; text-decoration:none; white-space:normal; cursor:pointer; }
.button:hover,.button:focus-visible { outline:none; box-shadow:2px 2px 0 var(--ink); transform:translate(2px,2px); }
.button.secondary { background:var(--paper); }
.button.danger { background:#ffd8d2; }
.button.small { min-height:2.55rem; padding:.55rem .75rem; border-width:2px; box-shadow:2px 2px 0 var(--ink); font-size:.88rem; }
.button:active:not(:disabled) { box-shadow:none; filter:brightness(.92); transform:translate(4px,4px); }
.button.small:active:not(:disabled) { transform:translate(2px,2px); }
.button:disabled { opacity:.55; box-shadow:none; cursor:not-allowed; transform:none; }
.app-confirmation-backdrop { position:fixed; z-index:99; inset:0; background:rgba(17,43,60,.68); }
.app-confirmation { width:min(34rem,calc(100% - 2rem)); max-height:calc(100vh - 2rem); padding:clamp(1.2rem,4vw,2rem); overflow:auto; border:3px solid var(--ink); border-radius:1.2rem; background:var(--paper); box-shadow:8px 8px 0 var(--ink); color:var(--ink); }
.app-confirmation::backdrop { background:rgba(17,43,60,.68); }
.app-confirmation.fallback { position:fixed; z-index:100; top:50%; left:50%; margin:0; transform:translate(-50%,-50%); }
.app-confirmation h2 { margin-bottom:.75rem; font-size:clamp(1.8rem,6vw,2.5rem); }
.app-confirmation-message { margin-bottom:1.5rem; overflow-wrap:anywhere; line-height:1.55; white-space:pre-wrap; }
.app-confirmation-actions { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:.8rem; }
.hero-duck-scene { --duck-center:0%; position:absolute; z-index:2; right:clamp(1rem,5vw,4rem); bottom:2.5rem; width:clamp(12rem,37vw,25rem); pointer-events:none; transform:translateX(var(--duck-center)); }
.hero-duck { --duck-lift:0px; position:relative; z-index:1; display:block; width:100%; filter:drop-shadow(5px 7px 0 rgba(17,43,60,.22)); transform:translateY(var(--duck-lift)); }
.hero-duck-slit { position:absolute; z-index:2; right:8%; bottom:0; left:8%; height:2.75rem; background:var(--water); }
.hero-duck-slit::before { content:""; position:absolute; top:-.38rem; right:0; left:0; height:1.05rem; border-radius:50%; background:var(--water); }
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
.duck-card > .actions { margin-top:.75rem; }
.page-panel.my-ducks-panel { max-width:70rem; }
.participant-section { margin:2rem 0; padding-top:1.5rem; border-top:3px solid var(--ink); }
.participant-section-head { display:flex; flex-wrap:wrap; align-items:end; justify-content:space-between; gap:.8rem; margin-bottom:.8rem; }
.participant-section-head h2 { min-width:0; margin:0; overflow-wrap:anywhere; }
.participant-section-head-actions { display:flex; flex:1 1 auto; flex-wrap:wrap; align-items:center; justify-content:flex-end; gap:.55rem; min-width:0; }
.participant-section-head-actions > .button { flex:0 1 auto; }
.carousel-controls { display:flex; flex-wrap:wrap; gap:.55rem; min-width:0; }
.participant-track { position:relative; display:flex; gap:1rem; padding:.25rem .25rem 1rem; overflow-x:auto; overscroll-behavior-inline:contain; scroll-padding-inline:.25rem; scroll-snap-type:x mandatory; scrollbar-color:var(--water-dark) #dce9e9; }
.participant-track:focus-visible { border-radius:.8rem; outline:4px solid #83d8ec; outline-offset:2px; }
.participant-card { flex:0 0 min(30rem,calc(100% - 3rem)); min-width:0; scroll-snap-align:start; scroll-snap-stop:always; }
.participant-card:focus-visible { outline:4px solid #83d8ec; outline-offset:2px; }
.success-tag { display:inline-block; margin-bottom:.65rem; padding:.3rem .55rem; border:2px solid var(--ink); border-radius:999px; background:var(--yellow); font-size:.75rem; font-weight:950; letter-spacing:.06em; text-transform:uppercase; }
.search-form { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:.75rem; align-items:end; margin-top:1rem; }
.search-form .button { min-height:3.2rem; }
.search-message { margin:.9rem 0 0; }
.my-ducks-search > .privacy { margin-top:1.5rem; }
.page-panel { max-width:49rem; margin:2rem auto 5rem; padding:clamp(1.2rem,5vw,3rem); border:3px solid var(--ink); border-radius:1.5rem; background:var(--paper); box-shadow:8px 8px 0 var(--ink); }
.page-panel > .duck-mark { float:right; width:8rem; color:var(--water-dark); }
.page-title { max-width:12ch; font-size:clamp(2.7rem,10vw,5.4rem); }
.muted { color:var(--muted); line-height:1.55; }
.notice { margin:1.2rem 0; padding:1rem; border-left:.5rem solid var(--orange); background:#fff0df; line-height:1.5; }
.lookup-code-notice { display:flex; flex-wrap:wrap; gap:1rem; align-items:center; }
.lookup-code-detail { flex:1 1 14rem; min-width:0; }
.lookup-code-qr { flex:0 0 auto; padding:.5rem; border:2px solid var(--ink); border-radius:.65rem; background:#fff; }
.participant-qr { display:block; width:clamp(8rem,38vw,10.5rem); height:auto; }
.participant-card > .lookup-code-qr { width:max-content; max-width:100%; margin:.15rem auto .5rem; }
.participant-card > .lookup-code-qr .participant-qr { width:clamp(7rem,28vw,9rem); }
.qr-scanner { display:grid; gap:.75rem; margin-top:1rem; padding:1rem; border:2px solid var(--ink); border-radius:.9rem; background:#fff; }
.qr-scanner[hidden] { display:none; }
.qr-video { width:100%; max-width:26rem; min-width:0; margin:0 auto; aspect-ratio:1; border-radius:.65rem; background:var(--ink); object-fit:cover; }
.qr-scanner .actions { margin:0; }
form { display:grid; width:100%; min-width:0; max-width:100%; gap:1.15rem; clear:both; }
.field-grid { display:grid; min-width:0; max-width:100%; gap:1rem; }
.field-grid > *,form > *,label,fieldset { min-width:0; max-width:100%; }
label,legend { font-weight:900; }
label span,legend span { display:block; margin-top:.25rem; color:var(--muted); font-size:.86rem; font-weight:650; line-height:1.4; }
.label-text { display:inline; margin:0; color:var(--ink); font-size:inherit; font-weight:900; }
input,select,textarea { width:100%; min-width:0; max-width:100%; min-height:3.2rem; margin-top:.45rem; padding:.7rem .8rem; border:2px solid var(--ink); border-radius:.65rem; background:#fff; color:var(--ink); font:inherit; }
textarea { min-height:6rem; resize:vertical; }
input:focus,select:focus,textarea:focus { outline:4px solid #83d8ec; outline-offset:1px; }
input[type="number"] { appearance:textfield; }
input[type="number"]::-webkit-inner-spin-button,input[type="number"]::-webkit-outer-spin-button { margin:0; appearance:none; }
.app-select { position:relative; display:block; min-width:0; max-width:100%; margin-top:.45rem; }
select.app-select-native { position:absolute; width:1px; height:1px; min-height:0; margin:0; padding:0; border:0; clip-path:inset(50%); opacity:0; overflow:hidden; pointer-events:none; }
.app-select-trigger { display:flex; width:100%; min-width:0; max-width:100%; min-height:3.2rem; align-items:center; justify-content:space-between; gap:.6rem; margin:0; padding:.7rem .8rem; border:2px solid var(--ink); border-radius:.65rem; background:#fff; color:var(--ink); font:inherit; font-weight:750; text-align:left; cursor:pointer; }
.app-select-trigger:focus-visible { outline:4px solid #83d8ec; outline-offset:1px; }
.app-select-trigger[aria-expanded="true"] { background:var(--cream); }
.app-select-trigger:disabled { opacity:.55; cursor:not-allowed; }
.app-select-value { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.app-select-arrow { flex:none; width:.8rem; height:.5rem; background:var(--ink); clip-path:polygon(0 0,100% 0,50% 100%); }
.app-select-trigger[aria-expanded="true"] .app-select-arrow { transform:rotate(180deg); }
.app-select-panel { position:absolute; z-index:60; top:calc(100% + .35rem); right:0; left:0; max-height:16rem; padding:.35rem; overflow:auto; overscroll-behavior:contain; border:3px solid var(--ink); border-radius:.8rem; background:var(--paper); box-shadow:4px 4px 0 var(--ink); }
.app-select-search { position:sticky; z-index:1; top:0; margin:-.35rem -.35rem .25rem; padding:.35rem; background:var(--paper); }
.app-select-search-input { display:block; width:100%; min-width:0; max-width:100%; min-height:2.75rem; margin:0; padding:.55rem .65rem; border:2px solid var(--ink); border-radius:.5rem; background:#fff; color:var(--ink); font:inherit; font-weight:750; }
.app-select-search-input:focus-visible { outline:4px solid #83d8ec; outline-offset:1px; }
.app-select-empty { margin:0; padding:.55rem .65rem; color:var(--muted); font-weight:750; overflow-wrap:anywhere; }
.app-select-option { display:flex; min-height:2.75rem; align-items:center; padding:.55rem .65rem; border-radius:.5rem; font-weight:750; overflow-wrap:anywhere; cursor:pointer; }
.app-select-option[aria-selected="true"] { background:var(--yellow); font-weight:900; }
.app-select-option.is-highlighted { outline:3px solid var(--water-dark); outline-offset:-3px; }
.app-select-option:hover { background:var(--cream); }
.app-select-option[aria-selected="true"]:hover { background:var(--yellow); }
.app-select-option[aria-disabled="true"] { color:var(--muted); cursor:not-allowed; }
.staff-role-controls > .app-select { flex:1 1 100%; margin-top:0; }
.app-date-picker { position:relative; display:block; min-width:0; max-width:100%; margin-top:.45rem; }
input.app-date-native { position:absolute; width:1px; height:1px; min-height:0; margin:0; padding:0; border:0; clip-path:inset(50%); opacity:0; overflow:hidden; pointer-events:none; }
.app-date-trigger { display:flex; width:100%; min-width:0; max-width:100%; min-height:3.2rem; align-items:center; justify-content:space-between; gap:.6rem; margin:0; padding:.7rem .8rem; border:2px solid var(--ink); border-radius:.65rem; background:#fff; color:var(--ink); font:inherit; font-weight:750; text-align:left; cursor:pointer; }
.app-date-trigger:focus-visible { outline:4px solid #83d8ec; outline-offset:1px; }
.app-date-trigger[aria-expanded="true"] { background:var(--cream); }
.app-date-trigger:disabled { opacity:.55; cursor:not-allowed; }
.app-date-value { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.app-date-icon { position:relative; flex:none; width:1rem; height:.9rem; border:2px solid var(--ink); border-radius:.18rem; }
.app-date-icon::before { content:""; position:absolute; top:-.35rem; left:.12rem; width:.15rem; height:.42rem; border-right:2px solid var(--ink); border-left:2px solid var(--ink); }
.app-date-icon::after { content:""; position:absolute; top:.18rem; right:0; left:0; border-top:2px solid var(--ink); }
.app-date-panel { position:absolute; z-index:70; top:calc(100% + .35rem); left:0; width:min(24rem,calc(100vw - 2rem)); max-height:min(34rem,calc(100vh - 2rem)); padding:var(--space-md); overflow:auto; overscroll-behavior:contain; border:3px solid var(--ink); border-radius:.9rem; background:var(--paper); box-shadow:5px 5px 0 var(--ink); }
.app-date-header { display:grid; grid-template-columns:2.75rem minmax(0,1fr) 2.75rem; gap:var(--space-sm); align-items:center; }
.app-date-heading { margin:0; font-size:1.12rem; text-align:center; }
.app-date-month-button { display:grid; width:2.75rem; min-height:2.75rem; place-items:center; padding:0; border:2px solid var(--ink); border-radius:.55rem; background:#fff; color:var(--ink); font:inherit; font-size:1.25rem; font-weight:950; cursor:pointer; }
.app-date-month-button:hover,.app-date-month-button:focus-visible { background:var(--yellow); outline:3px solid #83d8ec; outline-offset:1px; }
.app-date-weekdays,.app-date-grid { display:grid; grid-template-columns:repeat(7,minmax(0,1fr)); gap:.25rem; }
.app-date-weekdays { margin-top:var(--space-sm); color:var(--muted); font-size:.72rem; font-weight:950; text-align:center; text-transform:uppercase; }
.app-date-weekday { padding:.3rem 0; }
.app-date-grid { margin-top:.15rem; }
.app-date-day,.app-date-blank { min-width:0; min-height:2.6rem; }
.app-date-day { display:grid; place-items:center; padding:.25rem; border:2px solid transparent; border-radius:.5rem; background:transparent; color:var(--ink); font:inherit; font-weight:850; cursor:pointer; }
.app-date-day:hover,.app-date-day:focus-visible { border-color:var(--ink); background:var(--cream); outline:none; }
.app-date-day.is-today { border-color:var(--water-dark); }
.app-date-day[aria-pressed="true"] { border-color:var(--ink); background:var(--yellow); box-shadow:2px 2px 0 var(--ink); }
.app-date-time { margin-top:var(--space-md); padding-top:var(--space-md); border-top:2px solid #b8c6c9; }
.app-date-time-fields { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr) minmax(0,1fr); gap:var(--space-sm); margin-top:var(--space-xs); }
.app-date-time-field { min-width:0; }
.app-date-time-field > span { display:block; color:var(--muted); font-size:.72rem; font-weight:950; letter-spacing:.05em; text-transform:uppercase; }
.app-date-time-field .app-select { margin-top:.25rem; }
.app-date-actions { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:var(--space-sm); margin-top:var(--space-md); padding-top:var(--space-md); border-top:2px solid #b8c6c9; }
.app-date-actions .button { flex:1 1 7rem; }
fieldset { margin:0; padding:1rem; border:2px solid #b8c6c9; border-radius:.8rem; }
.check { display:grid; grid-template-columns:1.4rem minmax(0,1fr); gap:.7rem; align-items:start; font-weight:750; }
.check input[type="checkbox"] { display:grid; width:1.4rem; height:1.4rem; min-height:1.4rem; place-content:center; margin:.05rem 0 0; padding:0; appearance:none; border:2px solid var(--ink); border-radius:.3rem; background:#fff; color:var(--ink); cursor:pointer; }
.check input[type="checkbox"]::before { content:""; width:.7rem; height:.38rem; border-bottom:3px solid currentColor; border-left:3px solid currentColor; transform:translateY(-.08rem) rotate(-45deg) scale(0); transform-origin:center; }
.check input[type="checkbox"]:checked { background:var(--yellow); }
.check input[type="checkbox"]:checked::before { transform:translateY(-.08rem) rotate(-45deg) scale(1); }
.check input[type="checkbox"]:focus-visible { outline:4px solid #83d8ec; outline-offset:2px; }
.check input[type="checkbox"]:disabled { opacity:.5; cursor:not-allowed; }
.cf-turnstile,.turnstile-mock { width:100%; min-width:0; max-width:100%; }
.turnstile-mock { display:grid; min-height:4.4rem; place-items:center; padding:.8rem; border:2px dashed #8da0a6; border-radius:.7rem; background:#f4f7f7; color:var(--muted); font-size:.82rem; font-weight:800; text-align:center; }
.error-text { color:#9f261c; font-weight:850; }
.field-error { min-height:1.2em; color:#9f261c; font-size:.8rem; font-weight:800; }
.staff-bar { display:flex; flex-wrap:wrap; width:100%; min-width:0; max-width:100%; align-items:center; justify-content:space-between; gap:var(--space-sm); margin:var(--space-lg) 0 0; padding:.8rem 1rem; border:2px solid var(--ink); border-radius:.8rem; background:#e4f4f8; }
.staff-bar > * { min-width:0; max-width:100%; }
.staff-bar p { min-width:0; margin:0; overflow-wrap:anywhere; }
.staff-logout { display:inline; clear:none; }
.staff-logout button { display:inline-flex; min-height:2.75rem; align-items:center; padding:var(--space-xs); border:0; background:transparent; color:inherit; font:inherit; overflow-wrap:anywhere; text-decoration:underline; cursor:pointer; }
.staff-logout button:hover,.staff-logout button:focus-visible { border-radius:.2rem; outline:2px solid var(--ink); outline-offset:2px; }
.result-list { display:grid; gap:.6rem; margin:.8rem 0; }
.result-list:empty { display:none; }
.result-button { width:100%; padding:.8rem; border:2px solid var(--ink); border-radius:.65rem; background:#fff; color:var(--ink); font:inherit; font-weight:850; overflow-wrap:anywhere; text-align:left; cursor:pointer; }
.result-button > * { display:block; }
.result-button > * + * { margin-top:var(--space-xs); }
.result-button:hover,.result-button:focus-visible { outline:4px solid #83d8ec; outline-offset:1px; }
.result-button:active:not(:disabled) { background:#e4f4f8; filter:brightness(.97); transform:translate(1px,1px); }
.result-button:disabled { opacity:.55; cursor:not-allowed; }
.result-button.is-selected { border-color:var(--water-dark); background:var(--cream); box-shadow:inset .35rem 0 0 var(--water-dark); }
.pairing-review { margin:1rem 0; padding:1rem; border:2px solid var(--water-dark); border-radius:.8rem; background:#e4f4f8; }
.pairing-review > * { margin-bottom:0; overflow-wrap:anywhere; }
.pairing-review > * + * { margin-top:var(--space-xs); }
.pairing-confirmation { scroll-margin-block:1rem; }
.pairing-confirmation:focus-visible { border-radius:.9rem; outline:4px solid #83d8ec; outline-offset:.35rem; }
.work-area { margin-top:var(--space-lg); }
.work-area > * { margin-bottom:0; }
.work-area > * + * { margin-top:var(--space-md); }
.work-area > .result-list,.work-area > .pairing-review { margin-bottom:0; }
.staff-access-list { display:grid; gap:.75rem; margin-top:1rem; }
.staff-access-card { display:flex; flex-wrap:wrap; align-items:flex-start; justify-content:space-between; gap:var(--space-md); padding:var(--space-md); border:2px solid #b8c6c9; border-radius:.8rem; background:#fff; }
.staff-access-card > * { min-width:0; max-width:100%; }
.staff-access-card > div:first-child { min-width:0; flex:1 1 14rem; }
.staff-access-card p { margin:0; overflow-wrap:anywhere; }
.staff-role-controls { flex:1 0 100%; align-items:flex-end; gap:var(--space-sm); padding-top:var(--space-xs); }
.staff-role-controls > select,.staff-role-controls > fieldset { min-width:0; flex:1 1 100%; margin-top:0; }
.role-set { display:grid; grid-template-columns:repeat(auto-fit,minmax(10rem,1fr)); gap:var(--space-xs) var(--space-md); }
.role-set > legend { grid-column:1 / -1; }
.role-set > .check { min-height:2rem; align-items:center; }
.role-tag { max-width:100%; align-self:flex-start; padding:.3rem .55rem; border:2px solid var(--ink); border-radius:.7rem; background:var(--cream); font-size:.75rem; font-weight:950; letter-spacing:.06em; line-height:1.35; overflow-wrap:anywhere; text-transform:uppercase; }
.code { display:inline-block; margin:.5rem 0; padding:.65rem .85rem; border:2px dashed var(--ink); border-radius:.6rem; background:var(--cream); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:clamp(1.4rem,7vw,2.4rem); font-weight:950; letter-spacing:.12em; }
.facts { display:grid; gap:.8rem; margin:1.5rem 0; }
.facts:empty { display:none; }
.fact { padding:1rem; border:2px solid #b8c6c9; border-radius:.8rem; }
.fact dt { color:var(--muted); font-size:.75rem; font-weight:950; letter-spacing:.08em; text-transform:uppercase; }
.fact dd { margin:.25rem 0 0; font-size:1.08rem; font-weight:850; }
.duck-number-link { color:var(--water-dark); font-weight:950; text-decoration:underline; text-underline-offset:.2em; }
.duck-number-link:hover { text-decoration-thickness:.18em; }
.duck-number-link:focus-visible { outline:4px solid #83d8ec; outline-offset:2px; }
.duck-number-note { display:block; margin-top:.2rem; color:var(--muted); font-size:.8rem; font-weight:800; letter-spacing:.04em; }
.duck-name-note { color:var(--water-dark); font-weight:850; }
.duck-name-toggle { display:flex; width:max-content; margin-top:.7rem; font-size:.85rem; }
.duck-name-form { gap:.6rem; margin-top:.9rem; padding-top:.9rem; border-top:2px dashed #b8c6c9; font-size:.95rem; font-weight:750; }
.duck-name-form .actions { gap:.5rem; }
.duck-name-form .message-line { margin:0; }
.participant-contact { display:grid; gap:.65rem; margin-top:1rem; padding:1rem; border:2px solid var(--water-dark); border-radius:.8rem; background:#f4fbfd; }
.participant-contact > * { min-width:0; max-width:100%; }
.participant-contact-summary { display:grid; gap:.35rem; }
.participant-contact-summary > * { margin:0; overflow-wrap:anywhere; }
.participant-contact-line { line-height:1.45; }
.participant-contact-form { gap:.8rem; padding-top:.25rem; }
.participant-contact-form .actions { gap:.5rem; }
.participant-contact-form .message-line { margin:0; }
.page-panel > .actions[data-duck-follow] { margin:1.2rem 0; }
.privacy { display:flex; gap:.65rem; align-items:flex-start; padding:1rem; border-radius:.8rem; background:#e4f4f8; color:#245264; font-size:.9rem; line-height:1.5; }
.privacy strong { flex:none; }
.page-panel > .privacy + .actions { margin-top:1rem; }
.operations-panel,.station-panel { max-width:70rem; padding:clamp(1rem,3vw,2.2rem); background:var(--paper); }
.operations-title,.staff-panel > .page-title { max-width:none; margin-bottom:.6rem; font-size:clamp(2.5rem,8vw,5rem); line-height:.92; }
.console-nav { position:sticky; z-index:5; top:.5rem; display:flex; gap:.45rem; margin:1.3rem 0; padding:.65rem; overflow-x:auto; border:2px solid var(--ink); border-radius:.9rem; background:var(--cream); box-shadow:3px 3px 0 var(--ink); }
.console-nav a { flex:none; padding:.55rem .7rem; border-radius:.55rem; font-size:.85rem; font-weight:900; text-decoration:none; }
.console-nav a:hover,.console-nav a:focus-visible { background:var(--yellow); outline:2px solid var(--ink); }
.console-nav a[aria-current="page"] { background:var(--yellow); box-shadow:2px 2px 0 var(--ink); }
.staff-steps { display:grid; gap:.55rem; margin:0; padding-left:1.35rem; line-height:1.5; }
.staff-steps li { min-width:0; font-weight:750; overflow-wrap:anywhere; }
.participant-action-note { flex:1 1 100%; min-width:0; margin:0; line-height:1.5; }
.staff-nav { display:flex; flex-wrap:wrap; gap:.45rem; max-width:100%; margin:0 0 1.2rem; padding:.55rem; border:2px solid var(--ink); border-radius:.9rem; background:var(--cream); box-shadow:3px 3px 0 var(--ink); }
.staff-nav a { display:inline-flex; min-width:0; max-width:100%; min-height:2.75rem; align-items:center; padding:.5rem .7rem; border-radius:.55rem; font-size:.85rem; font-weight:900; overflow-wrap:anywhere; text-decoration:none; }
.staff-nav a:hover,.staff-nav a:focus-visible { background:var(--yellow); outline:2px solid var(--ink); }
.staff-nav a[aria-current="page"] { background:var(--yellow); box-shadow:2px 2px 0 var(--ink); }
.console-section { scroll-margin-top:6rem; margin:1.4rem 0; padding:clamp(1rem,3vw,1.5rem); border:3px solid var(--ink); border-radius:1rem; background:#fffdf8; }
.console-section > * + * { margin-top:1rem; }
.console-section > h2 { margin-bottom:0; font-size:clamp(1.8rem,5vw,2.7rem); }
.console-grid { display:grid; align-items:start; gap:1rem; }
.console-grid.wide { grid-template-columns:minmax(0,1fr); }
.operation-card { min-width:0; padding:var(--space-md); border:2px solid #b8c6c9; border-radius:.8rem; background:#fff; }
.operation-card > * + * { margin-top:.85rem; }
.operation-card > label { display:block; }
.operation-card > :last-child { margin-bottom:0; }
.operation-card > h2,.operation-card > h3,.operation-card > p { margin-bottom:0; }
.operation-card > h2,.operation-card > h3 { overflow-wrap:anywhere; }
.operation-card form + form { margin-top:1rem; }
form.operation-card > * + * { margin-top:0; }
.section-tools { display:flex; flex-wrap:wrap; gap:.65rem; align-items:end; margin:1rem 0; }
.section-tools > label { flex:1 1 15rem; min-width:0; max-width:100%; }
.section-tools > .button { flex:0 0 auto; min-height:3.2rem; }
.event-create-card { border-color:var(--ink); background:var(--cream); box-shadow:3px 3px 0 var(--ink); }
.event-detail { min-width:0; max-width:100%; padding:clamp(.7rem,2.5vw,1rem); border:2px solid var(--water-dark); border-radius:.9rem; background:#f4fbfd; }
.event-detail > * + * { margin-top:var(--space-md); }
.event-detail > .compact-facts { margin:0; }
.event-detail-title { margin:0; font-size:1.15rem; letter-spacing:.02em; overflow-wrap:anywhere; }
.data-list { display:grid; gap:.7rem; margin-top:1rem; }
.data-list:empty { display:none; }
.inventory-layout { display:grid; gap:1rem; align-items:start; }
.inventory-card-grid { grid-template-columns:repeat(auto-fit,minmax(min(100%,14rem),1fr)); grid-auto-rows:minmax(3.75rem,1fr); align-content:start; align-items:stretch; margin-top:0; }
.inventory-card-grid .result-button { height:100%; min-height:3.75rem; }
.inventory-card-grid .result-button[aria-expanded="true"] { background:var(--cream); outline:3px solid var(--water-dark); outline-offset:1px; }
.inventory-group { grid-column:1/-1; display:grid; gap:.5rem; }
.inventory-group-title { margin:0; font-size:1.05rem; overflow-wrap:anywhere; }
.inventory-group > .muted { margin:0; }
.inventory-group > .inventory-card-grid { margin-top:0; }
.inventory-detail-panel { min-width:0; max-height:none; overflow:visible; }
.inventory-detail-heading { display:flex; align-items:start; justify-content:space-between; gap:1rem; }
.inventory-detail-heading .button { flex:none; }
.data-card { padding:.9rem; border:2px solid #b8c6c9; border-radius:.75rem; background:#fff; }
.data-card > * + * { margin-top:.55rem; }
.data-card > :last-child { margin-bottom:0; }
.data-card h3 { margin-bottom:0; overflow-wrap:anywhere; }
.data-card p { margin-bottom:0; overflow-wrap:anywhere; }
.data-card .actions { margin-top:.65rem; }
.status-chip { display:inline-block; margin:0 .35rem .35rem 0; padding:.25rem .5rem; border:2px solid var(--ink); border-radius:999px; background:var(--cream); font-size:.72rem; font-weight:950; letter-spacing:.04em; text-transform:uppercase; }
.status-chip.blocked { background:#ffd8d2; }
.status-chip.ready,.status-chip.done { background:#d9f5df; }
.compact-facts { grid-template-columns:repeat(auto-fit,minmax(9rem,1fr)); margin:.8rem 0; }
.compact-facts .fact { min-width:0; }
.compact-facts .fact dd { overflow-wrap:anywhere; font-size:.95rem; }
.inventory-detail-panel > .facts { margin-block:var(--space-sm) var(--space-md); }
.inventory-detail-panel > .actions { align-items:center; }
.inventory-detail-panel > h3 + .data-list { margin-top:var(--space-sm); }
.danger-zone { border-color:#9f261c; background:#fff3f1; }
.message-line { min-height:1.5rem; margin:.65rem 0; font-weight:800; }
.empty-state { padding:1rem; border:2px dashed #8da0a6; border-radius:.7rem; color:var(--muted); text-align:center; }
details.operation-card > summary { display:flex; min-height:2.75rem; align-items:center; gap:.6rem; list-style:none; cursor:pointer; font-size:1.05rem; font-weight:950; }
details.operation-card > summary::-webkit-details-marker { display:none; }
details.operation-card > summary::before { content:""; flex:none; width:.65rem; height:.65rem; border-right:3px solid var(--ink); border-bottom:3px solid var(--ink); transform:rotate(-45deg); transform-origin:center; }
details.operation-card[open] > summary::before { transform:rotate(45deg); }
details.operation-card > summary:focus-visible { border-radius:.3rem; outline:4px solid #83d8ec; outline-offset:2px; }
details.operation-card[open] > summary { margin-bottom:0; }
.roster-list { display:grid; gap:.45rem; padding:0; list-style:none; }
.roster-list li { padding:.65rem; border-left:.35rem solid var(--water); background:#eaf7fa; }
.roster-entry { display:grid; gap:.4rem; }
.roster-entry p { margin:0; overflow-wrap:anywhere; }
.roster-entry-line { font-weight:800; }
.roster-entry-id { font-size:.78rem; color:var(--muted); }
.roster-entry .actions { gap:.5rem; }
.private-result { overflow-wrap:anywhere; }
.page-title.message-title { max-width:26ch; font-size:clamp(1.9rem,5vw,3.2rem); line-height:1.05; letter-spacing:.005em; }
.my-ducks-flow { display:flex; flex-direction:column; }
.my-ducks-flow > * { min-width:0; max-width:100%; }
.my-ducks-flow[data-my-ducks-flow="empty"] > .my-ducks-search { order:-1; }
.live-board { border-width:4px; background:var(--paper); box-shadow:7px 7px 0 var(--ink); }
.live-board-title { max-width:none; margin-bottom:.5rem; }
.live-board-stage { max-width:100%; margin:.2rem 0 .6rem; padding:.4rem .8rem; background:var(--yellow); font-size:.85rem; line-height:1.4; overflow-wrap:anywhere; }
.board-round { margin-top:1.5rem; }
.board-round h3 { font-size:1.65rem; }
.board-grid { display:grid; gap:.8rem; }
.board-heat { padding:1rem; border:3px solid var(--ink); border-radius:.85rem; background:var(--paper); }
.board-heat.current { background:#fff1a8; box-shadow:4px 4px 0 var(--ink); }
.board-heat h4 { margin:.1rem 0 .4rem; font-size:1.2rem; }
.board-entry { display:flex; flex-wrap:wrap; justify-content:space-between; gap:.4rem 1rem; margin:.35rem 0 0; padding:.45rem .6rem; border-left:.35rem solid var(--water); background:#fff; font-weight:800; }
.board-participant { display:inline-flex; flex-wrap:wrap; align-items:center; gap:.4rem; }
.winner-ribbon { display:inline-flex; align-items:center; padding:.2rem .5rem; border:2px solid #7b5600; border-radius:999px; background:#f4c542; color:#3d2b00; font-size:.7rem; font-weight:950; letter-spacing:.06em; line-height:1.2; text-transform:uppercase; }
.winner-action { margin:0 0 1.4rem; padding:1rem; border:3px solid #7b5600; border-radius:1rem; background:#fff1a8; box-shadow:5px 5px 0 var(--ink); }
.winner-action > * { margin-bottom:0; }
.winner-action > * + * { margin-top:.75rem; }
.winner-action .button { width:100%; min-height:4rem; }
.winner-action.ineligible { border-color:#9f261c; background:#ffd8d2; }
.winner-action.ineligible strong { display:block; font-size:clamp(1.35rem,6vw,2.1rem); line-height:1.08; overflow-wrap:anywhere; }
.heat-bag { margin:0 0 1.4rem; padding:clamp(1rem,4vw,1.7rem); border:6px solid var(--ink); border-radius:1rem; background:var(--yellow); box-shadow:8px 8px 0 var(--ink); text-align:center; }
.heat-bag > * { margin-bottom:0; }
.heat-bag > * + * { margin-top:.6rem; }
.heat-bag-instruction { font-size:clamp(1.35rem,6vw,2.4rem); font-weight:950; line-height:1.05; letter-spacing:.005em; text-transform:uppercase; overflow-wrap:anywhere; }
.heat-bag-number { font-size:clamp(3rem,17vw,7rem); font-weight:950; line-height:.95; letter-spacing:.005em; overflow-wrap:anywhere; }
.heat-bag-duck { font-size:clamp(1.05rem,4vw,1.5rem); font-weight:900; overflow-wrap:anywhere; }
.heat-bag-note { font-size:clamp(.95rem,3.2vw,1.1rem); font-weight:800; line-height:1.45; overflow-wrap:anywhere; }
.heat-bag .actions { justify-content:center; margin-top:1rem; }
.heat-bag .button { width:100%; }
.heat-bag.pending { border-color:#9f261c; background:#ffd8d2; }
.heat-bag.pending .heat-bag-number { font-size:clamp(1.5rem,7vw,2.6rem); line-height:1.1; }
.heat-bag.bag-move .heat-bag-number { font-size:clamp(1.8rem,9vw,3.6rem); line-height:1.05; letter-spacing:.005em; }
.station-ineligible { margin:1.2rem 0; padding:clamp(1rem,3.5vw,1.5rem); border:5px solid #9f261c; border-radius:.9rem; background:#ffd8d2; box-shadow:6px 6px 0 var(--ink); }
.station-ineligible > * { margin-bottom:0; }
.station-ineligible > * + * { margin-top:.5rem; }
.station-ineligible strong { display:block; font-size:clamp(1.35rem,6vw,2.1rem); line-height:1.08; overflow-wrap:anywhere; }
.station-ineligible p { font-size:clamp(1rem,3.6vw,1.25rem); font-weight:850; overflow-wrap:anywhere; }
.podium { display:grid; gap:.65rem; margin:1rem 0; }
.podium-place { padding:.8rem 1rem; border:3px solid var(--ink); border-radius:.75rem; background:var(--yellow); font-size:1.1rem; font-weight:950; }
.station-panel h1 { max-width:none; }
.station-panel h2 { font-size:clamp(2rem,8vw,4rem); }
.station-control { min-height:4rem; padding:1rem 1.3rem; font-size:clamp(1.15rem,4vw,1.45rem); }
.station-action { display:grid; gap:1rem; margin:1.2rem 0; }
.station-roster { display:grid; gap:.65rem; padding:0; list-style:none; }
.station-roster li { padding:1rem; border:3px solid var(--ink); border-radius:.7rem; background:#eaf7fa; font-size:1.12rem; font-weight:900; }
.station-selection { padding:1rem; border:3px solid var(--water-dark); border-radius:.8rem; background:#e4f4f8; font-size:1.1rem; }
.station-counters { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:.75rem; margin:1rem 0; }
.station-counter { padding:1rem; border:3px solid var(--ink); border-radius:.8rem; background:var(--cream); text-align:center; }
.station-counter strong { display:block; color:var(--ink); font-size:clamp(2rem,10vw,4rem); line-height:1; }
.station-history { display:grid; gap:.55rem; padding:0; list-style:none; }
.station-history li { padding:.75rem; border-left:.4rem solid var(--water); background:#eaf7fa; font-weight:850; overflow-wrap:anywhere; }
.announcer-panel h2 { font-size:clamp(1.8rem,7vw,3.2rem); overflow-wrap:anywhere; }
.announcer-section { margin:1.4rem 0; padding:clamp(1rem,3vw,1.5rem); border:3px solid var(--ink); border-radius:1rem; background:#fffdf8; }
.announcer-section > :last-child { margin-bottom:0; }
.announcer-cue { margin:0 0 1rem; font-size:clamp(1.05rem,3.6vw,1.4rem); font-weight:900; overflow-wrap:anywhere; }
.announcer-roster,.announcer-results { display:grid; gap:.65rem; margin:0; padding:0; list-style:none; }
.announcer-roster li,.announcer-results li { display:grid; gap:.2rem; min-width:0; padding:1rem; border:3px solid var(--ink); border-radius:.7rem; overflow-wrap:anywhere; }
.announcer-roster li { background:#eaf7fa; }
.announcer-results li { background:var(--cream); }
.announcer-results li.final-heat { background:var(--yellow); }
.announcer-label { color:var(--water-dark); font-size:.78rem; font-weight:950; letter-spacing:.08em; text-transform:uppercase; }
.announcer-name { min-width:0; font-size:clamp(1.5rem,6vw,2.4rem); line-height:1.05; letter-spacing:.005em; overflow-wrap:anywhere; }
.announcer-duck { font-size:clamp(1rem,3.4vw,1.25rem); font-weight:900; }
.announcer-progress { margin:0 0 .9rem; font-weight:900; }
.announcer-panel .podium { margin:0; padding:0; list-style:none; }
.announcer-panel .podium-place { display:grid; gap:.2rem; min-width:0; font-size:clamp(1.1rem,4vw,1.5rem); overflow-wrap:anywhere; }
.station-panel > h2,.station-panel > h3,[data-intake-controls] > h2 { margin-bottom:0; overflow-wrap:anywhere; }
.station-panel > h2 + *,.station-panel > h3 + *,[data-intake-controls] > h2 + * { margin-top:var(--space-sm); }
[data-intake-controls] > label,.station-panel > label { display:block; }
.station-panel > .notice + label,.station-panel > label + label,.station-panel > label + .button,.station-panel > .button + .operation-card,.station-panel > .operation-card + .operation-card,.station-panel > .operation-card + .station-counters,.station-panel > .station-counters + h2,[data-intake-controls] > .notice + label,[data-intake-controls] > label + label,[data-intake-controls] > label + .actions,[data-intake-controls] > .actions + .operation-card,[data-intake-controls] > .operation-card + .operation-card,[data-intake-controls] > .operation-card + .station-counters,[data-intake-controls] > .station-counters + h2 { margin-top:var(--space-lg); }
.station-panel > .muted + .station-history,[data-intake-controls] > .muted + .station-history { margin-top:var(--space-md); }
.station-state .message-line { min-height:0; }
.station-counter { min-width:0; }
.station-counter span { display:block; line-height:1.25; overflow-wrap:anywhere; }
[data-event-readiness] .data-card { display:flex; flex-wrap:wrap; align-items:center; gap:var(--space-sm); }
[data-event-readiness] .data-card > * { margin:0; }
[data-event-readiness] .data-card > h3,[data-event-readiness] .data-card > p { flex-basis:100%; }
[data-event-readiness] .status-chip { margin:0; }
[data-event-readiness] .button { margin-top:var(--space-xs); }
[data-event-readiness] .data-card > .readiness-note { flex-basis:100%; }
.readiness-note { padding:.5rem .7rem; border-left:.4rem solid var(--water-dark); border-radius:.25rem; background:#eaf7fa; color:var(--ink); font-size:.92rem; font-weight:850; line-height:1.4; overflow-wrap:anywhere; }
.roster-flag { display:block; min-width:0; padding:.4rem .6rem; border:3px solid #9f261c; border-radius:.5rem; background:#ffd8d2; box-shadow:3px 3px 0 var(--ink); color:#6d160f; font-size:clamp(.95rem,3.6vw,1.2rem); font-weight:950; letter-spacing:.03em; line-height:1.2; text-transform:uppercase; overflow-wrap:anywhere; }
.roster-flag-note { min-width:0; font-size:clamp(.85rem,3vw,1.02rem); font-weight:850; line-height:1.35; overflow-wrap:anywhere; }
li.ineligible,.data-card.ineligible { border-color:#9f261c; background:#fff3f1; }
.site-foot { padding:1rem 0 3rem; color:var(--muted); font-size:.85rem; text-align:center; }
@media (min-width:44rem) { .cards { grid-template-columns:repeat(3,minmax(0,1fr)); } .field-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } .console-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } .console-grid.wide { grid-template-columns:minmax(16rem,.8fr) minmax(0,1.2fr); } .inventory-layout { grid-template-columns:minmax(0,1.15fr) minmax(20rem,.85fr); } .inventory-detail-panel { position:sticky; top:5.75rem; max-height:calc(100vh - 6.75rem); overflow:auto; } .board-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } }
@media (max-width:43.99rem) { .shell { width:min(100% - 1rem,40rem); } .site-head { flex-wrap:wrap; } .nav { width:100%; } .nav a { flex:1 1 0; padding:.7rem .45rem; text-align:center; } .nav a:first-child { display:none; } .hero { min-height:0; padding:1.5rem 1.5rem 17rem; border-radius:1.35rem; box-shadow:6px 6px 0 var(--ink); } .hero h1 { font-size:clamp(1.7rem,8.9vw,2.3rem); } .actions { position:relative; z-index:4; gap:var(--space-sm); } .button.small { min-height:2.75rem; } .hero-duck-scene { --duck-center:50%; right:50%; bottom:4rem; width:13.5rem; } .hero-duck { --duck-lift:-.75rem; } .hero-water { height:11rem; } .ticker { font-size:.7rem; } .page-panel > .duck-mark { width:5.7rem; } .privacy { display:block; } .privacy strong { display:block; margin-bottom:.25rem; } .participant-card { flex-basis:calc(100% - 2.25rem); } .participant-section-head-actions { flex-basis:100%; justify-content:flex-start; } .search-form { grid-template-columns:1fr; } .app-date-panel { position:fixed; top:1rem; right:1rem; left:1rem; width:auto; max-height:calc(100vh - 2rem); } .staff-bar { align-items:flex-start; } .staff-access-card .actions { width:100%; } .role-set > .check { min-height:2.75rem; } .staff-role-controls .button { flex:1 1 8rem; } }
@media (prefers-reduced-motion:no-preference) { .button,.result-button { transition:transform 80ms ease-out,box-shadow 80ms ease-out,filter 80ms ease-out,background-color 80ms ease-out; } .hero-duck { animation:duck-bob 2.8s ease-in-out infinite; } .hero-water::before { animation:water-flow 2.8s linear infinite; } @keyframes duck-bob { 0%,100% { transform:translateY(var(--duck-lift)); } 50% { transform:translateY(calc(var(--duck-lift) - 7px)); } } @keyframes water-flow { to { background-position:-10rem 0; } } }
@media (prefers-reduced-motion:reduce) { html { scroll-behavior:auto; } .hero-water::before { background-position:-2.5rem 0; } }
`;

interface PageOptions {
  title: string;
  description: string;
  content: string;
  robots?: string;
  phase?: PublicPhase;
  liveNav?: boolean;
}

// Register and Race Status strictly swap, so the nav renders exactly one of
// them. My Ducks is always in the document but starts hidden outside the
// Registration-or-later phases, matching the route that redirects home during
// Preparing. Saved-registration presence controls only the page's own layout.
// Staff stays in every phase.
//
// `data-live-nav` is the admission marker for the live navigation subscriber in
// `live-ui.js`. Only public content pages set it. The live hub starts its socket
// and pollers lazily on the first subscriber, so a page without this marker and
// without any other live surface holds no connection at all — which matters
// because `RaceUpdates` admits a bounded number of sockets. Those pages keep the
// server-rendered nav for the life of the document.
const siteNav = (phase: PublicPhase, liveNav: boolean): string => {
  const myDucksVisible = phaseShowsMyDucks(phase);
  const swap = phaseShowsRegisterNav(phase)
    ? '<a href="/register" data-nav-register>Register</a>'
    : phaseShowsRaceStatusNav(phase) ? '<a href="/race" data-nav-race>Race Status</a>' : "";
  return `<nav class="nav" aria-label="Primary" data-site-nav${liveNav ? " data-live-nav" : ""} data-phase="${phase}"><a href="/" data-nav-home>Home</a>${swap}<a href="/my-ducks" data-my-ducks-nav data-phase-visible="${myDucksVisible ? "true" : "false"}"${myDucksVisible ? "" : " hidden"}>My Ducks</a><a href="/staff" data-nav-staff>Staff</a></nav>`;
};

const page = ({
  title,
  description,
  content,
  robots = "index,follow",
  phase = "PREPARING",
  liveNav = false,
}: PageOptions): string => `<!doctype html>
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
    <script src="/assets/live-ui.js" defer></script>
  </head>
  <body>
    <header class="shell site-head">
      <a class="brand" href="/">${duck("brand-duck")}<span>QuickDucks</span></a>
      ${siteNav(phase, liveNav)}
    </header>
    <main class="shell">${content}</main>
    <footer class="shell site-foot">Built for quick check-ins, clear heats, and happy ducks.</footer>
    <script src="/assets/participant.js" defer></script>
  </body>
</html>`;

const liveBoard = (): string => `
  <section class="status-section live-board" data-live-board aria-labelledby="live-board-title">
    <p class="eyebrow">Live race board</p>
    <p class="status-chip live-board-stage" data-live-board-stage aria-live="polite">Loading race stage…</p>
    <h2 class="live-board-title" id="live-board-title" data-live-board-title>Checking the race…</h2>
    <p class="lede" data-live-board-summary>Loading the latest official race information.</p>
    <p class="message-line muted" data-live-board-error role="alert" hidden></p>
    <div data-live-board-content><p class="empty-state">The board will appear here when race information is available.</p></div>
  </section>`;

// The compact home summary. It carries the stage chip and a single current-heat
// line and sends anyone who wants detail to `/race`; the full board lives there.
//
// This section is also where the phase call to action lives. `live.js` replaces
// the title with the event's own name, so this is the block a visitor reads as
// "this race", and the action for that race belongs beside it rather than in the
// decorative hero. The section renders only when there is a call to action, so
// the two are always present together.
const happeningNow = (cta: PublicPhaseCta): string => `
  <section class="status-section" data-live-summary aria-labelledby="happening-now-title">
    <p class="eyebrow">Happening now</p>
    <p class="status-chip live-board-stage" data-live-summary-stage aria-live="polite">Loading race stage…</p>
    <h2 class="live-board-title" id="happening-now-title" data-live-summary-title>Checking the race…</h2>
    <p class="lede" data-live-summary-line>Loading the latest official race information.</p>
    <p class="message-line muted" data-live-summary-error role="alert" hidden></p>
    <div class="actions"><a class="button" href="${escapeHtml(cta.href)}" data-home-cta>${escapeHtml(cta.label)}</a><a class="button secondary" href="/race">Open the full race board</a></div>
  </section>`;

// Preparing is deliberately terminal and bare: no form, no privacy block, no
// notice, and no multi-registration hint, only the one approved sentence for
// that page. `/register` is the only caller: it is the one page that may tell a
// visitor to come back and register. `/race` has no preparing panel because the
// route redirects home while a race is being prepared.
const preparingPanel = (marker: string, message: string): string => `
    <section class="page-panel" ${marker}>
      ${duck()}
      <h1 class="page-title message-title">${escapeHtml(message)}</h1>
    </section>`;

// The hero's "How it works" button was removed, so nothing on this page links to
// `#how-it-works` any more. The id on the cards section stays: `/#how-it-works`
// is a stable public deep link that can already have been shared or printed, an
// id costs nothing to keep, and dropping it would break those links purely to
// tidy markup no visitor sees. `public-race-flow.test.mjs` pins both halves — no
// button, and the anchor still there — so this decision cannot drift silently.
export const renderHome = (phase: PublicPhase = "PREPARING"): string => {
  const cta = homePhaseCta[phase];
  return page({
    title: "Race-day registration and results",
    description: "Register for the next QuickDucks race, check your heat, and follow race-day results.",
    phase,
    liveNav: true,
    content: `
    <section class="hero">
      <div class="hero-copy">
        <p class="eyebrow">Race-day, simplified</p>
        <h1><span>Find your duck.</span><br><span>Cheer it home.</span></h1>
        <p class="lede">A friendly home for the small races that bring a whole town down to the water. Built for the volunteers, families, and rubber ducks that make race day happen.</p>
      </div>
      <div class="hero-water" aria-hidden="true"></div>
      <div class="hero-duck-scene">
        ${duck("hero-duck")}
        <span class="hero-duck-slit" aria-hidden="true"></span>
      </div>
    </section>
    ${cta === null ? '<section class="status-section home-preparing-card" aria-labelledby="home-preparing-title"><p class="eyebrow">Happening now</p><h2 id="home-preparing-title" data-home-preparing>The next race is being prepared.</h2> <p class="lede">Check back soon for the next QuickDucks race.</p></section>' : happeningNow(cta)}
    <div class="ticker" aria-label="QuickDucks features"><span>Pick your duck</span><span>Find your heat</span><span>Cheer loudly</span></div>
    <section id="how-it-works" class="cards" aria-label="How QuickDucks works">
      <article class="card"><strong>Before the race</strong><h3>Register in under a minute</h3><p class="muted">You don’t need an account. Keep your private status link and short lookup code for race day.</p></article>
      <article class="card"><strong>At check-in</strong><h3>Staff pair your selected duck</h3><p class="muted">A staff member scans the duck, then enters your code or finds your registration by name.</p></article>
      <article class="card"><strong>On race day</strong><h3>One clear source of truth</h3><p class="muted">You can follow heat assignments, finalist progress, and results from check-in to finish.</p></article>
    </section>${cta === null ? "" : '\n    <script src="/assets/live.js" defer></script>'}`,
  });
};

// The full live board. It is public for the five post-DRAFT statuses, and it has
// no Preparing variant: `index.ts` redirects `/race` home while the phase is
// Preparing, so there is exactly one thing this page can be. The phase is still
// passed in because the shared navigation is phase-driven.
export const renderRace = (phase: PublicPhase = "PREPARING"): string => page({
  title: "Race status",
  description: "Live QuickDucks race status: stage, heats, the current heat, and official results.",
  robots: "noindex,nofollow",
  phase,
  liveNav: true,
  content: `
    <section class="page-panel">
      ${duck()}
      <p class="eyebrow">Live race status</p>
      <h1 class="page-title">Race status</h1>
      <p class="lede">The race stage, every heat, the heat running right now, and the official podium once results are final.</p>
    </section>${liveBoard()}<script src="/assets/live.js" defer></script>`,
});

// The public name search lives here rather than on the home page: it is the
// recovery path for a device that lost its saved list. Results carry public
// race status only, never a lookup code or a private link.
const nameSearchSection = (): string => `
      <section class="status-section my-ducks-search" data-status-search-section aria-labelledby="find-status-title">
        <p class="eyebrow">Lost your saved list?</p>
        <h2 id="find-status-title">Find race status by name</h2>
        <p class="muted" data-search-lead hidden>Nothing is saved on this device yet. Search for a participant below to follow their race status here.</p>
        <p class="muted">Enter an exact first name, last name, or full name. Results show race status only, never email, phone, private links, lookup codes, or staff data.</p>
        <form class="search-form" data-status-search>
          <label>Participant name<input name="name" autocomplete="name" minlength="2" maxlength="161" required></label>
          <button class="button" type="submit">Find status</button>
        </form>
        <p class="search-message muted" data-search-message aria-live="polite"></p>
        <div class="duck-list" data-search-results></div>
        <div class="privacy"><strong>Your data is temporary.</strong><span>QuickDucks permanently deletes the complete race, including participant, duck, tag, result, and audit data, when an administrator deletes the event.</span></div>
      </section>`;

export const renderMyDucks = (phase: PublicPhase = "PREPARING"): string => page({
  title: "My Ducks",
  description: "Registrations and race status saved on this browser.",
  robots: "noindex,nofollow",
  phase,
  liveNav: true,
  content: `
    <section class="page-panel my-ducks-panel" data-my-ducks-page>
      ${duck()}
      <p class="eyebrow">Saved on this device</p>
      <h1 class="page-title">My Ducks</h1>
      <p class="lede">Participants you registered on this device keep their full details and staff lookup code. Ducks you followed show public race status only.</p>
       <div class="privacy"><strong>Private by design.</strong><span>For participants registered on this device, participant-specific private proof lets this browser show and edit email, phone, and contact opt-ins. Anyone with access to this browser profile may see or change those saved details. Followed participants remain status-only, and ownership proof and private status links never appear on the page or in public responses.</span></div>
      <div class="notice" data-registration-success aria-live="polite" hidden></div>
      <p class="message-line muted" data-my-ducks-error role="alert" hidden></p>
      <div class="my-ducks-flow" data-my-ducks-flow>
      <div class="my-ducks-saved">
      <p class="empty-state" data-my-ducks-empty hidden>No registrations are saved on this device yet. Register a participant, or follow someone from the race status search on this page.</p>

      <section class="participant-section" data-participant-section="awaiting"${phaseAllowsRegistration(phase) ? ' data-keep-empty="true"' : ""} aria-labelledby="awaiting-participants-title" hidden>
        <div class="participant-section-head">
          <h2 id="awaiting-participants-title">Awaiting Duck Assignment</h2>
          <div class="participant-section-head-actions">
${phaseAllowsRegistration(phase) ? '            <a class="button small" href="/register" data-register-another>Register another participant</a>\n' : ""}            <div class="carousel-controls" data-carousel-controls hidden>
              <button class="button secondary small" type="button" data-carousel-previous aria-controls="awaiting-participants">Previous</button>
              <button class="button secondary small" type="button" data-carousel-next aria-controls="awaiting-participants">Next</button>
            </div>
          </div>
        </div>
        <p class="muted">Participants you registered on this device, waiting for staff to pair a physical duck. Their staff lookup code stays on this device.</p>
        <div class="participant-track" id="awaiting-participants" data-participant-track tabindex="0" aria-label="Awaiting duck assignment registrations" hidden></div>
      </section>

      <section class="participant-section" data-participant-section="paired" aria-labelledby="paired-participants-title" hidden>
        <div class="participant-section-head">
          <h2 id="paired-participants-title">My Ducks</h2>
          <div class="carousel-controls" data-carousel-controls hidden>
            <button class="button secondary small" type="button" data-carousel-previous aria-controls="paired-participants">Previous</button>
            <button class="button secondary small" type="button" data-carousel-next aria-controls="paired-participants">Next</button>
          </div>
        </div>
        <p class="muted">Participants you registered on this device, already paired with their race duck. Use Rename on a duck to give it a public name, and it appears instead of the generic duck number.</p>
        <div class="participant-track" id="paired-participants" data-participant-track tabindex="0" aria-label="Paired participant registrations" hidden></div>
      </section>

      <section class="participant-section" data-participant-section="followed" aria-labelledby="followed-participants-title" hidden>
        <div class="participant-section-head">
          <h2 id="followed-participants-title">Ducks I’m Following</h2>
          <div class="carousel-controls" data-carousel-controls hidden>
            <button class="button secondary small" type="button" data-carousel-previous aria-controls="followed-participants">Previous</button>
            <button class="button secondary small" type="button" data-carousel-next aria-controls="followed-participants">Next</button>
          </div>
        </div>
        <p class="muted">Participants you followed from a duck tag, a duck page, or the search below. These are someone else’s registration, so they show public race status and any public duck name, but no staff lookup code or naming controls.</p>
        <div class="participant-track" id="followed-participants" data-participant-track tabindex="0" aria-label="Followed participants" hidden></div>
      </section>
      </div>
${nameSearchSection()}
      </div>
    </section>
    <script src="/assets/search.js" defer></script>`,
});

export const renderRegistration = (
  turnstileSiteKey?: string,
  phase: PublicPhase = "PREPARING",
  localPreviewWithoutProtection = false,
): string => {
  if (phase === "PREPARING") {
    return page({
      title: "Register for the duck race",
      description: "Registration for the next QuickDucks race is not open yet.",
      robots: "noindex,nofollow",
      phase,
      liveNav: true,
      content: preparingPanel("data-registration-preparing", registrationPreparingMessage),
    });
  }
  if (!phaseAllowsRegistration(phase)) {
    return page({
      title: "Register for the duck race",
      description: "Registration for the current QuickDucks race is closed.",
      robots: "noindex,nofollow",
      phase,
      liveNav: true,
      content: `
    <section class="page-panel" data-registration-closed>
      ${duck()}
      <h1 class="page-title message-title">${escapeHtml(registrationClosedMessage)}</h1>
      <div class="actions"><a class="button" href="/race">View race status</a></div>
    </section>`,
    });
  }
  return page({
    title: "Register for the duck race",
    description: "Register a participant for the current QuickDucks race.",
    robots: "noindex,nofollow",
    phase,
    liveNav: true,
    content: `
    <section class="page-panel">
      ${duck()}
      <p class="eyebrow">Participant registration</p>
      <h1 class="page-title" data-event-name>Loading race details…</h1>
      <p class="lede" data-event-date>Registration takes about one minute.</p>
       <div class="privacy"><strong>Private by design.</strong><span>Outside the originating browser, your email and phone number are visible only to logged-in authorized race staff. The originating browser can privately view and edit them from its owned My Ducks card. They are never shown in public search or race status. After duck return processing, QuickDucks permanently deletes the complete race, including participant, duck, tag, result, and audit data.</span></div>
      <div class="notice"><strong>Registering more than one participant?</strong> Finish this form once for each person. You can use the same phone, email, or browser, and QuickDucks will keep their codes together on this device.</div>
      <form method="post" action="/api/v1/registrations" data-registration-form data-protection-ready="${turnstileSiteKey === undefined && !localPreviewWithoutProtection ? "false" : "true"}">
        <div class="field-grid">
          <label>First name<input name="first_name" autocomplete="given-name" maxlength="80" required placeholder="Jamie"><span class="field-error" data-field-error="first_name"></span></label>
          <label>Last name<input name="last_name" autocomplete="family-name" maxlength="80" required placeholder="Rivera"><span class="field-error" data-field-error="last_name"></span></label>
        </div>
        <p class="muted" data-public-name-policy>Loading how your name will appear publicly…</p>
        <div class="field-grid">
          <label><span class="label-text" data-email-label>Email (optional)</span><input name="email" type="email" autocomplete="email" maxlength="254" placeholder="jamie@example.com"><span>Used only for operational race updates.</span><span class="field-error" data-field-error="email"></span></label>
          <label>Phone (optional)<input name="phone" type="tel" autocomplete="tel" maxlength="32" placeholder="(555) 010-2040"><span class="field-error" data-field-error="phone"></span></label>
        </div>
        ${turnstileSiteKey !== undefined
          ? `<div class="cf-turnstile" data-sitekey="${escapeHtml(turnstileSiteKey)}" data-size="flexible"></div><script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`
          : localPreviewWithoutProtection
            ? `<div class="turnstile-mock">Local preview — registration protection is bypassed.</div><input type="hidden" name="cf-turnstile-response" value="${escapeHtml(localPreviewTurnstileToken)}">`
            : '<div class="turnstile-mock">Registration protection is still being configured.</div>'}
        <p class="muted" data-form-message aria-live="polite">Loading registration availability…</p>
        <button class="button" type="submit" disabled>Register participant</button>
      </form>
      <script src="/assets/register.js" defer></script>
    </section>`,
  });
};

export const renderStatus = (
  registration?: RegistrationStatusRecord & { raceStatus?: PublicRaceStatus | null },
  phase: PublicPhase = "PREPARING",
): string => {
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
  const participantName = registration === undefined
    ? "Jamie Rivera"
    : `${registration.first_name} ${registration.last_name}`;
  const raceStatus = registration?.raceStatus;
  return page({
  title: "Registration status",
  description: "Private QuickDucks participant registration status.",
  robots: "noindex,nofollow",
  phase,
  liveNav: true,
  content: `
    <section class="page-panel">
      ${duck()}
      <p class="eyebrow">Private registration status</p>
      <h1 class="page-title" data-private-status-heading>${escapeHtml(heading)}</h1>
      <p class="lede" data-private-status-event>Keep this page private. This is your status link for ${escapeHtml(eventName)}.</p>
      <div class="notice lookup-code-notice">
        <div class="lookup-code-detail"><strong>Staff lookup code</strong><br><span class="code">${escapeHtml(lookupCode)}</span><br><span class="muted">Show this screen to staff when you pick your duck. They can scan the code or type it in. Save this code or bookmark this page.</span></div>
        <div class="lookup-code-qr">${renderParticipantQrSvg(lookupCode)}</div>
      </div>
      <div data-live-personal="private"><dl class="facts"><div class="fact"><dt>Participant</dt><dd>${escapeHtml(participantName)}</dd></div><div class="fact"><dt>Status</dt><dd>${registrationStatus}</dd></div><div class="fact"><dt>Race date</dt><dd>${escapeHtml(raceDate)}</dd></div></dl>
        ${raceStatus === undefined ? "" : raceStatus === null
          ? '<p class="muted">Race status is not currently public.</p>'
          : publicStatusFacts(raceStatus, false)}</div>
       <p class="muted">Duck, heat, and result facts match public race status. Email and phone stay off this status page; they are available only to authorized staff and the originating browser’s owned My Ducks card. The complete race dataset is deleted after return processing.</p>
      <div class="actions">${phaseAllowsRegistration(phase) ? '<a class="button" href="/register">Register another participant</a>' : ""}<a class="button secondary" href="/">Back to home</a></div>
    </section>${liveBoard()}<script src="/assets/live.js" defer></script>`,
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
  duckName: "Sir Quacks-a-Lot",
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

// A participant-chosen name is the public label when one survives the read-time
// filter. The printed number remains authoritative data and the detail-link
// destination, but only supplies the visible fallback for an unnamed duck.
const duckIdentity = (status: PublicRaceStatus): string => {
  if (status.duck === null) return "Waiting for duck assignment";
  return typeof status.duckName === "string" && status.duckName.length > 0
    ? status.duckName
    : `Duck #${status.duck.visibleNumber}`;
};

const publicStatusFacts = (status: PublicRaceStatus, showParticipant = true): string => {
  const assignment = escapeHtml(duckIdentity(status));
  const heat = status.assignedHeat.final ?? status.assignedHeat.roundOne;
  const heatLabel = heat === null
    ? "Heat not assigned yet"
    : `${status.assignedHeat.final === null ? "Round one" : "Final"} · Heat ${heat.number}`;
  const running = status.currentHeat === null
    ? "Racing has not started"
    : `${roundLabel(status.currentHeat.round)} · Heat ${status.currentHeat.number}`;
  const participant = showParticipant
    ? `<div class="fact"><dt>Participant</dt><dd>${escapeHtml(status.participantDisplayName)}</dd></div>`
    : "";
  return `<dl class="facts">${participant}<div class="fact"><dt>Duck</dt><dd>${assignment}</dd></div><div class="fact"><dt>Assigned heat</dt><dd>${heatLabel}</dd></div><div class="fact"><dt>Currently running</dt><dd>${running}</dd></div><div class="fact"><dt>Race status</dt><dd>${outcomeLabel(status.outcome)}</dd></div></dl>`;
};

// Server-rendered Follow control for the two public duck pages. It appears only
// when the request resolved a genuinely followable participant, so a page that
// renders no control means "cannot be followed", never "not followed yet". The
// already-added state is a plain tag with no action, exactly like a search
// result that is already in the collection.
//
// `live.js` re-renders this block from the authoritative duck response, so the
// server paint and every later refetch agree.
const followPanel = (follow: PublicFollowState | null): string => follow === null ? "" : `
      <div class="actions" data-duck-follow data-follow-id="${escapeHtml(follow.followId)}">${
  follow.inMyDucks
    ? '<span class="success-tag" data-follow-added>In My Ducks</span><a class="button secondary small" href="/my-ducks">Open My Ducks</a>'
    : '<button class="button" type="button" data-follow-button>Follow this duck</button>'
}</div>
      <p class="message-line muted" data-follow-message role="status" hidden></p>`;

export const renderDuck = (
  status: PublicRaceStatus = mockRaceStatus,
  phase: PublicPhase = "PREPARING",
  follow: PublicFollowState | null = null,
): string => page({
  title: status.duck === null ? "Race status" : duckIdentity(status),
  description: "Public QuickDucks NFC duck race status.",
  robots: "noindex,nofollow",
  phase,
  liveNav: true,
  content: `
    <section class="page-panel">
      ${duck()}
      <p class="eyebrow">Public race status</p>
      <h1 class="page-title" data-duck-heading>${status.duck === null ? "Waiting for a duck" : escapeHtml(duckIdentity(status))}</h1>
      <p class="lede">Follow this duck through ${escapeHtml(status.event.name)}.</p>
      <div data-live-personal="duck">${publicStatusFacts(status)}</div>${followPanel(follow)}
      <div class="privacy"><strong>Public, not personal.</strong><span>This page shows race progress but never contact information, staff codes, or private links.</span></div>
      <div class="actions"><a class="button secondary" href="/">Visit QuickDucks</a></div>
    </section>${liveBoard()}<script src="/assets/live.js" defer></script>`,
});

// The board moved to `/race`, so a "back to the board" action has to follow it —
// and fall back to the home page in the one phase where `/race` has no board.
const boardLink = (phase: PublicPhase, variant = ""): string =>
  phaseAllowsRaceStatus(phase)
    ? `<a class="button${variant === "" ? "" : ` ${variant}`}" href="/race">Back to the race board</a>`
    : `<a class="button${variant === "" ? "" : ` ${variant}`}" href="/">Back to QuickDucks</a>`;

const heatFact = (heat: { number: number; status: string } | null, missing: string): string =>
  heat === null ? missing : `Heat ${heat.number} · ${publicHeatStatusLabel(heat.status)}`;

// Every value here comes from the shared public projection, so this view can
// never render contact details, lookup codes, tokens, or staff data.
const duckDetailFacts = (status: PublicRaceStatus): string => {
  const officialResult = publicOfficialResult(status.outcome);
  const facts = [
    ["Participant", status.participantDisplayName],
    ["Duck", duckIdentity(status)],
    ["Round one heat", heatFact(status.assignedHeat.roundOne, "Not assigned yet")],
    ["Final heat", heatFact(status.assignedHeat.final, "Not in the final")],
    ["Currently running", status.currentHeat === null
      ? "No heat is running right now"
      : `${roundLabel(status.currentHeat.round)} · Heat ${status.currentHeat.number} · ${publicHeatStatusLabel(status.currentHeat.status)}`],
    ["Race status", outcomeLabel(status.outcome)],
    ...(officialResult === null ? [] : [["Official result", officialResult]]),
  ];
  return `<dl class="facts">${facts
    .map(([label, value]) => `<div class="fact"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`)
    .join("")}</dl>`;
};

export const renderPublicDuck = (
  status: PublicRaceStatus = mockRaceStatus,
  phase: PublicPhase = "PREPARING",
  follow: PublicFollowState | null = null,
): string => {
  const heading = status.duck === null ? "This duck" : duckIdentity(status);
  return page({
    title: heading,
    description: "Public QuickDucks race status for one duck number.",
    robots: "noindex,nofollow",
    phase,
    liveNav: true,
    content: `
    <section class="page-panel">
      ${duck()}
      <p class="eyebrow">Public duck detail</p>
      <h1 class="page-title" data-duck-heading>${escapeHtml(heading)}</h1>
      <p class="lede">Follow this duck through ${escapeHtml(status.event.name)}.</p>
      <div data-live-personal="number">${duckDetailFacts(status)}</div>${followPanel(follow)}
      <div class="privacy"><strong>Public, not personal.</strong><span>This page shows race progress but never contact information, staff codes, private links, or the duck’s tag.</span></div>
      <div class="actions">${boardLink(phase, "secondary")}</div>
    </section>${liveBoard()}<script src="/assets/live.js" defer></script>`,
  });
};

// Unknown numbers, inventory ducks that are not paired, and ducks outside the
// current public event all render this identical page.
export const renderPublicDuckNotFound = (
  visibleNumber?: string,
  phase: PublicPhase = "PREPARING",
): string => page({
  title: "Duck not racing",
  description: "The requested QuickDucks duck number is not in the current race.",
  robots: "noindex,nofollow",
  phase,
  liveNav: true,
  content: `<section class="page-panel">${duck()}<p class="eyebrow">Public duck detail</p><h1 class="page-title">${visibleNumber === undefined ? "That duck isn’t racing." : `Duck #${escapeHtml(visibleNumber)} isn’t racing.`}</h1><p class="lede">No duck with this number is paired with a participant in the current race. Check the number printed on the duck, or find it on the live race board.</p>${boardLink(phase)}</section>`,
});

// Staff pages render the same primary site navigation as the public site, from
// the same resolved phase, so a staff member sees the same Home/Register/My
// Ducks/Staff links a visitor does. They deliberately do not set `liveNav`:
// `data-live-nav` is the admission marker for the live navigation subscriber,
// and `RaceUpdates` admits a bounded number of sockets, so staff surfaces keep
// the server-rendered nav for the life of the document and hold no subscription.
export const renderStaffLogin = (returnTo = "/staff", phase: PublicPhase = "PREPARING"): string => page({
  title: "Staff sign in",
  description: "Sign in to protected QuickDucks race operations.",
  robots: "noindex,nofollow",
  phase,
  content: `
    <section class="page-panel">
      ${duck()}
      <p class="eyebrow">Protected race operations</p>
      <h1 class="page-title">Staff sign in</h1>
      <p class="lede">Use your invited QuickDucks staff email. Cognito will send a one-time sign-in code.</p>
      <div class="privacy"><strong>Authorized staff only.</strong><span>QuickDucks verifies the Cognito account, active staff profile, and assigned operational roles. Participant email and phone require registration or race-director authority.</span></div>
      <div class="actions">
        <a class="button" href="${escapeHtml(`/staff/login/start?returnTo=${encodeURIComponent(returnTo)}`)}">Continue to secure sign in</a>
        <a class="button secondary" href="/">Back to public site</a>
      </div>
    </section>`,
});

const operationalRoleLabels: Record<OperationalRole, string> = {
  REGISTRATION: "Registration",
  DUCK_MANAGER: "Duck manager",
  ANNOUNCER: "Announcer",
  HEAT_RUNNER: "Heat runner",
  RESULT_TAKER: "Result taker",
  RACE_DIRECTOR: "Race director",
};

const roleCheckboxes = operationalRoles.map((role) =>
  `<label class="check"><input type="checkbox" name="roles" value="${role}"><span class="label-text">${operationalRoleLabels[role]}</span></label>`
).join("");

const staffLogoutForm = (): string =>
  '<form class="staff-logout" method="post" action="/staff/logout"><button type="submit">Log out</button></form>';

// The signed-in bar is the footer of every staff page, not a header on it. It
// carries who is signed in and how to sign out, and nothing else: navigation is
// the staff nav's job, and the page name is already the page's heading. Every
// staff surface renders exactly this element, at the end of its panel.
const staffFooter = (displayName: string): string =>
  `<footer class="staff-bar"><p><strong>${escapeHtml(displayName)}</strong></p>${staffLogoutForm()}</footer>`;

// Who may open the `/staff` Admin view. `is_system_admin` is an account type,
// not a race-day role, and the race-day role for changing the state of the
// overall race — open/close registration, start the rounds, manage heats,
// complete the event — is `RACE_DIRECTOR`. Both therefore open the Admin view,
// and the per-view gating inside it still decides what each of them sees:
// `#support`, `/staff/access`, Create event, Configure draft, and Delete event
// remain administrator-only.
//
// `index.ts` imports this rather than restating it, so the route that serves
// `/staff` and the nav link that offers it can never disagree.
export const canOpenAdminConsole = (
  isSystemAdmin: boolean,
  roles: readonly OperationalRole[],
): boolean => isSystemAdmin || roles.includes("RACE_DIRECTOR");

// Persistent staff navigation. It is organised by the job a staffer is doing,
// not by the shape of the application: Admin, Registration, and the three
// race-day stations. It lists only the pages this actor may open, so a missing
// link is a convenience filter; every page and API repeats the check.
//
// `anyOf` names the operational roles that may open the page and an
// administrator implicitly passes it. `viaAdminMenu` marks the one link that is
// not a plain role check. Inventory has its own item in the Admin menu bar, so
// anyone who can open the Admin view already has a route to it and a second
// top-level link would only duplicate that. A duck manager who is neither an
// administrator nor a race director has no Admin menu bar at all and would
// otherwise be left with no link to `/staff/inventory`, so the link is rendered
// for exactly that case.
interface StaffNavLink {
  href: string;
  label: string;
  access: {
    anyOf: readonly OperationalRole[];
    viaAdminMenu?: true;
  };
}

// Order is race-day reading order: the administrator console first, then the
// registration desk that runs before the race, then the three stations in the
// order the announcer reports on them — Announcer, Start line, Finish line —
// and finally the Inventory link a non-administrator duck manager needs.
const staffNavLinks: readonly StaffNavLink[] = [
  { href: "/staff", label: "Admin", access: { anyOf: ["RACE_DIRECTOR"] } },
  { href: "/staff/registration", label: "Registration", access: { anyOf: ["REGISTRATION", "RACE_DIRECTOR"] } },
  { href: "/staff/announcer", label: "Announcer", access: { anyOf: ["ANNOUNCER", "RACE_DIRECTOR"] } },
  { href: "/staff/start-line", label: "Start line", access: { anyOf: ["HEAT_RUNNER", "RACE_DIRECTOR"] } },
  { href: "/staff/finish-line", label: "Finish line", access: { anyOf: ["RESULT_TAKER", "RACE_DIRECTOR"] } },
  {
    href: "/staff/inventory",
    label: "Inventory",
    access: { anyOf: ["DUCK_MANAGER", "RACE_DIRECTOR"], viaAdminMenu: true },
  },
];

const staffNavLinkVisible = (
  { access }: StaffNavLink,
  isSystemAdmin: boolean,
  roles: readonly OperationalRole[],
): boolean => {
  const holdsRole = access.anyOf.some((role) => roles.includes(role));
  return access.viaAdminMenu === true
    ? !canOpenAdminConsole(isSystemAdmin, roles) && holdsRole
    : isSystemAdmin || holdsRole;
};

const staffNav = (
  isSystemAdmin: boolean,
  roles: readonly OperationalRole[],
  current?: string,
): string => {
  const links = staffNavLinks
    .filter((link) => staffNavLinkVisible(link, isSystemAdmin, roles))
    .map(({ href, label }) =>
      `<a href="${href}"${href === current ? ' aria-current="page"' : ""}>${label}</a>`)
    .join("");
  return `<nav class="staff-nav" aria-label="Staff pages">${links}</nav>`;
};

// The Admin console's own menu bar. Four items are separate views inside
// `/staff` that switch through the URL hash, so a view is linkable and works
// with browser back and forward; Inventory and Access are whole pages of their
// own, and they render this same bar so an administrator can navigate back.
//
// Each item carries exactly the gating of the surface it opens, so the bar can
// never offer a view the actor is not allowed to see. The three event-scoped
// items ship hidden for the same reason their sections do: nothing flashes and
// then vanishes while the first event query is still in flight.
interface AdminMenuItem {
  href: string;
  label: string;
  view?: "event" | "heats" | "participants" | "support";
  eventScoped?: true;
}

const adminMenuItems: readonly AdminMenuItem[] = [
  { href: "#event", label: "Event Details", view: "event" },
  { href: "#heats", label: "Heats", view: "heats", eventScoped: true },
  { href: "#participants", label: "Participants", view: "participants", eventScoped: true },
  { href: "/staff/inventory", label: "Inventory" },
  { href: "#support", label: "Support", view: "support", eventScoped: true },
  { href: "/staff/access", label: "Access" },
];

// `current` is the in-page hash on `/staff` and the page path on the two pages
// the bar links out to. Event Details is the default view, so it carries
// `aria-current` in the served markup and the view switcher moves it from there.
//
// Only the console's own bar is event-scoped: `/staff/inventory` and
// `/staff/access` run no console client, so hiding their hash links would strand
// them hidden forever. There the bar is a plain set of links back into `/staff`,
// each of which lands on that view or falls back to Event Details.
const adminMenu = (
  isSystemAdmin: boolean,
  roles: readonly OperationalRole[],
  current = "#event",
): string => {
  const inConsole = current.startsWith("#");
  const hasRole = (role: OperationalRole): boolean => isSystemAdmin || roles.includes(role);
  // Anyone with a console at all can see the event it is about. The rest stays
  // exactly as role-gated as the surface it opens, so admitting race directors
  // to the Admin view widens nothing else: Support and Access are still
  // administrator-only items and are simply absent from a race director's bar.
  const allowed: Record<string, boolean> = {
    "#event": isSystemAdmin || roles.length > 0,
    "#heats": hasRole("ANNOUNCER") || hasRole("HEAT_RUNNER") || hasRole("RESULT_TAKER") || hasRole("RACE_DIRECTOR"),
    "#participants": hasRole("REGISTRATION") || hasRole("RACE_DIRECTOR"),
    "/staff/inventory": hasRole("DUCK_MANAGER") || hasRole("RACE_DIRECTOR"),
    "#support": isSystemAdmin,
    "/staff/access": isSystemAdmin,
  };
  const links = adminMenuItems
    .filter(({ href }) => allowed[href] === true)
    .map(({ href, label, view, eventScoped }) => {
      const target = inConsole || !href.startsWith("#") ? href : `/staff${href}`;
      const hooks = inConsole && view !== undefined ? ` data-console-view-link="${view}"` : "";
      const scoped = inConsole && eventScoped === true ? " data-event-scoped hidden" : "";
      return `<a href="${target}"${hooks}${scoped}${href === current ? ' aria-current="page"' : ""}>${label}</a>`;
    })
    .join("");
  return `<nav class="console-nav" aria-label="Admin views">${links}</nav>`;
};

// Closing registration folds a short tail heat into the heat before it, and
// reopening splits it back out. Both move ducks that are already sealed in
// numbered bags, so neither may ever happen silently: the bags on the table
// would stop matching the rosters QuickDucks prints and the finish line reads.
//
// This is the console's half of that promise. It is deliberately the same loud
// visual language as the pairing page's own bag callout — the staffer who is
// told "Put this duck in HEAT 5 bag" is the staffer who must later be told
// "Pour the Heat 5 bag into the Heat 4 bag", and a physical instruction should
// not look different from a physical instruction. It sits above everything
// else, outside every console view so switching views cannot hide it, and it
// survives a reload because the console re-reads its queue from the browser.
// Only pressing Done clears one, because only a person can know a bag moved.
//
// The server never paints a heat number here: the numbers come from the
// lifecycle response the transition itself returned.
const bagMoveCallout = (): string => `<section class="heat-bag bag-move" data-bag-move hidden aria-live="assertive" aria-label="Move ducks between heat bags">
        <p class="heat-bag-instruction" data-bag-move-instruction></p>
        <p class="heat-bag-number" data-bag-move-number></p>
        <p class="heat-bag-duck" data-bag-move-ducks></p>
        <p class="heat-bag-note" data-bag-move-note></p>
        <div class="actions"><button class="button secondary station-control" type="button" data-bag-move-dismiss>Done — the bags match the heats</button></div>
      </section>`;

// The page for a signed-in staff account that holds no operational role at all.
//
// `/staff` is the return target of staff sign-in, so it can never refuse this
// account, and there is no station to send it to either. It used to be handed
// the Admin console shell: an empty menu bar, no displayed view, and a message
// line nothing would ever resolve. This is a real page instead. It says exactly
// what is missing, who grants it, and offers the two things that do work — the
// public site and signing out. It carries no console client and no live
// surface, so it holds no socket either.
//
// It therefore carries no `data-live-staff` marker. That marker is what the live
// hub looks for to decide a page has a staff surface worth revalidating, and it
// was here only because this panel was copied from the console shell. It changed
// nothing while the page loads no script, but a marker that contradicts the
// sentence above is a trap for the first person who adds one.
export const renderStaffNoAccess = (
  displayName: string,
  phase: PublicPhase = "PREPARING",
): string => page({
  title: "Staff access",
  description: "Protected QuickDucks staff account without operational roles.",
  robots: "noindex,nofollow",
  phase,
  content: `
    <section class="page-panel operations-panel staff-panel" data-staff-no-access data-system-admin="false" data-roles="">
      ${duck()}
      <p class="eyebrow">Staff account</p>
      <h1 class="page-title operations-title">No operational roles assigned.</h1>
      <p class="lede">You are signed in, but this account holds no race-day role yet, so there is no station for it to open.</p>
      <div class="notice"><strong>Ask a system administrator to assign the station roles this account needs.</strong> Registration, duck manager, announcer, heat runner, result taker, and race director each open their own page, and signing in again picks the first one up as soon as one is granted.</div>
      <div class="actions"><a class="button secondary" href="/">Back to public site</a></div>
      ${staffFooter(displayName)}
    </section>`,
});

// The one copy of the participants surface: the filter form, the walk-up card,
// the participant list, and the detail card with its edit form, duck-name form
// and action row. The Admin console's Participants view and `/staff/registration`
// both render exactly this, so the console client binds identical hooks on
// either page and the registration desk can never drift from the console.
const participantsSurface = (): string => `
        <form class="operation-card" data-participant-filter-form>
          <div class="field-grid"><label>Search<input name="q" maxlength="80" placeholder="Name, code, email, or phone"></label><label>Status<select name="status"><option value="">All statuses</option><option value="SUBMITTED">Submitted</option><option value="ACTIVE">Active</option><option value="WITHDRAWN">Withdrawn</option><option value="DISQUALIFIED">Disqualified</option></select></label></div>
          <div class="field-grid"><label>Created via<select name="createdVia"><option value="">Public and staff</option><option value="PUBLIC">Public</option><option value="STAFF">Staff walk-up</option></select></label><label>Assignment<select name="assignment"><option value="">Assigned and unassigned</option><option value="ASSIGNED">Assigned</option><option value="UNASSIGNED">Unassigned</option></select></label></div>
          <button class="button secondary" type="submit">List participants</button>
        </form>
        <div class="console-grid wide">
          <div><details class="operation-card" data-walkup-card><summary>Add walk-up participant</summary>
            <p class="muted" data-walkup-availability aria-live="polite">Checking walk-up availability…</p>
            <form data-walkup-form>
              <div class="field-grid"><label>First name<input name="firstName" maxlength="80" required></label><label>Last name<input name="lastName" maxlength="80" required></label></div>
              <div class="field-grid"><label>Email<input name="email" type="email" maxlength="254"></label><label>Phone<input name="phone" type="tel" maxlength="32"></label></div>
              <label>Staff notes<textarea name="notes" maxlength="2000"></textarea></label>
              <button class="button" type="submit">Create walk-up</button>
            </form><p class="private-result muted" data-walkup-result aria-live="polite"></p>
          </details><div class="data-list" data-participant-list></div></div>
          <article class="operation-card" tabindex="-1" data-participant-detail hidden>
            <h3 data-participant-name>Participant detail</h3><dl class="facts compact-facts" data-participant-facts></dl>
            <form data-participant-duck-name-form hidden><label>Duck name<input name="duckName" maxlength="${DUCK_NAME_MAX_LENGTH}" autocomplete="off" required placeholder="Sir Quacks-a-Lot"><span>Shown publicly beside the duck’s number. Staff names go through the same wordlist as a participant’s own.</span></label><button class="button secondary" type="submit">Save duck name</button></form>
            <form data-participant-edit-form>
              <div class="field-grid"><label>First name<input name="firstName" maxlength="80" required></label><label>Last name<input name="lastName" maxlength="80" required></label></div>
              <div class="field-grid"><label>Email<input name="email" type="email" maxlength="254"></label><label>Phone<input name="phone" type="tel" maxlength="32"></label></div>
              <label>Staff notes<textarea name="notes" maxlength="2000"></textarea></label>
              <button class="button secondary" type="submit">Save participant details</button>
            </form>
            <div class="actions" data-participant-actions></div>
          </article>
        </div>`;

// The Admin view. Its menu bar switches between four separate views —
// Event Details, Heats, Participants, Support — and links out to the Inventory
// and Access pages. Exactly one view is displayed at a time; the sections keep
// their existing event-scope and role gating, and the switcher only ever chooses
// among the sections that gating already permits.
//
// `/staff` serves it to exactly the actors `canOpenAdminConsole` admits: system
// administrators and race directors. An account with no operational role at all
// has no console to render — an empty menu bar over no displayed view, with a
// message line nothing would ever resolve — so it is handed the one real page
// for that state instead. That is a single answer rather than two, which is why
// the delegation lives here as well as in the route.
export const renderStaffHome = (
  displayName: string,
  isSystemAdmin: boolean,
  roles: readonly OperationalRole[],
  phase: PublicPhase = "PREPARING",
): string => {
  if (!isSystemAdmin && roles.length === 0) return renderStaffNoAccess(displayName, phase);
  const hasRole = (role: OperationalRole): boolean => isSystemAdmin || roles.includes(role);
  const canRegistration = hasRole("REGISTRATION") || hasRole("RACE_DIRECTOR");
  const canRaceRead = hasRole("ANNOUNCER") || hasRole("HEAT_RUNNER")
    || hasRole("RESULT_TAKER") || hasRole("RACE_DIRECTOR");
  return page({
  title: "Staff tools",
  description: "Protected QuickDucks staff race operations.",
  robots: "noindex,nofollow",
  phase,
  content: `
    <section class="page-panel operations-panel staff-panel" data-operations-root data-live-staff data-system-admin="${isSystemAdmin ? "true" : "false"}" data-roles="${escapeHtml(roles.join(","))}">
      ${staffNav(isSystemAdmin, roles, "/staff")}
      ${bagMoveCallout()}
      ${duck()}
      <p class="eyebrow">Staff operations</p>
      <h1 class="page-title operations-title">Race control, in one place.</h1>
      <p class="lede">Open the duck’s NFC or QR tag. QuickDucks will take you to pairing when it is available, or inspection when it is already assigned.</p>
      <div class="notice"><strong>Pairing order matters.</strong> Let the participant choose a physical duck, scan that duck, then find the participant by their short code or name.</div>
      ${adminMenu(isSystemAdmin, roles)}
      <p class="message-line muted" data-console-message aria-live="polite">Loading operations…</p>

      <section class="console-section" id="event" aria-labelledby="event-title" data-console-view="event" data-role-allowed="true">
        <p class="eyebrow">Event control</p><h2 id="event-title">Event Details</h2>
        <div class="notice" data-no-race hidden><strong>No race yet.</strong> <span>Create the race event to open participants, inventory, heats, and support. Until then this is the only view with anything to do.</span></div>
        ${isSystemAdmin ? `<details class="operation-card event-create-card" data-event-create-card hidden><summary>Create event</summary>
          <form data-event-create-form>
            <label>Event name<input name="name" maxlength="120" required placeholder="Annual Duck Race"></label>
            <label>URL slug preview<input data-event-create-slug-preview maxlength="80" readonly placeholder="Generated from event name"><span>Generated automatically when the event is saved.</span></label>
            <label>Event date<input name="eventDate" type="text" inputmode="none" autocomplete="off" data-app-date-picker="date" required placeholder="Choose date"></label>
            <label>Timezone<select name="timezone" data-timezone-select data-timezone-detect="true" data-app-select-search="true" required><option value="UTC">UTC</option></select><span>Detected from this device. Open the list and type to search every zone.</span></label>
            <label>Ducks per heat<input name="roundOneHeatCapacity" type="number" min="3" max="10000" step="1" required placeholder="10"><span>How many ducks race together in each round-one heat, at least 3. Ducks are placed into heats in pairing order, and this can change only while the event is still a draft.</span></label>
            <button class="button" type="submit">Create draft event</button>
          </form>
        </details>` : ""}
        <div class="section-tools">
          <label>Working event<select data-event-select aria-label="Working event"><option value="">Loading events…</option></select></label>
          <button class="button secondary small" type="button" data-refresh-event>Refresh event</button>
        </div>
        <p class="empty-state" data-event-empty hidden>Create a draft event to begin.</p>
        <div class="event-detail" role="region" aria-labelledby="event-detail-title" data-event-detail hidden>
          <h3 class="event-detail-title" id="event-detail-title">Selected event details</h3>
          <dl class="facts compact-facts" data-event-summary></dl>
          <div class="console-grid">
            ${isSystemAdmin ? `<details class="operation-card" data-event-config-card hidden><summary>Configure draft</summary>
              <form data-event-config-form>
                <div class="field-grid"><label>Event name<input name="name" maxlength="120" required></label><label>URL slug preview<input data-event-config-slug-preview maxlength="80" readonly placeholder="Generated from event name"><span>Changes automatically when the event name changes.</span></label></div>
                 <div class="field-grid"><label>Event date<input name="eventDate" type="text" inputmode="none" autocomplete="off" data-app-date-picker="date" placeholder="Choose date"></label><label>Timezone<select name="timezone" data-timezone-select data-app-select-search="true" required><option value="UTC">UTC</option></select></label></div>
                 <div class="field-grid"><label>Registration opens<input name="registrationOpensAt" type="text" inputmode="none" autocomplete="off" data-app-date-picker="datetime" placeholder="Choose date and time"></label><label>Registration closes<input name="registrationClosesAt" type="text" inputmode="none" autocomplete="off" data-app-date-picker="datetime" placeholder="Choose date and time"></label></div>
                <label class="check"><input name="emailRequired" type="checkbox"><span class="label-text">Require participant email</span></label>
                <label>Public names<select name="publicNamePolicy"><option value="FIRST_NAME_ONLY">First name</option><option value="FIRST_NAME_LAST_INITIAL">First name and last initial</option><option value="FULL_NAME">Full name</option></select></label>
                <div class="field-grid"><label>Ducks per heat<input name="roundOneHeatCapacity" type="number" min="3" max="10000" required><span>At least 3, so every heat is a real race.</span></label><label>Final capacity<input name="finalHeatCapacity" type="number" min="1" max="10000" required></label></div>
                <button class="button" type="submit">Save draft configuration</button>
              </form>
            </details>` : ""}
            <article class="operation-card"><h3>Readiness and lifecycle</h3><p class="muted">${canRaceRead ? "Every transition is checked again by the server." : "Use your assigned station section for operational work."}</p><div class="data-list" data-event-readiness></div></article>
            ${isSystemAdmin ? `<article class="operation-card danger-zone" data-force-delete-card hidden>
              <h3>Delete event</h3><p class="muted">Administrator-only. Permanently deletes this event and every record for it in any state.</p>
              <button class="button danger" type="button" data-open-force-delete>Delete event</button>
            </article>
            <dialog class="app-confirmation event-delete-dialog" data-force-delete-dialog aria-labelledby="force-delete-title">
              <form data-force-delete-form>
                <p class="eyebrow">Administrator only</p><h2 id="force-delete-title">Permanently delete this event?</h2>
                <p class="app-confirmation-message">This is the only way to clear a race. It permanently deletes the event and every registration, duck, tag, heat, result, notification, command, and audit record. This cannot be undone.</p>
                <label>Type <strong data-force-delete-event-name></strong> to confirm<input name="confirmName" maxlength="120" required autocomplete="off"></label>
                <p class="message-line muted" data-force-delete-message aria-live="polite"></p>
                <div class="app-confirmation-actions"><button class="button secondary" type="button" data-cancel-force-delete>Cancel</button><button class="button danger" type="submit" disabled>Delete event</button></div>
              </form>
            </dialog>` : ""}
          </div>
        </div>
      </section>

      <section class="console-section" id="participants" aria-labelledby="participants-title" data-console-view="participants" data-event-scoped data-role-allowed="${canRegistration ? "true" : "false"}" hidden>
        <p class="eyebrow">Registration desk</p><h2 id="participants-title">Participants</h2>${participantsSurface()}
      </section>

      <section class="console-section" id="heats" aria-labelledby="heats-title" data-console-view="heats" data-event-scoped data-role-allowed="${canRaceRead ? "true" : "false"}" hidden>
        <p class="eyebrow">Race control</p><h2 id="heats-title">Heats and results</h2>
        <div class="console-grid" data-finalist-card hidden>
          <article class="operation-card"><h3>Finalists</h3><p class="muted">The current round-one winners promoted into the final.</p><div class="data-list" data-finalist-list></div></article>
        </div>
        <div class="section-tools"><button class="button secondary small" type="button" data-refresh-heats>Refresh heats</button></div>
        <div class="console-grid wide"><div class="data-list" data-heat-list></div><article class="operation-card" data-heat-detail hidden><h3 data-heat-name>Heat detail</h3><dl class="facts compact-facts" data-heat-facts></dl><div data-heat-controls></div><h3>Roster</h3><ul class="roster-list" data-heat-roster></ul><h3>Published results</h3><div class="data-list" data-heat-results></div></article></div>
      </section>

      ${isSystemAdmin ? `<section class="console-section" id="support" aria-labelledby="support-title" data-support data-console-view="support" data-event-scoped data-role-allowed="true" hidden>
        <p class="eyebrow">Administrator support</p><h2 id="support-title">Support</h2>
        <div class="privacy"><strong>Administrator-only diagnostics.</strong><span>Notification actions and audit records are intentionally explicit. Clearing a race is done with Delete event in the Event Details view.</span></div>
        <div class="console-grid"><article class="operation-card"><h3>Operational summary</h3><button class="button secondary small" type="button" data-refresh-support>Refresh summary</button><dl class="facts compact-facts" data-support-summary></dl></article></div>
        <details class="operation-card"><summary>Notification operations</summary><form class="section-tools" data-notification-filter-form><label>Status<select name="status"><option value="">All statuses</option><option value="WAITING_FOR_SYNC">Waiting for sync</option><option value="PENDING">Pending</option><option value="QUEUED">Queued</option><option value="SENDING">Sending</option><option value="SENT">Sent</option><option value="RETRY_PENDING">Retry pending</option><option value="DELIVERED">Delivered</option><option value="FAILED">Failed</option><option value="BOUNCED">Bounced</option><option value="COMPLAINED">Complained</option><option value="SUPPRESSED">Suppressed</option><option value="CANCELLED">Cancelled</option></select></label><button class="button secondary small" type="submit">Load notifications</button></form><div class="console-grid wide"><div class="data-list" data-notification-list></div><div class="data-list" data-notification-attempts></div></div></details>
        <details class="operation-card"><summary>Redacted audit timeline</summary><button class="button secondary small" type="button" data-refresh-audit>Load audit</button><div class="data-list" data-audit-list></div></details>
      </section>` : ""}
      <script src="/assets/app-select.js" defer></script>
      <script src="/assets/app-date-picker.js" defer></script>
      <script src="/assets/staff-home.js" defer></script>
      ${staffFooter(displayName)}
    </section>`,
  });
};

// The registration desk. It is the page a registration staffer lands on, so it
// leads with how to register somebody in race-day language and then carries the
// same participants surface the Admin console's Participants view renders.
//
// It runs the console client (`staff-home.js`), which is why the working-event
// picker is here: participants belong to an event, so the client has to resolve
// one before it can list anybody. Every section of that client initialises
// defensively, so the heats, support, and event-detail code it also contains
// simply finds nothing to bind to here.
export const renderStaffRegistration = (
  displayName: string,
  isSystemAdmin = false,
  roles: readonly OperationalRole[] = [],
  phase: PublicPhase = "PREPARING",
): string => {
  const canRegistration = isSystemAdmin
    || roles.includes("REGISTRATION") || roles.includes("RACE_DIRECTOR");
  return page({
    title: "Registration",
    description: "Protected QuickDucks registration desk.",
    robots: "noindex,nofollow",
    phase,
    content: `
    <section class="page-panel operations-panel staff-panel" data-staff-registration data-operations-root data-live-staff data-system-admin="${isSystemAdmin ? "true" : "false"}" data-roles="${escapeHtml(roles.join(","))}">
      ${staffNav(isSystemAdmin, roles, "/staff/registration")}
      <p class="eyebrow">Registration desk</p>
      <h1 class="page-title operations-title">Get people into the race.</h1>
      <p class="lede">There are two jobs here. Register someone who walks up without a registration, and hand a registered participant the duck they picked.</p>
      <div class="notice"><strong>Pairing order matters.</strong> Let the participant choose a physical duck, scan that duck, then find the participant by their short code or name.</div>
      <div class="console-grid">
        <article class="operation-card" data-walkup-guide>
          <h2>Someone walked up</h2>
          <p class="muted">They have not registered on their phone. Register them here, then pair them with a duck.</p>
          <p class="muted">During Round One, this remains available only until the final unstarted heat begins.</p>
          <ol class="staff-steps">
            <li>Open <strong>Add walk-up participant</strong> below.</li>
            <li>Type their first and last name. Email and phone are optional.</li>
            <li>Press <strong>Create walk-up</strong>.</li>
            <li>Read them the short lookup code QuickDucks shows, or hand them the private status link.</li>
            <li>Now pair them with a duck, exactly as below.</li>
          </ol>
        </article>
        <article class="operation-card">
          <h2>Give them their duck</h2>
          <p class="muted">Never pick the duck for them, and never pair before the duck is in their hands.</p>
          <ol class="staff-steps">
            <li>Let the participant choose the physical duck they want.</li>
            <li>Scan that duck’s NFC tag or QR tag with this device.</li>
            <li>QuickDucks opens the duck. Find the participant by their short lookup code or their name.</li>
            <li>Check the participant and the duck number together on screen.</li>
            <li>Press <strong>Confirm duck pairing</strong>. The duck now goes in the heat bag.</li>
          </ol>
        </article>
      </div>
      <div class="section-tools">
        <label>Working event<select data-event-select aria-label="Working event"><option value="">Loading events…</option></select></label>
        <button class="button secondary small" type="button" data-refresh-event>Refresh event</button>
      </div>
      <p class="message-line muted" data-console-message aria-live="polite">Loading participants…</p>
      <div class="notice" data-no-race hidden><strong>No race yet.</strong> <span>An administrator creates the race event from the Admin console. Registrations belong to an event, so nothing can be registered until one exists.</span></div>

      <section class="console-section" id="participants" aria-labelledby="registration-participants-title" data-event-scoped data-role-allowed="${canRegistration ? "true" : "false"}" hidden>
        <p class="eyebrow">Everyone in this race</p><h2 id="registration-participants-title">Participants</h2>${participantsSurface()}
      </section>
      <script src="/assets/app-select.js" defer></script>
      <script src="/assets/staff-home.js" defer></script>
      ${staffFooter(displayName)}
    </section>`,
  });
};

// Staff account and role management is event-independent, so it lives on its own
// administrator page. The markup keeps the exact hooks the access client binds.
// The route is administrator-only, so the flag defaults to an administrator; the
// rendered authorization projection still carries the actor's real values so the
// live staff-session revalidation behaves exactly as on the other staff pages.
export const renderStaffAccess = (
  displayName: string,
  isSystemAdmin = true,
  roles: readonly OperationalRole[] = [],
  phase: PublicPhase = "PREPARING",
): string => page({
  title: "Staff access",
  description: "Protected QuickDucks staff account and role management.",
  robots: "noindex,nofollow",
  phase,
  content: `
    <section class="page-panel operations-panel staff-panel" data-staff-access data-live-staff data-system-admin="${isSystemAdmin ? "true" : "false"}" data-roles="${escapeHtml(roles.join(","))}">
      ${staffNav(isSystemAdmin, roles, "/staff/access")}
      ${isSystemAdmin ? adminMenu(isSystemAdmin, roles, "/staff/access") : ""}
      ${duck()}
      <p class="eyebrow">Administrator</p>
      <h1 class="page-title operations-title">Staff access</h1>
      <p class="lede">Invite staff, combine operational roles, or disable and restore Cognito access. This page does not depend on a race event.</p>
      <div class="privacy"><strong>Roles are composable.</strong><span>Give regular staff every station role they need and no others. Administrators implicitly have every permission and do not have role assignments.</span></div>
      <details class="operation-card" data-staff-access-create-card><summary>Add staff access</summary>
        <form data-staff-access-form><div class="field-grid"><label>Email address<input name="email" type="email" autocomplete="off" maxlength="254" required></label><label>Display name<input name="displayName" autocomplete="off" maxlength="100" required></label></div><label>Account type<select name="role" required><option value="STAFF">Regular staff</option><option value="ADMIN">System administrator</option></select></label><fieldset class="role-set" data-create-role-set><legend>Operational roles</legend>${roleCheckboxes}</fieldset><button class="button" type="submit">Add staff access</button></form>
      </details>
      <p class="message-line muted" data-staff-access-message aria-live="polite">Loading authorized staff…</p><div class="staff-access-list" data-staff-access-list></div>
      <script src="/assets/app-select.js" defer></script>
      <script src="/assets/staff-access.js" defer></script>
      ${staffFooter(displayName)}
    </section>`,
});

export const renderStartLine = (
  displayName: string,
  interactive = true,
  isSystemAdmin = false,
  roles: readonly OperationalRole[] = [],
  phase: PublicPhase = "PREPARING",
): string => page({
  title: "Start line",
  description: "Focused protected QuickDucks start-line station.",
  robots: "noindex,nofollow",
  phase,
  content: `<section class="page-panel station-panel staff-panel" data-start-line${interactive ? " data-live-staff" : ""} data-system-admin="${isSystemAdmin ? "true" : "false"}" data-roles="${escapeHtml(roles.join(","))}">
    ${staffNav(isSystemAdmin, roles, "/staff/start-line")}
    <p class="eyebrow">Start-line station</p><h1 class="page-title">Prepare the next heat.</h1>
    <p class="lede" data-station-event>Finding the active event and next heat.</p>
    <h2 data-station-heat>No heat selected</h2><dl class="facts compact-facts" data-station-facts></dl>
    <h3>Roster</h3><ul class="station-roster" data-station-roster><li>Waiting for the official roster.</li></ul>
    <div class="station-action" data-station-action></div>
    <p class="message-line muted" data-station-message aria-live="polite">This station can only ready, call, or start a heat.</p>
    ${interactive ? '<script src="/assets/start-line.js" defer></script>' : ""}
    ${staffFooter(displayName)}
  </section>`,
});

// The announcer holds a microphone, so this station is a script, not a console.
// It reads three authoritative APIs and writes nothing: there is no form, no
// button, and no command hook anywhere in this markup. Everything on it is
// either the heat to read out now or a result the finish line already recorded.
export const renderAnnouncer = (
  displayName: string,
  interactive = true,
  isSystemAdmin = false,
  roles: readonly OperationalRole[] = [],
  phase: PublicPhase = "PREPARING",
): string => page({
  title: "Announcer",
  description: "Focused protected QuickDucks announcer station.",
  robots: "noindex,nofollow",
  phase,
  content: `<section class="page-panel station-panel staff-panel announcer-panel" data-announcer${interactive ? " data-live-staff" : ""} data-system-admin="${isSystemAdmin ? "true" : "false"}" data-roles="${escapeHtml(roles.join(","))}">
    ${staffNav(isSystemAdmin, roles, "/staff/announcer")}
    <p class="eyebrow">Announcer station</p><h1 class="page-title">Read this out loud.</h1>
    <p class="lede" data-station-event>Finding the active event.</p>
    <section class="announcer-section" aria-labelledby="announcer-now-title">
      <p class="eyebrow">On the microphone now</p>
      <h2 id="announcer-now-title" data-announcer-heat>No heat is up yet</h2>
      <p class="announcer-cue" data-announcer-cue>The racers to announce will appear here.</p>
      <ol class="announcer-roster" data-announcer-roster><li>Waiting for the official roster.</li></ol>
    </section>
    <section class="announcer-section" aria-labelledby="announcer-podium-title" data-announcer-podium hidden>
      <p class="eyebrow">Official podium</p>
      <h2 id="announcer-podium-title">The final is decided</h2>
      <ol class="podium" data-announcer-podium-list></ol>
    </section>
    <section class="announcer-section" aria-labelledby="announcer-decided-title">
      <p class="eyebrow">Already decided</p>
      <h2 id="announcer-decided-title">Recorded winners</h2>
      <p class="announcer-progress" data-announcer-progress>Waiting for the first official result.</p>
      <ol class="announcer-results" data-announcer-results></ol>
      <p class="empty-state" data-announcer-results-empty>No winner has been recorded yet. Each one appears here the moment the finish line records it.</p>
    </section>
    <p class="message-line muted" data-station-message aria-live="polite">This station only reads. It never changes the race.</p>
    ${interactive ? '<script src="/assets/announcer.js" defer></script>' : ""}
    ${staffFooter(displayName)}
  </section>`,
});

export const renderFinishLine = (
  displayName: string,
  interactive = true,
  isSystemAdmin = false,
  roles: readonly OperationalRole[] = [],
  phase: PublicPhase = "PREPARING",
): string => page({
  title: "Finish line",
  description: "Focused protected QuickDucks finish-line station.",
  robots: "noindex,nofollow",
  phase,
  content: `<section class="page-panel station-panel staff-panel" data-finish-line${interactive ? " data-live-staff" : ""} data-system-admin="${isSystemAdmin ? "true" : "false"}" data-roles="${escapeHtml(roles.join(","))}">
    ${staffNav(isSystemAdmin, roles, "/staff/finish-line")}
    <p class="eyebrow">Finish-line station</p><h1 class="page-title">Record one official result.</h1>
    <p class="lede" data-station-event>Finding a running heat.</p>
    <h2 data-station-heat>No heat selected</h2><dl class="facts compact-facts" data-station-facts></dl>
    <h3>Authoritative roster</h3><ul class="station-roster" data-station-roster><li>Waiting for the official roster.</li></ul>
    <div class="station-action" data-finish-action></div>
    <section class="station-ineligible" data-finish-ineligible hidden aria-live="assertive" aria-label="Duck that cannot be recorded"></section>
    <form data-finish-scan-form hidden>
      <label>Tag URL or duck number<input class="station-control" name="duck" autocomplete="off" inputmode="url" maxlength="512" required placeholder="https://quickducks.com/t/… or 128"><span>Scan or paste the complete QuickDucks tag URL, or enter the number printed on the duck.</span></label>
      <div class="actions"><button class="button secondary station-control" type="submit">Add this duck</button><button class="button secondary station-control" type="button" data-start-nfc hidden>Scan NFC tag</button></div>
    </form>
    <div class="data-list" data-finish-selections></div>
    <button class="button station-control" type="button" data-submit-result hidden disabled>Submit official result</button>
    <p class="message-line muted" data-station-message aria-live="polite">A scan only selects a duck. Nothing is submitted until you press the final button.</p>
    ${interactive ? '<script src="/assets/finish-line.js" defer></script>' : ""}
    ${staffFooter(displayName)}
  </section>`,
});

// The whole of inventory on one page: the duck list and its detail panel, which
// used to be a console section, plus the blank-sticker scanning station, which
// used to be a separate Android-only page.
//
// The page itself is not device gated. Every device that can sign in can read
// inventory, select a duck, and run every inventory command; only the scanning
// station is conditional, and it explains itself in place rather than replacing
// the page with a compatibility notice that also took the staff navigation with
// it.
export const renderStaffInventory = (
  displayName: string,
  appOrigin: string,
  isSystemAdmin = false,
  roles: readonly OperationalRole[] = [],
  phase: PublicPhase = "PREPARING",
): string => page({
  title: "Inventory",
  description: "Protected QuickDucks duck inventory and NFC provisioning.",
  robots: "noindex,nofollow",
  phase,
  content: `
    <section class="page-panel operations-panel staff-panel" data-staff-inventory data-live-staff data-system-admin="${isSystemAdmin ? "true" : "false"}" data-roles="${escapeHtml(roles.join(","))}" data-app-origin="${escapeHtml(appOrigin)}">
      ${staffNav(isSystemAdmin, roles, "/staff/inventory")}
      ${canOpenAdminConsole(isSystemAdmin, roles) ? adminMenu(isSystemAdmin, roles, "/staff/inventory") : ""}
      <p class="eyebrow">Physical ducks</p>
      <h1 class="page-title operations-title">Inventory</h1>
      <p class="lede">Every duck QuickDucks knows about. Scan a blank sticker to add one; scan a duck already in inventory and it opens here.</p>
      <div class="section-tools">
        <label>Working event<select data-event-select aria-label="Working event"><option value="">Loading events…</option></select></label>
        <button class="button secondary small" type="button" data-refresh-inventory>Refresh inventory</button>
      </div>
      <p class="message-line muted" data-console-message aria-live="polite">Loading inventory…</p>
      <div class="notice" data-no-race hidden><strong>No race yet.</strong> <span>An administrator creates the race event on the staff console. Ducks are reserved for an event, so inventory work starts there.</span></div>

      <section class="console-section" id="scan" aria-labelledby="scan-title" data-intake-station>
        <p class="eyebrow">Blank sticker station</p><h2 id="scan-title">Scan ducks</h2>
        <div class="notice" data-intake-runtime aria-live="polite"><strong>Checking this device.</strong> <span data-intake-runtime-message>Scanning stays unavailable until this device’s NFC requirements are confirmed. Everything else on this page still works.</span></div>
        <div data-intake-controls hidden>
          <p class="lede">Press Start once. Then hold one blank writable NFC sticker to this device until success, remove it, and present the next duck. A sticker already in inventory opens its duck below instead.</p>
          <label>Station location (optional)<input data-intake-location maxlength="100" autocomplete="off" placeholder="Intake table"><span>This one location is applied automatically to stickers provisioned during this station run.</span></label>
          <div class="actions">
            <button class="button station-control" type="button" data-start-intake-nfc>Start NFC provisioning</button>
            <button class="button secondary station-control" type="button" data-end-intake-nfc hidden disabled>End NFC provisioning</button>
          </div>
          <article class="operation-card danger-zone" data-intake-takeover hidden>
            <h3>Abandoned sticker recovery</h3>
            <p class="muted" data-intake-takeover-message></p>
            <p>Race directors and administrators can explicitly take ownership. Do this only after confirming the previous station is no longer working on the sticker.</p>
            <button class="button danger" type="button" data-takeover-provisioning>Take over pending sticker</button>
          </article>
          <article class="operation-card station-state" role="status" aria-live="polite" aria-atomic="true"><p class="eyebrow">Station state</p><h3 data-intake-state>Not started</h3><p class="message-line muted" data-intake-message>Press Start once when you are ready to scan.</p></article>
          <div class="station-counters" aria-label="Inventory counts">
            <div class="station-counter"><span>Reserved for race</span><strong data-reserved-count>0</strong></div>
            <div class="station-counter"><span>Added this session</span><strong data-session-count>0</strong></div>
          </div>
          <details class="operation-card"><summary>Session history</summary>
            <p class="muted">Only provisioning outcomes appear here. Permanent URLs and tokens are never displayed or stored by the browser.</p>
            <ul class="station-history" data-intake-history><li>No ducks added in this page session.</li></ul>
          </details>
        </div>
      </section>

      <section class="console-section" id="ducks" aria-labelledby="ducks-title">
        <p class="eyebrow">Duck records</p><h2 id="ducks-title">Ducks</h2>
        <p class="muted">Assigning an available duck reserves it for the working event automatically; there is no separate reserve command.</p>
        <details class="operation-card"><summary>Add a duck by hand</summary>
          <p class="muted">For a tag that is already written, or a device that cannot scan. Scanning a blank sticker does all of this in one tap.</p>
          <form data-inventory-intake-form>
            <label>Visible duck number<input name="visibleNumber" type="number" min="1" max="999999999" required></label>
            <label>Tag token<input name="tagToken" minlength="22" maxlength="128" pattern="[A-Za-z0-9_\\-]+" required autocomplete="off"><span>Read or write the physical NFC/QR token before intake.</span></label>
            <div class="field-grid"><label>Storage location<input name="location" maxlength="100"></label><label>Notes<input name="notes" maxlength="1000"></label></div>
            <label class="check"><input name="physicallyPresent" type="checkbox" required><span class="label-text">I have the physical duck and tag in hand.</span></label>
            <button class="button" type="submit">Add duck</button>
          </form>
        </details>
        <div class="inventory-layout"><div class="data-list inventory-card-grid" data-inventory-list></div>
          <aside class="operation-card inventory-detail-panel" id="inventory-detail-panel" role="region" aria-labelledby="inventory-detail-title" data-inventory-detail hidden>
            <div class="inventory-detail-heading"><h3 id="inventory-detail-title" data-inventory-name>Duck detail</h3><button class="button secondary small" type="button" data-close-inventory-detail>Close</button></div><dl class="facts compact-facts" data-inventory-facts></dl>
            <div class="actions"><button class="button secondary small" type="button" data-print-label>Open label data</button><span class="muted" data-label-result></span></div>
            <form class="operation-card" data-inventory-duck-name-form hidden><h3>Duck name</h3><label>Name shown beside the number<input name="duckName" maxlength="${DUCK_NAME_MAX_LENGTH}" autocomplete="off" required placeholder="Sir Quacks-a-Lot"><span>Public. Staff names go through the same wordlist as a participant’s own.</span></label><div class="actions"><button class="button secondary small" type="submit">Save duck name</button><button class="button danger small" type="button" data-clear-duck-name hidden>Clear name</button></div></form>
            <details class="operation-card"><summary>Assign or reassign duck</summary><form data-inventory-assign-form><label>Participant race-entry ID<input name="raceEntryId" maxlength="128" required></label><label>Reason<input name="reason" minlength="4" maxlength="500" required placeholder="Walk-up pairing correction"></label><button class="button" type="submit">Assign selected duck</button></form></details>
            <form class="operation-card" data-inventory-unassign-form hidden><h3>Unpair duck</h3><label>Reason<input name="reason" minlength="4" maxlength="500" required></label><label class="check"><input name="releaseReservation" type="checkbox"><span class="label-text">Also release this duck from the event</span></label><button class="button danger" type="submit">Unpair duck</button></form>
            <form class="operation-card" data-reservation-release-form hidden><h3>Release event reservation</h3><label>Reason<input name="reason" minlength="4" maxlength="500" required></label><button class="button danger" type="submit">Release reservation</button></form>
            <details class="operation-card danger-zone"><summary>Delete duck</summary>
              <p class="muted" data-delete-duck-effect>Removes this duck from inventory and retires its tag. This cannot be undone.</p>
              <form data-duck-delete-form><label>Reason<input name="reason" minlength="4" maxlength="500" required></label><button class="button danger" type="submit">Delete duck</button></form>
            </details>
            <details class="operation-card"><summary>History</summary><div class="data-list" data-inventory-history></div></details>
          </aside>
        </div>
      </section>
      <script src="/assets/app-select.js" defer></script>
      <script src="/assets/staff-inventory.js" defer></script>
      ${staffFooter(displayName)}
    </section>`,
});

export const renderStaffDuck = (
  token: string,
  displayName: string,
  isSystemAdmin = false,
  roles: readonly OperationalRole[] = [],
  phase: PublicPhase = "PREPARING",
): string => {
  const canPair = roles.length === 0 || isSystemAdmin || roles.includes("REGISTRATION") || roles.includes("RACE_DIRECTOR");
  return page({
  title: "Staff duck scan",
  description: "Protected QuickDucks duck pairing and inspection.",
  robots: "noindex,nofollow",
  phase,
  content: `
    <section class="page-panel operations-panel staff-panel" data-staff-duck data-live-staff data-system-admin="${isSystemAdmin ? "true" : "false"}" data-roles="${escapeHtml(roles.join(","))}" data-token="${escapeHtml(token)}">
      ${staffNav(isSystemAdmin, roles)}
      ${canPair ? `<section class="heat-bag" data-heat-bag hidden aria-live="assertive" aria-label="Which heat bag this duck goes into">
        <p class="heat-bag-instruction" data-heat-bag-instruction></p>
        <p class="heat-bag-number" data-heat-bag-number></p>
        <p class="heat-bag-duck" data-heat-bag-duck></p>
        <p class="heat-bag-note" data-heat-bag-note></p>
        <div class="actions"><button class="button secondary station-control" type="button" data-heat-bag-dismiss>Done — this duck is in the bag</button></div>
      </section>` : ""}
      <section class="winner-action" data-winner-action hidden aria-live="polite"></section>
      <p class="eyebrow">Protected duck record</p>
      <h1 class="page-title" data-staff-title>Checking this duck…</h1>
      <p class="lede" data-staff-message aria-live="polite">Verifying tag, inventory, and assignment state.</p>
      <dl class="facts" data-duck-summary></dl>
      ${canPair ? `<section class="work-area" data-pairing-work hidden>
        <div class="privacy"><strong>Current event</strong><span data-pairing-event></span></div>
        <div class="actions" data-qr-launch hidden><button class="button" type="button" data-scan-qr>Scan QR code</button></div>
        <section class="qr-scanner" data-qr-scanner hidden aria-label="Participant QR scanner">
          <video class="qr-video" data-qr-video muted playsinline></video>
          <p class="muted" data-qr-message aria-live="polite">Point the camera at the participant's QR code.</p>
          <div class="actions"><button class="button secondary" type="button" data-qr-cancel>Cancel and search manually</button></div>
        </section>
        <form method="post" action="/staff" data-registration-search>
          <label>Participant code, name, phone, or email<input name="query" type="search" enterkeyhint="search" autocomplete="off" maxlength="80" placeholder="ABCD2345, Jamie Rivera, 555-0100, or name@example.com" data-registration-search-input><span>Everyone still waiting for a duck is listed below; typing narrows that list. An exact lookup code pairs immediately. Contact details are visible only to authorized registration staff.</span></label>
          <button class="button secondary" type="submit">Find participant</button>
        </form>
        <p class="muted" data-registration-search-status aria-live="polite">Loading participants who still need a duck…</p>
        <div class="result-list" data-registration-results></div>
        <section class="pairing-confirmation" data-pairing-confirmation aria-label="Pairing confirmation" tabindex="-1">
          <div class="pairing-review" data-pairing-review><p class="muted">Choose one registration to review.</p></div>
          <button class="button" type="button" data-confirm-pairing disabled>Confirm duck pairing</button>
        </section>
      </section>` : ""}
      <script src="/assets/app-select.js" defer></script>
      <script src="/assets/staff-duck.js" defer></script>
      ${staffFooter(displayName)}
    </section>`,
  });
};

export const renderStaffAuthError = (
  message: string,
  access?: { isSystemAdmin: boolean; roles: readonly OperationalRole[] },
): string => page({
  title: "Staff sign-in problem",
  description: "QuickDucks staff authentication could not be completed.",
  robots: "noindex,nofollow",
  content: `<section class="page-panel"${access === undefined ? "" : ` data-live-staff data-system-admin="${access.isSystemAdmin ? "true" : "false"}" data-roles="${escapeHtml(access.roles.join(","))}"`}>${duck()}<p class="eyebrow">Sign-in problem</p><h1 class="page-title">We couldn’t finish signing you in.</h1><div class="notice">${escapeHtml(message)}</div><div class="actions"><a class="button" href="/staff">Try staff sign in again</a><a class="button secondary" href="/">Back to public site</a></div></section>`,
});

export const renderStaffPairing = (phase: PublicPhase = "PREPARING"): string => page({
  title: "Pair Duck #128",
  description: "Protected staff duck-pairing mockup.",
  robots: "noindex,nofollow",
  phase,
  content: `<section class="page-panel"><p class="eyebrow">Protected staff preview</p><h1 class="page-title">Pair Duck #128</h1><p class="lede">This duck is available. Find the participant before confirming the assignment.</p><div class="privacy"><strong>Staff authentication required.</strong><span>Live scans verify the Cognito session and matching staff profile before showing codes or accepting a pairing command.</span></div><div class="facts"><div class="fact"><dt>Duck</dt><dd>#128 · Available</dd></div><div class="fact"><dt>Event</dt><dd>Summer Duck Race</dd></div></div><form><label>Participant code, name, phone, or email<input name="query" autocomplete="off" maxlength="80" placeholder="ABCD2345, Jamie Rivera, 555-0100, or name@example.com"></label><button class="button secondary" type="button">Find participant</button></form><div class="notice"><strong>Final confirmation required.</strong> Pairing shows participant and duck together before an authenticated command changes race data.</div></section>`,
});

// Deliberately phase-free. Every unmatched path reaches this page, including
// bot and scanner traffic, so it runs no current-event query and takes the
// minimal Home-and-Staff navigation of the default Preparing phase. It carries
// no live surface and no `data-live-nav` marker either, so it opens no socket.
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

// The public name-search client. It ships with `/my-ducks`, which is where the
// search now lives: it is the recovery path for a device that lost its saved
// list, not a home-page feature.
export const searchScript = String.raw`
const createText = (tag, text, className) => {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
};

const describeStatus = (status) => {
  if (!status) return "Race status is not currently public.";
  const parts = [];
  if (status.duck) {
    parts.push(typeof status.duckName === "string" && status.duckName.length > 0
      ? status.duckName
      : "Duck #" + status.duck.visibleNumber);
  }
  if (status.assignedHeat.roundOne) parts.push("Heat " + status.assignedHeat.roundOne.number);
  else if (status.duck) parts.push("Heat assignment pending");
  parts.push(status.outcome.replaceAll("_", " ").toLowerCase());
  return parts.join(" · ");
};

// The public name search deliberately carries no lookup code and no private
// token, so a result card renders public race status only.
const myDucksNav = document.querySelector("[data-my-ducks-nav]");
const addedTag = () => createText("span", "In My Ducks", "success-tag");

const addToMyDucks = async (followId, actions, button, feedback) => {
  button.disabled = true;
  button.textContent = "Adding…";
  feedback.textContent = "";
  feedback.hidden = true;
  try {
    const response = await fetch("/api/v1/registrations/mine/follow", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ followId }),
    });
    if (!response.ok) throw new Error("follow failed");
    actions.replaceChildren(addedTag());
    // Record that the device now has saved data. This page is phase-accessible,
    // so My Ducks is already visible in its navigation.
    if (myDucksNav) {
      myDucksNav.dataset.hasRegistrations = "true";
      myDucksNav.hidden = false;
    }
    // The search now shares the My Ducks page, so ask the hub to rerun every
    // subscriber's authoritative refetch; the saved list picks the new entry up
    // from the collection API rather than from this response.
    globalThis.quickDucksLive.markClean(searchForm);
  } catch {
    button.disabled = false;
    button.textContent = "Add to My Ducks";
    feedback.textContent = "That participant could not be added to My Ducks. Please try again.";
    feedback.hidden = false;
  }
};

const followControls = (result) => {
  const actions = createText("div", "", "actions");
  const feedback = createText("p", "", "message-line muted");
  feedback.setAttribute("role", "status");
  feedback.hidden = true;
  if (result.inMyDucks === true) {
    actions.append(addedTag());
    return [actions, feedback];
  }
  const button = createText("button", "Add to My Ducks", "button small");
  button.type = "button";
  button.addEventListener("click", () => addToMyDucks(result.followId, actions, button, feedback));
  actions.append(button);
  return [actions, feedback];
};

const appendStatusCard = (container, result) => {
  const card = createText("article", "", "duck-card");
  card.append(createText("h3", result.participantDisplayName));
  card.append(createText("p", describeStatus(result), "muted"));
  if (result.currentHeat) {
    card.append(createText("p", "Currently running: " + result.currentHeat.round.replaceAll("_", " ").toLowerCase() + " heat " + result.currentHeat.number, "muted"));
  }
  if (typeof result.followId === "string") card.append(...followControls(result));
  container.append(card);
};

const searchForm = document.querySelector("[data-status-search]");
const searchMessage = document.querySelector("[data-search-message]");
const searchResults = document.querySelector("[data-search-results]");
let lastSearchName = null;
let searchBusy = false;
const clearStatusSearchDraft = () => {
  delete searchForm.dataset.liveDirty;
  for (const control of searchForm.querySelectorAll('[data-live-dirty="true"]')) {
    delete control.dataset.liveDirty;
  }
};
const runStatusSearch = async (name) => {
  searchBusy = true;
  searchResults.replaceChildren();
  searchMessage.textContent = "Searching…";
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
    for (const result of results) appendStatusCard(searchResults, result);
    searchMessage.textContent = results.length === 1 ? "1 match found." : results.length + " matches found.";
  } catch {
    searchMessage.textContent = "Status search is temporarily unavailable. Please try again.";
  } finally {
    searchBusy = false;
  }
};
searchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  lastSearchName = String(new FormData(searchForm).get("name"));
  // The shared live runtime marks typed inputs dirty. Clear that draft after the
  // visitor submits it, then put this one authoritative read through the search
  // subscription's own queue. That coalesces any live refresh already waiting
  // behind the draft instead of markClean fanning out another search and an
  // unrelated My Ducks reload. Follow still calls markClean above because its
  // mutation changes both subscribers.
  clearStatusSearchDraft();
  await statusSearchSubscription.refresh();
});
const statusSearchSubscription = globalThis.quickDucksLive.subscribe({
  domains: ["event", "participants", "ducks", "heats"],
  root: searchForm,
  refresh: async () => {
    if (lastSearchName !== null) await runStatusSearch(lastSearchName);
  },
  isBlocked: () => searchBusy,
});
`;

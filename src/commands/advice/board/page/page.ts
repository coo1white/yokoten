// The board page (#603): HTML, CSS and the Lucide icons the page uses, with the script from
// script.ts. One file, nothing loaded from outside, so the board works offline and its
// content policy can forbid everything else. Lucide icons: ISC license, Lucide Contributors.
// The GitHub mark: Octicons, MIT license, GitHub, Inc.

import { BOARD_AGENT_FILE } from '../agents.ts';
import { PAGE_FUNCTIONS } from './script.ts';
import { LANG_NAMES, WORDS } from './words.ts';

/** How often the page asks for new data, in seconds. */
export const BOARD_REFRESH_SECONDS = 15;

const STYLE = `
:root{color-scheme:light;--bg:#fff;--fg:#0a0a0a;--card:#fff;--muted:#f5f5f5;--mut-fg:#6b6b6b;--accent:#f0f0f0;--border:#e5e5e5;--ring:#a1a1a1;--side:#fafafa;--side-accent:#efefef;--panel:#fafafa;
--brand:#b4532a;--ok:#16a34a;--wait:#b45309;--bad:#dc2626;--merged:#8250df;--open:#1a7f37;--radius:10px;
--mono:ui-monospace,'SF Mono',SFMono-Regular,'Cascadia Code',Menlo,Consolas,'Liberation Mono',monospace}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){color-scheme:dark;--bg:#0a0a0a;--fg:#fafafa;--card:#171717;--muted:#262626;--mut-fg:#a1a1a1;--accent:#2a2a2a;--border:rgb(255 255 255/.09);--ring:#737373;--side:#141414;--side-accent:#232323;--panel:#111;--brand:#ec8f6c;--ok:#3fb950;--wait:#e3a33b;--bad:#ff6568;--merged:#a371f7;--open:#3fb950}}
:root[data-theme=dark]{color-scheme:dark;--bg:#0a0a0a;--fg:#fafafa;--card:#171717;--muted:#262626;--mut-fg:#a1a1a1;--accent:#2a2a2a;--border:rgb(255 255 255/.09);--ring:#737373;--side:#141414;--side-accent:#232323;--panel:#111;--brand:#ec8f6c;--ok:#3fb950;--wait:#e3a33b;--bad:#ff6568;--merged:#a371f7;--open:#3fb950}
:root{--wait-bg:color-mix(in srgb,var(--wait) 11%,var(--bg));--bad-bg:color-mix(in srgb,var(--bad) 8%,var(--bg))}
*{box-sizing:border-box}
::selection{background:color-mix(in srgb,var(--brand) 28%,transparent)}
#pinned,#agents,#right,.feed{scrollbar-width:thin;scrollbar-color:var(--muted) transparent}
html,body{margin:0}
:lang(ja){word-break:auto-phrase}
body{font:13px/1.45 ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,'Noto Sans','PingFang SC','Microsoft YaHei',sans-serif;background:var(--bg);color:var(--fg);-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}
button{font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer}
a{color:inherit;text-decoration:none}
:focus-visible{outline:2px solid var(--ring);outline-offset:1px;border-radius:6px}
svg.i{width:16px;height:16px;flex:none;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
svg.i.s{width:14px;height:14px}
.mono{font-family:var(--mono);font-size:12px;display:inline-flex;align-items:center;gap:4px}
.mut,.quiet{color:var(--mut-fg)}
.quiet{margin:6px 8px;font-size:12px}
.grow{flex:1;min-width:0}
.app{display:grid;grid-template-rows:48px 1fr 28px;height:100vh;height:100dvh}
.top{display:flex;align-items:center;gap:10px;padding:0 12px 0 14px;border-bottom:1px solid var(--border);background:var(--side)}
.logo{display:flex;align-items:center;gap:8px;font-weight:600}
.crumb{color:var(--mut-fg)}
.sp{flex:1}
.pill{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 9px;border:1px solid var(--border);border-radius:999px;color:var(--mut-fg);font-size:12px;white-space:nowrap}
.pill .live{width:6px;height:6px;border-radius:50%;background:var(--ok)}
.pill.off .live{background:var(--wait)}
.tools{display:flex;align-items:center;gap:2px;padding-left:8px;margin-left:2px;border-left:1px solid var(--border)}
.tool{height:30px;min-width:30px;padding:0 8px;display:inline-flex;align-items:center;justify-content:center;gap:6px;border-radius:7px;color:var(--mut-fg);font-size:12px;white-space:nowrap}
.tool.icon{padding:0}
.tool:hover,.tool[aria-expanded=true]{background:var(--accent);color:var(--fg)}
.tool svg.gh{fill:currentColor;stroke:none}
.tool[hidden]{display:none}
.menu-wrap{position:relative}
.menu{position:absolute;right:0;top:calc(100% + 6px);z-index:10;min-width:176px;padding:4px;border:1px solid var(--border);border-radius:var(--radius);background:var(--card);box-shadow:0 8px 24px rgb(0 0 0/.16)}
.menu[hidden]{display:none}
.mi{display:flex;align-items:center;gap:8px;width:100%;height:36px;padding:0 10px;border-radius:7px;text-align:left;font-size:13px}
.mi:hover,.mi:focus-visible{background:var(--accent);outline:0}
.mi[aria-checked=true]{color:var(--brand);font-weight:600}
.main{display:grid;grid-template-columns:312px minmax(0,1fr) 360px;grid-template-rows:auto minmax(0,1fr);grid-template-areas:"pinned center right" "agents center right";min-height:0}
#pinned{grid-area:pinned;background:var(--side);border-right:1px solid var(--border);padding:8px 8px 0;max-height:55vh;overflow:auto}
#agents{grid-area:agents;background:var(--side);border-right:1px solid var(--border);padding:0 8px 16px;overflow:auto}
#center{grid-area:center;display:flex;flex-direction:column;min-width:0;min-height:0}
#right{grid-area:right;border-left:1px solid var(--border);background:var(--panel);overflow:auto;padding:4px 12px 16px}
.center-in{display:flex;flex-direction:column;min-height:0;flex:1}
.sh{display:flex;align-items:center;gap:6px;margin:14px 6px 6px;font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--mut-fg)}
.sh.lead-h{margin-top:6px}
.sh .n{font-weight:500;letter-spacing:0;min-width:18px;height:16px;padding:0 5px;border-radius:999px;background:var(--muted);display:inline-grid;place-items:center;font-size:10px}
.sh.need{color:var(--wait)}
h2.sh{line-height:inherit}
.sh .f{display:flex;align-items:center;gap:6px;flex:1;min-width:0;min-height:24px;border-radius:6px;font-weight:inherit;letter-spacing:inherit;text-transform:inherit;text-align:left}
.sh .f:hover{color:var(--fg)}
.sh .f>svg:first-child{width:12px;height:12px;transition:transform .15s}
.sh .f.open>svg:first-child{transform:rotate(90deg)}
.sh .sum{margin-left:auto;text-transform:none;letter-spacing:0;font-weight:400;font-size:11px}
.sh .act,.act{margin-left:auto;font-family:inherit;text-transform:none;letter-spacing:0;font-weight:500;font-size:11px;color:var(--mut-fg);padding:1px 6px;border-radius:5px;cursor:pointer}
.act:hover{background:var(--accent);color:var(--fg)}
.row{display:block;width:100%;text-align:left;padding:8px 8px 9px 10px;border-radius:8px;position:relative;margin-bottom:2px}
.row:hover{background:var(--side-accent)}
.row[aria-current=true]{background:var(--side-accent);box-shadow:inset 0 0 0 1px var(--border)}
.row.still{cursor:default}
.lead-row{border:1px solid var(--border);background:var(--card)}
.lead-row[aria-current=true]{box-shadow:inset 0 0 0 1px var(--ring)}
.r1{display:flex;align-items:center;gap:8px}
.dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--mut-fg);opacity:.5}
.dot.working{background:var(--ok);opacity:1}.dot.waiting{background:var(--wait);opacity:1}.dot.failing{background:var(--bad);opacity:1}.dot.done{opacity:.6}
.ttl{flex:1;min-width:0;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.age{font-size:11px;color:var(--mut-fg);white-space:nowrap}
.r2{display:flex;align-items:center;gap:6px;margin:5px 0 0 15px;min-width:0}
.r3{display:flex;margin:4px 0 0 15px;color:var(--mut-fg);font-size:12px;min-width:0}
.r3 span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.r3.wrap{display:block}
.chip{display:inline-flex;align-items:center;gap:5px;height:18px;padding:0 6px;border-radius:5px;background:var(--muted);font-size:11px;font-weight:500;white-space:nowrap}
.vm{width:8px;height:8px;border-radius:2px;display:inline-block;flex:none}
.who{color:var(--mut-fg);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.ref{margin-left:auto;display:inline-flex;align-items:center;gap:3px;color:var(--mut-fg);font-size:11px;white-space:nowrap}
.need-row{background:var(--wait-bg)}
.need-row:hover{background:color-mix(in srgb,var(--wait) 17%,var(--bg))}
.need-row .ttl{white-space:normal}
.done-row .ttl{font-weight:400;color:var(--mut-fg)}
.item{position:relative}
.r1,.r2,.r3{min-width:0}
.item .x{position:absolute;right:6px;top:6px;width:22px;height:22px;border-radius:6px;display:grid;place-items:center;color:var(--mut-fg);opacity:0}
.item:hover .x,.row[aria-current=true]+.x,.item .x:focus-visible{opacity:1}
.item .x:hover{background:var(--accent);color:var(--fg)}
.r3.wrap{display:block}
.arch{display:flex;align-items:center;gap:6px;margin:14px 6px 4px;padding-top:10px;border-top:1px solid var(--border);font-size:11px;color:var(--mut-fg)}
.ch{display:flex;align-items:center;gap:10px;padding:12px 20px;border-bottom:1px solid var(--border);flex-wrap:wrap}
.ch h1{font-size:15px;font-weight:600;margin:0;overflow:hidden;text-overflow:ellipsis}
.ch .sub{display:flex;align-items:center;gap:8px;margin-top:3px;color:var(--mut-fg);font-size:12px;flex-wrap:wrap}
.model{font-family:var(--mono);font-size:11px;height:22px;padding:0 7px;border:1px solid var(--border);border-radius:6px;display:inline-flex;align-items:center;gap:5px;color:var(--mut-fg);white-space:nowrap}
.model b{color:var(--fg);font-weight:500}
.ch .ref{margin-left:0;height:22px;padding:0 8px;border:1px solid var(--border);border-radius:999px}
.hbtn{height:26px;padding:0 9px;border-radius:7px;border:1px solid var(--border);font-size:12px;color:var(--mut-fg);display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
.hbtn:hover{background:var(--accent);color:var(--fg)}
.feed{flex:1;overflow:auto;padding:12px 20px 24px}
.day{display:flex;align-items:center;gap:10px;margin:4px 8px 8px;font-size:11px;color:var(--mut-fg)}
.day:after{content:"";flex:1;height:1px;background:var(--border)}
.ev{display:grid;grid-template-columns:22px 1fr auto;gap:8px;padding:7px 8px;border-radius:8px;align-items:start}
.ev .ic{color:var(--mut-fg);padding-top:1px}
.ev .t{min-width:0;overflow-wrap:anywhere}
.ev .t p{margin:0}
.ev .tm{font-size:11px;color:var(--mut-fg);padding-top:2px}
.ev.fail{background:var(--bad-bg);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--bad) 30%,transparent)}
.ev.fail .ic,.ev.fail p{color:var(--bad)}
.ev.wait .ic,.ev.wait p{color:var(--wait)}
.ev.pass .ic{color:var(--ok)}
.grp{display:grid;grid-template-columns:22px 1fr;gap:8px;padding:6px 8px;border-radius:8px;align-items:center;width:100%;text-align:left;color:var(--mut-fg);font-size:12px}
.grp:hover{background:color-mix(in srgb,var(--accent) 50%,transparent);color:var(--fg)}
.grp>svg{transition:transform .15s}
.grp.open>svg{transform:rotate(90deg)}
.grp-body{margin-left:14px;border-left:1px solid var(--border);padding-left:6px}
.ask{margin:14px 8px 4px;border:1px solid var(--border);background:var(--card);border-radius:var(--radius);padding:12px 14px}
.ask .ah{display:flex;gap:8px;align-items:center;color:var(--wait)}
.ask h2{margin:0;font-size:14px;font-weight:600;color:var(--fg)}
.ask p{margin:6px 0 0 24px}
.ro{margin:0 20px 16px;padding:10px 12px;border:1px dashed var(--border);border-radius:var(--radius);color:var(--mut-fg);font-size:12px;display:flex;gap:8px;align-items:center}
.blank{margin:auto;max-width:420px;padding:24px;text-align:center;color:var(--mut-fg)}
.blank h1{font-size:16px;color:var(--fg)}
.pr{display:block;padding:10px 10px 11px;border-radius:8px;border:1px solid var(--border);background:var(--card);margin-bottom:8px}
.pr .h{display:flex;gap:8px;align-items:flex-start}
.pr .open-i{color:var(--open);margin-top:1px}
.pr a:hover .nm{text-decoration:underline}
.pr .num,.mrow .num{color:var(--mut-fg)}
.pr .nm{font-weight:500;line-height:1.35}
.tier{font-size:10px;font-weight:600;height:18px;padding:0 6px;border-radius:5px;display:inline-grid;place-items:center;white-space:nowrap}
.tA{background:color-mix(in srgb,var(--bad) 14%,transparent);color:var(--bad)}
.tB,.tC{background:var(--muted);color:var(--mut-fg)}
.steps{display:grid;grid-template-columns:repeat(4,1fr);gap:3px;margin:10px 0 5px}
.steps i{height:4px;border-radius:2px;background:var(--muted)}
.steps i.done{background:var(--ok)}.steps i.now{background:var(--wait)}.steps i.fail{background:var(--bad)}
.steps i.skip{background:repeating-linear-gradient(90deg,var(--muted) 0 3px,transparent 3px 5px)}
.sl{display:flex;justify-content:space-between;gap:8px;font-size:12px}
.sl .mut{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sl .now{color:var(--wait);font-weight:500}.sl .fail{color:var(--bad);font-weight:500}.sl .ok{color:var(--ok);font-weight:500}
.mrow{display:flex;align-items:center;gap:8px;padding:5px 4px;color:var(--mut-fg);font-size:12px}
.mrow svg{color:var(--merged)}
.bar{display:flex;align-items:center;gap:14px;padding:0 12px;border-top:1px solid var(--border);background:var(--side);font-size:11px;color:var(--mut-fg);overflow:hidden;white-space:nowrap}
.bar span{display:inline-flex;align-items:center;gap:5px}
.toast{position:fixed;left:10px;bottom:38px;width:292px;max-width:calc(100vw - 20px);justify-content:space-between;background:var(--fg);color:var(--bg);padding:8px 12px;border-radius:8px;font-size:12px;display:flex;gap:12px;align-items:center;box-shadow:0 4px 16px rgb(0 0 0/.25)}
.toast[hidden]{display:none}
.toast button{font-weight:600;text-decoration:underline}
@media (prefers-reduced-motion:reduce){.sh .f>svg:first-child,.grp>svg{transition:none}}
@media (max-width:1100px){
.app{height:auto;min-height:100vh;grid-template-rows:48px auto 28px}
.main{grid-template-columns:300px minmax(0,1fr);grid-template-rows:auto auto 1fr;grid-template-areas:"pinned center" "agents center" "right center"}
#pinned,#agents{max-height:none;overflow:visible}
#right{border-left:0;border-right:1px solid var(--border);background:var(--side);padding-top:0}
#center{position:sticky;top:0;height:100vh;height:100dvh;align-self:start}
}
@media (max-width:700px){
.app{grid-template-rows:52px auto auto;align-content:start}
.main{grid-template-columns:minmax(0,1fr);grid-template-rows:auto;align-content:start;grid-template-areas:"pinned" "center" "agents" "right"}
#pinned,#agents,#right{border-right:0}
#pinned .lead-h,#pinned .lead-row{display:none}
#center{min-height:0;border-top:1px solid var(--border);border-bottom:1px solid var(--border)}
.ch{padding:12px 14px}.feed{padding:10px 8px 16px}.ro{margin:0 12px 12px}
.bar{height:auto;flex-wrap:wrap;padding:6px 12px;white-space:normal}
.row,.grp{min-height:40px}
.sh .f{min-height:40px}
.act{display:inline-flex;align-items:center;min-height:40px;padding:0 10px}
.item .x{opacity:1;width:40px;height:40px;top:0;right:0}
.tool{height:40px;min-width:40px}
#lang-name,.logo .word,.pill .live-word{display:none}
.top{gap:6px;padding:0 6px 0 12px}
#center{position:static;height:auto}
}
`;

const ICONS: Record<string, string> = {
  pr: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M6 9v12"/>',
  merge: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>',
  issue: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="1"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  term: '<path d="m4 17 6-6-6-6M12 19h8"/>',
  msg: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22z"/>',
  bell: '<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>',
  chev: '<path d="m9 18 6-6-6-6"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20M2 12h20"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
  archive: '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4"/>',
  done: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  branch: '<path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
};

/** The GitHub mark, filled, on its own 16-unit grid. */
const GITHUB = '<symbol id="i-github" viewBox="0 0 16 16"><path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"/></symbol>';

/** The yokoten mark: the C road with its station. */
const LOGO = '<svg width="20" height="20" viewBox="0 0 512 512" aria-hidden="true"><rect width="512" height="512" rx="112" fill="#0d1117"/><g fill="none" stroke="#eef2fb" stroke-width="44" stroke-linecap="round"><path d="M150 120 C 160 210, 205 255, 262 268"/><path d="M356 112 C 360 220, 300 300, 160 410"/></g><circle cx="268" cy="272" r="40" fill="#ec8f6c"/></svg>';

/** The page's script: its settings, the functions from script.ts, then the start. */
export function boardScript(): string {
  const settings = { token: '', refreshMs: BOARD_REFRESH_SECONDS * 1000, agentFile: BOARD_AGENT_FILE, words: WORDS, langNames: LANG_NAMES, data: null, ui: null, live: 'loading', isMenuOpen: false, toast: null, toastTimer: 0, readAt: 0 };
  return [
    '"use strict";',
    ...PAGE_FUNCTIONS.map(String),
    `const state = ${JSON.stringify(settings).replace(/</g, '\\u003c')};`,
    "state.token = new URLSearchParams(location.search).get('t') || '';",
    'startPage(state);',
  ].join('\n');
}

/** The whole page. `nonce` lets the page's own script run under the content policy, and nothing else. */
export function boardPage(nonce: string): string {
  const sprite = Object.entries(ICONS).map(([name, body]) => `<symbol id="i-${name}" viewBox="0 0 24 24">${body}</symbol>`).join('') + GITHUB;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>yokoten board</title>
<style>${STYLE}</style>
</head>
<body>
<div class="app">
<header class="top"><span class="logo">${LOGO}<span class="word">yokoten</span></span><span class="crumb">/</span><span id="repo"></span><span class="sp"></span><span class="pill off" id="live" role="status"><span class="live"></span><span id="live-text">Loading</span></span><span class="tools"><span class="menu-wrap"><button class="tool" id="lang" aria-haspopup="menu" aria-expanded="false" aria-controls="lang-menu" aria-label="Language"><svg class="i s" aria-hidden="true"><use href="#i-globe"/></svg><span id="lang-name">English</span><svg class="i s" aria-hidden="true"><use href="#i-down"/></svg></button><div class="menu" id="lang-menu" role="menu" aria-label="Language" hidden></div></span><a class="tool icon" id="github" target="_blank" rel="noopener noreferrer" aria-label="Open the repo on GitHub" hidden><svg class="i gh" aria-hidden="true"><use href="#i-github"/></svg></a><button class="tool icon" id="theme" aria-label="Switch light and dark"><svg class="i" aria-hidden="true"><use href="#i-sun"/></svg></button></span></header>
<main class="main"><nav id="pinned" aria-label="Lead and what needs you"></nav><nav id="agents" aria-label="Agents"></nav><section id="center" aria-label="The picked agent"></section><aside id="right" aria-label="Pull requests"></aside></main>
<footer class="bar" id="bar"></footer>
</div>
<div class="toast" id="toast" role="status" hidden></div>
<svg width="0" height="0" style="position:absolute" aria-hidden="true">${sprite}</svg>
<script nonce="${nonce}">
${boardScript()}
</script>
</body>
</html>
`;
}

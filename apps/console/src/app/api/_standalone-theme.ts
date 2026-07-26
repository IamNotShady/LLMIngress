import { THEME_BOOTSTRAP_SCRIPT } from "../_ui/theme";

/**
 * Chrome for the two pages an action renders on its own — the one-time API key
 * and the one-time provider key. They are served by a route handler rather than
 * by the console layout, so nothing stamps the theme for them: keyed off the
 * system preference alone, a console the operator set to light turned dark the
 * moment they created a key.
 *
 * The rule is the console's own: a stored choice wins, and only without one
 * does the system decide. The script applies it before first paint; the media
 * query keeps a scripts-off browser from landing on the wrong canvas.
 */
const LIGHT_TOKENS =
  "--bg:#ffffff;--ink:#23262b;--seg:#343a42;--segfg:#ffffff;--dim:#767d86;--faint:#a2a8b0;--hair:#ccd4dc;--rule:#e6eaef;--rule2:#f2f4f7;--track:#edf0f4;--btnbg:#fbfcfd;--btnbd:#ccd3da;--accent:oklch(0.64 0.13 245);--ambtx:oklch(0.56 0.12 68);--ambbd:oklch(0.88 0.08 85);--sans:'Open Sans',system-ui,sans-serif;--mono:'DM Mono',ui-monospace,monospace";

const DARK_TOKENS =
  "--bg:#15181c;--ink:#e9ecf0;--seg:oklch(0.72 0.12 245);--segfg:#15181c;--dim:#b3bac2;--faint:#8b929b;--hair:rgba(255,255,255,.17);--rule:rgba(255,255,255,.09);--rule2:rgba(255,255,255,.05);--track:#20242a;--btnbg:#22262d;--btnbd:rgba(255,255,255,.22);--accent:oklch(0.70 0.12 245);--ambtx:oklch(0.85 0.11 82);--ambbd:rgba(226,182,96,.30)";

/** The console's tokens, resolved the way the console resolves them. */
export function standaloneThemeCss(): string {
  return `:root{${LIGHT_TOKENS}}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${DARK_TOKENS}}}
:root[data-theme="dark"]{${DARK_TOKENS}}
.copy{flex:none;cursor:pointer;white-space:nowrap;border:1px solid var(--btnbd);background:var(--btnbg);color:var(--ink);border-radius:3px;font:500 12px var(--mono);padding:2px 8px}`;
}

/**
 * Copies whatever a [data-copy] button points at. Both of these pages exist to
 * hand a value over — a secret that cannot be shown again, a snippet meant to
 * be pasted elsewhere — so the fallback matters: the clipboard API is missing
 * over plain http to anything but localhost, which is how a self-hosted console
 * is often reached.
 */
export function standaloneCopyScript(): string {
  return `(function(){
function write(text){
if(navigator.clipboard&&navigator.clipboard.writeText){return navigator.clipboard.writeText(text)}
return new Promise(function(resolve,reject){
var area=document.createElement("textarea");
area.value=text;area.setAttribute("readonly","");area.style.position="fixed";area.style.top="-1000px";
document.body.appendChild(area);area.select();
var ok=false;try{ok=document.execCommand("copy")}catch(e){ok=false}
document.body.removeChild(area);
ok?resolve():reject(new Error("copy failed"));
});
}
document.addEventListener("click",function(event){
var button=event.target&&event.target.closest?event.target.closest("[data-copy]"):null;
if(!button){return}
var node=document.querySelector(button.getAttribute("data-copy"));
if(!node){return}
var text=typeof node.value==="string"?node.value:node.textContent||"";
var restore=function(label){button.textContent=label;setTimeout(function(){button.textContent="copy"},2000)};
write(text).then(function(){restore("copied")},function(){restore("copy failed")});
});
})()`;
}

/** Head markup that stamps the stored theme before the page paints. */
export function standaloneThemeHead(): string {
  return `<link rel="preconnect" href="https://fonts.googleapis.com" />
    <link href="https://fonts.googleapis.com/css2?family=Open+Sans:wght@400;500;600&amp;family=DM+Mono:wght@400;500&amp;display=swap" rel="stylesheet" />
    <script>${THEME_BOOTSTRAP_SCRIPT}</script>`;
}

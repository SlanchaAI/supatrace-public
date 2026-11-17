// Portable design contracts. Rendered/browser acceptance is a separate gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const html = readFileSync(new URL('../public/app/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/app/remodel.css', import.meta.url), 'utf8');
const landing = readFileSync(new URL('../public/remodel.css', import.meta.url), 'utf8');
const rule = selector => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const found = css.replace(/\/\*[\s\S]*?\*\//g, '').match(new RegExp('(?:^|})\\s*' + escaped + '\\s*\\{([^}]+)\\}'));
  assert.ok(found, `missing rule: ${selector}`);
  return found[1];
};
const contrast = (first, second) => {
  const luminance = hex => {
    const values = hex.match(/[\da-f]{2}/gi).map(v => parseInt(v, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
    return values[0] * .2126 + values[1] * .7152 + values[2] * .0722;
  };
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + .05) / (values[1] + .05);
};

test('app adopts the accepted landing paper, ink, surface, and separator palette', () => {
  for (const color of ['#f6f3e8', '#232922', '#fffdf5', '#60665a', '#d3d7ca']) {
    assert.ok(landing.includes(color), `accepted landing color ${color}`);
    assert.ok(css.includes(color), `app color ${color}`);
  }
  assert.match(rule(':root'), /color-scheme:light/);
  assert.match(html, /<meta name="theme-color" content="#f6f3e8">/);
});

test('app skin loads after shared authentication styles and is CSP compatible', () => {
  const stylesheets = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(stylesheets, ['/fonts.css', 'app.css', '/auth.css', 'remodel.css']);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)|<style|\sstyle=|\son[a-z]+=/i);
  assert.doesNotMatch(css, /@import|url\(|expression\(/i, 'no external assets or CSS execution');
});

test('desktop navigation has visible labels and adds Billing alongside the existing six routes', () => {
  assert.deepEqual([...html.matchAll(/data-nav="([^"]+)"/g)].map(m => m[1]), ['home', 'traces', 'agents', 'keys', 'usage', 'billing', 'settings']);
  assert.match(rule('.app #rail a span'), /position:static/);
  assert.match(rule('.app #rail a span'), /opacity:1/);
  assert.match(html, /<span class="brand-name">SupaTrace<\/span>/);
});

test('keyboard skip target and mobile drawer remain wired to existing controls', () => {
  assert.match(html, /<a id="skip-workspace" class="skip" href="#workspace">Skip to workspace<\/a>/);
  assert.match(html, /<main id="workspace" tabindex="-1">/);
  assert.match(html, /id="menu-toggle"[^>]*aria-expanded="false"[^>]*aria-controls="rail"/);
  assert.match(html, /id="close-menu"[^>]*aria-label="Close menu"/);
  assert.match(css, /\.app :focus-visible\{outline:3px solid #66804a/);
  assert.match(css, /@media\(max-width:800px\)/);
  assert.match(css, /@media\(max-width:520px\)/);
});

test('primary controls, inputs and navigation preserve 44px minimum targets', () => {
  for (const selector of ['.app button', '.app #rail a', '.app .trace-open', '.app .auth .choice,.app .auth button.primary']) {
    assert.match(rule(selector), /min-height:44px/, selector);
  }
  assert.match(rule('.app input,.app select'), /min-height:44px/);
  assert.match(rule('.app .auth input'), /min-height:44px/);
});

test('all chosen text and status colors meet WCAG AA contrast on their surfaces', () => {
  const pairs = [
    ['#232922', '#f6f3e8'], ['#232922', '#fffdf5'],
    ['#60665a', '#f6f3e8'], ['#60665a', '#fffdf5'], ['#60665a', '#f0f0e4'],
    ['#49633a', '#f6f3e8'], ['#49633a', '#fffdf5'],
    ['#fffdf5', '#232922'], ['#fffdf5', '#3b4833'],
    ['#77551a', '#f5ebd5'], ['#77551a', '#f6f3e8'],
    ['#a13630', '#fffdf5'], ['#a13630', '#f6f3e8']
  ];
  for (const [text, background] of pairs) assert.ok(contrast(text, background) >= 4.5, `${text} on ${background}`);
});

test('refresh retains export, explicit import and disabled commercial semantics', () => {
  for (const id of ['export-account', 'cancel-account-export', 'trace-search', 'clear-filters', 'events-more', 'import-form', 'import-result', 'mfa-section', 'commercial-selector']) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
  assert.match(html, /id="import-start"[^>]*disabled/);
  assert.match(html, /id="commercial-selector"[^>]*hidden/);
  assert.match(html, /id="commercial-checkout"[^>]*disabled/);
  assert.match(html, /id="billing-portal"[^>]*hidden disabled/);
  assert.match(html, /No real purchase, paid access or storage quota change is enabled/);
  assert.match(html, /Nothing is captured automatically/);
  assert.doesNotMatch(css, /\[hidden\]|#import-start\s*\{|#commercial-checkout\s*\{/, 'skin cannot override hidden/disabled gates');
});

test('refresh adds no stock artwork, graph-paper decoration, or rotating marks', () => {
  assert.deepEqual([...html.matchAll(/<img[^>]*src="([^"]+)"/g)].map(m => m[1]), ['/brand-mark.svg']);
  assert.doesNotMatch(css + html, /s12\.png|Fredoka|Permanent.Marker|setInterval|linear-gradient/i);
  assert.match(css, /prefers-reduced-motion:reduce/);
});


test('recent provider IDs fit their card without stretching sibling cards', () => {
  assert.match(rule('.app .cards'), /align-items:start/);
  assert.match(rule('.app #recent .run'), /grid-template-columns:minmax\(0,1fr\)/);
  assert.match(rule('.app #recent .run>span:first-child'), /min-width:0/);
  assert.match(rule('.app #recent .run>span:first-child'), /overflow:hidden/);
  assert.match(rule('.app #recent .run>span:first-child'), /text-overflow:ellipsis/);
  assert.match(rule('.app #recent .run>span:first-child'), /white-space:nowrap/);
  assert.match(rule('.app #recent .run>span:last-child'), /overflow-wrap:anywhere/);
  assert.doesNotMatch(css, /#recent \.run \.id|#recent \.run \.muted/, 'styles address the actual unclassed spans');
});

test('import plan text wraps without hiding or clipping page content', () => {
  const result=rule('.app #import-result');
  for(const declaration of ['min-width:0','max-width:100%','white-space:pre-wrap','overflow-wrap:anywhere','overflow:auto'])assert.ok(result.includes(declaration),declaration);
  assert.doesNotMatch(result,/overflow:hidden|text-overflow:ellipsis|white-space:nowrap/);
});

test('classic brand mark is original static geometry in the approved palette', () => {
  const mark = readFileSync(new URL('../public/brand-mark.svg', import.meta.url), 'utf8');
  const favicon = readFileSync(new URL('../public/favicon.svg', import.meta.url), 'utf8');
  assert.match(mark, /viewBox="0 0 60 112"/);
  assert.match(mark, /stroke="#708956"/);
  assert.match(mark, /M10 46V26L30 6L50 26V46L40 56L50 66V86L30 106L10 86V66L20 56Z/);
  assert.match(mark, /M30 26V46L40 56M20 56L30 66V86/);
  assert.doesNotMatch(mark + favicon, /<(?:script|image|filter|animate|foreignObject)\b|(?:href|style)=|data:|https?:\/\/(?!www\.w3\.org\/2000\/svg)/i);
  assert.match(favicon, /fill="#f6f3e8"/);
  assert.match(favicon, /stroke="#49633a"/);
  assert.match(mark, /stroke-linejoin="miter" stroke-linecap="butt"/);
  for (const path of [...mark.matchAll(/<path d="([^"]+)"/g)].map(m => m[1])) assert.ok(favicon.includes(path), 'favicon shares the same S geometry');
});

test('landing and app display the same decorative mark with an accessible home link', () => {
  const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(page, /aria-label="SupaTrace home"><img class="brand-mark" src="\/brand-mark\.svg" alt="" width="25" height="46">SupaTrace<\/a>/);
  assert.match(html, /aria-label="SupaTrace home"><img src="\/brand-mark\.svg" alt="" width="24" height="44">/);
  for (const source of [page, html]) assert.match(source, /href="\/favicon\.svg\?v=classic-s-2"/);
  assert.match(landing, /\.landing\.remodel \.brand-mark\{display:block;flex:none;width:25px;height:46px;object-fit:contain\}/);
  assert.match(rule('.app #rail .mark img'), /width:24px;height:44px/);
});

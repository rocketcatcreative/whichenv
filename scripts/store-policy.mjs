/**
 * Renders `store/privacy-policy.md` to HTML, in three forms.
 *
 *   privacy-policy.html           standalone, self-contained, styled. Works dropped on any host.
 *   privacy-policy.fragment.html  body content only, no styles, wrapped in .whichenv-policy. For
 *                                 the ACF body field, where a document with its own CSS would
 *                                 fight the theme and where TinyMCE strips style tags anyway.
 *   privacy-policy.css            the stylesheet for that fragment, every selector scoped to the
 *                                 wrapper. Source of record for the theme partial that ships it.
 *
 * Generated rather than hand-authored for the reason everything else here is: the policy is a
 * legal statement that also has to match the permission justifications, and three hand-maintained
 * copies of it would silently disagree within a month. Edit the markdown, re-run this.
 *
 * A focused converter rather than a markdown dependency. The input is one document whose syntax is
 * known and fixed: headings, bold, inline code, links, tables, bullets, rules, paragraphs. Anything
 * outside that set throws instead of emitting quietly wrong HTML.
 *
 * Run:
 *   npm run store:policy
 */

import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(root, 'store', 'privacy-policy.md');

const escape = (text) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Inline markdown: links, bold, code. Escaped first, so no raw HTML can pass through. */
function inline(text) {
  return escape(text)
    .replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => `<a href="${href}">${label}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, (_, bold) => `<strong>${bold}</strong>`);
}

const isTableDivider = (line) => /^\|[\s|:-]+\|$/.test(line);

function convert(markdown) {
  const lines = markdown.split('\n');
  const out = [];
  let i = 0;

  const flushParagraph = (buffer) => {
    if (buffer.length) out.push(`<p>${inline(buffer.join(' '))}</p>`);
    return [];
  };

  let paragraph = [];

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') {
      paragraph = flushParagraph(paragraph);
      i += 1;
      continue;
    }

    if (line.startsWith('---')) {
      paragraph = flushParagraph(paragraph);
      out.push('<hr />');
      i += 1;
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      paragraph = flushParagraph(paragraph);
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    // Tables: a header row, a divider, then body rows.
    if (line.startsWith('|') && isTableDivider(lines[i + 1] ?? '')) {
      paragraph = flushParagraph(paragraph);
      const cells = (row) =>
        row.slice(1, -1).split('|').map((cell) => cell.trim());

      const head = cells(line);
      i += 2;

      const body = [];
      while (i < lines.length && lines[i].startsWith('|')) {
        body.push(cells(lines[i]));
        i += 1;
      }

      out.push(
        '<table>',
        '<thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead>',
        '<tbody>',
        ...body.map(
          (row) => '<tr>' + row.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>',
        ),
        '</tbody>',
        '</table>',
      );
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      paragraph = flushParagraph(paragraph);
      const items = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        // Continuation lines of the same bullet are indented.
        let text = lines[i].replace(/^[-*]\s+/, '');
        i += 1;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i])) {
          text += ' ' + lines[i].trim();
          i += 1;
        }
        items.push(`<li>${inline(text)}</li>`);
      }
      out.push('<ul>', ...items, '</ul>');
      continue;
    }

    if (line.startsWith('#') || line.startsWith('|') || line.startsWith('>')) {
      throw new Error(`Unhandled markdown at line ${i + 1}: ${line}`);
    }

    paragraph.push(line.trim());
    i += 1;
  }

  flushParagraph(paragraph);
  return out.join('\n');
}

const markdown = readFileSync(SRC, 'utf8');
const body = convert(markdown);

// The <h1> becomes the page title; WordPress renders its own, so the fragment drops it.
const title = /^#\s+(.*)$/m.exec(markdown)?.[1] ?? 'Privacy policy';
const fragment = body.replace(/^<h1>.*?<\/h1>\n?/, '');

/**
 * Scoped styles for the WordPress fragment.
 *
 * Measured against the live page at localhost:7006/whichenv/privacy-policy/ rather than guessed.
 * The Rocket Cat theme is Inter 18px/27px and resets almost every margin to zero: h1, h2, h3, ul
 * and li are all `margin: 0`, `ul` loses its padding and list style, and `th`/`td` get 1px of
 * padding with centred headers. Pasted in raw, the document is one dense slab with borderless
 * tables. Everything below exists to put that back, and nothing else.
 *
 * Two rules about how it is written, both of which matter more than how it looks:
 *
 *   1. EVERY selector is prefixed with the wrapper class, so nothing here can reach a single
 *      element elsewhere on the site. No bare element selectors, no `*`, no `:root`, no `body`.
 *   2. The wrapper class is doubled (`.whichenv-policy.whichenv-policy`) to raise specificity to
 *      0,2,0 without `!important`. The theme's own rules are things like `.section-text__content
 *      ul` at 0,1,1, and relying on source order would break the moment WordPress emitted this
 *      block before a stylesheet. `!important` would win too, but it wins against Joe as well the
 *      next time he wants to override something.
 *
 * Deliberately NOT set: font-family, colours, link colour, and the heading type scale. Those are
 * the brand's, they already look right, and overriding them is how an embedded block starts
 * looking like a foreign object.
 */
const SCOPE = '.whichenv-policy.whichenv-policy';
const scopedCss = `/* Vertical rhythm. The theme zeroes these, so the document arrives as one slab. */
${SCOPE} { max-width: 850px; }
${SCOPE} h2 { margin: 2.25em 0 0.5em; }
${SCOPE} h2:first-child { margin-top: 0; }
${SCOPE} h3 { margin: 1.75em 0 0.4em; }
${SCOPE} p { margin: 0 0 1em; }

/* The theme sets list-style: none and padding-left: 0, which loses the bullets entirely. */
${SCOPE} ul { margin: 0 0 1.25em; padding-left: 1.35em; list-style: disc outside; }
${SCOPE} li { margin: 0 0 0.5em; }
${SCOPE} li:last-child { margin-bottom: 0; }

/* Tables carry real content in this document, and the theme gives them 1px of padding. */
${SCOPE} table {
  width: 100%;
  border-collapse: collapse;
  margin: 0 0 1.5em;
  font-size: 0.94em;
}
${SCOPE} th,
${SCOPE} td {
  padding: 0.7em 0.9em 0.7em 0;
  text-align: left;
  vertical-align: top;
  border-bottom: 1px solid rgba(0, 0, 0, 0.12);
}
${SCOPE} th {
  font-size: 0.82em;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  opacity: 0.6;
  white-space: nowrap;
}
${SCOPE} td:last-child,
${SCOPE} th:last-child { padding-right: 0; }

/* Inline code sits at body size in a monospace face, which reads as oversized next to Inter. */
${SCOPE} code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.86em;
  background: rgba(0, 0, 0, 0.05);
  padding: 0.12em 0.36em;
  border-radius: 3px;
  white-space: nowrap;
}

/* The browser default is an inset 3D groove. */
${SCOPE} hr {
  border: 0;
  border-top: 1px solid rgba(0, 0, 0, 0.12);
  height: 0;
  margin: 2.5em 0;
}

/* Three columns of prose do not fit a phone, so the rows become blocks. */
@media (max-width: 640px) {
  ${SCOPE} thead { display: none; }
  ${SCOPE} tr {
    display: block;
    padding-bottom: 0.9em;
    margin-bottom: 0.9em;
    border-bottom: 1px solid rgba(0, 0, 0, 0.12);
  }
  ${SCOPE} tr:last-child { border-bottom: 0; margin-bottom: 0; }
  ${SCOPE} td { display: block; border: 0; padding: 0.1em 0; }
  ${SCOPE} td:first-child { font-weight: 650; }
}
`;

writeFileSync(
  join(root, 'store', 'privacy-policy.css'),
  `/*
  Scoped styles for the WhichEnv privacy policy, for WordPress. This file is the source of record;
  the copy that actually ships lives in the Rocket Cat theme at

    wp-content/themes/rocketcat/assets/scss/pages/_whichenv.scss

  imported by assets/scss/custom.scss and compiled into assets/css/custom.css. Change the markdown,
  re-run the generator, then paste the body below into that partial and rebuild the theme.

  The styles cannot live in the page content instead: the ACF body field is a TinyMCE wysiwyg,
  which strips style tags on save.

  Every selector is prefixed with .whichenv-policy and the class is doubled to raise specificity
  to 0,2,0 without !important, so this is physically unable to affect anything outside the wrapper.
  Scoping to body.page-privacy-policy instead would NOT be safe: WordPress derives that class from
  the slug, and Rocket Cat's own /privacy-policy/ page carries the identical class.

  One constraint survives from when this lived in Appearance > Customize > Additional CSS, worth
  keeping in case it ever goes back: WordPress refuses to save Additional CSS containing an opening
  angle bracket followed by a letter or a slash anywhere, comments included, because
  WP_Customize_Custom_CSS_Setting::validate() reads that shape as markup in CSS and rejects the
  whole paste. A theme file has no such rule.
*/
${scopedCss}
`,
);

writeFileSync(
  join(root, 'store', 'privacy-policy.fragment.html'),
  `<!--
  For the ACF "Text Formatted" section's body field. Paste using the TEXT tab, not Visual, and
  save without switching tabs: TinyMCE reformats markup when you switch.

  Content only. No <html>, no <head>, no <h1> (WordPress renders the page title), and no <style>
  (TinyMCE strips it). The stylesheet is store/privacy-policy.css, whose shipping copy lives in
  the theme at assets/scss/pages/_whichenv.scss.

  The wrapper div is what the CSS hooks onto. Without it nothing is styled.

  Generated from store/privacy-policy.md by npm run store:policy. Edit the markdown, not this.
-->
<div class="whichenv-policy">
${fragment
  .split('\n')
  .map((line) => (line ? `  ${line}` : line))
  .join('\n')}
</div>\n`,
);

writeFileSync(
  join(root, 'store', 'privacy-policy.html'),
  `<!doctype html>
<!--
  Standalone, self-contained. Use this if the page is served as a static file rather than pasted
  into a CMS. Generated from store/privacy-policy.md by npm run store:policy.
-->
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escape(title)} · Rocket Cat Creative</title>
    <meta name="description" content="How the WhichEnv Chrome extension handles data. It collects none." />
    <style>
      :root { color-scheme: light dark; }
      * { box-sizing: border-box; }
      body {
        margin: 0 auto;
        max-width: 46rem;
        padding: 3rem 1.5rem 6rem;
        font: 16px/1.65 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
        color: light-dark(#1c1917, #e7e5e4);
        background: light-dark(#ffffff, #18181b);
      }
      h1 { font-size: 1.9rem; line-height: 1.2; letter-spacing: -0.02em; margin: 0 0 0.5rem; }
      h2 { font-size: 1.3rem; letter-spacing: -0.01em; margin: 2.5rem 0 0.75rem; }
      h3 { font-size: 1.05rem; margin: 1.75rem 0 0.5rem; }
      p { margin: 0 0 1rem; }
      ul { margin: 0 0 1rem; padding-left: 1.25rem; }
      li { margin-bottom: 0.4rem; }
      a { color: light-dark(#1d4ed8, #93b4ff); }
      code {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.875em;
        background: light-dark(#f5f5f4, #27272a);
        padding: 0.1em 0.35em;
        border-radius: 4px;
      }
      hr { border: 0; border-top: 1px solid light-dark(#e7e5e4, #3f3f46); margin: 2.5rem 0; }
      table { width: 100%; border-collapse: collapse; margin: 0 0 1.5rem; font-size: 0.95rem; }
      th, td {
        text-align: left; vertical-align: top;
        padding: 0.6rem 0.75rem;
        border-bottom: 1px solid light-dark(#e7e5e4, #3f3f46);
      }
      th { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em;
           color: light-dark(#78716c, #a1a1aa); }
      /* Tables carry real content here, so they stack rather than scroll on a phone. */
      @media (max-width: 34rem) {
        thead { display: none; }
        tr { display: block; margin-bottom: 1rem; }
        td { display: block; border: 0; padding: 0.15rem 0; }
        td:first-child { font-weight: 650; }
        tr { border-bottom: 1px solid light-dark(#e7e5e4, #3f3f46); padding-bottom: 0.75rem; }
      }
    </style>
  </head>
  <body>
${body
  .split('\n')
  .map((line) => (line ? `    ${line}` : line))
  .join('\n')}
  </body>
</html>\n`,
);

for (const name of ['privacy-policy.html', 'privacy-policy.fragment.html', 'privacy-policy.css']) {
  console.log(`OK  store/${name}  ${statSync(join(root, 'store', name)).size} bytes`);
}

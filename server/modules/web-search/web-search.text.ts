/**
 * Turns an HTML page into readable text for the search answer and for agents.
 * Author: Josh Neufield (Archon Tech)
 *
 * Page text is UNTRUSTED input to a model, and hidden text is the classic way to smuggle instructions into it. So the
 * parser walks the real document tree (parse5, which never runs scripts) and drops anything a reader would not see:
 * scripts, styles, navigation, forms, comments, and elements hidden with the hidden attribute, aria-hidden, or inline
 * styles such as display:none, visibility:hidden, opacity:0 and font-size:0.
 */
import { parse } from 'parse5';

import type { WebPageText } from '@/shared/types.js';

type Node = { nodeName: string; tagName?: string; value?: string; childNodes?: Node[]; attrs?: Array<{ name: string; value: string }> };

const SKIP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'object', 'embed', 'head', 'nav', 'footer', 'aside', 'form', 'button', 'select', 'option', 'input', 'textarea', 'dialog', 'audio', 'video', 'picture', 'map']);
const BLOCK = new Set(['p', 'div', 'section', 'article', 'main', 'header', 'ul', 'ol', 'table', 'tr', 'blockquote', 'pre', 'figure', 'figcaption', 'details', 'summary', 'dl', 'dt', 'dd', 'hr', 'br', 'address']);
const HEADING = /^h([1-6])$/;
const HIDDEN_STYLE = /display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?![.\d])|font-size\s*:\s*0(?![.\d])|height\s*:\s*0(?:px)?\s*;?\s*(?:overflow\s*:\s*hidden)|clip\s*:\s*rect\(0/i;

function attribute(node: Node, name: string): string | undefined {
  return node.attrs?.find((entry) => entry.name === name)?.value;
}

function isHidden(node: Node): boolean {
  if (attribute(node, 'hidden') !== undefined) return true;
  if (attribute(node, 'aria-hidden')?.toLowerCase() === 'true') return true;
  const style = attribute(node, 'style');
  return style !== undefined && HIDDEN_STYLE.test(style);
}

function findFirst(node: Node, tag: string): Node | null {
  if (node.tagName === tag) return node;
  for (const child of node.childNodes ?? []) {
    const hit = findFirst(child, tag);
    if (hit) return hit;
  }
  return null;
}

function textLength(node: Node): number {
  if (node.nodeName === '#text') return (node.value ?? '').trim().length;
  if (node.tagName && (SKIP.has(node.tagName) || isHidden(node))) return 0;
  return (node.childNodes ?? []).reduce((sum, child) => sum + textLength(child), 0);
}

function render(node: Node, out: string[]): void {
  if (node.nodeName === '#text') {
    out.push(node.value ?? '');
    return;
  }
  if (node.nodeName === '#comment' || node.nodeName === '#documentType') return;
  const tag = node.tagName;
  if (tag && (SKIP.has(tag) || isHidden(node))) return;
  const heading = tag ? HEADING.exec(tag) : null;
  if (heading) out.push(`\n\n${'#'.repeat(Number(heading[1]))} `);
  else if (tag === 'li') out.push('\n- ');
  else if (tag === 'td' || tag === 'th') out.push(' | ');
  else if (tag && BLOCK.has(tag)) out.push('\n\n');
  for (const child of node.childNodes ?? []) render(child, out);
  if (heading || (tag && BLOCK.has(tag))) out.push('\n\n');
}

/** Character classes built from code points, so the source stays plain ASCII (U+2028 and U+2029 would end a regex literal). */
const chars = (...ranges: Array<[number, number?]>) => ranges.map(([from, to]) => String.fromCharCode(from) + (to ? `-${String.fromCharCode(to)}` : '')).join('');
const INVISIBLE = new RegExp(`[${chars([0x200b, 0x200f], [0x2028, 0x2029], [0x202a, 0x202e], [0x2060], [0xfeff])}]`, 'g');
const SPACES = new RegExp(`[ \\t${chars([0xa0])}]+`, 'g');

function tidy(raw: string): string {
  const lines = raw
    .replace(INVISIBLE, '') // zero-width and bidi control characters
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(SPACES, ' ').trim());
  const out: string[] = [];
  let lastText = '';
  for (const line of lines) {
    if (line === '' && out[out.length - 1] === '') continue; // at most one blank line in a row
    if (line !== '' && line === lastText) continue; // the same line again, even across blank lines (menus, banners): nothing new
    out.push(line);
    if (line !== '') lastText = line;
  }
  return out.join('\n').trim();
}

/**
 * Readable text and the title of an HTML document, at most `maxChars` long. Prefers <article> or <main> when it holds the page.
 * Used by web-search.service.ts when reading an HTML page for a preview, an answer or an agent's web_read.
 */
export function htmlToText(html: string, maxChars = 12_000): WebPageText {
  const document = parse(html) as unknown as Node;
  const titleNode = findFirst(document, 'title');
  const title = tidy((titleNode?.childNodes ?? []).map((child) => child.value ?? '').join(' ')).replace(/\n/g, ' ').slice(0, 200);

  const body = findFirst(document, 'body') ?? document;
  const main = findFirst(body, 'article') ?? findFirst(body, 'main');
  const root = main && textLength(main) >= 400 ? main : body;

  const out: string[] = [];
  render(root, out);
  const text = tidy(out.join(''));
  return text.length > maxChars ? { title, text: `${text.slice(0, maxChars).trimEnd()}\n[...cut]`, truncated: true } : { title, text, truncated: false };
}

/**
 * Non-HTML text (plain text, JSON, XML) is passed through, cleaned and capped.
 * Used by web-search.service.ts for pages that are not HTML.
 */
export function plainToText(raw: string, maxChars = 12_000): WebPageText {
  const text = tidy(raw);
  return text.length > maxChars ? { title: '', text: `${text.slice(0, maxChars).trimEnd()}\n[...cut]`, truncated: true } : { title: '', text, truncated: false };
}

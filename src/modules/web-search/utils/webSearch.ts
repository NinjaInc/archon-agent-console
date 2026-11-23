import type { WebAnswerSource } from '@/shared/types';

export const CATEGORIES = [
  { value: 'general', label: 'General' },
  { value: 'it', label: 'Code and docs' },
  { value: 'science', label: 'Science' },
  { value: 'news', label: 'News' },
] as const;

export const TIME_RANGES = [
  { value: '', label: 'Any time' },
  { value: 'day', label: 'Past day' },
  { value: 'week', label: 'Past week' },
  { value: 'month', label: 'Past month' },
  { value: 'year', label: 'Past year' },
] as const;

/**
 * Turns the model's [1] markers into links to the matching source, so every claim is one click from its page.
 * Markers for sources that do not exist stay as plain text, and only http(s) addresses are ever linked.
 */
export function linkCitations(text: string, sources: WebAnswerSource[]): string {
  const byNumber = new Map(sources.map((source) => [source.n, source.url]));
  return text.replace(/\[(\d{1,2})\](?!\()/g, (marker, digits: string) => {
    const url = byNumber.get(Number(digits));
    if (!url || !/^https?:\/\//i.test(url)) return marker;
    return `[[${digits}]](${url.replace(/\)/g, '%29').replace(/\s/g, '%20')})`;
  });
}

/** "docs.example.com" for display, without the www. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

// isomorphic-dompurify runs DOMPurify in both environments: native DOMPurify in
// the browser (privacy/terms client pages) and a jsdom-backed window on the
// server (the blog Server Components render the post body during SSR). Plain
// `dompurify` needs a DOM and silently returns '' under Node, which would strip
// every blog post body from the server-rendered HTML — the exact content we
// need crawlers to see.
import DOMPurify from 'isomorphic-dompurify';

const ALLOWED_TAGS = [
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'br', 'hr',
  'ul', 'ol', 'li',
  'a', 'strong', 'em', 'b', 'i', 'u', 'span', 'div',
  'img', 'figure', 'figcaption',
  'blockquote', 'pre', 'code',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'sub', 'sup', 'small',
];

const ALLOWED_ATTR = [
  'href', 'src', 'alt', 'title',
  'class', 'style',
  'target', 'rel',
  'width', 'height',
];

export function sanitizeHtml(dirty: string): string {
  return DOMPurify.sanitize(dirty, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
  });
}

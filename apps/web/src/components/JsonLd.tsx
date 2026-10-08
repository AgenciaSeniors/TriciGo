import { serializeJsonLd } from '@tricigo/utils/htmlSafety';

/**
 * Reusable JSON-LD structured data component for SEO. serializeJsonLd escapes `<`,
 * so a blog title holding `</script>` cannot end the element and run as page script.
 */
export function JsonLd({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }}
    />
  );
}

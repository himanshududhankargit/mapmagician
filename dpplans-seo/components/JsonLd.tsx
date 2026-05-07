/**
 * Inline a JSON-LD <script> block. We render the JSON directly (no dangerouslySetInnerHTML
 * indirection) so static export emits the schema as part of the HTML — Google reads it on first crawl.
 */
export function JsonLd({ data }: { data: object | object[] }) {
  return (
    <script
      type="application/ld+json"
      // The graph is built from typed data we control, so escape only the unsafe </ sequence.
      dangerouslySetInnerHTML={{
        __html: JSON.stringify(data).replace(/<\//g, '<\\/'),
      }}
    />
  );
}

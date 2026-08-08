import Link from 'next/link';
import { DOWNLOAD, SITE, type RegionFaq } from '@/lib/site';

/**
 * "Download this DP map" section, reused by the region pages, the curated
 * sub-location pages and the hub.
 *
 * Why it exists: Google autocomplete for this niche is dominated by download intent —
 * "<city> development plan map pdf download", "dp plan download pdf maharashtra",
 * "<locality> dp plan pdf free download". Every one of those searchers landed on a
 * DPPlans page that said nothing about downloading anything. This section answers the
 * query on the page that already ranks, instead of hoping a new URL out-ranks it.
 *
 * Honesty rule (do not soften): the sheet is a JPEG, not a PDF, and it is not the
 * government's sanctioned-plan PDF. Both are stated in plain words here and in the
 * FAQ below. Matching the keyword by implying otherwise would buy a click and lose the
 * customer — and the same fairness the /overlayr/ QGIS section is written with.
 */

type Props = {
  /** Place the sheet will be centred on — "Pune", "Wagholi", "PCMC". */
  placeName: string;
  /** Full name used once in prose — "Pune Municipal Corporation Development Plan". */
  planName: string;
  /** Deep link into the map app, already centred on the place. */
  mapUrl: string;
  /** compact = no sample image and shorter prose (sub-location pages). */
  variant?: 'full' | 'compact';
};

export function DownloadSheet({ placeName, planName, mapUrl, variant = 'full' }: Props) {
  return (
    <section className="card dl-sheet" id="download">
      <h2>Download the {placeName} Development Plan map</h2>
      <p>
        Besides viewing {planName} online, you can <strong>download the part of it you are
        actually interested in</strong> as a print-ready map sheet. You draw a capture box over
        the plot, road or village you need, and the app renders that exact area at full
        resolution — {DOWNLOAD.widthPx}&nbsp;×&nbsp;{DOWNLOAD.heightPx}&nbsp;pixels, sized for{' '}
        {DOWNLOAD.paperNote} — with the DP overlay drawn over satellite imagery.
      </p>

      {variant === 'full' && (
        <figure className="dl-sample">
          <img
            src={DOWNLOAD.sampleImage}
            width={DOWNLOAD.sampleWidth}
            height={DOWNLOAD.sampleHeight}
            alt={`Sample print-ready Development Plan map sheet, as downloaded for ${placeName}`}
            loading="lazy"
            decoding="async"
          />
          <figcaption>
            A generated sheet: Development Plan overlay on satellite imagery, inside a titled
            border with a scale bar, north arrow and your own caption.
          </figcaption>
        </figure>
      )}

      <h3>What the downloaded sheet contains</h3>
      <ul className="dl-list">
        <li>The {placeName} DP overlay — zones, reservations and road lines — over satellite imagery</li>
        <li>A geodetic scale bar, so distances stay readable at whatever size you print</li>
        <li>North arrow, sheet border and a caption you type yourself (default: "Part Development Plan")</li>
        <li>Full-resolution tiles, not a screenshot — text and plot boundaries stay sharp when printed</li>
      </ul>

      <h3>How to download the {placeName} DP map</h3>
      <ol className="dl-steps">
        <li>
          <a href={mapUrl} target="_blank" rel="noopener">Open {placeName} on the full map</a> and zoom to the
          area you need.
        </li>
        <li>Tap <strong>Download Map</strong> and drag the map until the capture box covers your area.</li>
        <li>Hit <strong>Proceed</strong>, check the preview, type a caption, then confirm.</li>
        <li>The sheet saves to your Downloads folder, ready to print or attach.</li>
      </ol>

      <p className="dl-price">
        <strong>₹{DOWNLOAD.priceInr} per sheet.</strong> Re-download the same sheet free for as long as
        your region pass is active. Plan detail above zoom&nbsp;14 needs an active pass for {placeName} —
        without one, the sheet still generates, but at the free zoom level of detail.
      </p>

      <p className="dl-note">
        The file is a high-resolution <strong>{DOWNLOAD.format} image</strong>, not a PDF, and it is not the
        planning authority's sanctioned-plan document — it is a map sheet generated from the DP overlay for
        the area you picked. For a certified copy or a DP remark, apply to the planning authority.
        {variant === 'full' && (
          <>
            {' '}
            <Link href={DOWNLOAD.hubPath}>More about downloading DP maps →</Link>
          </>
        )}
      </p>
    </section>
  );
}

/**
 * The download questions, phrased the way people actually type them. Appended to each
 * page's FAQ list so they land in the visible accordion AND in the FAQPage JSON-LD.
 */
export function downloadFaqs(placeName: string, planName: string): RegionFaq[] {
  return [
    {
      q: `Can I download the ${placeName} Development Plan map?`,
      a: `Yes. Open ${placeName} on the ${SITE.name} map, tap Download Map, drag the capture box over the area you want, and confirm — the app renders that area as a print-ready sheet (${DOWNLOAD.widthPx}×${DOWNLOAD.heightPx} pixels, ${DOWNLOAD.paperNote}) with the DP overlay on satellite imagery, a scale bar, a north arrow and your own caption. It costs ₹${DOWNLOAD.priceInr} per sheet, and you can re-download it free while your region pass is active.`,
    },
    {
      q: `Is the ${placeName} DP plan available as a PDF download?`,
      a: `The sheet you download from ${SITE.name} is a high-resolution ${DOWNLOAD.format} image rather than a PDF — it prints on A4 without scaling and can be dropped straight into a report or a PDF you assemble yourself. It is also not the planning authority's sanctioned-plan PDF: it is a map sheet generated for the exact area you select, which is usually what people want when they search for a "${placeName} DP plan PDF download", because the official documents are city-wide files where a single plot is hard to find. For a certified extract or DP remark, apply to the planning authority.`,
    },
    {
      q: `How much does it cost to download a ${placeName} map sheet?`,
      a: `₹${DOWNLOAD.priceInr} per sheet. Viewing ${planName} online stays free up to zoom level 14. High-detail DP tiles (zoom 15 and beyond) need a 7-day access pass for the region, and that same pass lets you re-download any sheet you have already generated at no extra cost for as long as it is active.`,
    },
  ];
}

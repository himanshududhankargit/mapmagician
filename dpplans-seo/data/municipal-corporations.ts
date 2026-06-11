/**
 * Curated map of region slug -> the municipal corporation whose Development Plan that
 * region page covers. Drives a corporation-specific FAQ + a body mention in
 * app/[slug]/page.tsx so each city page also ranks for "<City> Municipal Corporation
 * development plan" / "<City> Municipal Corporation plan" searches — the visible FAQ
 * (and its FAQPage JSON-LD) is the real lever, since Google ignores <meta keywords>.
 *
 * Editorial rule: include ONLY genuine municipal CORPORATIONS, never municipal
 * councils. Verified (June 2026) against the Maharashtra Directorate of Municipal
 * Administration list of corporations and Wikipedia's list of urban local bodies in
 * Maharashtra. Councils such as Beed ("A"-class council), Washim, Nandurbar and Jalna
 * are intentionally excluded — labelling a council a "corporation" would be wrong.
 *
 * `name` is the official corporation name (parenthetical legacy names kept so the page
 * captures both the old and renamed query, e.g. Aurangabad ↔ Chhatrapati Sambhaji Nagar).
 * Where a region covers a wider area than the corporation (e.g. the Nagpur Metropolitan
 * Region contains, but is larger than, the Nagpur Municipal Corporation), the FAQ wording
 * "this page covers the … area" stays accurate either way.
 */
export type MunicipalCorporation = { name: string; abbr?: string };

export const MUNICIPAL_CORPORATIONS: Record<string, MunicipalCorporation> = {
  'solapur-dp-plan': { name: 'Solapur Municipal Corporation', abbr: 'SMC' },
  'kolhapur-dp-plan': { name: 'Kolhapur Municipal Corporation', abbr: 'KMC' },
  'sangli-dp-plan': { name: 'Sangli-Miraj & Kupwad City Municipal Corporation', abbr: 'SMKC' },
  'nashik-dp-plan': { name: 'Nashik Municipal Corporation', abbr: 'NMC' },
  'amravati-dp-plan': { name: 'Amravati Municipal Corporation', abbr: 'AMC' },
  'dhule-dp-plan': { name: 'Dhule Municipal Corporation', abbr: 'DMC' },
  'nanded-waghala-municipal-corporation-dp-plan': { name: 'Nanded-Waghala City Municipal Corporation', abbr: 'NWCMC' },
  'nagpur-metropolitan-region-dp-plan': { name: 'Nagpur Municipal Corporation', abbr: 'NMC' },
  'pune-dp-plan': { name: 'Pune Municipal Corporation', abbr: 'PMC' },
  'thane-dp-plan': { name: 'Thane Municipal Corporation', abbr: 'TMC' },
  'navi-mumbai-municipal-corporation-dp-plan': { name: 'Navi Mumbai Municipal Corporation', abbr: 'NMMC' },
  'mira-bhayandar-dp-plan': { name: 'Mira Bhayandar Municipal Corporation', abbr: 'MBMC' },
  'kharghar-dp-plan': { name: 'Panvel Municipal Corporation' },
  'chandrapur-region-dp-plan': { name: 'Chandrapur City Municipal Corporation' },
  'latur-region-dp-plan': { name: 'Latur City Municipal Corporation' },
  'ahmednagar-dp-plan': { name: 'Ahilyanagar (Ahmednagar) Municipal Corporation' },
  'aurangabad-dp-plan': { name: 'Chhatrapati Sambhaji Nagar (Aurangabad) Municipal Corporation' },
};

/** Look up the municipal corporation for a region slug. Null for non-corporation regions. */
export function municipalCorporation(slug: string): MunicipalCorporation | null {
  return MUNICIPAL_CORPORATIONS[slug] ?? null;
}

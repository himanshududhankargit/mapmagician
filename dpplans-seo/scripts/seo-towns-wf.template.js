export const meta = {
  name: 'dpplans-town-seo',
  description: 'Research + adversarially verify notable-town SEO content for dpplans sub-location pages',
  phases: [
    { title: 'Research', detail: 'web-research + draft verifiable content per district chunk' },
    { title: 'Verify', detail: 'strict fact-check; drop non-notable / unverifiable' },
  ],
}

// Injected by scripts/build-seo-wf.js (raw JSON array of region groups). Never edit by hand.
const GROUPS = __GROUPS_DATA__;

// Chunk each region's towns into groups of <=5 — shared district context, bounded agent output.
const CHUNKS = []
for (const g of GROUPS) {
  for (let i = 0; i < g.towns.length; i += 5) {
    CHUNKS.push({ reg: g.reg, rs: g.rs, st: g.st, dn: g.dn, src: g.src, towns: g.towns.slice(i, i + 5) })
  }
}
log(`${GROUPS.length} regions → ${CHUNKS.length} chunks → ${CHUNKS.reduce((a, c) => a + c.towns.length, 0)} towns`)

const vocab = st => (st === 'Karnataka' || st === 'Telangana') ? 'Master Plan' : 'Development Plan'

const DRAFT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['entries'],
  properties: {
    entries: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['k', 'notable', 'confidence'],
        properties: {
          k: { type: 'string' },
          notable: { type: 'boolean' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          pageTitle: { type: 'string' },
          description: { type: 'string' },
          keywords: { type: 'array', items: { type: 'string' } },
          intro: { type: 'string' },
          paragraphs: { type: 'array', items: { type: 'string' } },
          claims: { type: 'array', items: { type: 'string' } },
          sources: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['approved'],
  properties: {
    approved: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['k', 'pageTitle', 'description', 'keywords', 'intro', 'paragraphs'],
        properties: {
          k: { type: 'string' },
          pageTitle: { type: 'string' },
          description: { type: 'string' },
          keywords: { type: 'array', items: { type: 'string' } },
          intro: { type: 'string' },
          paragraphs: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
}

function researchPrompt(chunk) {
  const V = vocab(chunk.st)
  const list = chunk.towns
    .map(t => `- key="${t.k}" | town="${t.t}" | taluka="${t.tal}" | about ${t.d} km ${t.b} of the ${chunk.rs} district HQ`)
    .join('\n')
  return [
    `You are an Indian town-planning SEO researcher. Region: ${chunk.dn} (${chunk.rs}), state: ${chunk.st}. The planning-document term used in this state is "${V}".`,
    `Use WebSearch/WebFetch (your read-only web tools) to research EACH town below. The "key" is load-bearing — echo it back EXACTLY in your output.`,
    `Towns:\n${list}`,
    `For each town, decide "notable": a genuinely searchable place — a taluka headquarters, a municipal council/corporation, or a well-known pilgrimage/tourist/industrial town. A small revenue village or fringe locality with no real search demand is NOT notable.`,
    `If NOT notable: return { k, notable:false, confidence } and nothing else for it.`,
    `If notable: write UNIQUE, VERIFIABLE content. EDITORIAL RULE: state only claims you can verify from a primary or near-primary source (government sites, Wikipedia, established news). When in doubt, OMIT the claim. A thin verifiable page beats a rich fabricated one. Never invent population, history, landmarks, or zone specifics.`,
    `Fields when notable:`,
    `- pageTitle: like "<Town> ${V} map online — zones & land use, ${chunk.rs}" (adapt naturally; use this state's vocabulary "${V}"/"DP" as appropriate). AVOID saturated generic head terms that government/news domains own; favour map / zone / land-use / online intent. Capture renamed dual-names where they apply (Bijapur↔Vijayapura, Aurangabad↔Chhatrapati Sambhaji Nagar, Osmanabad↔Dharashiv, Bangalore↔Bengaluru).`,
    `- description: one factual meta description (~150-200 chars) that mentions the ${V} overlay on satellite imagery and the town's district/state.`,
    `- keywords: 5-7 real lowercase search phrases.`,
    `- intro: ONE paragraph (~50-90 words): the town's verifiable identity (administrative role, what it is known for, river/region) followed by: this page opens the ${V} layer covering it as an interactive overlay on satellite imagery so you can read the land-use zone, reservations and road lines for any plot.`,
    `- paragraphs: 1-2 SHORT paragraphs: planning/geographic context (you MAY use the distance/bearing from the HQ given above) and how to use the map (search a survey number or landmark, then toggle the overlay to confirm the designated zone before relying on it).`,
    `- claims: list every discrete factual claim you made (for the fact-checker). sources: the URLs you used.`,
    `Return { entries: [...] } covering ALL ${chunk.towns.length} towns (include the notable:false ones as stubs).`,
  ].join('\n\n')
}

function verifyPrompt(chunk, entries) {
  const V = vocab(chunk.st)
  return [
    `You are a STRICT, skeptical fact-checker for an Indian town-planning website (state: ${chunk.st}, region: ${chunk.rs}). Below are drafted page entries with their claims and sources. Verify adversarially. Use WebSearch/WebFetch to spot-check any doubtful claim.`,
    `Rules:`,
    `- DROP any entry whose notability is thin or unconvincing (do not include it in "approved").`,
    `- For surviving entries, REMOVE or SOFTEN any factual claim not supported by a primary/near-primary source. Prefer omission over risk. The planning/map framing (the DP/Master Plan overlay, zones, how to use the map) is product description and is always fine to keep.`,
    `- Confirm the title uses the correct state vocabulary ("${V}") and does not chase a saturated generic head term.`,
    `- Preserve each entry's "k" EXACTLY.`,
    `Return { approved: [ { k, pageTitle, description, keywords, intro, paragraphs } ] } with ONLY the entries that survive, content cleaned.`,
    `Drafts:\n${JSON.stringify(entries)}`,
  ].join('\n\n')
}

const results = await pipeline(
  CHUNKS,
  chunk =>
    agent(researchPrompt(chunk), { label: `research:${chunk.reg}`, phase: 'Research', schema: DRAFT_SCHEMA, agentType: 'Explore' })
      .then(r => ({ chunk, entries: (r && r.entries) || [] })),
  ({ chunk, entries }) => {
    const notable = entries.filter(e => e && e.notable && e.pageTitle)
    if (!notable.length) return { approved: [] }
    return agent(verifyPrompt(chunk, notable), { label: `verify:${chunk.reg}`, phase: 'Verify', schema: VERDICT_SCHEMA, agentType: 'Explore' })
      .then(v => ({ approved: (v && v.approved) || [] }))
  },
)

const approved = results.filter(Boolean).flatMap(r => (r && r.approved) || []).filter(e => e && e.k && e.pageTitle)

const lines = approved.map(e =>
  `  ${JSON.stringify(e.k)}: {\n` +
  `    pageTitle: ${JSON.stringify(e.pageTitle)},\n` +
  `    description: ${JSON.stringify(e.description || '')},\n` +
  `    keywords: ${JSON.stringify(e.keywords || [])},\n` +
  `    intro: ${JSON.stringify(e.intro || '')},\n` +
  `    paragraphs: ${JSON.stringify(e.paragraphs || [])},\n` +
  `  },`,
).join('\n')

const tsFile =
  `// AUTO-GENERATED by the 'dpplans-town-seo' workflow (research + adversarial verification).\n` +
  `// Verified, notable-town SEO overrides for sub-location pages. Hand edits may be overwritten\n` +
  `// on regeneration; for one-off tweaks prefer SUBLOCATION_CONTENT in sublocation-content.ts,\n` +
  `// which takes precedence over this file at lookup time.\n` +
  `import type { SubLocationContent } from './sublocation-content';\n\n` +
  `export const GENERATED_SUBLOCATION_CONTENT: Record<string, SubLocationContent> = {\n` +
  `${lines}\n` +
  `};\n`

log(`approved ${approved.length} towns of ${CHUNKS.reduce((a, c) => a + c.towns.length, 0)}`)
return { count: approved.length, regions: GROUPS.length, chunks: CHUNKS.length, tsFile }

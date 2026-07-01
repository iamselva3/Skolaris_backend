export const meta = {
  name: 'verify-ad-crops',
  description: 'Adversarially verify AD 2601 question crops (header removed, question+options, no bleed)',
  phases: [
    { title: 'Inspect', detail: 'each agent visually reviews a batch of crops' },
    { title: 'Synthesize', detail: 'aggregate verdicts + defect report' },
  ],
}

const DIR = 'C:/Users/hp/Downloads/new'
const batches = [
  ["q000.png","q008.png","q016.png","q024.png","q034.png","q044.png","q055.png","q065.png","q074.png","q083.png","q091.png","q100.png","q111.png","q119.png","q128.png","q137.png","q146.png","q155.png","q163.png","q172.png"],
  ["q001.png","q009.png","q017.png","q025.png","q035.png","q046.png","q056.png","q066.png","q075.png","q084.png","q092.png","q102.png","q112.png","q121.png","q130.png","q138.png","q147.png","q156.png","q164.png","q173.png"],
  ["q002.png","q010.png","q018.png","q026.png","q036.png","q047.png","q057.png","q067.png","q076.png","q085.png","q093.png","q103.png","q113.png","q122.png","q131.png","q139.png","q148.png","q157.png","q165.png","q174.png"],
  ["q003.png","q011.png","q019.png","q027.png","q037.png","q050.png","q058.png","q068.png","q077.png","q086.png","q095.png","q104.png","q114.png","q123.png","q132.png","q140.png","q149.png","q158.png","q166.png","q175.png"],
  ["q004.png","q012.png","q020.png","q028.png","q039.png","q051.png","q059.png","q069.png","q078.png","q087.png","q096.png","q106.png","q115.png","q124.png","q133.png","q141.png","q150.png","q159.png","q167.png","q176.png"],
  ["q005.png","q013.png","q021.png","q029.png","q041.png","q052.png","q060.png","q070.png","q079.png","q088.png","q097.png","q107.png","q116.png","q125.png","q134.png","q142.png","q151.png","q160.png","q169.png","q178.png"],
  ["q006.png","q014.png","q022.png","q032.png","q042.png","q053.png","q061.png","q071.png","q080.png","q089.png","q098.png","q108.png","q117.png","q126.png","q135.png","q143.png","q152.png","q161.png","q170.png","q180.png"],
  ["q007.png","q015.png","q023.png","q033.png","q043.png","q054.png","q062.png","q072.png","q081.png","q090.png","q099.png","q109.png","q118.png","q127.png","q136.png","q144.png","q153.png","q162.png","q171.png"],
]

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    crops: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          headerPresent: { type: 'boolean' },
          questionTextPresent: { type: 'boolean' },
          optionCount: { type: 'integer' },
          crossColumnBleed: { type: 'boolean' },
          nextQuestionBleed: { type: 'boolean' },
          verdict: { type: 'string', enum: ['GOOD', 'PARTIAL', 'BAD'] },
          note: { type: 'string' },
        },
        required: ['file', 'headerPresent', 'optionCount', 'crossColumnBleed', 'nextQuestionBleed', 'verdict'],
      },
    },
  },
  required: ['crops'],
}

phase('Inspect')
const results = await parallel(
  batches.map((batch, bi) => () =>
    agent(
      `You are reviewing OCR question-crop images from a NEET-style question paper (AD 2601). For EACH file in this list, ` +
      `use the Read tool on the absolute path "${DIR}/<file>" to view the image, then judge it.\n\n` +
      `Files: ${JSON.stringify(batch)}\n\n` +
      `For each crop decide:\n` +
      `- headerPresent: is the institute header "THE SK LEARNINGS / PRIVATE EDUCATIONAL SERVICES" logo or text visible anywhere? (it must NOT be)\n` +
      `- questionTextPresent: is there a readable question stem?\n` +
      `- optionCount: how many answer options (a)(b)(c)(d) are visible (0-5)?\n` +
      `- crossColumnBleed: does the crop contain a SECOND unrelated question's text sitting side-by-side (left+right column mixed)?\n` +
      `- nextQuestionBleed: is the beginning of the NEXT question visible at the bottom edge?\n` +
      `- verdict: GOOD = question stem + its options, no header, no cross-column bleed. PARTIAL = readable but missing some options OR minor next-question bleed. BAD = header present, OR cross-column bleed, OR no question content.\n` +
      `A diagram/figure question (figure + options) is GOOD even if tall. A descriptive question with a clear stem and no options is GOOD (optionCount 0).\n` +
      `Return one entry per file.`,
      { label: `inspect:batch${bi + 1}`, phase: 'Inspect', schema: VERDICT_SCHEMA },
    ),
  ),
)

phase('Synthesize')
const all = results.filter(Boolean).flatMap((r) => r.crops || [])
const good = all.filter((c) => c.verdict === 'GOOD')
const partial = all.filter((c) => c.verdict === 'PARTIAL')
const bad = all.filter((c) => c.verdict === 'BAD')
const headerLeak = all.filter((c) => c.headerPresent)
const colBleed = all.filter((c) => c.crossColumnBleed)
const nextBleed = all.filter((c) => c.nextQuestionBleed)
const lowOpts = all.filter((c) => c.optionCount > 0 && c.optionCount < 4)

const summary = await agent(
  `Synthesize a QUALITY REPORT for ${all.length} AD-2601 question crops.\n` +
  `Totals: GOOD=${good.length} PARTIAL=${partial.length} BAD=${bad.length}.\n` +
  `Defects: headerStillPresent=${headerLeak.length} (${headerLeak.map((c) => c.file).join(', ') || 'none'}); ` +
  `crossColumnBleed=${colBleed.length} (${colBleed.map((c) => c.file).join(', ') || 'none'}); ` +
  `nextQuestionBleed=${nextBleed.length}; under-4-options=${lowOpts.length}.\n` +
  `BAD files: ${JSON.stringify(bad.map((c) => ({ file: c.file, note: c.note })))}.\n\n` +
  `Write a concise verdict: (1) overall crop quality %, (2) is header/footer removal working across the set, ` +
  `(3) is cross-column cropping correct, (4) top defect categories with counts, (5) one-line honest bottom line.`,
  { label: 'synthesize', phase: 'Synthesize' },
)

return {
  totals: { inspected: all.length, good: good.length, partial: partial.length, bad: bad.length },
  defects: {
    headerStillPresent: headerLeak.map((c) => c.file),
    crossColumnBleed: colBleed.map((c) => c.file),
    nextQuestionBleed: nextBleed.length,
    underFourOptions: lowOpts.length,
  },
  badFiles: bad.map((c) => ({ file: c.file, note: c.note })),
  report: summary,
}

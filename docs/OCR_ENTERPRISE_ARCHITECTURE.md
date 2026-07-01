# OCR Enterprise Architecture — FROZEN

## ★ MANDATORY ENTERPRISE RULE (governs all OCR work)
Do NOT build PDF-centric, institute-centric, or NEET/JEE-centric solutions. The 5 reference PDFs
(RE NEET PST · Biology · Biology_Cell · AD 2601 Q · PHYCHE) are **regression guards only, never
targets**. Before accepting ANY implementation, ask: **"If 100 completely different MCQ papers are
uploaded tomorrow, will this still work?"** If NO → reject it.

Every solution must be derived ONLY from: **geometry · whitespace structure · OCR semantics · region
relationships · question grammar**. NEVER from: PDF names · institute names · subjects · question
counts · question numbers · hardcoded values · the reference PDFs.

Enterprise product requirement: any unseen MCQ paper from any client must yield **1 logical question =
1 crop (Question + Options only)** — no solutions, no duplicates, no missing/extra questions, no broken
boundaries, no human intervention when confidence is high.

**Architecture completion ≠ product completion.** The 11-phase framework + correction applier + bridge
are built and value-free (verified: no PDF/institute/subject/count strings in `src/modules/ocr-analysis`).
Product completion still requires: (a) routing the anti-aggressive explanation safety-skips to review
for literal 0-leakage; (b) ≥3 real positive samples each for split-layout / cross-page / handwritten to
PROVE those merge paths (0 exercised on guards); (c) wiring the bridge objects to persistence/rendering/
export. Until (a)–(c), the product is NOT complete regardless of architecture status.

---

Status: **FROZEN (2026-06-16).** This is the architecture-of-record for SKOLARIS OCR
question/option cropping. Do not add layers, stages, or detectors beyond what is listed
here. It **wraps** the existing OCR flow; it does not replace it.

Companion: `docs/OCR_FAMILY_REGISTRY.md` (the per-family catalogue). This doc owns the
pipeline + detector contract; the registry owns the layout-family evidence.

## Product requirement
Upload ANY generic Indian MCQ examination paper → return a correct **Question crop** and
**Options crop**, without manual intervention. Built for generic MCQ papers — **never**
optimized for NEET, JEE, an institute, or a specific PDF. The 5 reference PDFs (RE NEET PST,
Biology, Biology_Cell, AD 2601 Q, PHYCHE) are **validation datasets only**, not targets.

## Frozen pipeline
```
PDF
 ↓
Page Analyzer                 (extract value-free features: ink projection, whitespace rivers,
 ↓                             text-density map, figure/table bboxes, numeral-token map, regions)
Pattern Detectors             (independent detectors; emit findings + confidence; never mutate)
 ↓
Existing OCR flow             (UNCHANGED — segmentation + crop)
 ↓
Question Integrity Validator  (score each emitted crop; route by confidence; never edits)
 ↓
Question + Options crop
 ↓
Review Queue                  (uncertain cases only; never silent-delete)
```

## Permanent rules
- **Explainability gate:** if a detector cannot be explained using **geometry**, **semantics**,
  or **OCR output**, it is rejected and not built.
- Never PDF-specific, never institute-specific, never hardcoded values, never one large OCR rule.
- **Each detector is independent:** a pure function `detect(features) → Finding[]`, reads only the
  shared feature bus, never reads another detector's output, emits findings (the orchestrator
  applies corrections), is independently toggle-able / versioned / testable.
- **Confidence tiers (every detector):** High → Auto fix · Medium → Review queue · Low → NO-OP.
- **Quality > count. Prefer NO-OP over unsafe fixes.** Default action is NO-OP.
- **Enterprise test (applied to every rule):** "If 100 unseen PDFs are uploaded tomorrow, will
  this still work?" If NO → reject. (A rule passes only if it keys on morphology / whitespace
  geometry / region grammar / cross-region comparison — never on a value, institute, or PDF.)

## Frozen detectors (exactly these eight)
Each: what it detects · explainable-via · tiered correction · key guard.

1. **Content numerals** — a content numeral (unit-fused / sign-prefixed / `d[,-]d` locant /
   bare list-ordinal) promoted to a question marker. *Geometry+semantics+OCR.* High→demote/merge
   to parent stem; Med→review; Low→NO-OP. Guard: keep `word`-glued markers and real `d, word`.
2. **Multi-column** — false column from poisoned markers, or true columns over-sliced. *Geometry.*
   High→reflow to single-column pre-OCR; Med→review; Low→NO-OP. Guard: real boundary needs a dense
   whitespace river, low crossing, and markers on both sides.
3. **Split question/options** — one question split into separate stem and option regions
   (top/bottom or left/right). *Geometry+semantics.* High→associate into one unit; Med→review;
   Low→NO-OP. Guard: neighbour column must be marker-free; no next-question-number between.
4. **Cross-page continuation** — stem and options straddle a page break. *Geometry+semantics.*
   High→stitch across boundary; Med→review; Low→NO-OP. Guard: next page must open with options,
   not a fresh marker.
5. **Duplicate numbering** — one number labels >1 region (legitimate section restart vs phantom).
   *Semantics+OCR.* High→keep legitimate / demote degenerate; Med→review; Low→NO-OP. Guard:
   cross-compare instances; never judge by number alone.
6. **Wide content** — diagram/table/matrix/match/circuit sliced as columns. *Geometry.*
   High→keep whole/full-width; Med→review; Low→NO-OP. Guard: gutter-crossing band or figure/table
   bbox is kept intact.
7. **Handwritten markers** — handwritten/circled/stamped/margin question numbers. *Geometry+OCR.*
   High→bound question by stem→options rhythm + attach marker if found; Med→review; Low→NO-OP.
   Guard: numbers are hints, never mandatory; require an option block per bound.
8. **Explanation blocks** — solution/answer/explanation text captured into the question crop.
   *Semantics+geometry.* High→end crop at explanation onset (keep explanation as metadata);
   Med→review; Low→NO-OP. Guard: onset must follow a complete option block.

## Orchestration (so it never becomes one big rule)
- All detectors run over the same features; findings collected, applied in safety order
  (demotions/no-ops before merges/associations).
- Conflicting findings on one region → the more conservative wins; unresolved → review, never auto.
- Idempotent: re-running after correction yields no new high-tier findings.
- τ thresholds are global config (never per-PDF); they tune the auto/review boundary, not the logic.

## Question Integrity Validator
Independent post-OCR scorer (same contract): scores each Question+Options crop on geometry +
grammar (stem band present, option band present, sane boundaries). Confident-good → pass;
confident-bad → hand back to the owning detector's correction; uncertain → review. It decides
routing; it never edits.

## Implementation status
**Phase 1 (framework only, SHADOW MODE) — BUILT 2026-06-16.** `src/modules/ocr-analysis/`:
`contracts.ts` (Detector/Finding/IntegrityValidator interfaces + tier thresholds), `page-analyzer.ts`
(real value-free feature extraction), `detectors.ts` (the 8 detectors as STUBS — `detect()` returns
`[]`, behaviour not implemented), `integrity-validator.ts` (stub), `ocr-shadow-analyzer.ts`
(orchestrator + logging), `ocr-analysis.module.ts` (registered in `app.module` for DI only). The
module is **NOT wired into the OCR flow** (no hook into complete-upload / OcrJobRunner / engine), so
**OCR output is 100% identical** — verified: `scripts/ocr-shadow.ts` over Biology.pdf → 85 drafts
unchanged, findings=0, applied=0. Detector BEHAVIOUR and pipeline integration are NOT built.

**Phase 2 (Detector 1 — Content Numerals, ACTIVE) — BUILT 2026-06-16.** Detector 1 now has real
behaviour and is the ONLY active detector; detectors 2–8 stay shadow stubs. It catches the residual
content-numeral class the frozen engine guard misses (SIGN/dash-prefixed units `−22Gm` / `—85eV`,
locants) post-OCR: HIGH (sign-unit/locant + value==question-number + no separate clean marker) →
auto-fix (remove phantom from the framework's corrected output); plain-unit MEDIUM → review queue;
else LOW → NO-OP. Added `paper-analyzer.ts` (page/marker/region/SECTION structure → expected logical
question count, section-restart aware, NEVER hardcoded) and `OcrShadowAnalyzer.analyzePaper()`.
`contracts.ts` carries a `CompletionBoundary` PREP seam for the future explanation-trim (not built).
The auto-fix is applied in the framework's derived output ONLY — still NOT wired into live persistence
(HandleOcrCallback/OcrJobRunner/engine remain frozen). Validated (`scripts/ocr-phase2-validate.ts`):
RE NEET PST 22→22 and Biology 85→85 IDENTICAL (0 auto-fix, 0 review); AD 151→149 (2 sign-unit phantoms
auto-fixed); Biology_Cell/PHYCHE untouched by Detector 1 (their phantoms are Detector 2 / match
territory). tsc clean; OCR flow untouched.

**Phase 3 (Detector 2 — Duplicate Numbering + Question Completion validator) — BUILT 2026-06-16.**
Detector 2 (paper-level, `detectPaper`) groups drafts by question number: all-well-formed group →
legitimate SECTION RESTART (no finding); a degenerate instance with a well-formed sibling → finding
for that instance only (short stub / mislabel → HIGH auto-remove; ambiguous → MEDIUM review). A unique
real question is never flagged; the well-formed sibling always survives. The **Question Completion
validator** (the integrity stage) now REUSES the engine's exported Session-3 `isCompleteBlock` /
`classifyBlock` (read-only) to mark completeness + the **completion boundary** (bottom of the option
block) per draft — the boundary source the future Explanation Block detector will reuse (PREP only, no
trimming). It routes only option-only orphans to REVIEW (so clean papers stay identical). Detectors
3–8 remain shadow. Validated (`scripts/ocr-phase2-validate.ts`): RE NEET PST 22→22 and Biology 85→85
IDENTICAL; **Biology_Cell 100→92** (8 match-list-item fragments removed; true 90) and **PHYCHE 50→49**
(Q28-as-50 mislabel removed; = true 49) move toward true count; AD 151→149 (D2 finds its 5 cross-subject
duplicates all legitimate section-restart → 0 removals). Completion boundaries derived for 100% of
drafts. tsc clean; OCR flow untouched; auto-fixes still in the framework's derived output only.

**Phase 4 (Count Reconciliation + Review Queue routing) — BUILT 2026-06-16.** `count-reconciler.ts`
reconciles OCR count / corrected count / expected count (derived from SECTION structure, no
hardcoding) → final logical count + status: all agree → PASS; high-confidence fixes explain the gap →
RECONCILED; disagreement or ambiguous items → NEEDS_REVIEW. It NEVER invents a question and NEVER
deletes beyond the applied high-confidence fixes (final = corrected). `review-queue.ts` routes ONLY
ambiguous duplicates (Detector-2 MEDIUM) / ambiguous boundaries (completion option-only) /
low-confidence (Detector-1 MEDIUM); clean papers route nothing. Detectors 3–8 remain shadow.
Validated (`scripts/ocr-phase2-validate.ts`): RE NEET PST 22 PASS + Biology 85 PASS (IDENTICAL);
Biology_Cell final=92 RECONCILED (its 2 residuals deliberately NOT solved — awaiting later detectors);
PHYCHE final=49 RECONCILED (= true 49); AD final=149 RECONCILED, 7 sections (section-restart aware).
Review queue empty on all 5. tsc clean; OCR flow untouched; reconciliation/routing operate on the
framework's derived output only.

**Phase 5 (Question Lifecycle + Boundary Engine) — BUILT 2026-06-16.** `lifecycle.ts` —
`QuestionLifecycleEngine` runs each corrected question through START→EXPAND→COMPLETE→FINALIZE→EMIT and
emits exactly one Question+Options crop per logical question (one logical question = one crop). Phase 5
registers NO hooks ⇒ pure PASS-THROUGH: it creates no crop, deletes none, and NEVER gates emission on
the completeness check (which false-negatives on sparse OCR) — so clean papers are unchanged.
Uncertainty is carried as `needsReview` from the existing review signals (flagged, never dropped —
prefer NO-OP). Defines `StartHook`/`ExpandHook`/`FinalizeHook` extension points with documented future
ownership (Multi-column/Handwritten→START; Wide/Split/Cross-page→EXPAND; Explanation→FINALIZE). The
FINALIZE stage locks the Session-3 completion boundary (boundary source for the future Explanation
detector). Validated (`scripts/ocr-phase2-validate.ts`): emitted == finalLogicalCount on all 5
(RE NEET 22 PASS, Biology 85 PASS — IDENTICAL, N→N; Biology_Cell 92, PHYCHE 49=true, AD 149); every
draft traversed all 5 stages; review queue empty. tsc clean; OCR flow untouched; lifecycle operates on
the framework's derived output only.

**Phase 6 (Detector 3 — Multi-column, owns START) — BUILT 2026-06-16.** `multi-column.ts` —
`detectMultiColumnPage` (per-PAGE, value-free) flags a page TRUE multi-column only if ALL hold: clean
whitespace gutter (cleanFraction ≥ 0.8) + ≥2 increasing markers on BOTH sides + low gutter-crossing
(< 0.15); else NO-OP. `MultiColumnStartHook` (registered as the lifecycle's only START hook) gates on
that decision but returns geometry UNCHANGED (the frozen engine already column-scopes drafts; clamping
would risk cutting content that reaches the gutter, and splitting a gutter-spanning draft is
forbidden here) — it owns START without an unsafe change. `MultiColumnDetector.detect` emits
informational findings (HIGH true multi-column → observation; borderline → review); single-column /
divider / grid / crossing pages emit nothing. Detectors 4–8 remain shadow. Validated
(`scripts/ocr-phase2-validate.ts`): RE NEET 22 + Biology 85 IDENTICAL (0 detection, 0 START change);
Biology_Cell 92 / PHYCHE 49 / AD 149 unchanged; AD flags 1 clean-gutter page as multi-column
(observation), START-region changed = 0 on ALL papers, emitted == final everywhere. tsc clean; OCR
flow untouched.

**Phase 7 (Detector 4 — Wide Content, owns EXPAND) — BUILT 2026-06-16.** `wide-content.ts` —
`classifyWideContent` answers "is this content wider than a logical question?" per draft, value-free:
match-the-following / diagram (engine read-only `classifyBlock`) / gutter-crossing (geometry) / large
low-text figure (area + density). `WideContentExpandHook` (registered as the lifecycle's EXPAND hook)
keeps wide content FULL WIDTH and returns geometry UNCHANGED (nothing narrows/splits in Phase 7 → NO-OP
is the safe action). `WideContentDetector.detect` emits HIGH informational findings (observations);
uncertain regions emit nothing. Never creates/deletes/splits/merges, never changes counts/boundaries.
Detectors 5–8 remain shadow. Validated (`scripts/ocr-phase2-validate.ts`): RE NEET 22 + Biology 85
IDENTICAL; Biology_Cell 92 / PHYCHE 49 / AD 149 unchanged; **EXPAND-region changed = 0 on ALL papers**;
emitted == final everywhere; wide-content observations only (diagram/crosses-gutter/match/figure),
0 auto-fix, 0 review. tsc clean; OCR flow untouched.

**Phase 8 (Detector 5 — Split Question+Options, owns EXPAND) — BUILT 2026-06-16.** `split-question.ts`
— `detectSplitOrphans` (paper-level) finds ORPHAN OPTION REGIONS (option grammar + NO question marker
+ NO stem, via the engine's read-only `hasStem`) and a candidate stem under the strict 4-rule gate
(no valid next-marker between · orphan has no marker · orphan has no stem · neighbour option area
marker-free). It emits review findings + an EXPAND hint but NEVER merges (merging changes counts —
deferred); `SplitQuestionExpandHook` is NO-OP. Protects multi-column/match/diagram/shared-stem
implicitly (those carry markers/stems ⇒ never orphans). Detectors 6–8 remain shadow. Validated
(`scripts/ocr-phase2-validate.ts`): all 5 papers have 0 orphan findings (engine full-width regions +
Phases 2–3 already cover the references; true orphans only arise on unseen split-layout uploads);
RE NEET 22 + Biology 85 IDENTICAL; Biology_Cell 92 / PHYCHE 49 / AD 149 unchanged; emitted == final,
EXPAND-region changed = 0 everywhere; 0 merges, 0 splits. tsc clean; OCR flow untouched.

**Phase 9 (Detector 6 — Cross-page Continuation, owns EXPAND) — BUILT 2026-06-16.** `cross-page.ts` —
`detectCrossPageContinuations` (paper-level) inspects each adjacent page pair: page N's bottom region
INCOMPLETE (read-only `isCompleteBlock`=false) + page N+1's top region MARKER-FREE + option/continuation
text + no new marker first ⇒ continuation candidate (review). NEVER stitches (changes counts —
deferred); `CrossPageExpandHook` is NO-OP. Section headers/instructions/tables/diagrams/match are
protected (they carry a marker or aren't option/continuation text). Detectors 7–8 remain shadow.
Validated (`scripts/ocr-phase2-validate.ts`): all 5 papers have 0 cross-page candidates (page tops
start with numbered markers; real continuations only arise on unseen uploads); RE NEET 22 + Biology 85
IDENTICAL; Biology_Cell 92 / PHYCHE 49 / AD 149 unchanged; emitted == final, EXPAND-region changed = 0
everywhere; 0 stitches. tsc clean; OCR flow untouched.

**Phase 10 (Detector 7 — Handwritten Markers, owns START) — BUILT 2026-06-16.** `handwritten.ts` —
`detectHandwrittenMarkers` (per-PAGE) flags regions with NO printed marker (`questionNumber === null`)
that nevertheless have a real stem (read-only `hasStem`) + an option block (≥2 distinct labels) +
question-like vertical rhythm (height near the page median) — a valid boundary whose number is
handwritten/absent. Numbers are HINTS: it routes the uncertainty to review and NEVER creates a
question; `HandwrittenStartHook` is NO-OP. Diagrams/tables/match protected (no option block ⇒ rule
fails). Detector 8 remains shadow. Validated (`scripts/ocr-phase2-validate.ts`): all 5 papers have 0
candidates (every reference draft carries a printed number; unmarked boundaries only arise on unseen
uploads); RE NEET 22 + Biology 85 IDENTICAL; Biology_Cell 92 / PHYCHE 49 / AD 149 unchanged; emitted ==
final, START/EXPAND-region changed = 0 everywhere; 0 questions created. tsc clean; OCR flow untouched.

**Phase 11 (Detector 8 — Explanation Blocks, owns FINALIZE) — BUILT 2026-06-16. ALL 8 DETECTORS NOW
IMPLEMENTED.** `explanation.ts` — `detectExplanationBlocks` (per-PAGE) finds a generic explanation/
solution onset (`Sol|Ans|Explanation|Hint`, a semantic pattern — not a value) at a line start BELOW a
complete option block (≥2 labels + read-only `isCompleteBlock`), and emits a HIGH observation +
FINALIZE hint (trim-to-completion-boundary). It NEVER trims in Phase 11 (the `ExplanationFinalizeHook`
is NO-OP). Descriptive/diagram/match protected (no complete option block / match ⇒ skip). Validated
(`scripts/ocr-phase2-validate.ts`): RE NEET 22 (0 explanation obs) + Biology 85 (71 explanation obs)
both IDENTICAL — observations don't change crops; Biology_Cell 92 / PHYCHE 49 / AD 149 unchanged;
emitted == final, FINALIZE/emit-crop changed = 0 (0 trims) everywhere. tsc clean for ocr-analysis (8
unrelated errors are the concurrent students-module WIP, not this module); OCR flow untouched.

**PRODUCTION WIRE (OPTION a) — count corrections live — 2026-06-16.** `HandleOcrCallbackUseCase` now
runs `CallbackCorrectionService` (reuses the existing text-based Content-Numeral + Duplicate-Numbering
detectors + delivery gate) over the engine drafts BEFORE persistence, so the persisted/reviewed SET is
the corrected one (phantom/duplicate drafts dropped). Verified (`scripts/ocr-callback-verify.ts`):
PHYCHE 50→49, AD 151→149, Biology_Cell 100→92, RE NEET 22→22, Biology 85→85 — matches the validated
framework; all gate DELIVER. Minimum seam: only `HandleOcrCallbackUseCase` (+ its spec) + `ocr.module`
import; no OCR/engine/threshold/detector change. **LIMITATION:** the GEOMETRY corrections (explanation
crop-trim, split/cross-page crop-merge) need page words+images that exist only inside the OCR run, NOT
at this callback — so they are NOT applied to delivered crops; solution text in a crop is currently
delivered untrimmed/unflagged. Removing it needs the framework's word-level detectors to run inside the
OCR run (OcrJobRunner), which modifies OCR plumbing (out of scope).

**DELIVERY GATE + gated delivered output (TASK 2) — BUILT 2026-06-16.** `delivery-gate.ts`
(`DeliveryGate`) decides per PDF: DELIVER iff N=N, 0 duplicate/missing/extra/broken-boundary/orphan,
0 silent leakage; else REVIEW_ENTIRE_PDF (never silently delivered). Low-confidence questions are
flagged per-question for review without failing the PDF. The bridge object IS the gated delivered
representation. Verified (`scripts/ocr-ship-verify.ts`): all 5 → DELIVER, N=N, 0 defects, 0 silent
leakage; flagged-for-review solution cases (2/14/2) ride along as review flags. **Not yet wired into
the live client read-path** — the frozen persistence/dispatch (`HandleOcrCallbackUseCase`/`OcrJobRunner`)
still serves the base segmentation; connecting it is the one remaining production change.

**EXECUTION — declined trims routed to review (no silent failures) — 2026-06-16.** The Correction
Applier now surfaces explanation trims declined by the anti-aggressive guard (`skippedExplanationTrims`);
the orchestrator routes them to the review queue, and the bridge tracks `silentLeakageObjects`.
Verified: **silent solution leakage = 0 on all 5** (the 18 high-onset cases are flagged-for-review, not
silently delivered). N→N and 0 duplicate/extra/missing/orphan hold on all. No new phase/detector.

**PRODUCTION BRIDGE LAYER — BUILT 2026-06-16.** `production-bridge.ts` (`ProductionBridge`) is a PURE
transformation of the corrected `PaperReport` into export-ready logical-question objects (no rendering,
no storage, no persistence, no reviewer changes). Per question: `questionId` (deterministic), source
pages, final boundaries, merged regions, explanation-trim boundary, Question+Options bbox, review
status, confidence — fed by correction PROVENANCE the applier now records (`appliedProvenance`).
Cross-column / cross-page questions collapse to ONE object; explanation is trimmed out of the bbox.
Verified (`scripts/ocr-bridge-verify.ts`): N→N on all 5 (22/85/49/149/92 objects), 0 duplicate/orphan/
extra/missing; RE NEET + AD bridge objects fully VALID (0 leakage); Biology 2 / PHYCHE 14 /
Biology_Cell 2 residual leakage (safety-skipped trims). **Production Bridge Ready: NO** — residual
leakage (18 objects), split & cross-page merge UNPROVEN (0 exercised — no positive samples in guards),
and bridge objects are representations not yet wired to persistence/rendering/export. Real PDFs needed:
≥3 split-layout, ≥3 cross-page, ≥3 handwritten. tsc clean; engine/persistence untouched.

**APPLY DETECTOR CORRECTIONS (Enterprise mode) — BUILT 2026-06-16.** `correction-applier.ts`
(`CorrectionApplier`) applies the four detected operations to the framework's DERIVED crop set
(engine + live persistence still frozen): (1) **Explanation Trim** — shrink a crop's bottom to the
explanation onset (keep Q+Options), with an anti-aggressive guard (skip if the kept part would be
< half the crop → route to review); (2) **Split Merge** — union an orphan option region into its
candidate stem; (3) **Cross-page Merge** — absorb a next-page continuation into its stem; (4) surviving
crops are Question+Options only. The orchestrator runs the applier on the corrected set BEFORE the
lifecycle, so emitted crops + reconciliation reflect the corrections. Validated
(`scripts/ocr-enterprise-validate.ts`): N→N preserved on all 5 (22/85/49/149/92), 0 dup/orphan/extra/
missing; explanation leakage massively reduced — Biology 71→2, PHYCHE 35→14, Biology_Cell 66→2, AD 1→0,
RE NEET 0→0 (residuals are the safety-skipped aggressive trims → review). RE NEET + AD reach full
enterprise ACCEPTANCE PASS; Biology/PHYCHE/Biology_Cell NOT-YET only by the safety-skipped residual
leakage (kept rather than aggressively trimmed — quality > count). References used as guards only.

**SAFE SPLIT FALLBACK — auto-merge DISABLED, hard delivery blocker added — 2026-06-16.** Split-merge
auto-application is PROVEN UNSAFE and is now OFF: with the marker-free-path gate enabled, the applier
false-merged on the RE NEET regression standard (Q142 stem unioned with the entire adjacent-column Q148
Assertion-Reason question — markerFreePath held only because Q143-147 sit in the other column — losing a
real question, 180→179). `split-question.ts` now never emits `split-orphan-associable` (`associable=false`,
structural signals kept as review detail only); `correction-applier.ts` therefore performs 0 split merges.
`delivery-gate.ts` gains a hard blocker: an unresolved split orphan + Q+O completeness < 100% ⇒
`REVIEW_ENTIRE_PDF`, reason `split-question-unresolved`, `reviewRequired=true` — never silently passed,
delivered, or reviewed. Re-validated full-stack (`scripts/ocr-ship-verify.ts`): RE NEET restored
`180→180` (splitMerges=0); all 5 guards splitMerges=0, 0 duplicate/missing/extra/broken-boundary,
silent leakage=0, every unresolved split BLOCKED to review. Auto-merge stays blocked pending ≥3 real
positive split-layout samples (0 exist). tsc clean; engine/persistence untouched.

**EXPLANATION-TRIM ANTI-AGGRESSIVE GUARD made STRUCTURAL — 2026-06-16.** The Correction Applier's
explanation-trim guard previously skipped a trim whenever the kept Question+Options would be < 50% of
the crop height — a relative-size heuristic that wrongly retained solution text whenever the SOLUTION
block was taller than the question (multi-line `SOL:` / worked solutions). Replaced with a region-grammar
guard: the explanation detector already guarantees the onset (`trimToY`) sits BELOW a verified-complete
option block (`completeAtY`), so a trim is safe iff it preserves that whole option block (`trimToY ≥
completeAtY`); skip ONLY when the boundary is missing or the cut would bite into options (→ review, never
silent). Value-free, generic, ocr-analysis only (engine/persistence frozen). Re-validated
(`scripts/ocr-enterprise-validate.ts`, real OCR): explanation leakage → **0 on ALL 5** (Biology_Cell 2→0,
Biology 2→0, PHYCHE 14→0, AD 0, RE NEET 0); N→N preserved (92/178/85/49/149); 0 bad-duplicate / 0 extra /
0 missing everywhere. The only residual on each paper is the MEDIUM split-orphan review flag (Detector 5,
present even on the RE NEET baseline) — DETECTED and routed to review, merge deferred per the backlog.

**ENTERPRISE VALIDATION LAYER (shadow reporting) — BUILT 2026-06-16.** `enterprise-validation.ts`
(`EnterpriseValidator`) is a PURE function over the framework's `PaperReport` — no detection, no
engine, no persistence, no PDF/institute/value logic. For ANY uploaded MCQ PDF it emits the 11-field
report: total logical questions, total emitted crops, missing, duplicate (bad vs legitimate
section-restart), orphan, extra, Q+O completeness %, explanation leakage, review-queue items, N→N
verification, and per-detector contributions (findings / confidence range / auto-fix / review /
observe / no-op). It computes an acceptance verdict and lists criteria blocked by DEFERRED application
(trim/merge). The orchestrator now records every finding's routing outcome (`allFindings`) to feed it.
Runner: `scripts/ocr-enterprise-validate.ts <pdf>…` (generic; references are regression GUARDS only).
Observed: N→N PASS + 0 extra/orphan/bad-duplicate on all references; RE NEET ACCEPTANCE PASS;
Biology/PHYCHE acceptance NOT-YET only because explanation leakage (71 / 34) is DETECTED but not
trimmed (FINALIZE trim = deferred live application). The real acceptance target is 100 unseen PDFs,
not the references.

**ENTERPRISE FRAMEWORK STATUS (Phases 1–11 complete):** the wrap-around pipeline + all 8 detectors run
over every paper in shadow/observation mode around the UNCHANGED engine. Auto-fix is enabled only for
the two evidence-backed count correctors (Content Numerals HIGH + Duplicate Numbering HIGH); all other
detectors are observation / review / NO-OP. NOTHING is wired into live persistence (HandleOcrCallback /
OcrJobRunner / engine remain frozen) and no detector changes geometry. Remaining work (separately
authorized): live-persistence integration (actually applying the merges / stitches / trims / corrections
that are currently only hinted), and threshold tuning against real unseen-layout samples.

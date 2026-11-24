---
target: the landing page
total_score: 23
max_score: 32
na_heuristics: 7,10
p0_count: 0
p1_count: 3
target_identity: "file:C:\\Users\\kando\\OneDrive\\Desktop\\Software\\BV\\autodesk\\wwwroot\\landing.html"
target_fingerprint: "sha256:86c0100aa31b500465fdfa415461f2540e2f21e7a1ca26828c7dbd12563bcfcc"
target_path: "C:\\Users\\kando\\OneDrive\\Desktop\\Software\\BV\\autodesk\\wwwroot\\landing.html"
timestamp: 2026-11-09T03-45-04Z
slug: wwwroot-landing-html
---
# Critique: Ask Augmented landing page (wwwroot/landing.html)
Method: dual-agent (A: design review, B: detector + browser evidence)

## Design Health Score: 23/32 (Good, 72%); heuristics 7 and 10 n/a (one-pass landing page)
| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of status | 2 | Each demo answer is shown for ~3.9 s of a ~7.5 s loop; the plate is often empty |
| 2 | Match real world | 4 | Revit vocabulary and correct French terms |
| 3 | User control | 2 | The demo loop can't be paused, stepped or replayed |
| 4 | Consistency | 3 | One destination, two labels: "Open the app" / "Open the sample model" |
| 5 | Error prevention | 3 | Required fields not marked |
| 6 | Recognition | 3 | Example questions are dead text; "questions above" relies on memory |
| 7 | Flexibility | n/a | |
| 8 | Minimalism | 3 | Long: 8 + 5 + 6 cells plus a form after How |
| 9 | Error recovery | 3 | Errors appear in one status line far from the field |
| 10 | Help | n/a | |

## Design specificity
Authored, not template:
- the window and line frame with count markers
- understood tags instead of SQL
- can / can't signage
- drawing-set numbering

Generic zones: the 6 role cards, the stock contact form, and the "Spatial intelligence" copy.

## Priority issues
- **[P1] The mobile header app button has no accessible name.** Below 640px the span is `display:none` and the arrow is aria-hidden. Fix: visually hidden text, or an aria-label (translated).
- **[P1] The proof loop can't be paused; answers last ~4 s; the plate is aria-hidden.** Fix:
  - pause/play and 01–04 step buttons
  - hold each answer 6–8 s
  - pause on hover and focus
  - a hidden list of the questions and answers for screen readers
  - the refusal as scene 2
- **[P1] Example questions are dead text, and some (doors, level 3) may not exist in the structural sample.** Fix: link each to /app with the right model and the question prefilled; verify each one; change the gate copy.
- **[P2] The demo drawing is invented geometry presented next to real answers.** Fix: caption "real answer · simplified drawing".
- **[P2] Too many equal-weight choices.** The header has 8 controls, two CTA labels, the roles repeat the "can" grid, and the page ends on the form. Fix:
  - one CTA label everywhere
  - a smaller header
  - 3 roles, or role tags on the "can" cells
  - a quieter or separate contact form

## Persona red flags
- **Jordan:** two CTA names; which sample model?; may see an empty plate.
- **Riley:** door questions on the structural sample; detached error that keeps the old language after switching.
- **Casey:**
  - EN/FR buttons 27.6px tall
  - bare-arrow app button
  - the proof sits below the fold
  - "No sign-up" sits about 1000px below the CTA
- **Engineer:** no provenance shown (which Revit parameter); can't tell code answers from AI-written ones.

## Minor
- "ASK" contrast 3.06:1: darken to about #6f6d66.
- The bounce easing `cubic-bezier(.2,1.4,.4,1)`: use a plain ease-out.
- The status line uses one colour for progress and errors.
- FR "Jamais / Ne modifie la maquette": reword.
- No notice for FR visitors that the app answers in English.
- "215.875 m³" reads as raw precision.
- The success panel has no next step.
- The hero mouse tilt competes with the CTA.
- "Spatial intelligence" is buzzword copy.

## Detector
19 findings.
- Real: ASK contrast, bounce easing, `.limits p` leading 1.25, and drift in the 14px privacy size and `#fff` selection.
- False positives: cramped-padding ×13 (hairline dividers), font "ui" (the Segoe UI fallback), flat-type-hierarchy (measured labels, not headings).

## Questions
- Why is the refusal, the most credible moment, the last of four scenes?
- What if the window were a real, clickable question box on the sample model?
- Do the role cards and the contact form serve the decision to open the sample?

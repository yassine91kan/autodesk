---
target: live website askaugmented.com
total_score: 26
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 3
target_identity: "url:https://www.askaugmented.com/"
timestamp: 2026-11-23T00-32-51Z
slug: www-askaugmented-com
---
# Formal review: https://www.askaugmented.com/ (live, 2026-11-22)
Method: dual-agent (A design review, B detector + browser). The overlays were blocked by the client, so the CLI URL scans were used instead.

## Score: 26/40 (Acceptable)
| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Status | 3 | Empty demo card on first paint; "TOKENS 0·0" means nothing to guests |
| 2 | Real world | 3 | "TYPE 0/2" and "Spatial intelligence" |
| 3 | Control | 3 | The landing demo can't be paused |
| 4 | Consistency | 2 | Landing and app look like two products; examples look like links but aren't; FR slips |
| 5 | Error prevention | 2 | The guest model list shows capture.js and drive_shaft.dwg |
| 6 | Recognition | 3 | 15-icon viewer toolbar |
| 7 | Flexibility | 3 | No re-run of an earlier question |
| 8 | Minimalism | 2 | 8 + 6 cards; 8 app header controls; 15 toolbar icons |
| 9 | Error recovery | 3 | App error states untested |
| 10 | Help | 2 | No explanation of TYPE 0/2 or the guest budget |

## Priority issues
- **[P0] The demo pairs questions with the wrong answers.** The previous answer stays visible while the next question types, and the decimal count-up flashes wrong values. Fix: hide the answer when a new question starts; count up only integers.
- **[P1] The guest model list shows internal files** (capture.js, drive_shaft.dwg). Fix: show guests only the curated samples, with friendly names; remove the stray files.
- **[P1] The app header assumes knowledge a guest doesn't have:** TYPE 0/2, an unlabelled chat icon, TOKENS, and Upload shown to guests. Fix: hide or rename them; show "N questions left today"; "Sign in to upload".
- **[P1] No handoff from the landing page to the app.** Examples aren't links and don't match the app's chips, and the app looks nothing like the landing page. Fix: /app?q= links, verified per model; show a real drawing-sheet capture on the landing page.
- **[P2] SEO, sharing and security basics:**
  - the onrender.com duplicate (byte-identical)
  - no canonical, og:url, og:image or twitter card
  - robots.txt and sitemap.xml return 404
  - a two-hop apex redirect
  - no HSTS, nosniff or frame options; x-powered-by exposed
  Fix: redirect/headers middleware, meta tags plus a preview image, robots.txt and a sitemap.

Also real:
- /app script errors at BaseExtension.js:52 and SummaryPanel.js:31.
- The demo is aria-hidden with no pause control.
- EN/FR buttons are 32x28 on mobile.
- No nav menu below 1080px.

## Detector (CLI URL scans)
- **Landing:** blinking-cursor (deliberate), cream-palette (false positive), bounce-easing advisory on mobile.
- **/app:** cream (false positive), content-hidden-at-rest (false positive: viewer progress labels), 2 real script errors.

## Measurements
- **Landing:** about 160 KB and 10 requests, load ≈225 ms.
- **Accessibility:** all text passes contrast (minimum 4.66:1 for the clay indices); focus visible; heading order correct; no overflow at 375px.
- **Tap targets under 44px:** EN/FR, the logo, the hero link, footer links.

## Personas
- **Jordan:** app jargon; unlabelled mobile arrow; no menu.
- **Riley:** capture.js; language switch mid-animation; demo mismatch; console errors.
- **Casey:** tiny EN/FR buttons; no menu; empty round window.
- **Engineer:** the lit columns looked near-white (verify); "exact" undercut by the demo; how multi-level columns are counted.

## Minor
- FR: "See how answers are made" untranslated; 4-line H1 at 1536px; header CTA colour differs between EN and FR.
- "Spatial intelligence" is hype copy.
- The QUERY label isn't associated with the app's query box.
- No browser caching for the SVG and fonts.
- The live site lags the local copy: the Ask logo, contact form and contrast fixes are not pushed.

## Questions
- Show the real drawing sheet instead of the cartoon frame?
- List exclusions alongside counts?
- Make the hero the query box?

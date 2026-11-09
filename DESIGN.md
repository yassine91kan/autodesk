---
name: Augmented
description: Ask a Revit model a question in plain words; the exact number from the model, shown in 3D.
colors:
  clay: "#c15f3c"
  clay-ink: "#a9502f"
  clay-light: "#e8957a"
  clay-fill: "rgba(193, 95, 60, 0.18)"
  sky-deep: "#3d6f9f"
  sky-text-dark: "#8db4dc"
  ground: "#f0eee6"
  ground-2: "#e8e6dc"
  on-ground: "#141413"
  on-ground-2: "#5e5d59"
  rule: "#d3d0c5"
  ink: "#141413"
  ink-solid: "#0a0a09"
  ivory: "#faf9f5"
  cloudy: "#b0aea5"
  site: "#faf9f5"
  line: "#a3a198"
  ground-dark: "#1c1b18"
  ground-2-dark: "#24231f"
  on-ground-dark: "#ecebe4"
  rule-dark: "#3a3934"
  site-dark: "#26251f"
  line-dark: "#6b6a64"
typography:
  display:
    fontFamily: "Barlow Semi Condensed, Arial Narrow, sans-serif"
    fontSize: "min(clamp(54px, 7vw, 96px), 11.5svh)"
    fontWeight: 700
    lineHeight: 0.9
    letterSpacing: "-0.02em"
  headline-gate:
    fontFamily: "Barlow Semi Condensed, Arial Narrow, sans-serif"
    fontSize: "clamp(42px, 5.4vw, 78px)"
    fontWeight: 700
    lineHeight: 0.95
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Barlow Semi Condensed, Arial Narrow, sans-serif"
    fontSize: "clamp(36px, 4.4vw, 64px)"
    fontWeight: 700
    lineHeight: 0.95
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Barlow Semi Condensed, Arial Narrow, sans-serif"
    fontSize: "21px"
    fontWeight: 700
    lineHeight: 1.1
  title-role:
    fontFamily: "Barlow Semi Condensed, Arial Narrow, sans-serif"
    fontSize: "23px"
    fontWeight: 700
    lineHeight: 1.1
  question:
    fontFamily: "Barlow Semi Condensed, Arial Narrow, sans-serif"
    fontSize: "clamp(20px, 1.9vw, 25px)"
    fontWeight: 600
    lineHeight: 1.2
  button:
    fontFamily: "Barlow Semi Condensed, Arial Narrow, sans-serif"
    fontSize: "20px"
    fontWeight: 700
    lineHeight: 1
  statement:
    fontFamily: "Barlow Semi Condensed, Arial Narrow, sans-serif"
    fontSize: "18px"
    fontWeight: 600
    lineHeight: 1.25
  example:
    fontFamily: "Barlow Semi Condensed, Arial Narrow, sans-serif"
    fontSize: "16.5px"
    fontWeight: 600
    lineHeight: 1.3
  lede:
    fontFamily: "Barlow, Segoe UI, system-ui, sans-serif"
    fontSize: "clamp(18px, 1.5vw, 21px)"
    fontWeight: 500
    lineHeight: 1.45
  body:
    fontFamily: "Barlow, Segoe UI, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 400
    lineHeight: 1.55
  small:
    fontFamily: "Barlow, Segoe UI, system-ui, sans-serif"
    fontSize: "15.5px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "IBM Plex Mono, ui-monospace, Cascadia Mono, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "0.05em"
  label-strong:
    fontFamily: "IBM Plex Mono, ui-monospace, Cascadia Mono, monospace"
    fontSize: "11.5px"
    fontWeight: 500
    lineHeight: 1
    letterSpacing: "0.06em"
  wordmark:
    fontFamily: "Montserrat, Segoe UI, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    letterSpacing: "0.18em"
rounded:
  square: "2px"
  round: "50%"
spacing:
  gutter: "clamp(16px, 2.5vw, 32px)"
  section: "clamp(48px, 6vw, 88px)"
  head-gap: "clamp(28px, 3.4vw, 44px)"
  cell: "18px 20px 22px"
  card: "22px 22px 20px"
  container: "1440px"
components:
  button-primary:
    backgroundColor: "{colors.on-ground}"
    textColor: "{colors.ivory}"
    typography: "{typography.button}"
    rounded: "{rounded.square}"
    padding: "0 24px 0 26px"
    height: "58px"
  button-primary-hover:
    backgroundColor: "{colors.clay}"
    textColor: "#ffffff"
  button-ivory:
    backgroundColor: "{colors.ivory}"
    textColor: "{colors.ink}"
    typography: "{typography.button}"
    rounded: "{rounded.square}"
    padding: "0 24px 0 26px"
    height: "58px"
  nav-app:
    backgroundColor: "{colors.on-ground}"
    textColor: "{colors.ivory}"
    typography: "{typography.label}"
    rounded: "{rounded.square}"
    padding: "11px 14px"
  question-plate:
    backgroundColor: "{colors.ink-solid}"
    textColor: "{colors.ivory}"
    typography: "{typography.question}"
    rounded: "{rounded.square}"
    padding: "8px 16px 14px"
  understood-tag:
    textColor: "{colors.ivory}"
    typography: "{typography.label}"
    padding: "6px 7px"
  count-marker:
    backgroundColor: "{colors.clay}"
    height: "26px"
  can-sign:
    backgroundColor: "{colors.sky-deep}"
    textColor: "{colors.ivory}"
    rounded: "{rounded.round}"
    size: "46px"
  role-card:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.on-ground}"
    rounded: "{rounded.square}"
    padding: "{spacing.card}"
  role-card-hover:
    backgroundColor: "{colors.site}"
  how-board:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.ivory}"
    rounded: "{rounded.square}"
    padding: "clamp(32px, 4.4vw, 64px) clamp(24px, 3.6vw, 56px)"
  gate:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.ivory}"
    rounded: "{rounded.square}"
    padding: "clamp(36px, 5vw, 72px) clamp(28px, 4.4vw, 64px)"
---

# Design System: Augmented

Scope: this file records the public landing page only (`wwwroot/landing.html`, served at `/`). The app (`wwwroot/index.html`) and sign-in (`wwwroot/login.html`) still use the older drawing-sheet system in `wwwroot/assets/css/drawing-sheet.css`. That system is not recorded here, and its frames, margins and corner crosses must not carry over to the landing page.

The shipped page is variation C, a hybrid chosen by the owner on 2026-11-08. The two variations it was built from are archived and not served: `design/landing-variants/landing-a-site-hoarding.html` (A) and `design/landing-variants/landing-b-drawing-set.html` (B). The page ships no raster images; `.impeccable/review/c-full.png` and `c-top.png` are review captures of the local build, not assets.

## Overview

**Creative North Star: "The Site Window"**

A pale site hoarding with one round window cut into it, through which you watch the work. Through the window is an isometric frame drawn in lines; a question types onto a dark plate at the window's foot, the matching elements light in clay, and a clay count marker is pinned to them with a leader. Everything around the window is site signage: billboard-scale condensed headlines, blue round signs for what you can ask, an ink board for how an answer is made, clay ring-and-slash signs for what it cannot answer, and an ink gate framed in clay to close.

The data is labelled like a drawing set. Small IBM Plex Mono capitals carry every piece of data: the nav, the plate bar, the understood tags, the spec list, the [01] cell numbers, the 001–004 log, the limit codes and the footer small print. They never set a headline or a paragraph. Content sits in numbered cells divided by hairlines, not in boxes.

The page is lively but plain. Hovers lift, tilt and slide; sections rise in as they scroll into view; the window tilts with the mouse; the answer number counts up. All of it switches off under reduced motion. The owner has rejected an orange/clay page background, drawing-sheet frames and corner crosses, a black nav bar, a ruled information-board footer, a scrolling ticker strip and a three.js 3D model in the window.

**Key Characteristics:**
- Pale ground (#f0eee6 light, #1c1b18 dark) edge to edge; clay is an accent only.
- Barlow Semi Condensed billboard headlines; Barlow for reading; IBM Plex Mono capitals for data only.
- One round window with a clay rim, an iris transition and a line-drawn isometric frame.
- Hairlines between sections and cells; no frames.
- Signage grammar: blue round signs for "can", clay ring-and-slash for "can't".
- Claude's palette only.

## Colors

Claude's palette on a pale ground: ink for print, clay for the one accent, one deep sky blue for the "can" signs.

### Primary
- **Accent Clay** (clay): the window rim, the gate's inset frame, lit elements, the count marker, the role card's top bar, hovered signs and icons, prohibition rings, button hover, focus rings and selection.
- **Clay Ink** (clay-ink): clay as small text on the ground: [01] cell numbers, limit codes and nav hover. In dark mode it becomes clay-light.
- **Lit Clay** (clay-light): clay on ink: the button arrow, the caret, the 001 log numbers, the answer number and dashed "missing" tags.
- **Clay Fill** (clay-fill): the translucent fill of lit walls and slabs.

### Secondary
- **Sign Blue** (sky-deep): the round "can" signs and the example questions on the ground. In dark mode the example text uses sky-text-dark.

### Neutral
- **Ground** (ground, ground-2): the page, and the hover wash on cells and limits.
- **On-ground** (on-ground, on-ground-2): text on the ground, and secondary text. The primary button and app button take on-ground, so they invert in dark mode.
- **Rule** (rule): every hairline: section tops, cell borders, role card borders.
- **Board Ink / Print Ink** (ink, ink-solid): the How board and the gate; the question plate and the hole behind the iris.
- **Ivory** (ivory): text on ink, the ivory gate button.
- **Cloudy** (cloudy): secondary text on ink, spec labels, the plate bar.
- **Site / Line** (site, line): the paper and the frame lines inside the window.
- **Dark set** (ground-dark, ground-2-dark, on-ground-dark, rule-dark, site-dark, line-dark): the same roles under `prefers-color-scheme: dark`. Ink boards, the plate, sky-deep and clay stay fixed.

### Named Rules
**The Pinned Palette Rule.** Claude's palette only: clay, ink, ivory, cloudy and sky, plus their lightened or deepened steps. No new hues.

**The Clay-Is-An-Accent Rule.** Clay marks lit elements, the window rim, the gate frame, hover and focus. It never fills the page ground or a section.

## Typography

**Display Font:** Barlow Semi Condensed (with Arial Narrow)
**Body Font:** Barlow (with Segoe UI, system-ui)
**Label/Mono Font:** IBM Plex Mono (with ui-monospace, Cascadia Mono)
**Wordmark:** Montserrat 600, tracked capitals, for the AUGMENTED wordmark only.

**Character:** A condensed sign-writer's grotesque that shouts, its plain sibling for reading, and a drawing-set mono that only labels.

### Hierarchy
- **Display** (700, up to 96px and capped at 11.5svh, 0.9, -0.02em): the hero question only; max 11ch, balanced.
- **Headline** (700, clamp 36–64px, 0.95): section titles; the gate's title runs larger (clamp 42–78px).
- **Title** (700, 21px; 23px on role cards): cell, log and role titles.
- **Question** (600, clamp 20–25px): the question typing on the plate.
- **Statement / Example** (600, 18px / 16.5px): limit statements; quoted example questions in sky.
- **Lede** (Barlow 500, clamp 18–21px, 1.45, max 36ch).
- **Body** (Barlow 400, 17px, 1.55, 44–52ch); **Small** (15–15.5px) in cells and cards.
- **Label** (Plex Mono 400–500, 11–13px, uppercase, 0.04–0.08em): data labels only.

### Named Rules
**The Mono-Is-Data Rule.** IBM Plex Mono sets labels, codes, numbers and small print, always small and uppercase. Never a headline, a sentence of reading copy or a button label.

**The One Shout Rule.** The hero question is the only display-scale line in the first viewport.

## Layout

A 1440px column with a fluid gutter (clamp 16–32px). Sections are separated by a 1px rule and clamp(48–88px) of padding. The hero is two columns (1.1fr / 1fr): headline, lede and actions on the left with the note below, the window on the right, sized to fit the first viewport (at most 580px). Section heads are two columns, title left and explanation right, aligned to the bottom.

Content sits in ruled grids: 8 "can" cells in 4 columns, 5 limits in a row, 6 role cards in 3 columns, and the How board as statement plus spec list beside the 001–004 log. At 1080px cells go to 2 columns, roles to 2, and the nav drops its text links, keeping the language pair and the app button. At 900px the hero stacks (copy, window, note) and the heads, board and gate go to one column. At 640px everything is one column and the hero button runs full width.

**The Hairline Rule.** Structure is drawn with 1px rules between sections and cells. No outer frames, margins or corner marks.

## Elevation & Depth

Mostly flat, with soft downward shadows on the few objects that stand off the ground: the window, the plate, the button and a lifted role card. The gate is the only inset. No glass, blur or glow; the closing button's breathing ring is the one soft halo.

### Shadow Vocabulary
- **Window** (`0 0 0 clamp(8px, 1vw, 12px) var(--clay), 0 22px 40px -18px rgba(10,10,9,.45)`, plus `inset 0 14px 28px -8px rgba(10,10,9,.4)` inside): the clay rim and the window's depth.
- **Plate** (`0 18px 30px -16px rgba(10,10,9,.6)`): the question plate.
- **Button** (`0 14px 24px -14px rgba(10,10,9,.6)`): primary buttons at rest.
- **Lifted card** (`0 22px 36px -24px rgba(10,10,9,.5)`): role cards on hover only.
- **Gate frame** (`inset 0 0 0 clamp(8px, 1vw, 12px) var(--clay)`): the clay inset frame of the closing gate.

### Named Rules
**The Flat-At-Rest Rule.** Cells and cards are flat at rest; a role card earns its shadow only on hover.

## Shapes

Nearly square: 2px corners on buttons, boards, the plate and cards. The only curves are circles: the window, the blue "can" signs and the prohibition rings. Icons are authored inline SVG, stroked (1.5–2.2) with round caps and joins.

## Components

### Buttons
- **Shape:** square (2px), 58px tall, with a stroked right arrow.
- **Primary:** on-ground (ink in light, ivory in dark) with a clay-light arrow. Hover: clay with white text; the arrow moves 4px.
- **Ivory (in the gate):** ivory with ink text and a clay arrow; it breathes (a faint ivory ring, 3.2s).
- **Secondary link:** condensed 600 18px, underlined 2px.
- **Focus:** 3px clay outline, 3px offset; ivory on ink.

### Navigation
No bar: the masthead (72px) sits on the ground. Logo, mono links with an underline that slides in on hover, an EN/FR pair (the active key outlined in on-ground) and the on-ground app button, clay on hover. Below 1080px only the language pair and app button remain; below 640px the app button keeps only its arrow. The footer repeats the logo and mono links, then one line of mono small print.

### Viewing window (signature)
A round window with a clay rim shows an isometric frame drawn in lines on site paper; it draws itself once on load. Each question irises open and closed (clip-path circle, 3 beats). The question types onto the ink plate, mono understood tags stamp in (dashed clay-light when data is missing), the matched elements light in clay while the rest dim to 40%, a clay count marker is pinned with a leader on the left of the lit elements, and the answer's number counts up. The window tilts with the mouse (up to 7deg) on fine pointers.

**The One Clock Rule.** The demo runs on `--beat` (150ms), read by the script too: typing at a third of a beat, one tag per beat, the iris in 3, the count-up in 5, an answer held for 26.

**The Exact Match Rule.** The demo uses only real sample-model answers, and the lit elements equal the stated count: 17 level-2 beams, 9 walls, 17 concrete pieces (9 walls, 6 pads, 2 slabs).

**The Understood-not-Executed Rule.** The demo shows how a question was understood, as tags. It never shows the query or the SQL.

### "Can" cells
Eight numbered cells in a ruled grid: a mono [01] number in clay-ink, a 46px blue round sign with an ivory pictogram, a title, a short description and a quoted example in sky (« » with thin spaces in French). Hover: the cell washes ground-2, the sign rotates and turns clay, the example shifts 4px.

### How board
An ink board: headline, cloudy sub-line and a mono spec list (cloudy terms) on the left; the 001–004 log on the right, ruled in translucent ivory, numbers in clay-light. Hover: the row title slides 6px and the number turns ivory.

### Limits
Five limits in a ruled row: a 34px clay ring-and-slash over an on-ground pictogram, a mono code in clay-ink ("Not in the data", "Often missing", "Read-only") and a condensed statement. Hover: the cell washes and the sign wobbles.

### Role cards
Six cards ("Made for the people in the model"), 1px rule border on the ground: a 46px authored stroke icon, a role title, a use case and an example question in sky at the foot. Hover: the card lifts 5px onto site paper, a 3px clay bar draws across its top, the icon tilts and turns clay, and a short rule extends after the example.

### Gate
A two-leaf ink panel with a clay inset frame and a translucent ivory joint between the leaves: headline and copy on the left, the ivory button bottom-right. The leaves stack below 900px.

### Motion
Reveal on scroll: 22px rise and fade over 700ms (`cubic-bezier(.16, 1, .3, 1)`), staggered 70ms within a row, then the class is removed so hover transitions take over. Hovers use 200–320ms with `cubic-bezier(.2, .8, .2, 1)` or the springy `cubic-bezier(.2, 1.4, .4, 1)`. Under `prefers-reduced-motion` all of it is off and the first scene is shown static.

### Language
EN/FR through a dictionary keyed by the English text; English stays in the HTML. The choice is stored in localStorage `augmented-lang`, with the browser language as the default.

## Do's and Don'ts

### Do:
- **Do** keep the page ground pale (dark in dark mode) and use clay as an accent only.
- **Do** set data labels in small uppercase IBM Plex Mono and everything else in Barlow or Barlow Semi Condensed.
- **Do** divide content with 1px hairlines into numbered cells.
- **Do** use blue round signs for what Augmented can do and clay ring-and-slash signs for what it cannot, each with real content.
- **Do** use only real sample-model answers, with lit elements matching the stated count.
- **Do** switch every animation and hover movement off under `prefers-reduced-motion`.
- **Do** route every visible string through the EN/FR dictionary.

### Don't:
- **Don't** fill the page or a section with clay (the owner rejected the orange background).
- **Don't** add drawing-sheet frames, margins or corner crosses to the landing page.
- **Don't** put a black bar across the top; the masthead sits on the ground.
- **Don't** close with a ruled information-board footer; keep the quiet footer.
- **Don't** add a scrolling ticker strip.
- **Don't** replace the line-drawn frame with a three.js 3D model.
- **Don't** show the internal query or SQL anywhere public; show understood tags instead.
- **Don't** introduce colours outside Claude's palette.

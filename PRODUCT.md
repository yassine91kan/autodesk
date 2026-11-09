# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

All AEC professionals working with Revit models: structural engineers, architects, BIM coordinators and managers, quantity surveyors and estimators. Their situation: a model is open, and they need a fact from it (a count, a list, a size, a quantity, a gap in the data) without building a schedule or filter in Revit. Job: ask the model a question in plain words and get the exact answer, with the elements shown in 3D.

## Product Purpose

Augmented answers questions about a Revit model in plain language. It reads the model's properties through Autodesk Platform Services, cleans them into one consistent table (units converted, Revit naming untangled, empty values marked as not set), and answers with the exact number from the data while highlighting every element it counted in the 3D viewer. Success: a professional gets a correct, verifiable answer in seconds, and trusts it because they can see which elements it came from.

## Positioning

The numbers always come from the model data, never from the AI. Plain questions are answered by code; harder ones are turned into a checked, read-only query by AI, using only names that exist in the model. When a question needs data the model does not contain (connections, clashes, grids, orientation, level elevations), it says so plainly instead of guessing.

## Operating Context

Web app at /app with an Autodesk 3D viewer beside a chat-like "schedule of answers". Sample models available to everyone: the Revit structural sample (rstbasicsampleproject.rvt, 845 elements) and the Seaport Civic Center architecture model (15,147 elements, imperial units). Guests can ask questions with a daily token budget; signing in (shared password today) removes the budget and allows uploading Revit models. Every answer can be rated with thumbs up or down.

## Capabilities and Constraints

- Answers: counts and lists; filters by level, material, family, type, function; sizes in any unit (metric and imperial); totals and averages of length, area, volume, weight; rankings and breakdowns; spacing from 3D positions; model checks (missing materials, marks, levels); follow-up questions.
- Cannot answer: connections or support relationships, clashes, grids and orientation, level elevations when not exported; it only reads, never changes the model.
- Revit models only today (other formats not supported for questions).
- Landing page at /, app at /app; landing page available in English and French (the app itself answers in English).
- Hosting: Render (Node/Express, SQLite on a persistent disk).
- Open decision: personal accounts and private model spaces are not built yet; client models should not be uploaded until they are.

## Brand Commitments

- Name: Augmented. Logo: the "A" mark with the orange spark plus the AUGMENTED wordmark (Montserrat, wide-tracked capitals); ivory mark for dark grounds (wwwroot/assets/images/augmented-mark.svg), ink mark for light grounds (augmented-mark-light.svg).
- Palette commitment from the owner: Claude's colour palette (ivory, ink, clay orange, sky blue, cloudy grey).
- The internal query (SQL) is never shown publicly; show how a question was understood, not how it is executed.
- Voice: plain, factual, honest about limits; no hype.

## Evidence on Hand

- Real answers from the sample models may be used publicly, for example: 17 steel framing members on Level 2; 9 walls thicker than 200 mm (all 280 mm); 215.875 m3 of concrete across 17 elements; 294 non-steel beams, 67 of them on Level 2; "the model data doesn't include connections" for support questions.
- Test results (accuracy figures) are NOT for public use.
- No customers, testimonials, logos, pricing or press exist; none may be invented.

## Product Principles

1. Exact numbers from the model, never from the AI.
2. Show the evidence: every answer points to the elements it counted.
3. Say plainly what the data cannot answer.
4. Plain language in, plain language out: no Revit expertise needed to ask.
5. Keep the internal machinery private; show understanding, not execution.

## Accessibility & Inclusion

WCAG AA contrast, keyboard access with visible focus, reduced-motion support for all animation, English and French on the landing page.

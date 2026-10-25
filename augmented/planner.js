// augmented/planner.js
// ===========================================================================
// 3. PLANNER - the ONLY place the LLM is used, and the tiers that decide when:
//   tier 0  a tiny prompt picks list / count / group (code found every name)
//   tier 1  a small prompt with only the names that matched
//   tier 2  the full model description, when tier 1 couldn't do it
// The LLM writes a JSON plan; it never sees elements and never writes SQL.
// ===========================================================================

const OpenAI = require('openai');
const { OPENAIKEY } = require('../config.js');
const {
    PlannerError, NAME_PATHS, LEVEL_PATHS, HIDDEN_FROM_PROMPT, ASSISTANT_NAME, ASSISTANT_ABOUT, ASSISTANT_OFF_TOPIC
} = require('./shared');
const {
    WORD_VARIANTS, MATERIAL_WORDS, UNMATCHED_OK, STOPWORDS, toWords, SPATIAL_WORDS
} = require('./words');
const {
    matchQuestion, summarizeMatch, isSimple
} = require('./matcher');
const {
    planFromMatch, wantsTotal, planRankOrTotal, understoodByCode, isFollowUp, mergeFollowUp,
    describePrevious, spatialPlan
} = require('./plans');
const {
    ask, validatePlan
} = require('./engine');

const openai = new OpenAI({ apiKey: OPENAIKEY });
// gpt-6-luna replaces gpt-4o-mini, which OpenAI shuts down on 14 Jan 2027.
// It's OpenAI's most efficient model for short, high-volume tasks like ours.
const PLANNER_MODEL = 'gpt-6-luna';

// The vocabulary is sent with EVERY question, so it decides the cost per question.
// Which properties go in:
//   1. ALWAYS_IN_PROMPT - the ones people ask about most (if the model has them)
//   2. the top PER_CATEGORY properties of each category, so small categories
//      (30 columns) aren't crowded out by big ones (346 rebar)
//   3. never more than MAX_PROMPT_PROPERTIES in total
// Everything left out still WORKS in a query; the LLM just isn't told about it.
const MAX_PROMPT_PROPERTIES = 60;
const PER_CATEGORY = 6;
const ALWAYS_IN_PROMPT = [
    'Element.Family', 'Element.Type',
    'Constraints.Level', 'Constraints.Base Level', 'Constraints.Reference Level', 'Constraints.Base Constraint',
    'Materials and Finishes.Structural Material', 'Materials and Finishes.Material',
    'Structural.Structural Usage', 'Dimensions.Length', 'Dimensions.Volume'
];

// Picks which properties to describe, in the order explained above.
function choosePromptProperties(vocabulary) {
    const candidates = vocabulary.properties.filter(p => p.useful && !HIDDEN_FROM_PROMPT.has(p.path));
    const byPath = new Map(candidates.map(p => [p.path, p]));
    const chosen = new Set(ALWAYS_IN_PROMPT.filter(path => byPath.has(path)));

    for (const category of vocabulary.categories) {
        // This category's properties, most used by this category first.
        // (sort keeps the original coverage order for ties)
        const forCategory = candidates
            .filter(p => p.countByCategory[category.name])
            .sort((a, b) => b.countByCategory[category.name] - a.countByCategory[category.name]);
        let added = 0;
        for (const property of forCategory) {
            if (added >= PER_CATEGORY) break;
            if (!chosen.has(property.path)) {
                chosen.add(property.path);
                added++;
            }
        }
    }

    return [...chosen].slice(0, MAX_PROMPT_PROPERTIES).map(path => byPath.get(path));
}

// "[used by: Structural Framing, Walls, Floors +2 more]"
function describeUsedBy(categories) {
    const shown = categories.slice(0, 3).join(', ');
    return categories.length > 3 ? `[used by: ${shown} +${categories.length - 3} more]` : `[used by: ${shown}]`;
}

// One property as one short line, e.g.
//   - Constraints.Reference Level [used by: Structural Framing] values: "Level 1", "Level 2"
// `onlyValues` shows just some of the values (tier 1 shows only the matched family names).
function describeProperty(property, onlyValues = null) {
    const usedBy = describeUsedBy(property.usedBy);
    // JSON.stringify adds quotes, so the LLM sees exactly where a value starts and ends.
    if (property.kind === 'values') {
        const numberNote = property.isNumeric ? ' (numeric)' : '';
        const values = onlyValues || property.values;
        return `- ${property.path} ${usedBy} values${numberNote}: ${values.map(v => JSON.stringify(v)).join(', ')}`;
    }
    if (property.kind === 'number') {
        return `- ${property.path} ${usedBy} numbers from ${property.min} to ${property.max}${property.unit ? ' ' + property.unit : ''}`;
    }
    if (onlyValues) {   // names that matched the question, from a property with too many to list
        return `- ${property.path} ${usedBy} matching values: ${onlyValues.map(v => JSON.stringify(v)).join(', ')}`;
    }
    return `- ${property.path} ${usedBy} free text, e.g. ${property.samples.map(v => JSON.stringify(v)).join(', ')}`;
}

// The whole vocabulary as text, for the tier 2 prompt.
function describeVocabulary(vocabulary) {
    const categoryLines = vocabulary.categories
        .map(category => `- ${category.name} (${category.count})`);
    const propertyLines = choosePromptProperties(vocabulary).map(property => describeProperty(property));

    return `CATEGORIES (name and element count):\n${categoryLines.join('\n')}\n\n` +
           `PROPERTIES (path, which categories use it, and its values):\n${propertyLines.join('\n')}`;
}

// The full instruction text. It's identical for every question about the same
// model, so we build it once per model (see planQuery). OpenAI also caches
// long identical prompt beginnings automatically, which makes repeat calls cheaper.
function buildSystemPrompt(vocabulary) {
    return `You are ${ASSISTANT_NAME}, an assistant for questions about one BIM model. You turn each question into a JSON query plan.
Use ONLY the categories and property paths listed under MODEL below. Never invent names.

Return ONLY a JSON object with these fields:
{
  "action": "list" | "count" | "group" | "rank" | "total" | "coordinates" | "clarify" | "reply",
  "category": exact category name, or null for all categories,
  "filters": [ { "properties": [exact paths], "op": "equals" | "not_equals" | "contains" | "gt" | "gte" | "lt" | "lte", "value": text, number, or a list of texts for equals / not_equals } ],
  "groupBy": [exact paths] or "category" or null,
  "sortBy": [one number path] or null, "order": "desc" | "asc", "limit": number or null,
  "measure": [one number path] or "weight" or null, "aggregate": "sum" | "average" | "min" | "max",
  "elementId": number or null,
  "message": text or null,
  "ignored": [ { "word": a word of the question your plan does not use, "why": "filler" | "narrows" } ]
}

How to choose:
- "list": show / find / which elements. "count": how many. "group": breakdowns such as
  "which level has the most beams", "what materials are used", "count by type".
- "rank": longest / heaviest / largest / top N. sortBy = the number property, order "desc" for
  the highest first. limit = N for "top N", null for "the longest" (all tied elements are returned).
- "total": total / sum / average of a quantity (length, volume, area). measure = that number
  property, or "weight" for total weight or tonnage (computed as Nominal Weight x Length).
  groupBy is optional ("total volume per level"). "Total number of beams" is a count, not a total.
- "coordinates": where a specific element id is. Put the id in elementId.
- If the message has PREVIOUS QUESTION and PREVIOUS PLAN, the question is a follow-up: start from
  the previous plan and change only what the question changes.
- "clarify": the question mentions something this model does not have, or is ambiguous.
  Put a short question for the user in message, naming the closest real options.
- In message, write property names the way a person would ("Top Level", "Unconnected Height"),
  never as paths ("Dimensions.Elevation at Top").
- "reply": questions about you or not about the model. Put the answer in message. You are
  ${ASSISTANT_NAME}: never say you are ChatGPT or name the company behind the AI.
- "ignored": list every word of the question your plan doesn't use (not small words like "the").
  why "filler" = it doesn't change WHICH elements ("different", "various", "please").
  why "narrows" = it limits which elements ("curtain" walls, a material, a name). Never answer
  while ignoring a "narrows" word: use "clarify" instead.

Rules:
- Map everyday words to the real category: "beams" -> "Structural Framing", "columns" -> "Structural Columns".
- Element.Family and Element.Type hold the Revit family and type names. When the user names a kind
  of element ("light gauge joists", "UB beams", "CHS"), filter on Element.Family with the matching
  listed name(s).
- Levels: use any one level property (e.g. "Constraints.Reference Level"). The system adds the
  level properties of the other categories automatically.
- The same idea can be stored under different paths for different categories. Check "used by" and
  put every relevant path in "properties". An element matches if any of them matches.
- If a property lists its values, use op "equals" with exact listed value(s).
- For free text (e.g. a material name like "steel" inside "Steel ASTM A992"), use op "contains".
- For numbers use gt/gte/lt/lte with a plain number in the property's unit. kg/m and kgf/m are
  the same unit for weight per metre.
- Several conditions = several entries in "filters" (they are combined with AND).
- Within one property, "X or Y" is one filter with a list of values.
- Use the fewest filters that answer the question. Never add a condition the user did not ask for.
- Set "category" only when the question names a kind of element (beams, columns, walls, ...).
  For "members", "elements", "items" or "everything", use null.
- If the question asks for something this model doesn't have, use "clarify". Never answer while
  leaving out a word that says what the user wants.

Examples:
"steel beams" ->
{"action":"list","category":"Structural Framing","filters":[{"properties":["Materials and Finishes.Structural Material"],"op":"contains","value":"steel"}],"groupBy":null,"elementId":null,"message":null}
"what materials are used for the walls" ->
{"action":"group","category":"Walls","filters":[],"groupBy":["Materials and Finishes.Structural Material"],"elementId":null,"message":null}
"how many elements per category" ->
{"action":"group","category":null,"filters":[],"groupBy":"category","elementId":null,"message":null}
"the 5 longest walls" ->
{"action":"rank","category":"Walls","filters":[],"sortBy":["Dimensions.Length"],"order":"desc","limit":5,"elementId":null,"message":null}
"total volume of the floors per level" ->
{"action":"total","category":"Floors","filters":[],"measure":["Dimensions.Volume"],"aggregate":"sum","groupBy":["Constraints.Level"],"elementId":null,"message":null}

MODEL
${describeVocabulary(vocabulary)}`;
}

// One LLM call that must answer with JSON. Returns { json, usage }.
// The answer is NOT trusted yet: validatePlan checks every plan before it runs.
async function askForJson(systemPrompt, userMessage) {
    const completion = await openai.chat.completions.create({
        model: PLANNER_MODEL,
        // Luna can "think" before answering (reasoning), which adds hidden tokens and delay.
        // Writing a small JSON plan doesn't need it, so it's switched off. That also keeps
        // `temperature` allowed: OpenAI only accepts it while reasoning is off.
        reasoning_effort: 'none',
        temperature: 0,                            // 0 = as repeatable as possible; same question -> same plan
        response_format: { type: 'json_object' },  // forces the reply to be JSON (it can still be the WRONG JSON)
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage }
        ]
    });

    const usage = {
        promptTokens: completion.usage?.prompt_tokens || 0,
        // The part of promptTokens OpenAI re-used from its cache (same prompt start as an
        // earlier call). Cached tokens are billed at a discount, so this is the cheap part.
        // OpenAI only caches prompts of 1,024+ tokens, so tiers 0 and 1 will show 0 here.
        cachedTokens: completion.usage?.prompt_tokens_details?.cached_tokens || 0,
        completionTokens: completion.usage?.completion_tokens || 0,
        totalTokens: completion.usage?.total_tokens || 0
    };

    try {
        return { json: JSON.parse(completion.choices[0].message.content), usage };
    } catch {
        throw new PlannerError('The language model returned invalid JSON.');
    }
}

// --- Tier 0: code found every name; the LLM only says WHAT to do with them.
// Kept short on purpose: it's sent with most questions, so every word costs on each one.
const INTENT_PROMPT = `Classify a question for a BIM model assistant. Return ONLY JSON {"action": X}, X one of:
list (show/find elements), count (how many), group (breakdown: per X, which X has most, what X are used),
rank (longest, biggest, top N), total (total / sum / average of a quantity), distance (spacing, how far apart),
about (to or about the assistant: name, abilities, opinions of it, greetings, small talk),
off_topic (not about the model or the assistant, e.g. weather, news), other (anything else).`;

// "about" and "off_topic" let code answer with a fixed text (ASSISTANT_ABOUT /
// ASSISTANT_OFF_TOPIC), in any wording or language, without a word list or a bigger prompt.
// "rank", "total" and "distance" catch the phrasings code's word lists miss.
const INTENTS = ['list', 'count', 'group', 'rank', 'total', 'distance', 'about', 'off_topic'];
async function classifyIntent(question) {
    const { json, usage } = await askForJson(INTENT_PROMPT, question);
    const action = INTENTS.includes(json.action) ? json.action : 'other';
    return { action, usage };
}

// --- Tier 1: the LLM writes the plan, but only sees the names that matched the question.
const CANDIDATES_PROMPT = `You are ${ASSISTANT_NAME}, an assistant for questions about a BIM model. You turn a question into a JSON query plan.
The user message has the QUESTION and the CANDIDATES: the names in this model that match it. Use only those names.

Return ONLY JSON:
{"action": "list" | "count" | "group" | "rank" | "total" | "coordinates" | "clarify" | "reply" | "need_more",
 "category": category name or null,
 "filters": [{"properties": [paths], "op": "equals" | "not_equals" | "contains" | "gt" | "gte" | "lt" | "lte", "value": text, number or list of texts}],
 "groupBy": [paths] or "category" or null,
 "sortBy": [one number path] or null, "order": "desc" | "asc", "limit": number or null,
 "measure": [one number path] or "weight" or null, "aggregate": "sum" | "average" | "min" | "max",
 "elementId": number or null,
 "message": text or null,
 "ignored": [{"word": a question word your plan doesn't use, "why": "filler" | "narrows"}]}

- list: show / find. count: how many. group: a breakdown (per X, which X has the most, what X are used).
- rank: longest / heaviest / top N, by sortBy (desc = highest first; limit null = all tied at the top).
- total: total / average of a length, volume or area (measure), or "weight" for total weight.
  groupBy optional. "Total number of X" is a count.
- coordinates: where one element is; put its id in elementId.
- In message, write property names as a person would ("Top Level"), never as paths ("Constraints.Top Level").
- PREVIOUS QUESTION / PREVIOUS PLAN given: this is a follow-up. Start from the previous plan and
  change only what the question changes (a new level replaces the level filter, "only X" adds a
  filter, "how many" changes the action, a new category replaces the category).
- kg/m and kgf/m are the same unit for weight per metre.
- equals: exact listed value(s). contains: part of a text. gt/gte/lt/lte: a plain number in the
  property's unit (6 m = 6000 when the unit is mm).
- Several filters are combined with AND. Use the fewest filters; never add one the user didn't ask for.
- Within one property, "X or Y" is one filter with a list of values.
- category: only when the question names a kind of element (beams, columns, walls, ...). For
  "members", "elements", "items" or "everything", use null.
- Never answer without part of the question. If a word under "words not found in this model" says
  WHAT the user wants (a kind of element, a material, a name), use need_more; don't drop it.
- ignored: every question word the plan doesn't use (not "the", "me"...). filler = doesn't change
  which elements ("different", "various"); narrows = limits them ("curtain" walls): then need_more.
- reply: questions about you, not the model (answer in message). You are ${ASSISTANT_NAME}: never say
  you are ChatGPT or name the company behind the AI.
- clarify: the question is ambiguous (a short question in message).
- need_more: the CANDIDATES don't contain what the question needs.`;

const MAX_CANDIDATE_PROPERTIES = 12;

// The CANDIDATES text: only what matched, usually 3-10 lines.
function describeCandidates(match, summary, model) {
    const { vocabulary } = model;
    const lines = [];

    for (const name of summary.categories) {
        const count = vocabulary.categories.find(c => c.name === name)?.count;
        lines.push(`- category: ${name} (${count})`);
    }
    for (const name of summary.missingCategories) {
        lines.push(`- this model has no "${name}" category`);
    }
    if (summary.groupByCategory) {
        lines.push('- you can group by "category"');
    }

    // Properties: the ones named, plus the ones whose values matched. For family and
    // type names we show only the matched names, not all 100.
    const shown = new Map(); // path -> values to show (null = all)
    // The rank word ("longest") was taken out of the question's words, so show its property here.
    if (match.rank && vocabulary.allPaths.has(match.rank.path)) {
        lines.push(`- "${match.rank.word}" ranks by ${match.rank.path} (${match.rank.order}${match.rank.limit ? `, limit ${match.rank.limit}` : ''})`);
        shown.set(match.rank.path, null);
    }
    for (const paths of summary.propertyMentions) {
        paths.forEach(path => shown.set(path, null));
    }
    for (const filter of summary.valueFilters) {
        for (const path of filter.paths) {
            if (!shown.has(path)) shown.set(path, NAME_PATHS.has(path) ? filter.values : null);
        }
    }
    let added = 0;
    for (const [path, onlyValues] of shown) {
        const property = vocabulary.properties.find(p => p.path === path);
        if (!property || added >= MAX_CANDIDATE_PROPERTIES) continue;
        // With one category named, show only the values that category uses: for "beams",
        // the framing materials, not "Steel, 45-345", which only columns have.
        let values = onlyValues;
        if (!values && property.kind === 'values' && summary.categories.length === 1) {
            const inCategory = (model.dictionary.valuesByPath.get(path) || [])
                .filter(entry => entry.categories.has(summary.categories[0]))
                .map(entry => entry.value);
            if (inCategory.length > 0) values = inCategory;
        }
        lines.push(describeProperty(property, values));
        added++;
    }
    if ([...shown.keys()].some(path => LEVEL_PATHS.includes(path))) {
        lines.push('- (a filter on one level property automatically covers all of them)');
    }

    // Only words that could be names: numbers, units and comparisons ("20", "kg", "than")
    // are never names, and listing them made the LLM give up on questions it could answer.
    const notFound = match.unexplained.filter(word => !/^\d/.test(word) && !UNMATCHED_OK.has(word));
    if (notFound.length > 0) {
        lines.push(`- words not found in this model: ${notFound.join(', ')}`);
    }
    return lines.length > 0 ? lines.join('\n') : '- nothing in the question matched a name in this model';
}

// intent: what the intent check found ("total", "rank"...), passed on as a hint.
async function planWithCandidates(question, match, summary, model, previous = null, intent = null) {
    let message = `QUESTION: ${question}\n\nCANDIDATES:\n${describeCandidates(match, summary, model)}`;
    if (previous) message += `\n\n${describePrevious(previous)}`;
    if (intent && intent !== 'other') message += `\n\nINTENT (from a quick check): ${intent}`;
    const { json, usage } = await askForJson(CANDIDATES_PROMPT, message);
    return { plan: json, usage };
}

// --- Tier 2: the full vocabulary (~3,000 tokens), only when tier 1 couldn't do it.
async function planQuery(question, model, match, summary, previous = null) {
    // Build the prompt the first time this model needs it, then reuse it.
    if (!model.plannerPrompt) {
        model.plannerPrompt = buildSystemPrompt(model.vocabulary);
    }
    // The full vocabulary shows only the most common properties. The names that matched
    // THIS question (e.g. Nominal Weight for "weigh") go along in the user message: after
    // the system prompt, so the long shared beginning stays cacheable.
    const matched = describeCandidates(match, summary, model);
    let message = `${question}\n\nNames in this model that match the question:\n${matched}`;
    if (previous) message += `\n\n${describePrevious(previous)}`;
    const { json, usage } = await askForJson(model.plannerPrompt, message);
    return { plan: json, usage };
}

// The guard against answering a different question: "the longest beam" or "total length of
// the beams" answered with a plain list, count or breakdown leaves out what was asked.
function missedIntent(match, summary, plan) {
    if (!plan || !['list', 'count', 'group'].includes(plan.action)) return false;
    return wantsTotal(match, summary) || Boolean(match.rank);
}

// The guard against answers that leave part of the question out: returns a word from the
// question that no model name matched, that isn't a number, unit or comparison, and that
// the plan doesn't use either. "curtain walls" answered with all walls -> "curtain".
//
// The LLM says itself which words it ignored and why (the plan's "ignored" list): words it
// marks "filler" ("list the DIFFERENT materials") don't stop the answer. Words it doesn't
// mention, or marks "narrows" ("CURTAIN walls"), still do. No word lists needed for this.
function ignoredWord(match, plan) {
    if (!plan || !['list', 'count', 'group'].includes(plan.action)) return null;
    const reported = Array.isArray(plan.ignored) ? plan.ignored : [];
    // The plan without its "ignored" list: a word named there isn't "used" by the plan.
    const planText = JSON.stringify({ ...plan, ignored: undefined }).toLowerCase();
    const filler = new Set(reported
        .filter(item => String(item?.why).toLowerCase() === 'filler')
        .flatMap(item => toWords(item?.word || '')));   // same word forms as match.unexplained
    return match.unexplained.find(word =>
        !/^\d/.test(word) && !UNMATCHED_OK.has(word) && !filler.has(word) && !planText.includes(word.slice(0, 5))) || null;
}

// The guard against filters the LLM made up: a text filter (equals / not_equals /
// contains) is kept only if its value shares a word with the question. "steel" keeps
// "Metal - Steel - 345 MPa"; "shorter than 2 m" drops an invented Family = "M_TJL Wood
// Open Web Joist". Typo fixes and material stand-ins ("timber" -> softwood) count as words
// of the question. Returns the plan with those filters removed, and logs what it removed.
function dropInventedFilters(plan, question, match) {
    if (!plan || !Array.isArray(plan.filters)) return plan;
    const asked = new Set(toWords(question).map(word => WORD_VARIANTS[word] || word));
    for (const fix of match.corrections) asked.add(fix.split(' -> ')[1]);
    for (const word of [...asked]) (MATERIAL_WORDS[word] || []).forEach(alias => asked.add(alias));
    const grounded = filter => {
        if (!['equals', 'not_equals', 'contains'].includes(filter?.op)) return true;   // numbers: always kept
        const values = [].concat(filter.value ?? []).map(String);
        return values.every(value => {
            const words = toWords(value).filter(word => !/^\d+$/.test(word) && !STOPWORDS.has(word));
            if (/^-?\d/.test(value.trim())) return true;                                 // "25.4 kg/m" is a number
            return words.length === 0 || words.some(word => asked.has(word) || [...asked].some(a => a.length > 3 && word.includes(a)));
        });
    };
    const kept = plan.filters.filter(grounded);
    if (kept.length === plan.filters.length) return plan;
    console.log(`Removed invented filter(s): ${JSON.stringify(plan.filters.filter(f => !grounded(f)))}`);
    return { ...plan, filters: kept };
}

// Decides which tier answers. Returns { tier, plan, checked, calls, match }:
//   checked - the result of validatePlan (ok + clean plan, or a question for the user)
//   calls   - one { tier, ...usage } per LLM call, for the token report
//   previous - { question, plan } of the last answer on this sheet, or null
async function answerQuestion(question, model, previous = null) {
    const calls = [];
    const match = matchQuestion(question, model.dictionary);
    let summary = summarizeMatch(match);
    const followUp = Boolean(previous) && isFollowUp(question, match, summary);
    // A follow-up without a category of its own is about the previous plan's category.
    if (followUp && summary.categories.length === 0 && previous.plan?.category) {
        summary = summarizeMatch(match, previous.plan.category);
    }
    const context = followUp ? previous : null;   // what tiers 1 and 2 are told about the last question
    const done = (tier, plan, checked) => ({ tier, plan, checked, calls, match, followUp });
    // The guard against invented filters must accept words from the earlier questions too:
    // "steel" in the plan came from "steel beams on level 2", not from "and on level 3?".
    const askedText = context ? `${question} ${context.question}` : question;

    // Asked for a category this model doesn't have ("ceilings"): no LLM needed.
    if (summary.missingCategories.length > 0 && summary.categories.length === 0) {
        const available = model.vocabulary.categories.map(c => c.name).join(', ');
        return done(0, null, ask(`This model has no ${summary.missingCategories[0]} category. Categories in this model: ${available}.`));
    }

    // Distances ("distance between the piles", "distance between 3493 and 3902"): planned
    // in code (0 tokens) and measured from the positions the viewer sent (spatial.js).
    if (toWords(question).some(word => SPATIAL_WORDS.has(word))) {
        const plan = spatialPlan(question, summary);
        return done(0, plan, validatePlan(plan, model));
    }

    // Questions about the assistant itself ("what's your name?", "are you smart?") or about
    // something else entirely ("weather in Sydney") get a fixed answer. When nothing REAL in
    // the question matched the model, the tiny intent prompt (about 120 tokens) checks for
    // that before tier 1 (about 800) or tier 2 (about 4,500). A property label alone doesn't
    // count as real: "what is your NAME" matched "Type Name". Questions that mention beams,
    // levels, materials... never get here, so a real question is never brushed off.
    const fixedAnswer = message => {
        const plan = { action: 'reply', message };
        return done(0, plan, { ok: true, plan });
    };
    const FIXED_ANSWERS = { about: ASSISTANT_ABOUT, off_topic: ASSISTANT_OFF_TOPIC };
    // (Follow-ups too: after any question, "are you smart?" looked like a follow-up, because
    // typo correction read "smart" as "start" of Start Level Offset. A follow-up that names
    // nothing real, like "how many?", costs this one small check.)
    const nothingRealMatched = !summary.groupByCategory && !match.rank && !match.aggregate &&
        summary.categories.length + summary.valueFilters.length + summary.numberFilters.length === 0;
    let intent = null;   // the intent prompt's answer, reused below (never asked twice)
    if (nothingRealMatched) {
        intent = await classifyIntent(question);
        calls.push({ tier: 0, ...intent.usage });
        if (FIXED_ANSWERS[intent.action]) return fixedAnswer(FIXED_ANSWERS[intent.action]);
    }

    // A follow-up code fully understood: merge it into the previous plan (0 tokens).
    if (followUp && understoodByCode(match, summary)) {
        const plan = mergeFollowUp(previous.plan, summary, match, question);
        if (plan) {
            const checked = validatePlan(plan, model);
            // "and the columns?" when the old filter's value isn't used by columns is a
            // real question for the user; only an unknown name sends it on to the LLM.
            if (checked.ok || checked.kind !== 'unknown-name') return done(0, plan, checked);
        }
    }

    // Code's fast path: rankings and totals whose words say everything (0 tokens, exact).
    // (Not for follow-ups: starting from scratch would forget the previous question.)
    const special = wantsTotal(match, summary) || Boolean(match.rank);
    if (!followUp && isSimple(match, summary) && special) {
        const plan = planRankOrTotal(summary, match);
        if (plan) {
            const checked = validatePlan(plan, model);
            // 'final' = a complete answer from code ("Structural Columns have no Unconnected Height")
            if (checked.ok || checked.kind === 'final') return done(0, plan, checked);
        }
    }

    // THE INTENT CHECK: the one gate before the LLM tiers, asked at most once per question
    // (about 120 tokens). Code's word lists handle the clear cases above; this catches the
    // phrasings they miss, so the lists don't have to keep growing.
    // (Without the comparisons code already read: also a few tokens cheaper.)
    if (!intent) {
        intent = await classifyIntent(match.withoutComparisons);
        calls.push({ tier: 0, ...intent.usage });
    }
    const { action } = intent;
    if (FIXED_ANSWERS[action]) return fixedAnswer(FIXED_ANSWERS[action]);

    // A distance or a total that code's words missed ("how far apart are the piles?",
    // "what's the combined volume?"): code still builds the exact plan.
    if (action === 'distance') {
        const plan = spatialPlan(question, summary);
        // (Only with two ids or a set to measure: "where is element 3001?" is for tier 1.)
        if (plan.kind === 'between' || plan.category || plan.filters.length > 0) return done(0, plan, validatePlan(plan, model));
    }
    if (action === 'total' && !followUp) {
        const asTotal = { ...match, aggregate: match.aggregate || 'sum' };
        if (wantsTotal(asTotal, summary)) {
            const plan = planRankOrTotal(summary, asTotal);
            const checked = plan && validatePlan(plan, model);
            if (checked && (checked.ok || checked.kind === 'final')) return done(0, plan, checked);
        }
    }

    // List / count / group with every name understood: code writes the plan.
    if (!followUp && isSimple(match, summary)) {
        // "How high are the walls?" may read as "other", but it names a property: a breakdown
        // by it answers it ("Unconnected Height: 4,700 mm: 3 walls ...").
        const asked = ['list', 'count', 'group'].includes(action) ? action
            : summary.propertyMentions.length > 0 ? 'group' : null;
        const plan = asked && planFromMatch(summary, asked);
        if (plan) {
            const checked = validatePlan(plan, model);
            if (checked.ok || checked.kind === 'final') return done(0, plan, checked);
        }
    }

    // Tier 1: small prompt with only the matched names, told what the intent check found.
    const tier1 = await planWithCandidates(question, match, summary, model, context, action);
    calls.push({ tier: 1, ...tier1.usage });
    tier1.plan = dropInventedFilters(tier1.plan, askedText, match);
    if (tier1.plan?.action !== 'need_more' && !ignoredWord(match, tier1.plan) && !missedIntent(match, summary, tier1.plan)) {
        const checked = validatePlan(tier1.plan, model);
        // A plan using names that don't exist means the candidates were too few:
        // try again with everything. Any other problem is a real question for the user.
        if (checked.ok || checked.kind !== 'unknown-name') return done(1, tier1.plan, checked);
    }
    // (A tier 1 plan that ignored a word of the question also goes on to tier 2:
    //  the full vocabulary may contain what that word refers to.)

    // Tier 2: the full vocabulary.
    const tier2 = await planQuery(question, model, match, summary, context);
    calls.push({ tier: 2, ...tier2.usage });
    tier2.plan = dropInventedFilters(tier2.plan, askedText, match);
    const dropped = ignoredWord(match, tier2.plan);
    if (dropped) {
        return done(2, tier2.plan, ask(`I couldn't find "${dropped}" in this model, so I can't answer that exactly. Ask without it, or use a name from the model.`));
    }
    if (missedIntent(match, summary, tier2.plan)) {
        return done(2, tier2.plan, ask(match.rank
            ? `I couldn't work out how to rank that. Try e.g. "the ${match.rank.word} beams" or "top 5 ${match.rank.word} columns".`
            : 'I couldn\'t work out which quantity to add up. Try e.g. "total length of the steel beams" or "total volume of the floors".'));
    }
    return done(2, tier2.plan, validatePlan(tier2.plan, model));
}

module.exports = {
    openai, PLANNER_MODEL, MAX_PROMPT_PROPERTIES, PER_CATEGORY, ALWAYS_IN_PROMPT,
    choosePromptProperties, describeUsedBy, describeProperty, describeVocabulary, buildSystemPrompt,
    askForJson, INTENT_PROMPT, classifyIntent, CANDIDATES_PROMPT, MAX_CANDIDATE_PROPERTIES,
    describeCandidates, planWithCandidates, planQuery, missedIntent, ignoredWord,
    dropInventedFilters, answerQuestion
};

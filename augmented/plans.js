// augmented/plans.js
// ===========================================================================
// 2c. PLANS BUILT BY CODE - when code understood the question, it writes the plan
// itself: list/count/group pieces, rankings, totals, and follow-up questions
// merged into the previous plan. No LLM call, no tokens.
// ===========================================================================

const {
    LENGTH_PATH, VOLUME_PATH, WEIGHT_PATH, LEVEL_PATHS, TOP_LEVEL_PATHS, toArray
} = require('./shared');
const {
    FOLLOW_UP_OPENERS, BACK_REFERENCES, FRESH_WORDS, QUESTION_WORDS, LIST_WORDS, toWords, QUANTITY_MEASURES
} = require('./words');

// The filters code found: names ("Level 2", "steel") and numbers ("longer than 6 m").
function filtersOf(summary) {
    return [
        ...summary.valueFilters.map(f => ({ properties: f.paths, op: 'equals', value: f.values })),
        ...(summary.numberFilters || []).map(f => ({ properties: f.paths, op: f.op, value: f.value }))
    ];
}

// Builds the plan in code from the matches + the intent the tier 0 prompt chose.
// Returns null when the pieces don't fit that intent (then tier 1 takes over).
function planFromMatch(summary, action) {
    // "How many elements PER CATEGORY" or "show the MATERIALS of the columns": a count or
    // list that names something to break down by is really a grouping.
    if (summary.groupByCategory || summary.propertyMentions.length > 0) {
        action = 'group';
    }

    const plan = {
        action,
        category: summary.categories[0] || null,
        filters: filtersOf(summary),
        groupBy: null
    };

    if (action === 'group') {
        if (summary.groupByCategory) {
            plan.groupBy = 'category';
        } else if (summary.propertyMentions.length === 1) {
            plan.groupBy = summary.propertyMentions[0];
        } else {
            return null; // group by what? Let tier 1 decide.
        }
    }
    return plan;
}

// Properties that can be added up or ranked.
const MEASURE_PATHS = new Set([LENGTH_PATH, VOLUME_PATH, 'Dimensions.Area', WEIGHT_PATH]);
const isMeasure = paths => paths.length > 0 && paths.every(path => MEASURE_PATHS.has(path));

// Does the question ask to add up a measure? Three ways it can:
//   "total LENGTH", "how much do they WEIGH"   an aggregate word + a measure
//   "how much CONCRETE is used"                an aggregate word + a material (impliedMeasure)
//   "what is the VOLUME of the steel"          "what" + volume, area or weight
// "Total number of beams" names no measure, so it stays a count.
function wantsTotal(match, summary) {
    const namesQuantity = summary.propertyMentions.some(paths => paths.some(path => QUANTITY_MEASURES.includes(path)));
    return (Boolean(match.aggregate) && (summary.propertyMentions.some(isMeasure) || Boolean(match.impliedMeasure))) ||
        (Boolean(match.quantityQuestion) && namesQuantity && !match.rank);
}

// Ranking and totals, built in code with NO LLM call: the words already say everything.
//   "the longest beam"              -> { action: "rank", sortBy: [Length], order: "desc", limit: null }
//   "total length of steel beams"   -> { action: "total", measure: [Length], aggregate: "sum" }
//   "total volume per level"        -> ... groupBy: [the level properties]
// Returns null when the pieces don't fit (e.g. two "per ..." words): then tier 1 decides.
function planRankOrTotal(summary, match, base = null) {
    base = base || {
        category: summary.categories[0] || null,
        filters: filtersOf(summary)
    };

    if (wantsTotal(match, summary)) {
        const measureAt = summary.propertyMentions.findIndex(isMeasure);
        // No measure named ("how much concrete"): the material's own measure.
        const measure = measureAt >= 0 ? summary.propertyMentions[measureAt]
            : match.impliedMeasure === 'weight' ? [WEIGHT_PATH] : [VOLUME_PATH];
        const others = summary.propertyMentions.filter((_, i) => i !== measureAt); // "per LEVEL"
        if (others.length + (summary.groupByCategory ? 1 : 0) > 1) return null;
        return {
            action: 'total', ...base,
            // Weight isn't stored per element, only per metre: "weight" = Nominal Weight x Length.
            measure: measure.includes(WEIGHT_PATH) ? 'weight' : measure,
            aggregate: match.aggregate || 'sum',
            groupBy: summary.groupByCategory ? 'category' : (others[0] || null)
        };
    }

    if (match.rank) {
        // "the door with the largest WIDTH", "the greatest LENGTH": rank by the named property.
        let sortBy = match.rank.path ? [match.rank.path] : null;
        let others = summary.propertyMentions;
        if (match.rank.flexible && others.length === 1) {
            sortBy = others[0];
            others = [];
        } else if (sortBy) {
            // "the longest beam by length" is fine; "the longest beam per level" is for tier 1.
            others = others.filter(paths => !paths.includes(sortBy[0]));
        }
        if (!sortBy || others.length > 0 || summary.groupByCategory) return null;
        return { action: 'rank', ...base, sortBy, order: match.rank.order, limit: match.rank.limit };
    }
    return null;
}


// ---------------------------------------------------------------------------
// Follow-up questions: "steel beams on level 2" -> "and on level 3?" -> "how many?"
// The route remembers the last plan that ran (per user, model and sheet). A follow-up
// is merged into it instead of being answered from scratch.
// ---------------------------------------------------------------------------

// Did code understand every word? (Then it can merge the plans itself, 0 tokens.)
function understoodByCode(match, summary) {
    return match.unexplained.length === 0 && !match.negated && !summary.ambiguous &&
        summary.missingCategories.length === 0 && summary.categories.length <= 1;
}

// Is this question a follow-up of the previous one?
//   - it starts with "and", "only", "what about", "except", ...  -> yes
//   - it refers back with "them", "those", "they", ...           -> yes
//   - "which ONES are steel?" (no category named)              -> yes
//   - a FRAGMENT code fully understood, with no category: no question word of its own
//     ("on level 3?", "the longest?"), or nothing but one ("how many?") -> yes
// A full question ("show me the light gauge joists") is a new question, even without
// a category: treating it as a follow-up mixed it with the previous answer's filters.
function isFollowUp(question, match, summary) {
    const words = toWords(question);
    if (FOLLOW_UP_OPENERS.has(words[0])) return true;
    if ((words[0] === 'what' || words[0] === 'how') && words[1] === 'about') return true;
    if (words.some(word => BACK_REFERENCES.has(word))) return true;
    const noCategory = summary.categories.length === 0 && !summary.groupByCategory;
    if (noCategory && words.some(word => word === 'one' || word === 'ones')) return true;

    if (!understoodByCode(match, summary) || !noCategory || words.some(word => FRESH_WORDS.has(word))) return false;
    const named = summary.valueFilters.length + summary.propertyMentions.length + (match.rank || match.aggregate ? 1 : 0);
    const asksSomething = words.some(word => QUESTION_WORDS.has(word));
    return !asksSomething || named === 0;
}

// Do two filters test the same property? All level properties count as one
// ("on level 3" replaces "on level 2"), and so do the two material properties.
const isLevelPath = path => LEVEL_PATHS.includes(path) || TOP_LEVEL_PATHS.includes(path);
const isMaterialPath = path => path.startsWith('Materials and Finishes.');
function sameProperty(a, b) {
    return a.some(path => b.includes(path)) ||
        (a.some(isLevelPath) && b.some(isLevelPath)) ||
        (a.some(isMaterialPath) && b.some(isMaterialPath));
}

// Merges a follow-up into the previous plan, in code. Returns the new plan, or null
// when code can't tell what to change (then tier 1 gets both questions).
//   a new category   replaces the old one        ("and the columns?")
//   a new value      replaces a filter on the same property, or is added
//                                                ("and on level 3?", "only the UB ones")
//   rank / total words, "how many", "show", "per X" change the action
//   nothing about the action keeps it            ("and on level 3?" after a total = a total)
function mergeFollowUp(previous, summary, match, question) {
    const words = new Set(toWords(question));
    let category = previous.category ?? null;
    if (summary.categories.length === 1) category = summary.categories[0];

    let filters = (Array.isArray(previous.filters) ? previous.filters : []).map(filter => ({ ...filter }));
    for (const added of filtersOf(summary)) {
        filters = filters.filter(old => !sameProperty(toArray(old.properties ?? old.property), added.properties));
        filters.push(added);
    }
    const base = { category, filters };

    // "the longest?", "and the total length?"
    if (wantsTotal(match, summary) || match.rank) {
        return planRankOrTotal(summary, match, base);
    }
    // "per level?" / "and their materials?": break the same set down by that property.
    if (summary.propertyMentions.length > 1) return null;
    const mention = summary.propertyMentions[0];
    if (mention) {
        return previous.action === 'total'
            ? { ...previous, ...base, groupBy: mention }   // a total per level
            : { action: 'group', ...base, groupBy: mention };
    }
    if ((words.has('how') && words.has('many')) || words.has('count') || words.has('number')) {
        return { action: 'count', ...base, groupBy: null };
    }
    if ([...words].some(word => LIST_WORDS.has(word))) {
        return { action: 'list', ...base, groupBy: null };
    }
    // Only the filters changed: same kind of answer as before.
    return { ...previous, ...base };
}

// The previous question and plan, as text for the LLM (tiers 1 and 2).
function describePrevious(previous) {
    return `PREVIOUS QUESTION: ${previous.question}\nPREVIOUS PLAN: ${JSON.stringify(previous.plan)}\n` +
        'This question follows on from it: start from the previous plan and change only what this question changes.';
}

// Distance questions (see spatial.js), planned in code:
//   two element ids named ("distance between 3493 and 3902")  -> kind "between"
//   otherwise, the set the question names ("between the columns") -> kind "spacing"
function spatialPlan(question, summary) {
    const ids = (String(question).match(/\b\d{3,}\b/g) || []).map(Number);
    if (ids.length >= 2) return { action: 'spatial', kind: 'between', elementIds: ids.slice(0, 2) };
    return { action: 'spatial', kind: 'spacing', category: summary.categories[0] || null, filters: filtersOf(summary) };
}

module.exports = {
    filtersOf, planFromMatch, MEASURE_PATHS, isMeasure, wantsTotal, planRankOrTotal,
    understoodByCode, isFollowUp, isLevelPath, isMaterialPath, sameProperty, mergeFollowUp,
    describePrevious, spatialPlan
};

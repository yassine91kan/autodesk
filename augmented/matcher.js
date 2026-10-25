// augmented/matcher.js
// ===========================================================================
// 2b. MATCHER - which words of the question match which names of the model.
//   buildDictionary   the model's names as lookup tables (once per model)
//   parseComparisons  "longer than 6 m" -> a number filter, units converted
//   matchQuestion     words -> matches; summarizeMatch -> pieces of a plan
// ===========================================================================

const {
    NAME_PATHS, PLACEHOLDER_VALUE, LENGTH_PATH, WEIGHT_PATH, LEVEL_PATHS, TOP_LEVEL_PATHS,
    HIDDEN_FROM_PROMPT, label
} = require('./shared');
const {
    CATEGORY_WORDS, PROPERTY_WORDS, RANK_WORDS, GENERIC_RANK_WORDS, SIZE_RANK_WORDS, AGGREGATE_WORDS,
    MATERIAL_TERMS, NEGATION_WORDS, VALUE_SYNONYMS, MATERIAL_WORDS, UNMATCHED_OK, STOPWORDS,
    VAGUE_VALUES, toWords, editDistance, MATERIAL_QUANTITY
} = require('./words');

// How matching works:
// It matches the words of a question to real names in the model, in plain code
// (no LLM, 0 tokens). Built once per model when it loads.
//
//   "show me the UB beams on level 2"
//      beam      -> category  Structural Framing       (everyday word)
//      ub        -> family    UB-Universal Beams (...) (part of a family name)
//      level 2   -> value     "Level 2" of the level properties
//      show, me, the, on -> ignored (stopwords)
//
// If every word is explained, the question is "simple" (tier 0). Otherwise the
// matches become the short CANDIDATES list for the tier 1 prompt.

// Builds the lookup tables for one model.
function buildDictionary(db, vocabulary) {
    const phrases = new Map();  // "light gauge joist" -> [entries]   (exact matches)
    const partials = [];        // names that can also match by some of their words ("ub")
    const genericWords = new Set(); // category words: too vague to match a family on their own

    function addPhrase(words, entry) {
        if (words.length === 0) return;
        const key = words.join(' ');
        if (!phrases.has(key)) phrases.set(key, []);
        phrases.get(key).push(entry);
    }

    // Categories: their own names plus the everyday words.
    const present = new Set(vocabulary.categories.map(c => c.name));
    for (const name of present) {
        addPhrase(toWords(name), { kind: 'category', category: name });
    }
    for (const [name, words] of Object.entries(CATEGORY_WORDS)) {
        for (const word of words) {
            const parts = toWords(word);
            parts.forEach(part => genericWords.add(part));
            // A known word for a category this model doesn't have ("ceilings") is
            // remembered too, so we can say "no such category" instead of guessing.
            addPhrase(parts, present.has(name) ? { kind: 'category', category: name } : { kind: 'missing-category', category: name });
        }
    }
    addPhrase(['category'], { kind: 'group-by-category' });

    // Properties: by their label ("Bar Diameter") and by the everyday words above.
    const visible = vocabulary.properties.filter(p => !HIDDEN_FROM_PROMPT.has(p.path));
    for (const property of visible) {
        const entry = { kind: 'property', paths: [property.path] };
        addPhrase(toWords(label(property.path)), entry);
        partials.push({ words: new Set(toWords(label(property.path))), entry });
    }
    for (const [word, paths] of Object.entries(PROPERTY_WORDS)) {
        const existing = (paths || LEVEL_PATHS).filter(path => vocabulary.allPaths.has(path));
        if (existing.length > 0) {
            addPhrase(toWords(word), { kind: 'property', paths: existing });
        }
    }

    // Values of short-list text properties (levels, materials, usage) and all
    // family / type names, each with the categories that use it.
    // Family and type names are ALWAYS included, however many there are: the 100-name
    // limit (MAX_LISTED_NAMES) keeps the PROMPT small, but matching in code costs nothing.
    // (Seaport has 154 families: with the limit, "chairs" and "precast stairs" found none.)
    const listedPaths = visible
        .filter(p => (p.kind === 'values' && !p.isNumeric) || NAME_PATHS.has(p.path))
        .map(p => p.path);
    const rows = listedPaths.length === 0 ? [] : db.prepare(`
        SELECT p.path, p.value, e.category
        FROM properties p JOIN elements e ON e.objectid = p.objectid
        WHERE p.path IN (${listedPaths.map(() => '?').join(', ')})
        GROUP BY p.path, p.value, e.category
    `).all(...listedPaths);

    const values = new Map(); // "path|value" -> entry
    for (const row of rows) {
        const key = `${row.path}|${row.value}`;
        if (!values.has(key)) {
            values.set(key, { kind: 'value', path: row.path, value: row.value, categories: new Set() });
        }
        values.get(key).categories.add(row.category);
    }
    for (const entry of values.values()) {
        const words = toWords(entry.value);
        if (PLACEHOLDER_VALUE.test(entry.value) || (words.length === 1 && VAGUE_VALUES.has(words[0]))) {
            continue;
        }
        addPhrase(words, entry);
        partials.push({ words: new Set(words), entry });
    }

    // Every word the model's names use, for typo correction ("colums" -> "column").
    const knownWords = new Set();
    for (const key of phrases.keys()) key.split(' ').forEach(word => knownWords.add(word));
    for (const item of partials) item.words.forEach(word => knownWords.add(word));
    Object.keys(PROPERTY_WORDS).concat(Object.keys(MATERIAL_WORDS)).forEach(word => knownWords.add(word));

    // path -> its value entries, so tier 1 can show only the values a category really uses.
    const valuesByPath = new Map();
    for (const entry of values.values()) {
        if (!valuesByPath.has(entry.path)) valuesByPath.set(entry.path, []);
        valuesByPath.get(entry.path).push(entry);
    }

    // The unit each size property is stored in ("mm" here, "ft" in an imperial model),
    // so "longer than 6 m" can be converted in code (see parseComparisons).
    const units = new Map();
    for (const path of COMPARISON_PATHS.filter(p => vocabulary.allPaths.has(p))) {
        const row = db.prepare('SELECT unit FROM properties WHERE path = ? AND unit IS NOT NULL GROUP BY unit ORDER BY COUNT(*) DESC LIMIT 1').get(path);
        if (row) units.set(path, row.unit);
    }

    const longest = Math.max(1, ...[...phrases.keys()].map(key => key.split(' ').length));
    return { phrases, partials, genericWords, knownWords, valuesByPath, units, longestPhrase: Math.min(longest, 8) };
}

// ---------------------------------------------------------------------------
// Comparisons with a number, read and converted in code:
//   "longer than 6 m", "over 2000 mm", "wider than 36 inches", "between 3 and 5 metres"
// The number is converted into the unit the PROPERTY uses (mm, or ft in an imperial
// model), so "doors wider than 1 m" works on a model in feet. An LLM can get that
// arithmetic wrong without anyone noticing; code gets it right every time.
// ---------------------------------------------------------------------------
const COMPARISON_PATHS = [LENGTH_PATH, 'Dimensions.Width', 'Dimensions.Height', 'Dimensions.Thickness', WEIGHT_PATH];
const COMPARATIVES = {
    longer: ['gt', LENGTH_PATH], shorter: ['lt', LENGTH_PATH],
    wider: ['gt', 'Dimensions.Width'], narrower: ['lt', 'Dimensions.Width'],
    taller: ['gt', 'Dimensions.Height'],
    thicker: ['gt', 'Dimensions.Thickness'], thinner: ['lt', 'Dimensions.Thickness'],
    heavier: ['gt', WEIGHT_PATH], lighter: ['lt', WEIGHT_PATH],
    // these say "more / less" but not of WHAT: the unit and the words around decide
    bigger: ['gt', null], larger: ['gt', null], greater: ['gt', null], more: ['gt', null], over: ['gt', null], above: ['gt', null],
    smaller: ['lt', null], less: ['lt', null], under: ['lt', null], below: ['lt', null],
    'at least': ['gte', null], 'at most': ['lte', null]
};
const UNIT_RE = '(mm|millimet(?:er|re)s?|cm|centimet(?:er|re)s?|km|met(?:er|re)s?|m|ft|feet|foot|inch(?:es)?|in|kgf?\\s*/\\s*m|kgf?\\s+per\\s+(?:met(?:er|re)|m))';
const NUMBER_RE = '(-?\\d+(?:\\.\\d+)?)';
const COMPARE_RE = new RegExp(`\\b(${Object.keys(COMPARATIVES).join('|')})(?:\\s+than)?\\s+${NUMBER_RE}\\s*${UNIT_RE}(?![a-z])`, 'g');
const BETWEEN_RE = new RegExp(`\\bbetween\\s+${NUMBER_RE}\\s*${UNIT_RE}?\\s+(?:and|to)\\s+${NUMBER_RE}\\s*${UNIT_RE}(?![a-z])`, 'g');
const METRES_PER_UNIT = { mm: 0.001, cm: 0.01, m: 1, km: 1000, ft: 0.3048, in: 0.0254 };

// "millimetres" -> "mm", "feet" -> "ft", "kg per metre" -> "kg/m". Unknown -> null.
function normalUnit(unit) {
    const u = String(unit || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (/^kgf?\s*\/\s*m$/.test(u) || /^kgf? per /.test(u)) return 'kg/m';
    if (/^(mm|millimet)/.test(u)) return 'mm';
    if (/^(cm|centimet)/.test(u)) return 'cm';
    if (u === 'km') return 'km';
    if (/^(m|met)/.test(u)) return 'm';
    if (/^(ft|feet|foot)$/.test(u)) return 'ft';
    if (/^(in|inch)/.test(u)) return 'in';
    return null;
}

// 1, "m", "ft" -> 3.28084. null when the two units can't be converted.
function convertUnit(value, from, to) {
    if (!from || !to) return null;
    if (from === to) return value;
    if (from === 'kg/m' || to === 'kg/m') return null;
    if (!(from in METRES_PER_UNIT) || !(to in METRES_PER_UNIT)) return null;
    return value * METRES_PER_UNIT[from] / METRES_PER_UNIT[to];
}

// Which property "more than 6 m" is about: the comparative says it ("longer"), or the
// unit (kg/m = weight), or a size word in the question ("width greater than", "6 m long").
// Otherwise length is only a GUESS ("beams over 6 m"): returns null if the question
// names another property ("start offset ABOVE 100 mm"), and the LLM decides instead.
function comparedProperty(word, unit, text, dictionary) {
    if (word && COMPARATIVES[word]?.[1]) return COMPARATIVES[word][1];
    if (unit === 'kg/m') return WEIGHT_PATH;
    if (/\b(width|wide)\b/.test(text)) return 'Dimensions.Width';
    if (/\b(height|tall)\b/.test(text)) return 'Dimensions.Height';
    if (/\bthick/.test(text)) return 'Dimensions.Thickness';
    if (/\b(length|long)\b/.test(text)) return LENGTH_PATH;
    return namesOtherProperty(text, dictionary) ? null : LENGTH_PATH;
}

// Does the question name a property code doesn't compare by itself ("start OFFSET")?
// A word counts if it is part of property names and of no value, category or everyday word.
function namesOtherProperty(text, dictionary) {
    return toWords(text).some(word => !STOPWORDS.has(word) && !(word in PROPERTY_WORDS) &&
        !dictionary.genericWords.has(word) && !/\d/.test(word) &&
        findPartial(dictionary, [word], e => e.kind === 'property').length > 0 &&
        findPartial(dictionary, [word], e => e.kind !== 'property').length === 0);
}

// Finds the comparisons in a question. Returns { filters, text, intentText }:
//   filters     the number filters
//   text        the question with those parts blanked out (so "6" and "m" don't
//               count as words nothing matched)
//   intentText  the question with those parts replaced by a neutral phrase, for the
//               tier 0 intent prompt. Removing them entirely left only "doors" of
//               "doors wider than 1 m", and the LLM couldn't tell list from count.
// A comparison code can't convert is left in the text for the LLM.
const COMPARISON_MARK = '\u0000';
function parseComparisons(question, dictionary) {
    const lower = String(question).toLowerCase();
    const filters = [];
    const filterFor = (path, op, value, unit) => {
        const propertyUnit = normalUnit(dictionary.units.get(path));
        const converted = convertUnit(value, unit, propertyUnit);
        return converted === null ? null : { paths: [path], op, value: Math.round(converted * 1e6) / 1e6 };
    };
    let text = lower.replace(BETWEEN_RE, (all, low, lowUnit, high, highUnit) => {
        const unit = normalUnit(highUnit);
        const path = comparedProperty(null, unit, lower, dictionary);
        if (!path) return all;
        const from = filterFor(path, 'gte', Number(low), normalUnit(lowUnit) || unit);
        const to = filterFor(path, 'lte', Number(high), unit);
        if (!from || !to) return all;
        filters.push(from, to);
        return COMPARISON_MARK;
    });
    text = text.replace(COMPARE_RE, (all, word, number, unitText) => {
        const unit = normalUnit(unitText);
        const path = comparedProperty(word, unit, lower, dictionary);
        if (!path) return all;
        const filter = filterFor(path, COMPARATIVES[word][0], Number(number), unit);
        if (!filter) return all;
        filters.push(filter);
        return COMPARISON_MARK;
    });
    const intentText = text.split(COMPARISON_MARK).join(' with a size condition ').replace(/\s+/g, ' ').trim();
    return { filters, text: text.split(COMPARISON_MARK).join(' '), intentText };
}

// "colums" -> "column": a word the model never uses, one edit away from exactly one word
// it does use (two edits for long words), is treated as that word. Numbers, ignored words
// and short words are left alone, and so is anything with more than one close match.
function correctTypo(word, dictionary) {
    if (word.length < 3 || /\d/.test(word) || STOPWORDS.has(word) || UNMATCHED_OK.has(word) || dictionary.knownWords.has(word)) {
        return word;
    }
    // 3-letter words are only fixed into category words: "dors" -> (singular) "dor" -> "door".
    // Anything else that short ("ask", "way") is too likely a real word to "correct".
    if (word.length === 3) {
        const close = [...dictionary.genericWords].filter(known => known.length === 4 && editDistance(word, known) === 1);
        return close.length === 1 ? close[0] : word;
    }
    // Superlatives ("heaviest", "longest") are real words, not typos: "heaviest" is two
    // edits from "heavier", and "correcting" it turned a top-N question into a breakdown.
    if (word.length > 5 && word.endsWith('est')) {
        return word;
    }
    const allowed = word.length >= 8 ? 2 : 1;
    let best = null;
    let bestDistance = allowed + 1;
    let tie = false;
    for (const known of dictionary.knownWords) {
        if (/\d/.test(known) || Math.abs(known.length - word.length) > allowed) continue;
        const distance = editDistance(word, known);
        if (distance < bestDistance) { best = known; bestDistance = distance; tie = false; }
        else if (distance === bestDistance) tie = true;
    }
    return best && !tie ? best : word;
}

// Finds names whose words include ALL of `words` ("ub" is in "UB-Universal Beams").
// At least one word must be specific: "beam" alone would match every beam family.
// `accept` narrows the kind of entry wanted; it runs BEFORE the cut to 12, or 12
// property labels containing "chair" could crowd out the chair families.
function findPartial(dictionary, words, accept = () => true) {
    const specific = words.filter(word => !dictionary.genericWords.has(word) && !/^\d+$/.test(word));
    if (specific.length === 0) return [];
    return dictionary.partials
        .filter(item => words.every(word => item.words.has(word)) && accept(item.entry))
        .map(item => item.entry)
        .slice(0, 12);
}

// Part of a property label nobody means as a property ("piles" in "Pile Type") gives way
// to the family / type names that contain the word ("Pile Cap-..."). Everyday property
// words ("length", "level") stay properties. Used for every partial match, so a run of
// words and a single word looked up alone follow the same rule.
function preferNames(entries, phrase) {
    if (!entries.some(e => e.kind === 'property') || phrase in PROPERTY_WORDS) return entries;
    const names = entries.filter(e => e.kind === 'value' && NAME_PATHS.has(e.path));
    return names.length > 0 ? names : entries;
}

// Step 1: which words of the question match which names?
// Returns { matches: [{ words, partial, entries }], unexplained: [words nothing matched] }.
function matchQuestion(question, dictionary) {
    const corrections = []; // "colums -> column", shown in the response for transparency
    const compared = parseComparisons(question, dictionary);   // "longer than 6 m" -> a number filter
    const words = toWords(compared.text).map(word => {
        // "external" -> "exterior", only when the model has "exterior" and not "external"
        const synonym = VALUE_SYNONYMS[word];
        if (synonym && !dictionary.knownWords.has(word) && dictionary.knownWords.has(synonym)) {
            corrections.push(`${word} -> ${synonym}`);
            return synonym;
        }
        const fixed = correctTypo(word, dictionary);
        if (fixed !== word) corrections.push(`${word} -> ${fixed}`);
        return fixed;
    });
    const negated = words.some(word => NEGATION_WORDS.has(word));

    // Ranking: "the 3 longest beams", "top 5 heaviest columns" -> { path, order, limit }.
    // The rank word and its number are replaced by "the" (a stopword): code has
    // understood them, so they mustn't count as words nothing matched.
    let rank = null;
    // ("the highest NUMBER of beams" / "how MANY" is about counts, not a ranking.)
    const aboutCounts = words.includes('number') || words.includes('many');
    words.forEach((word, i) => {
        if (rank || !(RANK_WORDS[word] || (GENERIC_RANK_WORDS[word] && !aboutCounts))) return;
        const [path, order] = RANK_WORDS[word] || [null, GENERIC_RANK_WORDS[word]];
        // flexible: ranks by the property the question names, if it names one
        rank = { word, path, order, limit: null, flexible: !RANK_WORDS[word] || SIZE_RANK_WORDS.has(word) };
        words[i] = 'the';
        // The number right before ("3 longest") or right after "top" ("top 3 longest").
        const numberAt = [i - 1, words.indexOf('top') + 1].find(j => j >= 0 && /^\d+$/.test(words[j] || ''));
        if (numberAt !== undefined) {
            rank.limit = Number(words[numberAt]);
            words[numberAt] = 'the';
        }
    });

    // Adding up: "total length", "average volume", "how much do they weigh", "tonnage".
    // (Only a real total if a measure such as length or volume is named too: see planRankOrTotal.)
    let aggregate = AGGREGATE_WORDS[words.find(word => AGGREGATE_WORDS[word])] || null;
    // ("how MANY beams weigh more than 50 kg/m" is a count, so it needs "much" or "how heavy".)
    const weightWord = words.some(word => ['weight', 'weigh', 'heavy', 'mass'].includes(word));
    const howHeavy = words.some((word, i) => word === 'how' && words[i + 1] === 'heavy');
    if (!aggregate && (words.includes('tonnage') || howHeavy || (weightWord && words.includes('much')))) {
        aggregate = 'sum';
    }
    // "How much concrete is used?": a quantity of a material, with no measure named. It's
    // a total of the measure that material is counted in: volume, or weight for steel.
    // (impliedMeasure is used only if the question names no measure itself.)
    let impliedMeasure = null;
    const material = words.find(word => MATERIAL_TERMS.has(word));
    if (words.includes('much') && material && !weightWord) {
        aggregate = aggregate || 'sum';
        impliedMeasure = MATERIAL_QUANTITY[material] || 'volume';
    }
    // "What is the VOLUME of the steel?": for volume, area and weight the answer is a sum,
    // even without the word "total". (Not with "per" / "by" / "how many": those are
    // breakdowns and counts.)
    const quantityQuestion = words.includes('what') &&
        !words.some(word => ['per', 'by', 'each', 'many', 'breakdown', 'group', 'grouped'].includes(word));

    const matches = [];
    const leftover = []; // runs of words that didn't match a whole phrase

    // "level 2" in a model whose levels are "O-Level 2", "O/G/PH/C-Level 1": the level
    // VALUES containing those words. Returns [] if there's no such value.
    const levelValues = (i) => {
        if (!['level', 'story', 'floor'].includes(words[i]) || !words[i + 1] || dictionary.phrases.has(`${words[i]} ${words[i + 1]}`)) return [];
        return findPartial(dictionary, [words[i], words[i + 1]], e => e.kind === 'value' && (LEVEL_PATHS.includes(e.path) || TOP_LEVEL_PATHS.includes(e.path)));
    };

    // Longest phrase first: "light gauge joist" before "joist".
    let run = [];
    let i = 0;
    while (i < words.length) {
        let found = false;
        const levels = levelValues(i);
        if (levels.length > 0) {
            if (run.length) leftover.push(run);
            run = [];
            matches.push({ words: `${words[i]} ${words[i + 1]}`, partial: true, entries: levels, levelName: true });
            i += 2;
            continue;
        }
        for (let n = Math.min(dictionary.longestPhrase, words.length - i); n >= 1; n--) {
            const phrase = words.slice(i, i + n).join(' ');
            // A filler word alone never matches a model name: "NUMBER of doors" was matching
            // the grid property "Number", "count ALL the doors" the value "All" (Region).
            if (n === 1 && STOPWORDS.has(phrase)) continue;
            if (dictionary.phrases.has(phrase)) {
                let entries = dictionary.phrases.get(phrase);
                // An exact match only on a minor property ("pile caps" = Assembly Description
                // "Pile Caps") must not hide the names people mean (the "Pile Cap-..." families):
                // add those partial matches too, and let name preference choose.
                // Same for a property LABEL nobody means as a property: "chairs" is the label of
                // a dining-table parameter (Construction.Chairs = 4), but people mean the chairs.
                // Everyday property words ("length", "level") are kept as properties.
                const obscureProperty = entries.some(e => e.kind === 'property') && !(phrase in PROPERTY_WORDS);
                if (obscureProperty) {
                    const isName = e => e.kind === 'value' && NAME_PATHS.has(e.path);
                    const names = [...new Set([...entries.filter(isName), ...findPartial(dictionary, words.slice(i, i + n), isName)])];
                    if (names.length > 0) entries = names;
                }
                const valuesOnly = entries.every(e => e.kind === 'value');
                if (valuesOnly && Math.min(...entries.map(e => pathPriority(e.path))) >= 5) {
                    const better = findPartial(dictionary, words.slice(i, i + n))
                        .filter(e => e.kind === 'value' && pathPriority(e.path) < 5);
                    if (better.length > 0) entries = entries.concat(better);
                }
                matches.push({ words: phrase, partial: false, entries });
                i += n;
                found = true;
                break;
            }
        }
        if (found) {
            if (run.length) leftover.push(run);
            run = [];
            continue;
        }
        if (STOPWORDS.has(words[i])) {
            if (run.length) leftover.push(run);
            run = [];
        } else {
            run.push(words[i]);
        }
        i++;
    }
    if (run.length) leftover.push(run);

    // Step 2: the leftover words, by parts of names ("ub", "steel", "diameter").
    const unexplained = [];
    for (const words of leftover) {
        let whole = findPartial(dictionary, words);
        // A material word on its own ("timber") also looks for its stand-ins ("softwood",
        // "lumber"), even when a name contains the word itself ("Rectangular(Timber)-Beam"):
        // then summarizeMatch can prefer the MATERIAL (see MATERIAL_TERMS).
        if (whole.length > 0 && words.length === 1 && MATERIAL_WORDS[words[0]]) {
            const standIns = MATERIAL_WORDS[words[0]].flatMap(w => findPartial(dictionary, [w]));
            whole = [...new Set([...whole, ...standIns])];
        }
        // As for exact matches: part of a property label nobody means as a property
        // ("piles" in "Pile Type") gives way to the names that contain the word
        // (the "Pile Cap-..." families). Everyday property words stay properties.
        whole = preferNames(whole, words.join(' '));
        if (whole.length > 0) {
            matches.push({ words: words.join(' '), partial: true, entries: whole });
            continue;
        }
        for (const word of words) { // the run as a whole matched nothing: try word by word
            // Everyday material words look for their stand-ins ("wooden" -> softwood, lumber).
            const lookFor = MATERIAL_WORDS[word] || [word];
            const single = preferNames([...new Set(lookFor.flatMap(w => findPartial(dictionary, [w])))], word);
            if (single.length > 0) {
                matches.push({ words: word, partial: true, entries: single });
            } else {
                unexplained.push(word);
            }
        }
    }

    // withoutComparisons: the question with "more than 20 kg per metre" replaced by a
    // neutral phrase, for the intent prompt (whose "per" read as "a breakdown per X").
    return { matches, unexplained, negated, corrections, rank, aggregate, impliedMeasure, quantityQuestion, comparisons: compared.filters,
        withoutComparisons: compared.filters.length > 0 ? compared.intentText : question };
}

// Which property a name most likely refers to, when it appears in several (lower = more likely).
function pathPriority(path) {
    if (path === 'Element.Family') return 1;
    if (path === 'Element.Type') return 2;
    if (path.startsWith('Materials and Finishes.') || path === 'Construction.Function') return 3; // "exterior walls"
    if (LEVEL_PATHS.includes(path) || TOP_LEVEL_PATHS.includes(path)) return 4;
    if (path === 'Structural.Structural Usage') return 5;
    return 9;
}

// Step 2: turn the matches into the pieces of a plan.
// categoryHint: for a follow-up that names no category ("only the UB ones"), the
// previous plan's category, so values are chosen for THAT category (the UB beams).
function summarizeMatch(match, categoryHint = null) {
    const summary = {
        categories: [],        // categories named in the question
        missingCategories: [], // categories named that this model doesn't have
        groupByCategory: false,
        valueFilters: [],      // { paths, values } e.g. Level properties = "Level 2"
        propertyMentions: [],  // properties named without a value ("which LEVEL", "what MATERIALS")
        ambiguous: false       // a word matched things we can't choose between
    };

    // Categories first: they're needed to choose between values below.
    for (const m of match.matches) {
        for (const entry of m.entries) {
            if (entry.kind === 'category' && !summary.categories.includes(entry.category)) summary.categories.push(entry.category);
            if (entry.kind === 'missing-category') summary.missingCategories.push(entry.category);
        }
    }

    for (const m of match.matches) {
        const kinds = new Set(m.entries.map(entry => entry.kind));
        if (kinds.has('category') || kinds.has('missing-category')) continue; // handled above
        if (kinds.has('group-by-category')) {
            summary.groupByCategory = true;
            continue;
        }
        if (kinds.has('property')) {
            const paths = [...new Set(m.entries.filter(e => e.kind === 'property').flatMap(e => e.paths))];
            summary.propertyMentions.push(paths);
            // "diameter" matching 5 different properties: we can't pick one in code.
            if (m.partial && paths.length > 1) summary.ambiguous = true;
            continue;
        }

        // Values. If the question names a category, keep the values used by it:
        // "UB beams" -> the UB *beam* family, not the UB *column* family.
        let entries = m.entries.filter(e => e.kind === 'value');
        const category = summary.categories.length === 1 ? summary.categories[0] : categoryHint;
        if (category) {
            const inCategory = entries.filter(e => e.categories.has(category));
            if (inCategory.length > 0) entries = inCategory;
        }
        // A word found in several properties: keep the one people most likely mean.
        // "pile caps" -> the Pile Cap families, not Assembly Description "Pile Caps";
        // "steel" -> the material, not Assembly Description "Steel Light Gauge Floor System".
        // A material word ("concrete") means the material, even where a family name also
        // contains it ("M_Concrete-Square-Column"): "concrete elements" are the ones MADE of it.
        const materials = entries.filter(e => e.path.startsWith('Materials and Finishes.'));
        if (MATERIAL_TERMS.has(m.words) && materials.length > 0) entries = materials;
        const best = Math.min(...entries.map(e => pathPriority(e.path)));
        entries = entries.filter(e => pathPriority(e.path) === best);

        // Part of a name, found in names of SEVERAL categories, and no category named:
        // "toilet" is in "Toilet-Domestic-3D" (plumbing) and in "Toilet Partition Panel"
        // (specialty equipment). Which one is meant is for tier 1 to decide, not code.
        const nameCategories = new Set(entries.filter(e => NAME_PATHS.has(e.path)).flatMap(e => [...e.categories]));
        if (m.partial && !category && nameCategories.size > 1) {
            summary.ambiguous = true;
        }
        if (m.levelName && new Set(entries.map(e => e.value)).size > 1) {
            summary.ambiguous = true;
        }
        const paths = [...new Set(entries.map(e => e.path))];
        const allLevels = paths.every(path => LEVEL_PATHS.includes(path) || TOP_LEVEL_PATHS.includes(path));
        if (paths.length > 1 && !allLevels) {
            summary.ambiguous = true; // e.g. "concrete" is both a material and a family name
        }
        summary.valueFilters.push({ paths, values: [...new Set(entries.map(e => e.value))] });
    }

    // Number filters read in code ("longer than 6 m"). The property word next to them
    // ("LENGTH greater than 6 m", "WEIGH more than 20 kg/m") is part of the comparison,
    // not a request to break the answer down by it.
    summary.numberFilters = match.comparisons || [];
    const compared = new Set(summary.numberFilters.flatMap(filter => filter.paths));
    summary.propertyMentions = summary.propertyMentions.filter(paths => !paths.some(path => compared.has(path)));
    return summary;
}

// Tier 0 only when code understood EVERYTHING: no leftover words, nothing ambiguous.
function isSimple(match, summary) {
    const found = summary.categories.length + summary.valueFilters.length + summary.numberFilters.length +
        summary.propertyMentions.length + (summary.groupByCategory ? 1 : 0);
    return found > 0 && match.unexplained.length === 0 && !summary.ambiguous && !match.negated &&
        summary.missingCategories.length === 0 && summary.categories.length <= 1;
}

module.exports = {
    buildDictionary, COMPARISON_PATHS, COMPARATIVES, UNIT_RE, NUMBER_RE, COMPARE_RE, BETWEEN_RE,
    METRES_PER_UNIT, normalUnit, convertUnit, comparedProperty, namesOtherProperty, parseComparisons,
    correctTypo, findPartial, matchQuestion, pathPriority, summarizeMatch, isSimple
};

// augmented/words.js
// ===========================================================================
// 2a. WORDS - every hand-written word list in one place, plus how a question is
// cut into words (toWords). Changing a list here changes how questions are read
// everywhere, so after any change run the tests and the dry runs:
//   node test/run_v2.js
//   node test/dry_run.js --cases test/eval-cases-<model>.json
// ===========================================================================

const {
    LENGTH_PATH, VOLUME_PATH, WEIGHT_PATH
} = require('./shared');

// Everyday words for categories. This is the only hand-written name list: family,
// type, property and value names all come from the model itself.
const CATEGORY_WORDS = {
    // Not "girder": Revit records it as a Structural Usage value, which the dictionary
    // finds by itself. As a category word it turned "girders" into all 370 framing members.
    'Structural Framing': ['beam', 'framing'],
    'Structural Columns': ['column'],
    'Walls': ['wall'],
    'Floors': ['floor', 'slab'],
    // Not "pile": models usually have pile CAPS, not piles. As a category word, "piles"
    // returned every foundation (wall footings too); now it finds the "Pile Cap" families.
    'Structural Foundations': ['foundation', 'footing'],
    'Structural Rebar': ['rebar', 'reinforcing bar'],
    'Structural Area Reinforcement': ['area reinforcement'],
    'Stairs': ['stair', 'staircase'],
    'Doors': ['door'],
    'Windows': ['window'],
    'Roofs': ['roof'],
    'Ceilings': ['ceiling'],
    'Railings': ['railing'],
    'Rooms': ['room'],
    'Spaces': ['space']
};

// Everyday words for properties. `null` means "all the level properties" (LEVEL_PATHS, section 4).
const PROPERTY_WORDS = {
    level: null,
    material: ['Materials and Finishes.Structural Material', 'Materials and Finishes.Material'],
    family: ['Element.Family'],
    type: ['Element.Type'],
    length: ['Dimensions.Length'],
    long: ['Dimensions.Length'],
    longer: ['Dimensions.Length'],
    short: ['Dimensions.Length'],
    shorter: ['Dimensions.Length'],
    volume: ['Dimensions.Volume'],
    area: ['Dimensions.Area'],
    usage: ['Structural.Structural Usage'],
    // Revit's steel sections carry their weight per metre as "Nominal Weight".
    weight: ['Structural Analysis.Nominal Weight'],
    weigh: ['Structural Analysis.Nominal Weight'],
    heavy: ['Structural Analysis.Nominal Weight'],
    heavier: ['Structural Analysis.Nominal Weight'],
    lighter: ['Structural Analysis.Nominal Weight'],
    tonnage: ['Structural Analysis.Nominal Weight'],
    mass: ['Structural Analysis.Nominal Weight'],
    // Sizes ("the widest", "taller than 3 m", "square footage"): only used if the model has them.
    width: ['Dimensions.Width'], wide: ['Dimensions.Width'],
    // Height: Revit keeps a wall's height as "Unconnected Height"; other elements may have
    // "Height". (Not "Structural Section Geometry.Height": that's a steel profile's depth.)
    height: ['Dimensions.Height', 'Constraints.Unconnected Height'],
    tall: ['Dimensions.Height', 'Constraints.Unconnected Height'],
    high: ['Dimensions.Height', 'Constraints.Unconnected Height'],
    thickness: ['Dimensions.Thickness'], thick: ['Dimensions.Thickness'],
    'square footage': ['Dimensions.Area'], footage: ['Dimensions.Area'], sqft: ['Dimensions.Area']
};

// Superlatives: rank by this property, highest ("desc") or lowest ("asc") first.
// "the longest beam" = the beams tied at the greatest length.
const RANK_WORDS = {
    longest: [LENGTH_PATH, 'desc'], shortest: [LENGTH_PATH, 'asc'],
    heaviest: [WEIGHT_PATH, 'desc'], lightest: [WEIGHT_PATH, 'asc'],
    largest: [VOLUME_PATH, 'desc'], biggest: [VOLUME_PATH, 'desc'], smallest: [VOLUME_PATH, 'asc'],
    widest: ['Dimensions.Width', 'desc'], narrowest: ['Dimensions.Width', 'asc'],
    tallest: ['Dimensions.Height', 'desc'],
    thickest: ['Dimensions.Thickness', 'desc'], thinnest: ['Dimensions.Thickness', 'asc']
};

// Rank words that don't say WHICH property: "the greatest LENGTH", "the highest WIDTH".
// They rank by the property the question names. (So do "largest", "biggest", "smallest"
// when a property is named: "the door with the largest WIDTH", not the largest volume.)
const GENERIC_RANK_WORDS = { greatest: 'desc', highest: 'desc', maximum: 'desc', max: 'desc', lowest: 'asc', minimum: 'asc', min: 'asc' };
const SIZE_RANK_WORDS = new Set(['largest', 'biggest', 'smallest']);

// Words that ask to add numbers up, and which aggregate each one means.
const AGGREGATE_WORDS = { total: 'sum', sum: 'sum', overall: 'sum', combined: 'sum', together: 'sum', add: 'sum',
    average: 'average', mean: 'average' };

// Material words: when one also appears inside a family name ("M_Concrete-Square-Column"),
// people still mean the material ("concrete elements" = elements made of concrete).
const MATERIAL_TERMS = new Set(['steel', 'concrete', 'timber', 'wood', 'wooden', 'softwood', 'lumber',
    'aluminum', 'metal', 'masonry', 'brick', 'glass', 'precast', 'stud']);

// Words that make a question continue the previous one: "AND on level 3?", "ONLY the
// steel ones", "how many of THEM?". They name nothing in the model, so they are also
// stopwords (they would otherwise count as words nothing matched).
const FOLLOW_UP_WORDS = new Set(['and', 'also', 'only', 'just', 'now', 'but', 'then', 'same', 'about',
    'them', 'those', 'these', 'they', 'their', 'again', 'instead', 'too', 'ok', 'okay']);
// A follow-up usually STARTS with one of these ("and on level 3?", "except the HSS ones").
const FOLLOW_UP_OPENERS = new Set(['and', 'also', 'only', 'just', 'now', 'but', 'then', 'same',
    'except', 'excluding', 'without', 'not']);
// ...or refers back to the last answer with one of these, anywhere ("how long are THEY?").
const BACK_REFERENCES = new Set(['them', 'those', 'these', 'they', 'their']);
// Words that ask about the WHOLE model: a question with them starts afresh.
const FRESH_WORDS = new Set(['everything', 'anything', 'all', 'element', 'model']);

// Words that turn a question around ("NOT on level 2", "EXCEPT the HSS ones"). Code
// can't express those, so such questions skip tier 0 and go to the LLM, which can.
// They're also kept from matching values like Section Shape "Not Defined".
const NEGATION_WORDS = new Set(['not', 'except', 'excluding', 'exclude', 'without', 'isn', 'aren', 'don', 'doesn', 'non']);

// Questions about distances and positions ("distance between piles", "the closest
// column"). The model data has properties, not element positions, so code says so
// straight away instead of sending them to the LLM, which can only ask back.
const SPATIAL_WORDS = new Set(['distance', 'distances', 'spacing', 'spaced', 'apart', 'gap', 'near', 'nearest',
    'nearby', 'closest', 'close', 'adjacent', 'far', 'farthest', 'furthest', 'neighbour', 'neighbor']);

// "How much concrete / steel?": a quantity of a material, with no measure named.
// Concrete is counted by volume, steel by weight (tonnage), as on construction sites.
const MATERIAL_QUANTITY = { steel: 'weight', metal: 'weight' };   // everything else: volume

// "What is the VOLUME of the steel" asks for a total even without "total": for these
// measures the answer is a sum. (Not length: "how long are the beams" is about each beam.)
const QUANTITY_MEASURES = ['Dimensions.Volume', 'Dimensions.Area', 'Structural Analysis.Nominal Weight'];

// Everyday words for values, used ONLY when the model lacks the word itself:
// "external walls" -> "Exterior" (Revit's Function value). ("inside" is left out: it is
// more often a place, "columns inside the core", than a value.)
const VALUE_SYNONYMS = { external: 'exterior', outside: 'exterior', internal: 'interior' };

// Numbers written as words, after a level word: "level two" -> "level 2".
// Ordinals before one: "second level", "2nd floor" -> "level 2".
const NUMBER_WORDS = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8',
    nine: '9', ten: '10', eleven: '11', twelve: '12' };
const ORDINAL_WORDS = { first: '1', second: '2', third: '3', fourth: '4', fifth: '5', sixth: '6', seventh: '7',
    eighth: '8', ninth: '9', tenth: '10' };
const LEVEL_NOUNS = new Set(['level', 'story', 'floor']);

// British / American spellings, so "aluminium" finds "Aluminum".
const WORD_VARIANTS = { aluminium: 'aluminum', colour: 'color', grey: 'gray', centre: 'center', storey: 'story' };

// Everyday material words. Each looks for these words inside material and family names
// instead ("wooden" finds "Softwood, Lumber"; "timber" also finds the "...(Timber)-Beam" family).
const MATERIAL_WORDS = {
    wood: ['softwood', 'lumber'],
    wooden: ['softwood', 'lumber'],
    timber: ['timber', 'softwood', 'lumber']
};

// Words a question may contain that no model name will ever match, and that a plan
// expresses without repeating them: numbers, units, comparisons, sorting, "or".
// Any OTHER unmatched word that the plan ignores means the answer leaves something out.
const UNMATCHED_OK = new Set([
    'mm', 'cm', 'm', 'meter', 'metre', 'km', 'kg', 'kgf', 'ton', 'tonne', 'sq', 'square', 'cubic', 'unit',
    'than', 'more', 'less', 'over', 'under', 'above', 'below', 'between', 'greater', 'smaller', 'larger',
    'bigger', 'shorter', 'wider', 'deeper', 'taller', 'exactly', 'about', 'around', 'approximately', 'equal',
    'or', 'only', 'just', 'also', 'start', 'starting', 'end', 'ending', 'begin', 'sit', 'located', 'placed',
    'break', 'down', 'split', 'sort', 'sorted', 'order', 'ordered', 'first', 'last', 'them', 'they', 'where',
    'other', 'no', 'there', 'available', 'exist', 'existing'
]);

// Words that carry no meaning for the query. Intent words (show, how many, per)
// are here too: the tier 0 prompt reads the intent from the full question.
const STOPWORDS = new Set([
    'a', 'an', 'the', 'me', 'my', 'i', 'you', 'we', 'us', 'please', 'can', 'could', 'would',
    'show', 'list', 'find', 'get', 'give', 'display', 'select', 'highlight', 'see',
    'how', 'many', 'much', 'what', 'which', 'is', 'are', 'was', 'were', 'be', 'there', 'here',
    'do', 'does', 'did', 'have', 'has', 'had', 'of', 'on', 'in', 'at', 'to', 'for', 'from',
    'with', 'by', 'per', 'each', 'every', 'all', 'any', 'some', 'and', 'that', 'this', 'those',
    'these', 'it', 'its', 'element', 'item', 'object', 'thing', 'model', 'number', 'count',
    'total', 'most', 'least', 'used', 'use', 'made', 'kind', 'kinds', 'group', 'grouped', 'breakdown',
    'member', 'members', 'one', 'ones', 'everything', 'anything', 'something',
    'sum', 'average', 'mean', 'overall', 'combined', 'top', 'value', 'values', 'break', 'down', 'split',
    // filler that names nothing: "columns LOCATED on level 1", "PLS show", "I NEED the beams",
    // "how are the beams DISTRIBUTED ACROSS the levels", "ADD UP the lengths", "all of them TOGETHER"
    'located', 'placed', 'situated', 'sitting', 'exist', 'exists', 'existing', 'available', 'pls', 'plz', 'kindly',
    'need', 'want', 'distributed', 'distribution', 'across', 'spread', 'add', 'up', 'together',
    ...NEGATION_WORDS, ...FOLLOW_UP_WORDS
]);

// Single-word values that are also ordinary English ("Other", "None", "Top").
// Matching those would turn "the other beams" into a filter, so they're skipped.
const VAGUE_VALUES = new Set(['other', 'yes', 'no', 'none', 'top', 'bottom', 'center', 'centre', 'left',
    'right', 'standard', 'single', 'origin', 'uniform', 'new', 'main', 'part', 'not']);

// "beams" -> "beam", "families" -> "family". Rough, but applied the same way to the
// question AND to the model's names, so both sides end up with the same form.
function singular(word) {
    if (word.length > 4 && word.endsWith('ies')) return word.slice(0, -3) + 'y';
    if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
    return word;
}

// "Light Gauge-Joists" -> ["light", "gauge", "joist"]. Anything that isn't a letter
// or digit becomes a space, so "-", "_", "(" and ")" don't matter.
function toWords(text) {
    const words = String(text).toLowerCase()
        .replace(/['’]s\b/g, '')          // "what's" -> "what", "beam's" -> "beam" (a lone "s" matched marks like "S-3.3")
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .split(' ')
        .filter(Boolean)
        .map(word => WORD_VARIANTS[word] || word)
        .map(word => (STOPWORDS.has(word) ? word : singular(word)));
    // "level two" -> "level 2"; "second level" / "2nd floor" -> "level 2".
    for (let i = 0; i < words.length; i++) {
        const ordinal = ORDINAL_WORDS[words[i]] || (words[i].match(/^(\d+)(st|nd|rd|th)$/) || [])[1];
        if (ordinal && LEVEL_NOUNS.has(words[i + 1])) {
            words[i] = 'level';
            words[i + 1] = ordinal;
        } else if (LEVEL_NOUNS.has(words[i]) && NUMBER_WORDS[words[i + 1]]) {
            words[i + 1] = NUMBER_WORDS[words[i + 1]];
            if (words[i] === 'story') words[i] = 'level';
        }
    }
    return words;
}

// How many single-letter edits turn `a` into `b`: add, remove, change a letter, or swap
// two neighbouring letters ("widnow" -> "window" is ONE swap, the most common typo).
// (Levenshtein distance plus swaps: "optimal string alignment".)
function editDistance(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
                d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);   // the swap
            }
        }
    }
    return d[a.length][b.length];
}

// Words that start a full question of its own.
const QUESTION_WORDS = new Set(['show', 'list', 'find', 'get', 'give', 'display', 'select', 'highlight', 'see',
    'how', 'what', 'which', 'where', 'count']);

const LIST_WORDS = new Set(['show', 'list', 'which', 'find', 'highlight', 'display', 'select', 'see']);

module.exports = {
    CATEGORY_WORDS, PROPERTY_WORDS, RANK_WORDS, GENERIC_RANK_WORDS, SIZE_RANK_WORDS, AGGREGATE_WORDS,
    MATERIAL_TERMS, FOLLOW_UP_WORDS, FOLLOW_UP_OPENERS, BACK_REFERENCES, FRESH_WORDS, NEGATION_WORDS,
    VALUE_SYNONYMS, NUMBER_WORDS, ORDINAL_WORDS, LEVEL_NOUNS, WORD_VARIANTS, MATERIAL_WORDS,
    UNMATCHED_OK, STOPWORDS, VAGUE_VALUES, singular, toWords, editDistance, QUESTION_WORDS,
    LIST_WORDS, SPATIAL_WORDS, MATERIAL_QUANTITY, QUANTITY_MEASURES
};

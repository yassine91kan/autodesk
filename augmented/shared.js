// augmented/shared.js
// ===========================================================================
// Small things every other file uses: the error types, the property paths that
// several stages need (levels, family/type, length, weight...), and tiny helpers.
// It requires nothing, so any file can use it without circular requires.
// ===========================================================================

// Our own error type. When APS says "still processing this model" we throw
// THIS instead of a plain Error. The route checks `instanceof ModelNotReadyError`
// and answers 503 "try again in a minute" instead of 500 "server broke".
class ModelNotReadyError extends Error {}

// The model loaded fine, but its objects don't look like model elements ("Name [id]"),
// e.g. a DWG drawing. The route answers 422 "can't do this with that model".
class UnsupportedModelError extends Error {}

// If a property has 25 or fewer different values (Level: "Level 1", "Level 2"...)
// we list them all for the LLM. If it has more (Mark: thousands of ids)
// we only show a few examples - listing them all would make the prompt huge.
const MAX_LISTED_VALUES = 25;

// Family and type names are how people describe elements ("light gauge joists",
// "UB beams"), so the LLM needs to see all of them, not 3 samples. A model has
// far fewer families than elements, so up to 100 is still a short list.
const MAX_LISTED_NAMES = 100;
const NAME_PATHS = new Set(['Element.Family', 'Element.Type']);

// Number properties with up to this many values are listed ("8.000 mm", "12.000 mm");
// with more, only their range is shown.
const MAX_LISTED_NUMBERS = 6;

// Revit placeholders like "<By Category>" or "<not associated>" aren't real values.
const PLACEHOLDER_VALUE = /^<.*>$/;

// Keeps a per-user Map from growing forever: past this many entries the oldest goes.
const MAX_USER_ENTRIES = 500;
function remember(map, key, value) {
    map.delete(key);   // re-inserting moves the key to the end: Maps keep insertion order
    map.set(key, value);
    if (map.size > MAX_USER_ENTRIES) map.delete(map.keys().next().value);
}

// The number properties ranking and totals use most.
const LENGTH_PATH = 'Dimensions.Length';
const VOLUME_PATH = 'Dimensions.Volume';
const WEIGHT_PATH = 'Structural Analysis.Nominal Weight';   // weight PER METRE (kgf/m) in Revit

// Duplicates of Element.Family / Element.Type / the category: showing them twice only costs tokens.
const HIDDEN_FROM_PROMPT = new Set([
    'Identity Data.Type Name', 'Identity Data.Family Name', 'Identity Data.Family and Type',
    'Identity Data.Category', 'Other.Family and Type', 'Other.Category', 'Other.Family'
]);

// Our own error type, so the route can answer "the AI gave a bad answer" (502)
// instead of a generic 500.
class PlannerError extends Error {}

// Revit keeps "the level an element sits on" in a different property per category:
// beams use Reference Level, columns Base Level, walls Base Constraint, floors Level.
// The LLM kept picking only one of them, so whenever a plan uses ANY of these,
// the code adds all the others itself. ("Top Level" is left out on purpose:
// a column that ends at Level 2 isn't "on" Level 2.)
const LEVEL_PATHS = ['Constraints.Level', 'Constraints.Base Level', 'Constraints.Reference Level', 'Constraints.Base Constraint'];
// Where an element ENDS. Dropped whenever a plan also uses a level above, so a column from
// Level 1 up to Level 2 doesn't count as "on Level 2". Asked about on its own, it's kept.
const TOP_LEVEL_PATHS = ['Constraints.Top Level', 'Constraints.Top Constraint'];

const MAX_RETURNED_ELEMENTS = 500; // never send more than this many elements to the frontend
const MAX_GROUPS = 50;

// Accept "x", ["x", "y"] or nothing, and always return an array of non-empty strings.
function toArray(value) {
    if (value === null || value === undefined) return [];
    return (Array.isArray(value) ? value : [value])
        .map(item => String(item ?? '').trim())
        .filter(item => item !== '');
}

// "Constraints.Reference Level" -> "Reference Level" (for display only).
function label(path) {
    return path.slice(path.indexOf('.') + 1);
}

// Several paths -> "Structural Material / Material" (duplicates removed).
// All the level properties are shown as just "Level".
function labels(paths) {
    const names = paths.map(path => (LEVEL_PATHS.includes(path) ? 'Level' : label(path)));
    return [...new Set(names)].join(' / ');
}

// In LIKE, % means "anything" and _ means "any one character". Put a "\" in
// front of them so that a user searching for "50%" searches for a real % sign.
function escapeLike(text) {
    return text.replace(/[\\%_]/g, '\\$&');
}

// "?, ?, ?" for an IN (...) list with one placeholder per item.
function placeholders(items) {
    return items.map(() => '?').join(', ');
}

// A request asked for something we refuse to even try (e.g. a malformed model id).
class BadRequestError extends Error {}

// Who the assistant is: told to the LLM in every prompt, and the answer to questions about
// the assistant itself ("what's your name?", "are you ChatGPT?"). Without it the LLM
// answered as itself: "I'm ChatGPT."
const ASSISTANT_NAME = 'Augmented';
const ASSISTANT_ABOUT = "I'm Augmented, an assistant that answers questions about the BIM model on screen: " +
    'counts, lists, breakdowns, rankings and quantities. I\'m an AI, and I read the model\'s data; I don\'t change it. ' +
    'Try e.g. "how many columns are on level 1?" or "total volume of the concrete".';

// The answer to questions that aren't about the model or the assistant ("weather in Sydney").
// Fixed text: paying the LLM 5,000 tokens to say "I can't do weather" bought nothing.
const ASSISTANT_OFF_TOPIC = 'I only answer questions about the BIM model on screen, such as counts, lists, ' +
    'breakdowns, rankings and quantities of its elements. Try e.g. "show me the steel beams on level 2".';

module.exports = {
    ASSISTANT_NAME, ASSISTANT_ABOUT, ASSISTANT_OFF_TOPIC,
    ModelNotReadyError, UnsupportedModelError, MAX_LISTED_VALUES, MAX_LISTED_NAMES, NAME_PATHS,
    MAX_LISTED_NUMBERS, PLACEHOLDER_VALUE, MAX_USER_ENTRIES, remember, LENGTH_PATH, VOLUME_PATH,
    WEIGHT_PATH, HIDDEN_FROM_PROMPT, PlannerError, LEVEL_PATHS, TOP_LEVEL_PATHS,
    MAX_RETURNED_ELEMENTS, MAX_GROUPS, toArray, label, labels, escapeLike, placeholders,
    BadRequestError
};

// augmented/aps.js
// ===========================================================================
// 1. APS - everything that talks to Autodesk Platform Services:
// logging in, finding a model's main 3D view, downloading its tree + properties.
// ===========================================================================

const axios = require('axios');
const { APS_CLIENT_ID, APS_CLIENT_SECRET } = require('../config.js');
const {
    ModelNotReadyError, UnsupportedModelError
} = require('./shared');

const AUTH_URL = 'https://developer.api.autodesk.com/authentication/v2/token';
const MODEL_URL = 'https://developer.api.autodesk.com/modelderivative/v2/designdata';

// An APS token lasts about an hour. We renew it 60 seconds early, so a request
// that starts just before expiry doesn't fail half-way through.
const TOKEN_REFRESH_BUFFER_MS = 60 * 1000;

// One token shared by the whole server. It's an *app* token ("2-legged"),
// not tied to a user, so every request can reuse the same one.
const token = {
    value: null,    // the token string; null until we log in the first time
    expiresAt: 0,   // when it stops working (milliseconds since 1970, like Date.now())
    pending: null   // a Promise while a login is in progress (explained below)
};

// Logs in to APS and stores the new token.
async function requestNewToken() {
    // The token endpoint expects a form-encoded body (like an HTML form post).
    const body = new URLSearchParams({
        grant_type: 'client_credentials', // "log in as the app itself, not as a user"
        scope: 'data:read'                // we only need to read models, so ask for nothing more
    });

    // APS wants "clientId:clientSecret" encoded as base64 in a "Basic" header.
    const credentials = Buffer.from(`${APS_CLIENT_ID}:${APS_CLIENT_SECRET}`).toString('base64');

    const response = await fetch(AUTH_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Basic ${credentials}`
        },
        body
    });

    // fetch() does NOT throw on 401/500, so we have to check ourselves.
    if (!response.ok) {
        throw new Error(`APS authentication failed with status ${response.status}`);
    }

    const data = await response.json();
    token.value = data.access_token;
    token.expiresAt = Date.now() + data.expires_in * 1000; // expires_in is in seconds; Date.now() is in ms
    return token.value;
}

// Returns a working token, logging in only when we have to.
async function getAccessToken() {
    const stillValid = token.value && Date.now() < token.expiresAt - TOKEN_REFRESH_BUFFER_MS;
    if (stillValid) {
        return token.value;
    }

    // If 10 requests arrive while the token is expired, we want ONE login, not 10.
    // The first request starts the login and saves its Promise in `pending`.
    // The other 9 find `pending` already set and simply wait on the same Promise.
    if (!token.pending) {
        token.pending = requestNewToken().finally(() => {
            token.pending = null; // runs whether the login worked or failed
        });
    }
    return token.pending;
}

// GET an APS URL and refuse to continue if APS answers 202.
// 202 means "accepted, still working on it": the body is NOT the data yet.
// v1 treated that body as an empty model and cached it forever.
async function getReadyJson(url, accessToken) {
    const response = await axios.get(url, {
        headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (response.status === 202) {
        throw new ModelNotReadyError('APS is still processing this model. Try again in a minute.');
    }
    return response.data;
}

// A model has one or more views (3D views, sheets), each with its own GUID. The page
// only knows the model's URN, so we ask APS for the list of views and take the main
// 3D one: the "master view" if there is one, otherwise the first 3D view.
async function findMainViewGuid(urn) {
    const accessToken = await getAccessToken();
    const list = await getReadyJson(`${MODEL_URL}/${urn}/metadata`, accessToken);
    const views = list?.data?.metadata || [];
    if (views.length === 0) {
        throw new ModelNotReadyError('This model has no views yet. APS may still be translating it.');
    }
    const view = views.find(v => v.role === '3d' && v.isMasterView) || views.find(v => v.role === '3d');
    if (!view) {
        // Only 2D views (e.g. a DWG drawing): there are no model elements to ask about,
        // and APS would answer "still processing" forever if we waited for them.
        throw new UnsupportedModelError('This model has no 3D view, so there are no elements to ask about. The assistant works with 3D models such as Revit files.');
    }
    return view.guid;
}

// Downloads everything we need about one model view:
//   - properties: a flat list of every object with its property groups
//   - tree:       the hierarchy (Category > Family > Type > Element)
async function fetchModelData(urn, guid) {
    const accessToken = await getAccessToken();
    const base = `${MODEL_URL}/${urn}/metadata/${guid}`;

    // The two downloads don't depend on each other, so Promise.all starts
    // both at the same time instead of waiting for one to finish first.
    const [properties, tree] = await Promise.all([
        getReadyJson(`${base}/properties?forceget=true`, accessToken),
        getReadyJson(base, accessToken)
    ]);

    return {
        // `?.` means "if this is missing, give undefined instead of crashing";
        // `|| []` then turns undefined into an empty list.
        collection: properties?.data?.collection || [],
        tree
    };
}

module.exports = {
    AUTH_URL, MODEL_URL, TOKEN_REFRESH_BUFFER_MS, token, requestNewToken, getAccessToken,
    getReadyJson, findMainViewGuid, fetchModelData
};

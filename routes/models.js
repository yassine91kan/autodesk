const express = require('express');
const formidable = require('express-formidable');
const { listObjects, uploadObject, translateObject, getManifest, urnify } = require('../services/aps.js');
const { forgetModel } = require('../augmented/store');

let router = express.Router();

// The sample models guests see, with the names shown in the app (in this order). Signed-in
// users see every model in the bucket, but never files that aren't models (a stray .js).
const SAMPLES = [
    [/^rstbasicsampleproject\.rvt$/i, 'Structural sample'],
    [/^Seaport-Civic-Center_Architecture\.rvt$/i, 'Seaport Civic Center (architecture)'],
    [/^Snowdon Towers Sample Architectural\.rvt$/i, 'Snowdon Towers (architecture)']
];
const MODEL_FILE = /\.(rvt|rfa|ifc|nwd|nwc|dwg|dwf|dwfx|fbx|obj|step|stp|iam|ipt|sldprt|zip)$/i;

// objects: [{ objectKey, objectId }] from the bucket -> what this user's dropdown lists.
function visibleModels(objects, kind) {
    const label = name => SAMPLES.find(([pattern]) => pattern.test(name))?.[1] || null;
    const models = objects
        .filter(o => MODEL_FILE.test(o.objectKey))
        .map(o => ({ name: o.objectKey, label: label(o.objectKey), urn: urnify(o.objectId) }));
    if (kind !== 'guest') return models;
    return models
        .filter(m => m.label)
        .sort((a, b) => SAMPLES.findIndex(([p]) => p.test(a.name)) - SAMPLES.findIndex(([p]) => p.test(b.name)));
}

router.get('/api/models', async function (req, res, next) {
    try {
        const objects = await listObjects();
        res.json(visibleModels(objects, req.user?.kind || 'member'));
    } catch (err) {
        next(err);
    }
});

router.get('/api/models/:urn/status', async function (req, res, next) {
    try {
        const manifest = await getManifest(req.params.urn);
        if (manifest) {
            let messages = [];
            if (manifest.derivatives) {
                for (const derivative of manifest.derivatives) {
                    messages = messages.concat(derivative.messages || []);
                    if (derivative.children) {
                        for (const child of derivative.children) {
                            messages.concat(child.messages || []);
                        }
                    }
                }
            }
            res.json({ status: manifest.status, progress: manifest.progress, messages });
        } else {
            res.json({ status: 'n/a' });
        }
    } catch (err) {
        next(err);
    }
});

router.post('/api/models', formidable(), async function (req, res, next) {
    const file = req.files['model-file'];
    if (!file) {
        res.status(400).send('The required field ("model-file") is missing.');
        return;
    }
    try {
        const obj = await uploadObject(file.name, file.path);
        await translateObject(urnify(obj.objectId), req.fields['model-zip-entrypoint']);
        // Same file name = same urn: drop the old version's saved index, so the next
        // question indexes the new one (augmented/store.js).
        forgetModel(urnify(obj.objectId));
        res.json({
            name: obj.objectKey,
            urn: urnify(obj.objectId)
        });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
module.exports.visibleModels = visibleModels;
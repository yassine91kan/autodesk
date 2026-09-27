const fs = require('fs');
const axios = require('axios');
const { APS_CLIENT_ID, APS_CLIENT_SECRET, APS_BUCKET } = require('../config.js');

let internalToken = null;
let publicToken = null;
let internalTokenExp = 0;
let publicTokenExp = 0;

const service = module.exports = {};

// ====================
// AUTH (OAuth v2, Base64)
// ====================

async function authenticate(scopes) {
    const basicAuth = Buffer.from(`${APS_CLIENT_ID}:${APS_CLIENT_SECRET}`).toString('base64');

    const res = await axios.post(
        'https://developer.api.autodesk.com/authentication/v2/token',
        new URLSearchParams({
            grant_type: 'client_credentials',
            scope: scopes.join(' ')
        }),
        {
            headers: {
                Authorization: `Basic ${basicAuth}`,
                'Content-Type': 'application/x-www-form-urlencoded',
                Accept: 'application/json'
            }
        }
    );

    return res.data;
}

service.getInternalToken = async () => {
    const now = Date.now();

    if (internalToken && now < internalTokenExp) {
        return internalToken;
    }

    const data = await authenticate([
        'bucket:read',
        'bucket:create',
        'data:read',
        'data:write',
        'data:create'
    ]);

    internalToken = data.access_token;
    internalTokenExp = now + (data.expires_in - 60) * 1000;

    return internalToken;
};

service.getPublicToken = async () => {
    const now = Date.now();

    if (publicToken && now < publicTokenExp) {
        // console.log('Using cached public token',publicToken);
        return publicToken;
    }

    publicToken = null; // 👈 FORCE refresh

    // const data = await authenticate(['viewables:read']);

    const data = await authenticate(['data:read']);

    publicToken = data.access_token;
    publicTokenExp = now + (data.expires_in - 60) * 1000;

    // console.log('Using non - cached public token',publicToken);
    // console.log('Using non - cached public token expiry',publicTokenExp);

    return publicToken;
};

// ====================
// BUCKET
// ====================

service.ensureBucketExists = async (bucketKey) => {
    const token = await service.getInternalToken();

    try {
        await axios.get(
            `https://developer.api.autodesk.com/oss/v2/buckets/${bucketKey}/details`,
            { headers: { Authorization: `Bearer ${token}` } }
        );
    } catch (err) {
        if (err.response?.status === 404) {
            await axios.post(
                `https://developer.api.autodesk.com/oss/v2/buckets`,
                {
                    bucketKey,
                    policyKey: 'persistent'
                },
                {
                    headers: {
                        Authorization: `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    }
                }
            );
        } else {
            throw err;
        }
    }
};

// ====================
// OBJECTS
// ====================

service.listObjects = async () => {
    await service.ensureBucketExists(APS_BUCKET);
    const token = await service.getInternalToken();

    let objects = [];
    let startAt = null;

    do {
        const url = new URL(
            `https://developer.api.autodesk.com/oss/v2/buckets/${APS_BUCKET}/objects`
        );

        url.searchParams.append('limit', 64);
        if (startAt) url.searchParams.append('startAt', startAt);

        const res = await axios.get(url.toString(), {
            headers: { Authorization: `Bearer ${token}` }
        });

        objects = objects.concat(res.data.items);
        startAt = res.data.next
            ? new URL(res.data.next).searchParams.get('startAt')
            : null;

    } while (startAt);

    return objects;
};

service.uploadObject = async (objectName, filePath) => {
    await service.ensureBucketExists(APS_BUCKET);
    const token = await service.getInternalToken();

    const buffer = await fs.promises.readFile(filePath);

    const res = await axios.put(
        `https://developer.api.autodesk.com/oss/v2/buckets/${APS_BUCKET}/objects/${objectName}`,
        buffer,
        {
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/octet-stream'
            }
        }
    );

    return res.data;
};

// ====================
// DERIVATIVES
// ====================

// service.translateObject = async (urn, rootFilename) => {
//     const token = await service.getInternalToken();

//     const job = {
//         input: { urn },
//         output: {
//             formats: [{ type: 'svf', views: ['2d', '3d'] }]
//         }
//     };

//     if (rootFilename) {
//         job.input.compressedUrn = true;
//         job.input.rootFilename = rootFilename;
//     }

//     const res = await axios.post(
//         `https://developer.api.autodesk.com/modelderivative/v2/designdata/job`,
//         job,
//         {
//             headers: {
//                 Authorization: `Bearer ${token}`,
//                 'Content-Type': 'application/json'
//             }
//         }
//     );

  

//     return res.data;
// };

service.translateObject = async (urn, rootFilename) => {
    const token = await service.getInternalToken();

    const job = {
        input: { urn },
        output: {
            formats: [{ type: 'svf', views: ['2d', '3d'] }]
        }
    };

    if (rootFilename) {
        job.input.compressedUrn = true;
        job.input.rootFilename = rootFilename;
    }

    try {
        const res = await axios.post(
            'https://developer.api.autodesk.com/modelderivative/v2/designdata/job',
            job,
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        console.log("🔥 TRANSLATE RESPONSE:", res.data); // IMPORTANT

        return res.data;

    } catch (err) {
        console.log("❌ TRANSLATE ERROR STATUS:", err.response?.status);
        console.log("❌ TRANSLATE ERROR DATA:", err.response?.data);
        throw err;
    }
};
// service.getManifest = async (urn) => {
//     const token = await service.getInternalToken();

//     try {
//         const res = await axios.get(
//             `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/manifest`,
//             {
//                 headers: {
//                     Authorization: `Bearer ${token}`
//                 }
//             }
//         );

//         // const manifest = await service.getManifest(urn);
//         // console.log(manifest);

//          // 👇 ADD THIS


//         return res.data;
//     } catch (err) {
//         if (err.response?.status === 404) {
//             return null;
//         } else {
//             throw err;
//         }
//     }
// };

service.getManifest = async (urn) => {
    const token = await service.getInternalToken();

    try {
        const res = await axios.get(
            `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/manifest`,
            {
                headers: {
                    Authorization: `Bearer ${token}`
                }
            }
        );

        // console.log("MANIFEST SUCCESS:", res.data);
        return res.data;

    } catch (err) {
        console.log("MANIFEST ERROR STATUS:", err.response?.status);
        console.log("MANIFEST ERROR DATA:", err.response?.data);

        return null; // keep simple for now
    }
};

// ====================
// UTIL
// ====================

service.urnify = (id) =>
    Buffer.from(id).toString('base64').replace(/=/g, '');
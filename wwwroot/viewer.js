/// import * as Autodesk from "@types/forge-viewer";

import './extensions/LoggerExtension.js';
import './extensions/SummaryExtension.js';
import './extensions/HistogramExtension.js';

// async function getAccessToken(callback) {
//     try {
//         const resp = await fetch('/api/auth/token');
//         if (!resp.ok) {
//             throw new Error(await resp.text());
//         }
//         // console.log('Access token obtained successfully');
//         // const { access_token, expires_in } = await resp.json();
//         // // callback(access_token, expires_in);

//         // console.log("TOKEN:", access_token);
//         // console.log("EXPIRES_IN:", expires_in);

//         // callback(access_token, Number(expires_in));

//         // const resp = await fetch('/api/auth/token');
//         const token = await resp.text(); // 👈 IMPORTANT FIX

//          console.log("TOKEN:", token);

//          callback(token, 3600);

//     } catch (err) {
//         alert('Could not obtain access token. See the console for more details.');
//         console.error(err);
//     }
// }

async function getAccessToken(callback) {
    const resp = await fetch('/api/auth/token');
    const data = await resp.json();

    let token;
    let expires = 3600;

    // 🔥 HANDLE STRING RESPONSE
    if (typeof data === 'string') {
        token = data;
    } else {
        token = data.access_token;
        expires = data.expires_in;
    }

    // console.log("FINAL TOKEN:", token);

    callback(token, expires);
}


export function initViewer(container) {
    return new Promise(function (resolve, reject) {
        Autodesk.Viewing.Initializer({ getAccessToken }, function () {
            const config = {
                extensions: ['Autodesk.DocumentBrowser','LoggerExtension','SummaryExtension','HistogramExtension']
            };
            const viewer = new Autodesk.Viewing.GuiViewer3D(container, config);
            viewer.start();
            viewer.setTheme('light-theme');
            resolve(viewer);
        });
    });
}

export function loadModel(viewer, urn) {
    return new Promise(function (resolve, reject) {
        function onDocumentLoadSuccess(doc) {
            resolve(viewer.loadDocumentNode(doc, doc.getRoot().getDefaultGeometry()));
        }
        function onDocumentLoadFailure(code, message, errors) {
            console.log('urn:' + urn);
            reject({ code, message, errors });
        }
        viewer.setLightPreset(0);
        Autodesk.Viewing.Document.load('urn:' + urn, onDocumentLoadSuccess, onDocumentLoadFailure);
    });
}

//Added code for the Logger Extension
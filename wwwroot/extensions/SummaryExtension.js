import { BaseExtension } from './BaseExtension.js';
import { SummaryPanel } from './SummaryPanel.js';
// import { OpenAI } from '../../node_modules/openai/index.mjs';
// const  OpenAIApi = require('openai');



//Property Names

// import { ChatOpenAI } from "langchain/chat_models/openai";

const SUMMARY_PROPS = ['Length', 'Area', 'Volume', 'Density', 'Mass', 'Price'];

class SummaryExtension extends BaseExtension {
    constructor(viewer, options) {
        super(viewer, options);
        this._button = null;
        this._panel = null;
    }

    load() {
        super.load();
        console.log('SummaryExtension loaded.');

        // Code goes here

        // const openai = new OpenAI({
        //     organization: 'org-hY3ebtVlOfD56J3IBx5a2xgo',apiKey: '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'
        //   });

            
        //     async function main() {
        //     const completion = await openai.chat.completions.create({
        //         messages: [{ role: "system", content: "You are a helpful assistant." }],
        //         model: "gpt-3.5-turbo",
        //     });

        //     console.log(completion.choices[0]);
        //     }

        //     main();

        //

        function openaiquery() {

            let access_token="";

            let query = {
                "model": "gpt-3.5-turbo",
                "messages": [{"role": "user", "content": "Say this is a test!"}],
                "temperature": 0.7
    
            };

            fetch(`https://api.openai.com/v1/chat/completions`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${access_token}`,
                    'Content-Type': 'application/json'
                },
                body:JSON.stringify(query)
            })
            .then(response => response.json())
            .then(data => {
                console.log("GPT Response:", data);

                document.getElementById("analytics").text="New"
            })
            .catch(error => {
                console.error("Error retrieving object tree:", error);
            });
        }


        // openaiquery()


        return true;
    }

    unload() {
        super.unload();
        if (this._button) {
            this.removeToolbarButton(this._button);
            this._button = null;
        }
        if (this._panel) {
            this._panel.setVisible(false);
            this._panel.uninitialize();
            this._panel = null;
        }
        console.log('SummaryExtension unloaded.');
        return true;
    }

    onToolbarCreated() {
        this._panel = new SummaryPanel(this, 'model-summary-panel', 'Model Summary');
        this._button = this.createToolbarButton('summary-button', 'https://img.icons8.com/small/32/brief.png', 'Show Model Summary');
        this._button.onClick = () => {
            this._panel.setVisible(!this._panel.isVisible());
            this._button.setState(this._panel.isVisible() ? Autodesk.Viewing.UI.Button.State.ACTIVE : Autodesk.Viewing.UI.Button.State.INACTIVE);
            if (this._panel.isVisible()) {
                this.update();
            }
        };
    }

    onModelLoaded(model) {
        super.onModelLoaded(model);
        this.update();

        console.log("I am trying here buddy");

        function queryModelMetadata(urn, access_token) {
            fetch(`https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/metadata`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${access_token}`
                }
            })
            .then(response => response.json())
            .then(data => {
                console.log("Metadata:", data);
                // Continue with retrieving an object tree or properties
            })
            .catch(error => {
                console.error("Error querying model's metadata:", error);
            });
        }


        function retrieveObjectTree(urn, guid, access_token) {
            fetch(`https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/metadata/${guid}`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${access_token}`
                }
            })
            .then(response => response.json())
            .then(data => {
                console.log("Object Tree:", data);
            })
            .catch(error => {
                console.error("Error retrieving object tree:", error);
            });
        }

        let query = {
           
            "query": {
                "$contains": [
                    "properties.Materials and Finishes.Structural Material",
                    "Concrete"
                ]
            },
            "fields": [
                "objectid",
                "name",
                "externalId",
                "properties.Materials and Finishes"
            ],
            "pagination": {
                "offset": 30,
                "limit": 30
            },
            "payload": "text"

        };

        console.log(JSON.stringify(query))

        function queryModel(urn, guid, access_token) {
            fetch(`https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/metadata/${guid}/properties:query`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${access_token}`,
                    'Content-Type': 'application/json'
                },
                body:JSON.stringify(query)
            })
            .then(response => response.json())
            .then(data => {
                console.log("Object Tree:", data);
            })
            .catch(error => {
                console.error("Error retrieving object tree:", error);
            });
        }


//
        const client_id = 'fQPtGtGD67GG4gVubAGeIvjPXUsuOimS';
        const client_secret = 'Wrwo4ROxNFlfrYmG';
        const credentials = `client_id=${client_id}&client_secret=${client_secret}&grant_type=client_credentials&scope=data:read`;

        fetch('https://developer.api.autodesk.com/authentication/v1/authenticate', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: credentials
        })
        .then(response => response.json())
        .then(data => {
        const access_token = data.access_token;
        console.log("You access token is :");    
        console.log(access_token);
         // Proceed to query the model's metadata
         let urn = "dXJuOmFkc2sub2JqZWN0czpvcy5vYmplY3Q6ZnFwdGd0Z2Q2N2dnNGd2dWJhZ2VpdmpweHVzdW9pbXMtYmFzaWMtYXBwL3JzdGJhc2ljc2FtcGxlcHJvamVjdC5ydnQ";
         let guid = "2b8b1cf8-31bf-7e71-dfb5-e1d4342ddb82";
        //  queryModelMetadata(urn,access_token)
        // retrieveObjectTree(urn, guid, access_token)
        queryModel(urn, guid, access_token)

        })
        .catch(error => {
            console.error("Error authenticating:", error);
        });

        // Metadata EndPoint    
        



//

    }

    onSelectionChanged(model, dbids) {
        super.onSelectionChanged(model, dbids);
        this.update();
    }

    onIsolationChanged(model, dbids) {
        super.onIsolationChanged(model, dbids);
        this.update();
    }
//Logic once the viewer is updated
    async update() {
        if (this._panel) {
            const selectedIds = this.viewer.getSelection();
            const isolatedIds = this.viewer.getIsolatedNodes();
        // Added Code 

     

        //




            if (selectedIds.length > 0) { // If any nodes are selected, compute the aggregates for them
                this._panel.update(this.viewer.model, selectedIds, SUMMARY_PROPS);
            } else if (isolatedIds.length > 0) { // Or, if any nodes are isolated, compute the aggregates for those
                this._panel.update(this.viewer.model, isolatedIds, SUMMARY_PROPS);
            } else { // Otherwise compute the aggregates for all nodes
                const dbids = await this.findLeafNodes(this.viewer.model);
                this._panel.update(this.viewer.model, dbids, SUMMARY_PROPS);
            }
        }
    }
}

Autodesk.Viewing.theExtensionManager.registerExtension('SummaryExtension', SummaryExtension);
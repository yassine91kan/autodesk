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
     

        // console.log("Fetch Call from the Summary Extension");

        // let prompt = "Select the elements that are made of steel";


        // fetch(`/openaifunc`, {
        //     method: 'POST',
        //     headers: {
        //         'Content-Type': 'application/json'
        //     },
        //     body:JSON.stringify({"prompt":prompt})
        // })
        // .then(response => response.json())
        // .then(data => {

        //     let objectids=[];

        //     for (let i = 0; i < data.message.length; i++) {
        //         objectids.push(data.message[i].objectid);
        //       }

        //     console.log(objectids);

        //     console.log(data.message);
    
        //     console.log(data.message[0]);
        //     console.log(typeof data.message[0].objectid);

        //     this.viewer.select(objectids);

        //     console.log(document.getElementById('fname').value);


        //     // this.viewer.isolate(objectids);
        //     // document.getElementById('analyticss').innerHTML=JSON.stringify(data.message);
    
        // })
        // .catch(error => {
        //     console.error("Error retrieving object tree:", error);
        //     // res.json({success: false, message: "You are unsuccessful"})
        // });


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
                // added code
            //
            }  else if(document.getElementById('fname').value) {
                // Added Code

                let prompt = document.getElementById('fname').value;


                    fetch(`/openaifunc`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body:JSON.stringify({"prompt":prompt})
                    })
                    .then(response => response.json())
                    .then(data => {

                        let objectids=[];

                        for (let i = 0; i < data.message.length; i++) {
                            objectids.push(data.message[i].objectid);
                        }

                        console.log(objectids);

                        console.log(data.message);
                
                        console.log(data.message[0]);
                        console.log(typeof data.message[0].objectid);

                        this.viewer.select(objectids); 
                    })
                    .catch(error => {
                        console.error("Error retrieving object tree:", error);
                        // res.json({success: false, message: "You are unsuccessful"})
                    });        

                //
            } else { // Otherwise compute the aggregates for all nodes
                const dbids = await this.findLeafNodes(this.viewer.model);
                this._panel.update(this.viewer.model, dbids, SUMMARY_PROPS);
            }
        }
    }
}

Autodesk.Viewing.theExtensionManager.registerExtension('SummaryExtension', SummaryExtension);
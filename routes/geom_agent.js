const express = require('express');
const { OPENAIKEY, APS_CLIENT_ID, APS_CLIENT_SECRET } = require('../config.js');
// import OpenAI from "openai";
const OpenAI = require('openai');
// Langchain Imports
const { ChatOpenAI } = require("@langchain/openai");
const { TavilySearchResults } = require ("@langchain/community/tools/tavily_search") ;
const { AgentExecutor, createOpenAIFunctionsAgent } = require("langchain/agents");
const { pull } = require("langchain/hub");
const { ChatPromptTemplate, MessagesPlaceholder } = require ("@langchain/core/prompts");
const { DynamicTool } = require("@langchain/core/tools");
const { DynamicStructuredTool } = require("@langchain/core/tools") ;
const axios = require("axios");
const { z } = require('zod');



let router = express.Router();

let access_token;
let resp_forge;
let tokenExpirationTime;
let metadata_ask;
let propertiesList;
let objid_coord ;
let token;
let completionTokens=0;
let promptTokens=0;
let geomType ;

const openai = new OpenAI({
    apiKey: OPENAIKEY
  });

// Proceed to query the model's metadata
let urn = "dXJuOmFkc2sub2JqZWN0czpvcy5vYmplY3Q6ZnFwdGd0Z2Q2N2dnNGd2dWJhZ2VpdmpweHVzdW9pbXMtYmFzaWMtYXBwL3JzdGJhc2ljc2FtcGxlcHJvamVjdC5ydnQ";
let guid = "2b8b1cf8-31bf-7e71-dfb5-e1d4342ddb82";


async function authenticate(){

    const body = new URLSearchParams();
    body.append('grant_type', 'client_credentials');
    body.append('scope', 'data:read');

    const concatword = APS_CLIENT_ID + ":" + APS_CLIENT_SECRET;
    const cred_encod = btoa(concatword);

    try {
        const response = await fetch('https://developer.api.autodesk.com/authentication/v2/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': 'Basic ' + cred_encod
            },
            body: body
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        console.log('Basic ' + cred_encod);
        console.log(data);
        tokenExpirationTime = Date.now() + data.expires_in * 1000;

        return data.access_token;
    } catch (error) {
        console.error('Error:', error);
        throw error; // rethrow the error if needed
    }

}

async function getAccessToken() {
    if (!access_token || Date.now() >= tokenExpirationTime) {
        return await authenticate();
    }

    console.log("access Token is the same");

    return access_token;
}

//getmodel metadata

async function getModelMetadata(urn, guid, access_token) {
    const response = await axios.get(`https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/metadata/${guid}/properties`, {
        headers: {
            'Authorization': `Bearer ${access_token}`
        }
    });
    return response.data;

}


const propertiesUnique = [];

function extractProperties(data) {
    const propertiesList = [];
    const uniquePaths = new Set();

  
    data.forEach((item, index) => {
      const { objectid, name, properties } = item;
      for (const [propertyCategory, propertyDetails] of Object.entries(properties)) {
        if (Object.keys(propertyDetails).length > 0) {
          for (const subDetail of Object.keys(propertyDetails)) {
            const path = `${propertyCategory}.${subDetail}`;
            if (!uniquePaths.has(path)) {
              uniquePaths.add(path);
              propertiesList.push({ objectid, name, path });
              propertiesUnique.push(subDetail);

            }
          }
        } else {
          const path = `${propertyCategory}`;
          if (!uniquePaths.has(path)) {
            uniquePaths.add(path);
            propertiesList.push({ objectid, name, path });
            propertiesUnique.push(propertyCategory);


          }
        }
      }
    });
  
    return propertiesList;
  }

  let uniqueNames;

  function getUniqueNames(data) {
    // Extract names from the collection and store them in a set to ensure uniqueness
    const uniqueNamesSet = new Set();
  
    data.collection.forEach(item => {
      if (item.name) {
        uniqueNamesSet.add(item.name.toLowerCase().split("[")[0]);
      }
    });
  
    // Convert the set back to an array
    return Array.from(uniqueNamesSet);
  }
  
//



let resultGeometry ;

router.get('/geom_agent', async function (req, res, next) {

    res.json({success: true, message: objid_coord,geomtype:geomType});
 
 });

 router.put('/geom_agent', async function (req, res, next) {

    // console.log(req.body);

    objid_coord = req.body ; 

    console.log(objid_coord["2442"])

    res.json({success: true, message:objid_coord});
 
 });

router.post('/geom_agent', async function (req, res, next) {

    // console.log(objid_coord);

    if (req.body.prompt.includes("solar")){

            geomType="solar_panel";
            console.log(geomType);
    }

    else if(req.body.prompt.includes("wind")){

        geomType="wind_turbine";
        console.log(geomType);

    }

    else if(req.body.prompt.includes("barrier")){

        geomType="barrier";
        console.log(geomType);
    }

    else if(req.body.prompt.includes("wash")){

        geomType="wash_station";
        console.log(geomType);
    }

    const access_token = await getAccessToken();

    if(!metadata_ask){

        metadata_ask = await getModelMetadata(urn, guid, access_token);
        propertiesList = extractProperties(metadata_ask.data.collection);
        uniqueNames = getUniqueNames(metadata_ask.data);
        console.log("I am here AUTH again");
        console.log(uniqueNames);
        console.log(metadata_ask);

    }

    // console.log(metadata_ask);
    // console.log(uniqueNames);

    console.log("The corresponding name to beam is ");

    console.log(uniqueNames.filter(name => name.includes("beam"))) ;

    let path_property ="";
    
    async function querymodel(material, path_property){

        const query = {
            "query": {
                "$contains": [
                    `properties.${path_property}`,
                    material
                ]
            },
            // Other query fields
            "fields":[
                "objectid",
                "name",
                // `properties.${path_property}`
            ]
        };


        console.log("These are the properties with paths.");
        console.log(propertiesList.length);


        const response = await axios.post(`https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/metadata/${guid}/properties:query`, query, {
        headers: {
            'Authorization': `Bearer ${access_token}`,
            'Content-Type': 'application/json'
        }
        });

        resultGeometry =response.data.data.collection;

        return JSON.stringify(response.data.data.collection);

    }

    async function querymodel_type(type){

        const query = {
            "query": {
                "$prefix": [
                    "name",
                    `${type}`
                ]
            },
            // Other query fields
            "fields":[
                "objectid",
                "name",
            ]
        };

        const response = await axios.post(`https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/metadata/${guid}/properties:query`, query, {
        headers: {
            'Authorization': `Bearer ${access_token}`,
            'Content-Type': 'application/json'
        }
        });

        console.log(response.data.data.collection);

        resultGeometry =response.data.data.collection;

        return JSON.stringify(response.data.data.collection);

    }

    const customTool = new DynamicStructuredTool({
        name: "SearchElement",
        description: "Searches the object in the model using a specific property and its corresponding value. example would be the property is material and value is steel. the function has two mandatory parameters property and value",
        schema: z.object({
            property: z.string().describe("the property to be used for querying the model"),
            value: z.string().describe("the value to be used for querying the model. Use Tavily search for unusual values"),
          }),       
        func: async ({ property, value }) => {
            try {
                if (!property || !value) {
                    console.log(property);
                    console.log(value);
                    throw new Error("Both property and value must be provided.");
                }

                const matchingValuesAndIndices = propertiesUnique.reduce((acc, element, index) => {
                    if (element.toLowerCase().includes(property.toLowerCase())) {
                        acc.push({ value: element, index: index });
                    }
                    return acc;
                }, []);

                if (matchingValuesAndIndices.length > 0) {
                    console.log(`Elements containing "${property}" (case-insensitive) along with their indices are:`, matchingValuesAndIndices[0].value);
                    console.log(`The Length of matching elements is "${matchingValuesAndIndices.length}"`);
                    // console.log(`The index of this element in the properties is "${matchingValuesAndIndices[0].index}"`);                  
                    console.log(`This element from the properties list is "${propertiesList[matchingValuesAndIndices[0].index].path}"`);
                    path_property= propertiesList[matchingValuesAndIndices[0].index].path;
                    console.log(path_property);

                } else {
                    console.log(`No element containing "${property}" (case-insensitive) is in the array.`);
                }

                // return await querymodel( value.trim(), property.trim(),);
                return await querymodel( value.trim(), path_property);
            } catch (error) {
                console.error("Error in customTool function:", error);
                return `Error: ${error.message}`;
            }
        }
    });

    
    const customTool_2 = new DynamicStructuredTool({
        name: "SearchElement_Type",
        description: "Searches the objects in the model using a specific type of the elements. example would be door, wall ...",
        schema: z.object({
            type: z.string().describe("the type of elements to be used for querying the model "),
            
        }),       
        func: async (type) => {
            try {
                if ( !type) {
                    console.log(type);
                      throw new Error("The object ID of element must be specified.");
                }

                return await querymodel_type(type.type);
            } catch (error) {
                console.error("Error in customTool function:", error);
                return `Error: ${error.message}`;
            }
        }
    });


    // const customTool_3 = new DynamicStructuredTool({
    //     name: "SearchElem_Coordinate",
    //     description: "Searches the Coordinates of objects in the model using an objectID",
    //     schema: z.object({
    //         type: z.string().describe("the objectID of elements to be used for getting the coordinates use a number only without type"),
            
    //     }),       
    //     func: async (id) => {
    //         try {
    //             if (!objid_coord[id.type].elementCent) {
    //                 console.log(id);
    //                   throw new Error("The objectid of element must be specified.");
    //             }

                
    //             console.log("I am here");
    //             console.log(id.type)

    //             console.log("The objectid of elements specified is : ");

    //            return  JSON.stringify(objid_coord[id.type].elementCent) ;

    //         } catch (error) {
    //             console.error("Error in customTool function:", error);
    //             return `Error: ${error.message}`;
    //         }
    //     }
    // });


    const customTool_4 = new DynamicStructuredTool({
        name: "Add_Object_Model",
        description: "Add geometries to objects in the model based on ObjectIDs",
        schema: z.object({
            type: z.string().describe("The IDs of the objects for which the addition is requested.  "),
            
        }),       
        func: async (id) => {
            try {
                if (!id) {
                    console.log(id.type);
                      throw new Error("The objectid of element must be specified.");
                }

                let uniqueNamearray = id.type;
                objid_coord=id.type;

               
              return  uniqueNamearray ;

            //    return "The coordinates are : x=4, y=10, z=20";

            } catch (error) {
                console.error("Error in customTool function:", error);
                return `Error: ${error.message}`;
            }
        }
    });
  
    const tools = [customTool, customTool_2,customTool_4];



    const llm = new ChatOpenAI({
        // modelName: "gpt-3.5-turbo-1106",
        modelName: "gpt-4o-mini",      
        temperature: 0,
        apiKey: OPENAIKEY,
        callbacks: [
            {
              handleLLMEnd(output) {
                
                // Directly access the token usage values from the output object
                completionTokens = completionTokens + output.llmOutput.tokenUsage.completionTokens;
                promptTokens = promptTokens + output.llmOutput.tokenUsage.promptTokens;
                

                // Store the tokens in variables if needed
                token = {
                    completionTokens,
                    promptTokens
                };

                // If you need to store it as a string
                const tokenString = JSON.stringify(token, null, 2);
                console.log(tokenString);

                
              },
            },
          ],
      });


      const prompt = ChatPromptTemplate.fromMessages([
        ["system", "You are a very powerful assistant that can help me add geometries to objects in the 3D model. For example you can be requested to add a box,solar panel, wind turbine, barrier, wash station to each wall, floor, door .."],
        ["human", "{input}"],
        new MessagesPlaceholder("agent_scratchpad")
      ]);
 

    const agent = await createOpenAIFunctionsAgent({
        llm,
        tools,
        prompt

    });

    const agentExecutor = new AgentExecutor({
        agent,
        tools,
        // verbose:true,
        // returnIntermediateSteps: true,
        
        
    });


    const results = await agentExecutor.invoke({
        input:req.body.prompt
    })


    res.json({success: true, message: results.output, token:token});

    //Stream The response using the Log


  
 });

module.exports = router;
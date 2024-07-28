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

const openai = new OpenAI({
    apiKey: OPENAIKEY
  });

// Proceed to query the model's metadata
let urn = "dXJuOmFkc2sub2JqZWN0czpvcy5vYmplY3Q6ZnFwdGd0Z2Q2N2dnNGd2dWJhZ2VpdmpweHVzdW9pbXMtYmFzaWMtYXBwL3JzdGJhc2ljc2FtcGxlcHJvamVjdC5ydnQ";
let guid = "2b8b1cf8-31bf-7e71-dfb5-e1d4342ddb82";

// async function authenticate(){

//     const credentials = `client_id=${APS_CLIENT_ID}&client_secret=${APS_CLIENT_SECRET}&grant_type=client_credentials&scope=data:read`;
//     const response = await axios.post('https://developer.api.autodesk.com/authentication/v1/authenticate', credentials, {
//     headers: {
//         'Content-Type': 'application/x-www-form-urlencoded'
//     }
// });
//     return response.data.access_token;

// }

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

        return data.access_token;
    } catch (error) {
        console.error('Error:', error);
        throw error; // rethrow the error if needed
    }

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

//

  
//   function extractProperties(data) {
//     const propertiesList = [];
  
//     data.forEach((item, index) => {
//       const { objectid, name, properties } = item;
//       for (const [propertyCategory, propertyDetails] of Object.entries(properties)) {
//         propertiesList.push({
//           objectid,
//           name,
//           path: `object ${index + 1} -> properties -> ${propertyCategory} ->${propertyDetails}`
//         });
//       }
//     });
  
//     return propertiesList;
//   }

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
  
//

router.post('/ask_agent_simple', async function (req, res, next) {

    const access_token = await authenticate();

    const metadata_ask = await getModelMetadata(urn, guid, access_token);

    const propertiesList = extractProperties(metadata_ask.data.collection);

    let path_property ="";
    
    async function querymodel(material, path_property,){

        const query = {
            "query": {
                "$contains": [
                    // "properties.Materials and Finishes.Structural Material",
                    `properties.${path_property}`,
                    material
                ]
            },
            // Other query fields
            "fields":[
                "name",
                `properties.${path_property}`
            ]
        };


        console.log("These are the properties with paths.")
        // console.log(propertiesList);
        console.log(propertiesList.length);
        // console.log(propertiesUnique);

        const response = await axios.post(`https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/metadata/${guid}/properties:query`, query, {
        headers: {
            'Authorization': `Bearer ${access_token}`,
            'Content-Type': 'application/json'
        }
        });
        return JSON.stringify(response.data.data.collection);

    }



    const customTool = new DynamicStructuredTool({
        name: "SearchElement",
        description: "Searches the objects in the model using a specific property and its corresponding value. example would be the property is material and value is steel. the function has two mandatory parameters property and value",
        schema: z.object({
            property: z.string().describe("the property to be used for querying the model"),
            value: z.string().describe("the value to be used for querying the model"),
          }),       
        func: async ({ property, value }) => {
            try {
                if (!property || !value) {
                    console.log(property);
                    console.log(value);
                    throw new Error("Both property and value must be provided.");
                }

                // const matchingValues = propertiesUnique.filter(element => 
                //     element.toLowerCase().includes(property.toLowerCase())
                // );
                
                // if (matchingValues.length > 0) {
                //     console.log(`Elements containing "${property}" (case-insensitive) are:`, matchingValues);
                // } else {
                //     console.log(`No element containing "${property}" (case-insensitive) is in the array.`);
                // }

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

    
    const customTool_2 = new DynamicTool({
        name: "get_word_length",
        description: "Returns the length of a word.",
        func: async (input) => input.length.toString(),
      });
  
    const tools = [customTool, customTool_2, new TavilySearchResults({ maxResults: 1, apiKey:"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" })];



    const llm = new ChatOpenAI({
        // modelName: "gpt-3.5-turbo-1106",
        modelName: "gpt-4o-mini",      
        temperature: 0,
        apiKey: OPENAIKEY
      });

    // const prompt = await pull(
    //     "hwchase17/openai-functions-agent"
    //   );

    //   const prompt = ChatPromptTemplate.fromMessages([
    //     ["system", "You are very powerful assistant, but don't know current events"],
    //     ["human", "{input}"],
    //     new MessagesPlaceholder("agent_scratchpad"),
    //   ]);

      const prompt = ChatPromptTemplate.fromMessages([
        ["system", "You are a very powerful assistant that can derive specific properties and its corresponding values from a given prompt to query a model. Identify the property and its corresponding value from the user's input"],
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
        // verbose:true
        // returnIntermediateSteps: true,
        
        
    });


    const results = await agentExecutor.invoke({
        input:req.body.prompt
    })

    // for await (const chunk of results){
    //     console.log(JSON.stringify(chunk, null, 2));
    //     console.log("------");
    //     // res.json({success: true, message: JSON.stringify(chunk, null, 2)});
    //     res.write(JSON.stringify(chunk, null, 2));

    // }

    // res.end();

    // console.log(results);

    // console.log(JSON.stringify(results, null, 2));


    res.json({success: true, message: results.output});

  
 });

module.exports = router;
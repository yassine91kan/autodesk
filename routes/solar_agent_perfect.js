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

let resultPower ;
let longitude ;
let latitude;
 

router.get('/solar_agent', async function (req, res, next) {

    // res.json({success: true, message: objid_coord,geomtype:geomType});
 
 });

 router.put('/solar_agent', async function (req, res, next) {

    // console.log(req.body);

    // objid_coord = req.body ; 

    // console.log(objid_coord["2442"])

    // res.json({success: true, message:objid_coord});
 
 });

router.post('/solar_agent', async function (req, res, next) {

    let polygonCord ;
    let robotic;

 

    const customTool = new DynamicStructuredTool({
        name: "Add_Solar_Elements",
        description: "Add Solar Elements in the model based on the required power and single longitude and latitude value of the location",
        schema: z.object({
            power: z.string().describe("The power requested by the user"),
            long: z.string().describe("The longitude of the site"),
            lat:z.string().describe("The latitude of the site")
            // value: z.string().describe("the value to be used for querying the model. Use Tavily search for unusual values"),
          }),       
        func: async (power,long,lat) => {
            try {
                if (!power.power) {
                    console.log(power.power);
                    throw new Error("The power must be provided.");
                }

                console.log(power);

                resultPower= power.power;

                console.log(`I am here the result Power is ${resultPower}`);

                console.log(power.long);
                console.log(power.lat);



                longitude = power.long;
                latitude = power.lat;

                console.log(longitude);
                console.log(latitude);
                
                return power.power;
            } catch (error) {
                console.error("Error in customTool function:", error);
                return `Error: ${error.message}`;
            }
        }
    });

    const customTool_2 = new DynamicStructuredTool({
        name: "Add_Panel_property_line",
        description: "Add the panels based on the Property line polygon consisting of a set of longitudes and latitudes provided by the user",
        schema: z.object({
            coordinates: z.string().describe("The longitudes and latitudes representing the polygon"),
            // value: z.string().describe("the value to be used for querying the model. Use Tavily search for unusual values"),
          }),  
        func: async (coordinates) => {
            try {
                if (!coordinates) {
                    console.log(coordinates);
                    throw new Error("The coordinates must be provided");
                }

                polygonCord = coordinates.coordinates;

                console.log(`The coordinates check within the tool are ${polygonCord}`);
                
                return polygonCord;
            } catch (error) {
                console.error("Error in customTool function:", error);
                return `Error: ${error.message}`;
            }
        }
    });


    

    const tools = [customTool, customTool_2];



    const llm = new ChatOpenAI({
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
        ["system", "You are a very powerful assistant that can help me add solar panels to the model based on the power requested from the user input and a longitude latitude of the site or the property line made of a series of longitudes and latitudes. Use the tools. Do not use the unit in the power. Format the points of the polygon of property line in the tool as an array of objects containing longitudes and latitudes as the keys. "],
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

    console.log(typeof(longitude));

    console.log(`This is the longitude ${longitude}and ${latitude}`);


    res.json({success: true, message: results.output, token:token, power:resultPower,long:longitude, lat:latitude, coordinates:polygonCord });

    //Stream The response using the Log


  
 });

module.exports = router;
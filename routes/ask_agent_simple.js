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
const axios = require("axios");



let router = express.Router();

let access_token;

let resp_forge;

const openai = new OpenAI({
    apiKey: OPENAIKEY
  });

// Proceed to query the model's metadata
let urn = "dXJuOmFkc2sub2JqZWN0czpvcy5vYmplY3Q6ZnFwdGd0Z2Q2N2dnNGd2dWJhZ2VpdmpweHVzdW9pbXMtYmFzaWMtYXBwL3JzdGJhc2ljc2FtcGxlcHJvamVjdC5ydnQ";
let guid = "2b8b1cf8-31bf-7e71-dfb5-e1d4342ddb82";

async function authenticate(){

    const credentials = `client_id=${APS_CLIENT_ID}&client_secret=${APS_CLIENT_SECRET}&grant_type=client_credentials&scope=data:read`;
    const response = await axios.post('https://developer.api.autodesk.com/authentication/v1/authenticate', credentials, {
    headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
    }
});
    return response.data.access_token;

}

router.post('/ask_agent_simple', async function (req, res, next) {
    
    async function querymodel(material){

        const query = {
            "query": {
                "$contains": [
                    "properties.Materials and Finishes.Structural Material",
                    material
                ]
            },
            // Other query fields
            "fields":[
                "name",
                "properties.Materials and Finishes.Structural Material"
            ]
        };

        const access_token = await authenticate();

        const response = await axios.post(`https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/metadata/${guid}/properties:query`, query, {
        headers: {
            'Authorization': `Bearer ${access_token}`,
            'Content-Type': 'application/json'
        }
        });
        return JSON.stringify(response.data.data.collection);

    }


    const customTool= new DynamicTool ({
      name:"SearchElement",
      description:"searches the objects in the model that are made of a specific material",
      func:  async (input) => querymodel(input),

    });

    
    const customTool_2 = new DynamicTool({
        name: "get_word_length",
        description: "Returns the length of a word.",
        func: async (input) => input.length.toString(),
      });
  
    const tools = [customTool, customTool_2, new TavilySearchResults({ maxResults: 1, apiKey:"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" })];



    const llm = new ChatOpenAI({
        modelName: "gpt-3.5-turbo-1106",
        temperature: 0,
        apiKey: OPENAIKEY
      });

    // const prompt = await pull(
    //     "hwchase17/openai-functions-agent"
    //   );

      const prompt = ChatPromptTemplate.fromMessages([
        ["system", "You are very powerful assistant, but don't know current events"],
        ["human", "{input}"],
        new MessagesPlaceholder("agent_scratchpad"),
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
        returnIntermediateSteps: true,
        
        
    });

    // const results = await agentExecutor.invoke({
    //     input:req.body.prompt,
    //     //// returnIntermediateSteps: true

    // });

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
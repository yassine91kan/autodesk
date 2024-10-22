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


let token;
let completionTokens=0;
let promptTokens=0;
let geomType ;
let addressObj;

const openai = new OpenAI({
    apiKey: OPENAIKEY
  });


async function geocodeAddress(address) {
    const apiKey = "ee92de415a9747069da56179e723f4ba";
    const url = `https://api.opencagedata.com/geocode/v1/json?q=${encodeURIComponent(address)}&key=${apiKey}&limit=1`;

    try {
        const response = await fetch(url);
        const data = await response.json();

        if (data.results.length > 0) {
            const { lat, lng } = data.results[0].geometry;
            addressObj= { latitude: lat, longitude: lng };
            return { latitude: lat, longitude: lng };
        } else {
            throw new Error('Address not found');
        }
    } catch (error) {
        console.error(error);
        throw error;
    }
}

let resultGeometry ;

router.get('/design_agent', async function (req, res, next) {

    // res.json({success: true, message: objid_coord,geomtype:geomType});
 
 });

 router.put('/design_agent', async function (req, res, next) {


 
 });

router.post('/design_agent', async function (req, res, next) {

      
    const customTool = new DynamicStructuredTool({
        name: "Wind_loading_Calculator",
        description: "Calculates Wind Loading on a structure based on its location",
        schema: z.object({
            address: z.string().describe("The location where the structure is located "),
            
        }),       
        func: async (address) => {
            try {
                // if ( !address) {
                //     console.log(address);
                //       throw new Error("The address to be geocoded is missing");
                // }

                return JSON.stringify(await geocodeAddress(address.address));
            } catch (error) {
                console.error("Error in customTool function:", error);
                return `Error: ${error.message}`;
            }
        }
    });

 
    const tools = [customTool];

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
        ["system", "You are a very powerful assistant that can help me add geocode addresses. Use the tools provided."],
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
        verbose:true,
        // returnIntermediateSteps: true,
        
        
    });


    const results = await agentExecutor.invoke({
        input:req.body.prompt
    })


    res.json({success: true, message: results.output, token:token,addressObj:addressObj});

    //Stream The response using the Log


  
 });

module.exports = router;
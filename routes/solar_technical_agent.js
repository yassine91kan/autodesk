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

let soilLayer;
let soilDepth;
let soilFriction;

let totalCapacity;

const openai = new OpenAI({
    apiKey: OPENAIKEY
  });



let resultPower ;

router.get('/solar_technical_agent', async function (req, res, next) {

    // res.json({success: true, message: objid_coord,geomtype:geomType});
 
 });

 router.put('/solar_technical_agent', async function (req, res, next) {

 
 });

router.post('/solar_technical_agent', async function (req, res, next) {
 

    // const customTool = new DynamicStructuredTool({
    //     name: "Determine_Embedment",
    //     description: "Determine the embedment of piles based on the loading, number of soil layers, the depth of soil layers and the value of Skin Friction",
    //     schema: z.object({
    //         load: z.string().describe("load provided by the user"),
    //         soillayerNum: z.string().describe("Number of Soil Layer"),
    //         soillayerDepth: z.string().describe("Depth of Each Soil Layer"),
    //         soilskinFriction: z.string().describe("load provided by the user"),
            
    //       }),       
    //     func: async ({ load, soillayerNum, soillayerDepth, soilskinFriction }) => {
    //         try {
    //             if (!load) {
    //                 console.log(load);
    //                 // console.log(load);
    //                 throw new Error("The power must be provided.");
    //             }

    //             console.log({ load, soillayerNum, soillayerDepth, soilskinFriction });

    //             let resultCalc = parseInt(load)*parseInt(soillayerNum);

    //             let resultString = resultCalc.toString();
              
    //             return `The result is : ${resultString} meters`;

    //         } catch (error) {
    //             console.error("Error in customTool function:", error);
    //             return `Error: ${error.message}`;
    //         }
    //     }
    // });

    const customTool = new DynamicStructuredTool({
        name: "Determine_Embedment_Resistive_Force",
        description: "Determine the embedment of piles based on the loading, number of soil layers, the depth of soil layers and the value of Skin Friction",
        schema: z.object({
            load: z.string().describe("load provided by the user"),
            soillayerNum: z.string().describe("Number of Soil Layer"),
            soillayerDepth: z.string().describe("Depth of Each Soil Layer"),
            soilskinFriction: z.string().describe("load provided by the user"),
            
          }),       
        func: async ({ load, soillayerNum, soillayerDepth, soilskinFriction }) => {
            try {
                if (!load) {
                    console.log(load);
                    throw new Error("The power must be provided.");
                }

                let resultCalc=0;

                soilLayer = soillayerNum;
                soilDepth = soillayerDepth;
                soilFriction = soilskinFriction;

                for(let i=0;i<parseInt(soillayerNum);i++){
                    
                    resultCalc += parseInt(soillayerDepth)*parseInt(soilskinFriction)/1000;

                }

                console.log({ load, soillayerNum, soillayerDepth, soilskinFriction });            

                let resultString = resultCalc.toString();
              
                return `The available embedment resistive force is : ${resultString} kip`;

            } catch (error) {
                console.error("Error in customTool function:", error);
                return `Error: ${error.message}`;
            }
        }
    });

    const customTool_2 = new DynamicStructuredTool({
        name: "Design_Pile",
        description: "Calculate the capacity of steel section provided by the user based on loadings provided by the user",
        schema: z.object({
            loadAxial: z.string().describe("Axial load provided by the user, can be provided by the user as Px"),
            loadBendingStrong: z.string().describe("Bending load Moment for strong axis provided by the user, can be provided by the user as Mx"),
            loadBendingWeak: z.string().describe("Bending load Moment for weak axis provided by the user, can be provided by the user as My"),
            // value: z.string().describe("the value to be used for querying the model. Use Tavily search for unusual values"),
          }),       
        func: async (loadAxial,loadBendingStrong,loadBendingWeak) => {
            try {
                if (!loadAxial) {
                    console.log(loadAxial);
                    throw new Error("The loading params must be provided.");
                }

                console.log("I am here getting the values");
                console.log(loadAxial);

                let axialCapacity = 1127 ; 
                let bendingsCapacity= 725 ;
                let bendingwCapacity = 325 ;

                totalCapacity = parseInt(loadAxial.loadAxial)/axialCapacity + parseInt(loadAxial.loadBendingStrong)/bendingsCapacity + parseInt(loadAxial.loadBendingWeak)/bendingwCapacity ; 
              
                return `The total capacity ratio of this design section is : ${totalCapacity.toString()}`;;
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
        ["system", "You are a very powerful assistant that can help me determine the embedment resistive force of piles based on loadings on the foundations, number of soild layers, depth of soil layers and value of skin friction. Also, you can help me determine the capacity of seel sections based on loadings provided by the user. Use the tools. Also use numbers only without units in the tools"],
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


    res.json({success: true, message: results.output, token:token, soilLayer:soilLayer, soilDepth: soilDepth, soilFriction:soilFriction, totalCapacity:totalCapacity.toString()});

    //Stream The response using the Log


  
 });

module.exports = router;
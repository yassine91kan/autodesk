const express = require('express');
const { OPENAIKEY, APS_CLIENT_ID, APS_CLIENT_SECRET } = require('../config.js');
// import OpenAI from "openai";
const OpenAI = require('openai');
// Langchain Imports
const { ChatOpenAI } = require("@langchain/openai");
const { TavilySearchResults } = require ("@langchain/community/tools/tavily_search") ;
const { AgentExecutor, createOpenAIFunctionsAgent } = require("langchain/agents");
const { pull } = require("langchain/hub");
const { ChatPromptTemplate } = require ("@langchain/core/prompts");
const { DynamicTool } = require("@langchain/core/tools");



let router = express.Router();

let access_token;

let resp_forge;

const openai = new OpenAI({
    apiKey: OPENAIKEY
  });

router.post('/aps_agent_simple', async function (req, res, next) {


    const customTool= new DynamicTool ({
      name:"get_word_length",
      description:"Returns the length of a word",
      func: async (input) => input.length.toString(),

    });
  
    const tools = [customTool, new TavilySearchResults({ maxResults: 1, apiKey:"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" })];

    // const tools = [customTool];


    const llm = new ChatOpenAI({
        modelName: "gpt-3.5-turbo-1106",
        temperature: 0,
        apiKey: OPENAIKEY
      });

    const prompt = await pull(
        "hwchase17/openai-functions-agent"
      );

    //   console.log(prompt);

    const agent = await createOpenAIFunctionsAgent({
        llm,
        tools,
        prompt

    });

    // console.log(agent);

    const agentExecutor = new AgentExecutor({
        agent,
        tools,
        // verbose:true
        returnIntermediateSteps: true,
        
        
    });

    const results = await agentExecutor.invoke({
        input:req.body.prompt,
        // returnIntermediateSteps: true

    });

    // console.log(results);

    console.log(JSON.stringify(results, null, 2));

    res.json({success: true, message: results.output});

  
 });

module.exports = router;
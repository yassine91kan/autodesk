const express = require('express');
const { OPENAIKEY, APS_CLIENT_ID, APS_CLIENT_SECRET } = require('../config.js');
// import OpenAI from "openai";
const OpenAI = require('openai');
const axios = require("axios");    // For making HTTP requests.
const moment = require("moment-timezone");

// Langchain Imports
const { ChatOpenAI } = require("@langchain/openai");
const { TavilySearchResults } = require ("@langchain/community/tools/tavily_search") ;
const { AgentExecutor, createOpenAIFunctionsAgent } = require("langchain/agents");


let router = express.Router();

let access_token;

let resp_forge;

const openai = new OpenAI({
    apiKey: OPENAIKEY
  });

router.post('/aps_agent', async function (req, res, next) {
  
    const tools = [new TavilySearchResults({ maxResults: 1, apiKey:"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" })];

    const llm = new ChatOpenAI({
        modelName: "gpt-3.5-turbo-1106",
        temperature: 0,
        apiKey: OPENAIKEY
      });

    const agent = await createOpenAIFunctionsAgent({
        llm,
        tools,
        prompt
    });

    const agentExecutor = new AgentExecutor({
        agent,
        tools
    });

    const results = await agentExecutor.invoke({
        input:"What is langchain"
    });

    console.log(results);



  
 });

module.exports = router;
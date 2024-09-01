// const express = require('express');
// const { OPENAIKEY, APS_CLIENT_ID, APS_CLIENT_SECRET } = require('../config.js');
// // import OpenAI from "openai";
// const OpenAI = require('openai');
// // Langchain Imports
// const { ChatOpenAI } = require("@langchain/openai");
// const { TavilySearchResults } = require ("@langchain/community/tools/tavily_search") ;
// const { AgentExecutor, createOpenAIFunctionsAgent, AgentStep, createOpenAIToolsAgent } = require("langchain/agents");
// const { pull } = require("langchain/hub");
// const { ChatPromptTemplate, MessagesPlaceholder } = require ("@langchain/core/prompts");
// // Custom tools
// const { DynamicTool } = require("@langchain/core/tools");
// const { convertToOpenAIFunction, convertToOpenAITool } = require("@langchain/core/utils/function_calling");
// const { RunnableSequence } = require("@langchain/core/runnables");
// const { formatToOpenAIFunctionMessages } = require ("langchain/agents/format_scratchpad") ;
// const { OpenAIFunctionsAgentOutputParser } = require("langchain/agents/openai/output_parser") ;

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
const {AIMessage, HumanMessage} = require('@langchain/core/messages')



let router = express.Router();

let access_token;

let resp_forge;

const openai = new OpenAI({
    apiKey: OPENAIKEY
  });

let chatHistory = [new HumanMessage("Hello My Name is Yassine"), new AIMessage("Great to hear that")];

router.post('/agent_trial', async function (req, res, next) {
  
    const llm = new ChatOpenAI({
      modelName: "gpt-3.5-turbo-1106",
      temperature: 0,
      apiKey: OPENAIKEY
    });  

    const tools = [new TavilySearchResults({maxResults:1, apiKey:"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"})] ;



    const prompt = ChatPromptTemplate.fromMessages([
        ["system", "You are a knowledgeable assistant"],
        new MessagesPlaceholder("chat_history"),
        ["human", "{input}"],
        new MessagesPlaceholder("agent_scratchpad")
      ]);    


      const agent = await createOpenAIFunctionsAgent({
        llm,
        tools,
        prompt

    });

    

    const executor = new AgentExecutor({
        agent,
        tools,

    });


  
    const results = await executor.invoke({
        input:req.body.prompt,
        chat_history:chatHistory
    });

    console.log(JSON.stringify(results, null, 2));

    console.log(results);

    res.json({success: true, message: results.output});

    chatHistory.push(new HumanMessage(req.body.prompt));
    chatHistory.push(new AIMessage(results.output));

    console.log(chatHistory);

 });

module.exports = router;
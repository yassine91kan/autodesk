const express = require('express');
const { OPENAIKEY, APS_CLIENT_ID, APS_CLIENT_SECRET } = require('../config.js');
// import OpenAI from "openai";
const OpenAI = require('openai');
// Langchain Imports
const { ChatOpenAI } = require("@langchain/openai");
const { TavilySearchResults } = require ("@langchain/community/tools/tavily_search") ;
const { AgentExecutor, createOpenAIFunctionsAgent, AgentStep } = require("langchain/agents");
const { pull } = require("langchain/hub");
const { ChatPromptTemplate, MessagesPlaceholder } = require ("@langchain/core/prompts");
// Custom tools
const { DynamicTool } = require("@langchain/core/tools");
const { convertToOpenAIFunction } = require("@langchain/core/utils/function_calling");
const { RunnableSequence } = require("@langchain/core/runnables");
const { formatToOpenAIFunctionMessages } = require ("langchain/agents/format_scratchpad") ;
const { OpenAIFunctionsAgentOutputParser } = require("langchain/agents/openai/output_parser") ;




let router = express.Router();

let access_token;

let resp_forge;

const openai = new OpenAI({
    apiKey: OPENAIKEY
  });

router.post('/aps_agent', async function (req, res, next) {
  
    const model = new ChatOpenAI({
      modelName: "gpt-3.5-turbo-1106",
      temperature: 0,
      apiKey: OPENAIKEY
    });  


    const customTool= new DynamicTool ({
      name:"get_word_length",
      description:"Returns the length of a word",
      func: async (input) => input.length.toString(),

    });

    // const customTool_2= new DynamicTool ({
    //   name:"Sum_two_numbers",
    //   description:"Returns the sum of two numbers",
    //   func: async (a,b) => a+b,

    // });

    const tools = [customTool];

    const prompt = ChatPromptTemplate.fromMessages([

      ["system","You are very powerful assistant, but don't know current events"],
      ["human","{input}"],
      new MessagesPlaceholder("agent_scratchpad")

    ]);

    // Bind tools to the LLM

    const modelWithFunctions = model.bind ({

      functions: tools.map((tool)=> convertToOpenAIFunction(tool))

    });


    // Creating the agent

    const runnableAgent = RunnableSequence.from ([

      {
        input: (i) => i.input,
        agent_scratchpad: (i) => formatToOpenAIFunctionMessages(i.steps),
     },
      prompt,
      modelWithFunctions,
      new OpenAIFunctionsAgentOutputParser()

    ]);

    const executor = AgentExecutor.fromAgentAndTools({
      agent : runnableAgent,
      tools,
      // verbose:true
      verbose:True, 
      return_intermediate_steps:True

    });


    //  

  
    const results = await executor.invoke({
        input:req.body.prompt,

    });

    console.log(JSON.stringify(results, null, 2));

    // console.log(results);

    res.json({success: true, message: results.output});

  
 });

module.exports = router;
const express = require('express');
const { OPENAIKEY, APS_CLIENT_ID, APS_CLIENT_SECRET } = require('../config.js');
// import OpenAI from "openai";
const OpenAI = require('openai');
const axios = require("axios");    // For making HTTP requests.
const moment = require("moment-timezone");

const { ChatOpenAI } = require("@langchain/openai");
const { AgentExecutor, createOpenAIToolsAgent } = require("langchain/agents");
const { ChatPromptTemplate, HumanMessagePromptTemplate, MessagesPlaceholder } = require ("@langchain/core/prompts");
const { AIMessage } = require("langchain/schema");

//Imports for SQL Databse

const {SqlDatabase}  = require('langchain/sql_db') ;
const {DataSource}  = require ('typeorm') ;
const { SqlToolkit } = require('langchain/agents/toolkits/sql');


let router = express.Router();

router.post('/sql', async function (req, res, next) {
  
    let token;
    let completionTokens=0;
    let promptTokens=0;


    const datasource = new DataSource({
        type: "sqlite",
        database: "./wwwroot/assets/db/model.sdb",
      });

    const db = await SqlDatabase.fromDataSourceParams({
        appDataSource: datasource,
    });

    const llm = new ChatOpenAI({
        modelName: "gpt-3.5-turbo-1106",
        // modelName: "gpt-4o-mini",      
        temperature: 0,
        apiKey: OPENAIKEY,
        callbacks: [
            {
              handleLLMEnd(output) {
                
                // Directly access the token usage values from the output object
                completionTokens = completionTokens + output.llmOutput.tokenUsage.completionTokens;
                promptTokens = promptTokens + output.llmOutput.tokenUsage.promptTokens;
                
                // Log the token values
                console.log(`Completion Tokens: ${completionTokens}`);
                console.log(`Prompt Tokens: ${promptTokens}`);

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

    const sqlToolKit = new SqlToolkit(db, llm);

    const tools = sqlToolKit.getTools();

    const SQL_PREFIX = `You are an agent designed to interact with a SQL database.
    Given an input question, create a syntactically correct {dialect} query to run, then look at the results of the query and return the answer.
    Unless the user specifies a specific number of examples they wish to obtain, always limit your query to at most {top_k} results using the LIMIT clause.
    You can order the results by a relevant column to return the most interesting examples in the database.
    Never query for all the columns from a specific table, only ask for a the few relevant columns given the question.
    You have access to tools for interacting with the database.
    Only use the below tools.
    Only use the information returned by the below tools to construct your final answer.
    You MUST double check your query before executing it. If you get an error while executing a query, rewrite the query and try again.

    DO NOT make any DML statements (INSERT, UPDATE, DELETE, DROP etc.) to the database.

    For example to get the objects where the structural material property contains concrete we can use the following :

    SELECT _objects_id.id AS dbId, _objects_attr.display_name AS propName, _objects_val.value AS propValue
        FROM _objects_eav
            INNER JOIN _objects_id ON _objects_eav.entity_id = _objects_id.id
            INNER JOIN _objects_attr ON _objects_eav.attribute_id = _objects_attr.id
            INNER JOIN _objects_val ON _objects_eav.value_id = _objects_val.id
        WHERE propName ="Structural Material" and propValue LIKE "%concrete%"

    If the question does not seem related to the database, just return "I don't know" as the answer.`;
    const SQL_SUFFIX = `Begin!

    Question: {input}
    Thought: I should look at the tables in the database to see what I can query.
    {agent_scratchpad}`;

    const prompt = ChatPromptTemplate.fromMessages([
        ["system", SQL_PREFIX],
        HumanMessagePromptTemplate.fromTemplate("{input}"),
        new AIMessage(SQL_SUFFIX.replace("{agent_scratchpad}", "")),
        new MessagesPlaceholder("agent_scratchpad"),
    ]);

    const newPrompt = await prompt.partial({
        dialect: sqlToolKit.dialect,
        top_k: "10",
      });

    const runnableAgent = await createOpenAIToolsAgent({
        llm,
        tools,
        prompt: newPrompt,
    });

    const agentExecutor = new AgentExecutor({
        agent: runnableAgent,
        tools,
        // verbose:true
    });

    // console.log(
    //     await agentExecutor.invoke({
    //       input:
    //         "List the total sales per country. Which country's customers spent the most?",
    //     })
    // );

    const results = await agentExecutor.invoke({
        input: req.body.prompt,
    })

    console.log(results)

    // const results = JSON.stringify(db.allTables.map((t) => t.tableName)) ; 

    res.json({success: true, message: results.output, token:token});
    


  
 });

module.exports = router;
const express = require('express');
const { OPENAIKEY, APS_CLIENT_ID, APS_CLIENT_SECRET } = require('../config.js');
// import OpenAI from "openai";
const axios = require("axios");    // For making HTTP requests.
const moment = require("moment-timezone");
// Langchain Code
const { ChatOpenAI } = require("@langchain/openai");
const { AIMessage, HumanMessage } = require("@langchain/core/messages");
const { ChatPromptTemplate, MessagesPlaceholder } = require ("@langchain/core/prompts"); 
const { StringOutputParser } = require ("@langchain/core/output_parsers") ;
const { GithubRepoLoader } = require("langchain/document_loaders/web/github") ;
const { PDFLoader } = require("langchain/document_loaders/fs/pdf"); 
const { RecursiveCharacterTextSplitter } = require("langchain/text_splitter");
const { RunnableSequence } = require("@langchain/core/runnables") ;

const { RunnableWithMessageHistory } = require("@langchain/core/runnables") ;
const { ChatMessageHistory } = require ("@langchain/community/stores/message/in_memory") ;

const {ignore} = require("ignore") ;


let router = express.Router();

let access_token;

let resp_forge;



router.post('/langchain', async function (req, res, next) {

// General Invoking of the LLM
    const model = new ChatOpenAI({
        modelName: "gpt-3.5-turbo-1106",
        openAIApiKey: OPENAIKEY,
    });
    
    // const response_old = await model.invoke([
    //     new HumanMessage("Tell me a joke.")
    // ]);

    // console.log(response);


/// LLM PROMPT TEMPLATE (Template variables)

    const promptFromMessages = ChatPromptTemplate.fromMessages([
        ["system", "You are a helpful Assistant that can answer questions based on context and chat history"],
        new MessagesPlaceholder("history"),
        ["human", "{question}?"]
    ]);

    // Chat History

    const chatHistory = [
        new HumanMessage("What are the prereq for this course ?"),
        new AIMessage("Math 1"),
    ] ; 

    const messageHistory = new ChatMessageHistory();


    /// Langchain Expression Language   

    const chain = promptFromMessages.pipe(model);

    // Output parser

    const outputParser = new StringOutputParser();
    const nameGenerationChain = promptFromMessages.pipe(model).pipe(outputParser);

    const rephraseQuestionChain = RunnableSequence.from([
        promptFromMessages,
        model,
        outputParser,
    ]);

    const finalRetrievalChain = new RunnableWithMessageHistory({
        runnable: rephraseQuestionChain,
        getMessageHistory: (_sessionId) => messageHistory,
        historyMessagesKey: "history",
        inputMessagesKey: "question",
    })

    // const resp = await rephraseQuestionChain.invoke({
        
    //     input_prompt: req.body.prompt,
    //     history: chatHistory
        
    // });

    const resp = await finalRetrievalChain.invoke({
        question: req.body.prompt,
      }, {
        configurable: { sessionId: "test" }
      });

    console.log(messageHistory);

    res.json({success: true, message: resp});

    //// Good Streaming

    // for await (const chunk of resp){
    //     console.log(JSON.stringify(chunk, null, 2));
    //     console.log("------");
    //     // res.json({success: true, message: JSON.stringify(chunk, null, 2)});
    //     // res.write(JSON.stringify(chunk, null, 2));
    //     res.write(chunk);

    //     console.log(chunk);

    // }

    // res.end();

    ///

    // Streaming

    // Batch (Multiple Concureent Prompts)

    // const inputs = [
    //     { product: "large calculators" },
    //     { product: "alpaca wool sweaters" }
    // ];
    
    // const re = await nameGenerationChain.batch(inputs);

    // // console.log(re);

    // //Lesson 2: Loading and preparing data

    // // const loader = new GithubRepoLoader(
    // //     "https://github.com/langchain-ai/langchainjs",
    // //     { recursive: false, ignorePaths: ["*.md", "yarn.lock"] }
    // // );

    // // const docs = await loader.load();

    // // console.log(docs.slice(0, 3));

    // const loader = new PDFLoader("./data/MachineLearning-Lecture01.pdf");

    // const rawCS229Docs = await loader.load();

    // // console.log(rawCS229Docs.slice(0, 5));

    // // Splitting

    // const splitter = new RecursiveCharacterTextSplitter({
    //     chunkSize: 512,
    //     chunkOverlap: 64,
    //   });

    // const splitDocs = await splitter.splitDocuments(rawCS229Docs);

    // console.log(splitDocs.slice(0, 5));  
  
 });

module.exports = router;
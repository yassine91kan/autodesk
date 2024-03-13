const express = require('express');
const { OPENAIKEY, APS_CLIENT_ID, APS_CLIENT_SECRET } = require('../config.js');
// import OpenAI from "openai";
const axios = require("axios");    // For making HTTP requests.
const moment = require("moment-timezone");
// Langchain Code
const { ChatOpenAI } = require("@langchain/openai");
const { HumanMessage } = require("@langchain/core/messages");
const { ChatPromptTemplate } =require("@langchain/core/prompts"); 
const { StringOutputParser } = require ("@langchain/core/output_parsers") ;
const { GithubRepoLoader } = require("langchain/document_loaders/web/github") ;
const { PDFLoader } = require("langchain/document_loaders/fs/pdf"); 
const { RecursiveCharacterTextSplitter } = require("langchain/text_splitter");

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
        ["system", "You are a helpful Assistant"],
        ["human", "{input_prompt}?"]
    ]);
    
    // const response = await promptFromMessages.formatMessages({
    //     prompt: "What is your name"
    // });


/// Langchain Expression Language   

    const chain = promptFromMessages.pipe(model);

    // const resp = await chain.invoke({
    //     product: "colorful socks"
    // });



    // Output parser

    const outputParser = new StringOutputParser();
    const nameGenerationChain = promptFromMessages.pipe(model).pipe(outputParser);

    const resp = await nameGenerationChain.invoke({
        input_prompt: req.body.prompt
    });

    // console.log(resp);

    // console.log(typeof resp);

    res.json({success: true, message: resp});

    // Streaming

    // const stream = await nameGenerationChain.stream({
    //     product: "really cool robots",
    //   });

    //   for await (const chunk of stream) {
    //     console.log(chunk);
    // }

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
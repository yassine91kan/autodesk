const express = require('express');
const { OPENAIKEY, APS_CLIENT_ID, APS_CLIENT_SECRET, OPENAI_API_KEY } = require('../config.js');
// import OpenAI from "openai";
const axios = require("axios");    // For making HTTP requests.
// Langchain Imports
const { ChatOpenAI } = require("@langchain/openai");
// const { HumanMessage } = require("@langchain/core/messages");
const { ChatPromptTemplate } = require("@langchain/core/prompts"); 
const { StringOutputParser } = require ("@langchain/core/output_parsers") ;
// const { GithubRepoLoader } = require("langchain/document_loaders/web/github") ;
const { PDFLoader } = require("@langchain/community/document_loaders/fs/pdf"); 
const { RecursiveCharacterTextSplitter } = require("langchain/text_splitter");
const { OpenAIEmbeddings } = require("@langchain/openai") ;
const { MemoryVectorStore } = require("langchain/vectorstores/memory"); 
const { RunnableSequence } = require("@langchain/core/runnables");
const { RunnablePassthrough } = require("@langchain/core/runnables");
const { RunnableWithMessageHistory } = require ("@langchain/core/runnables");
const { ChatMessageHistory } = require ("langchain/stores/message/in_memory");
const { RunnableMap } = require ("@langchain/core/runnables");
// const { Document } = require("@langchain/core/documents");
const { MessagesPlaceholder } = require ("@langchain/core/prompts") ;
const  { HumanMessage, AIMessage,  SystemMessage,ToolMessage,} = require ("@langchain/core/messages") ;
const {ignore} = require("ignore") ;


// Additional Packages 
const { pull } = require("langchain/hub");
const { StateGraph, Annotation } = require ("@langchain/langgraph") ;
const { z } = require("zod") ;
const { tool } = require ("@langchain/core/tools") ;
const { MessagesAnnotation, MemorySaver  } = require ("@langchain/langgraph") ;
const { ToolNode } = require ("@langchain/langgraph/prebuilt") ;
const { toolsCondition } = require ("@langchain/langgraph/prebuilt") ;
const { BaseMessage, isAIMessage } = require ("@langchain/core/messages") ;
const { SimpleDirectoryReader, Document, VectorStoreIndex} =require("llamaindex");

// const { SimpleDirectoryReader } = require("llamaindex/readers/SimpleDirectoryReader");

 
//

let router = express.Router();

router.post('/rag_llamaindex', async function (req, res, next) {

    const llm = new ChatOpenAI ({
        temperature: 0,
        openAIApiKey: OPENAIKEY,
        modelName: "gpt-4o-mini"
    });


    const reader = new SimpleDirectoryReader();
    const documents = await reader.loadData({ directoryPath: "./data" });

    // Utilize an index

    const index = await VectorStoreIndex.fromDocuments(documents);

    const queryEngine = index.asQueryEngine()

    const response = await queryEngine.query({
        query: "What is RPD "
    });

    console.log(response.toString());

});



    

module.exports = router;
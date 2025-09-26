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
const { Document } = require("@langchain/core/documents");
const { MessagesPlaceholder } = require ("@langchain/core/prompts") ;
const  { HumanMessage, AIMessage } = require ("@langchain/core/messages") ;
const {ignore} = require("ignore") ;


// Additional Packages 
const { pull } = require("langchain/hub");
const { StateGraph, Annotation } = require ("@langchain/langgraph") ;

//

let router = express.Router();

router.post('/rag_agent_langgraph', async function (req, res, next) {

    const llm = new ChatOpenAI ({
        temperature: 0,
        openAIApiKey: OPENAIKEY,
        modelName: "gpt-4o-mini"
    });


    // Create embeddings
    const embeddings = new OpenAIEmbeddings({
        openAIApiKey: OPENAIKEY
    });

    console.log("I am here here")

    // create a vectorstore

    const vectorStore = new MemoryVectorStore(embeddings);

    // Load the documents using a document loader

    // Load and chunk contents of blog
    
    const loader = new PDFLoader("./data/RoboticPileDriver.pdf");
    const rawCS229Docs = await loader.load();

    console.log(`You have ${rawCS229Docs.length} documents in your data.`);

    console.log(`This is the data: ${rawCS229Docs}`)


    const splitter = new RecursiveCharacterTextSplitter({
        chunkSize:1000,
        chunkOverlap:200
    })

    const allSplits = await splitter.splitDocuments(rawCS229Docs);

    console.log(`Split into ${allSplits.length} chunks.`);


    // Index chunks
    await vectorStore.addDocuments(allSplits);

    // Define prompt for question-answering (RAG-PROMPT)
    const promptTemplate = await pull("rlm/rag-prompt");

    // Define state for application - langgraph
    const InputStateAnnotation = Annotation.Root({
        question: Annotation,
    });
  
    const StateAnnotation = Annotation.Root({
        question: Annotation,
        context: Annotation,
        answer: Annotation,
    });

    // Define a dummy start node
    // Define a dummy start node
    const start = async (state) => {
      console.log("Starting the graph execution...");
      return { question: state.question };
    };

    // Create the retrieval function (Node)
    const retrieve = async (state) => {
      const retrievedDocs = await vectorStore.similaritySearch(state.question);
      return { context: retrievedDocs };
    };

      // generation function (Node)

      const generate = async (state) => {
        const docsContent = state.context.map((doc) => doc.pageContent).join("\n");
        const messages = await promptTemplate.invoke({
          question: state.question,
          context: docsContent,
        });
        const response = await llm.invoke(messages);
        return { answer: response.content };
      };

    
      const graph = new StateGraph(StateAnnotation)
          .addNode("start", start)
          .addNode("retrieve", retrieve)
          .addNode("generate", generate)
          .addEdge("start", "retrieve")
          .addEdge("retrieve", "generate")
          .addEdge("generate", "__end__")
          .setEntryPoint("start")   
          .compile();


        let inputs = { question: req.body.prompt };

        const result = await graph.invoke(inputs);

        res.json({success: true, message: result.answer});

        console.log(result.answer);
 
      });

module.exports = router;
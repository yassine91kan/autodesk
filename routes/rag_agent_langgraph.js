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

    console.log("I am here here");


    // create a vectorstore

    const vectorStore = new MemoryVectorStore(embeddings);

    // Load the documents using a document loader

    // Load and chunk contents of blog
    
    const loader = new PDFLoader("./data/Geotechnical-Report.pdf");
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


    // const graph = new StateGraph(MessagesAnnotation);

    const retrieveSchema = z.object({ query: z.string() });

    // Create a tool for the retrieval

    const retrieve = tool(
      async ({ query }) => {
        const retrievedDocs = await vectorStore.similaritySearch(query, 2);
        const serialized = retrievedDocs
          .map(
            (doc) => `Source: ${doc.metadata.source}\nContent: ${doc.pageContent}`
          )
          .join("\n");
        return [serialized, retrievedDocs];
      },
      {
        name: "retrieve",
        description: "Retrieve information related to a query.",
        schema: retrieveSchema,
        responseFormat: "content_and_artifact",
      }
    );

    // Step 1: Generate an AIMessage that may include a tool-call to be sent.
      async function queryOrRespond(state) {
        const llmWithTools = llm.bindTools([retrieve]);
        const response = await llmWithTools.invoke(state.messages);
        // MessagesState appends messages to state instead of overwriting
        return { messages: [response] };
      }

        // Step 2: Execute the retrieval.
      const tools = new ToolNode([retrieve]);

      // Step 3: Generate a response using the retrieved content.
      async function generate(state) {
        // Get generated ToolMessages
        let recentToolMessages = [];
        for (let i = state["messages"].length - 1; i >= 0; i--) {
          let message = state["messages"][i];
          if (message instanceof ToolMessage) {
            recentToolMessages.push(message);
          } else {
            break;
          }
        }
        let toolMessages = recentToolMessages.reverse();

        // Format into prompt
        const docsContent = toolMessages.map((doc) => doc.content).join("\n");
        const systemMessageContent =
          "You are an assistant for question-answering tasks. " +
          "Use the following pieces of retrieved context to answer " +
          "the question. If you don't know the answer, say that you " +
          "don't know. Use three sentences maximum and keep the " +
          "answer concise." +
          "\n\n" +
          `${docsContent}`;

        const conversationMessages = state.messages.filter(
          (message) =>
            message instanceof HumanMessage ||
            message instanceof SystemMessage ||
            (message instanceof AIMessage && message.tool_calls.length == 0)
        );
        const prompt = [
          new SystemMessage(systemMessageContent),
          ...conversationMessages,
        ];

        // Run
        const response = await llm.invoke(prompt);
        return { messages: [response] };
      }

      const graphBuilder = new StateGraph(MessagesAnnotation)
      .addNode("queryOrRespond", queryOrRespond)
      .addNode("tools", tools)
      .addNode("generate", generate)
      .addEdge("__start__", "queryOrRespond")
      .addConditionalEdges("queryOrRespond", toolsCondition, {
        __end__: "__end__",
        tools: "tools",
      })
      .addEdge("tools", "generate")
      .addEdge("generate", "__end__");

    const graph = graphBuilder.compile();

    let inputs1 = { messages: [{ role: "user", content: req.body.prompt }] };

 
    // const result = await graph.invoke(inputs1);

    // console.log(result.messages);

    // res.json({success: true, message: result.messages[1].content});

    // Add chat history to the graph

    const checkpointer = new MemorySaver();
    const graphWithMemory = graphBuilder.compile({checkpointer});

    // Specifiy an ID fo the threa
    const threadConfig = {
            configurable: { thread_id: "abc123" },
            streamMode: "values",
        };

    let inputs3 = { messages: [{ role: "user", content: req.body.prompt }] }; 

    //     for await (const step of await graphWithMemory.stream(inputs3, threadConfig)) {
    //   const lastMessage = step.messages[step.messages.length - 1];
    //   prettyPrint(lastMessage);
    //   console.log("-----\n");
    // }

    const result = await graphWithMemory.invoke(inputs3,threadConfig);

    console.log(result.messages);

    res.json({success: true, message: result.messages[1].content});

      });

    



    

module.exports = router;
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

const checkpointer = new MemorySaver();

let graphWithMemory;

// Add general varial

let Px = 0;
let Mx = 0;
let My = 0;
let axialCapacity ;
let bendingsCapacity ; 
let bendingwCapacity ; 
let totalCapacityOutput;

// Outside router.post — run once
let vectorStore;

(async () => {
  const embeddings = new OpenAIEmbeddings({
    openAIApiKey: OPENAIKEY,
    model: "text-embedding-3-small",
  });

  const loader = new PDFLoader("./data/Geotechnical-Report-1.pdf");
  const rawDocs = await loader.load();

      const docsWithMetadata = rawDocs.map((doc, index) => {
      return new Document({
        pageContent: doc.pageContent,
        metadata:{
          ...doc.metadata,
          title: "Geotechnical-Report.pdf",
          pageNumber: index + 1 

        }
      })

    });


  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1000,
    chunkOverlap: 200,
  });

  const docs = await splitter.splitDocuments(docsWithMetadata);

  // console.log(docs);

  // 🔥 Create the in-memory vector store ONCE
  vectorStore = await MemoryVectorStore.fromDocuments(docs, embeddings);
  console.log("Vector store initialized and cached in memory.");
})();

router.post('/technical_agent_langgraph', async function (req, res, next) {

    if (!vectorStore) {
    return res.status(503).json({ success: false, message: "Vector store still loading..." });
  }

  totalCapacityOutput = 0 ;

    const llm = new ChatOpenAI ({
        temperature: 0,
        openAIApiKey: OPENAIKEY,
        modelName: "gpt-4o-mini"
    });


    // // Create embeddings
    // const embeddings = new OpenAIEmbeddings({
    //     openAIApiKey: OPENAIKEY,
    //      model: "text-embedding-3-small", // Specify your desired embedding model here
    // });

    // console.log("I am here here");


    // // create a vectorstore

    // const vectorStore = new MemoryVectorStore(embeddings);

    // // Load the documents using a document loader

    // // Load and chunk contents of blog
    
    // const loader = new PDFLoader("./data/Geotechnical-Report.pdf");
    // const rawCS229Docs = await loader.load();

    // console.log(`You have ${rawCS229Docs.length} documents in your data.`);

    // console.log(`This is the data: ${rawCS229Docs}`);

    // const docsWithMetadata = rawCS229Docs.map((doc, index) => {
    //   return new Document({
    //     pageContent: doc.pageContent,
    //     metadata:{
    //       ...doc.metadata,
    //       title: "Geotechnical-Report.pdf",
    //       pageNumber: index + 1 

    //     }
    //   })

    // });

    // const splitter = new RecursiveCharacterTextSplitter({
    //     chunkSize:1000,
    //     chunkOverlap:200
    // })

    // const allSplits = await splitter.splitDocuments(docsWithMetadata);

    // console.log(`Split into ${allSplits.length} chunks.`);


    // // Index chunks
    // await vectorStore.addDocuments(allSplits);


    // const graph = new StateGraph(MessagesAnnotation);

    const retrieveSchema = z.object({ query: z.string() });

    // Create a tool for the retrieval

    const retrieve = tool(
      async ({ query }) => {
        const retrievedDocs = await vectorStore.similaritySearch(query, 2);
        const serialized = retrievedDocs
        .map(doc => {
        const title = doc.metadata?.title || "Unknown";
        const page = doc.metadata?.pageNumber || "Unknown";
        return `Title: ${title}, Page: ${page}\nContent: ${doc.pageContent}`;
        })
        .join("\n\n---\n\n");
        return [serialized, retrievedDocs];
      },
      {
        name: "retrieve",
        description: "Retrieve information related to a query. Use this to answer questions about the geotechnical report.",
        schema: retrieveSchema,
        responseFormat: "content_and_artifact",
      }
    );

    const PileCapacitySchema = z.object({
            loadAxial: z.string().describe("Axial load provided by the user, can be provided by the user as Px"),
            loadBendingStrong: z.string().describe("Bending load Moment for strong axis provided by the user, can be provided by the user as Mx"),
            loadBendingWeak: z.string().describe("Bending load Moment for weak axis provided by the user, can be provided by the user as My"),
            // value: z.string().describe("the value to be used for querying the model. Use Tavily search for unusual values"),
        });

    const pileCapacity = tool(
            async ({ loadAxial, loadBendingStrong, loadBendingWeak }) => {

              console.log("I AM IN THE PILE CAPACITY TOOL");
              console.log(loadAxial);
              console.log(loadBendingStrong);
              console.log(loadBendingWeak);
                try {
                if (!loadAxial || !loadBendingStrong || !loadBendingWeak) {
                    throw new Error("All loading parameters must be provided.");
                }

                axialCapacity = 91;
                bendingsCapacity = 20;
                bendingwCapacity = 8.66;

                Px = loadAxial;
                Mx = loadBendingStrong;
                My = loadBendingWeak;

                const totalCapacity =
                    parseFloat(loadAxial) / axialCapacity +
                    (8 / 9) *
                    (parseFloat(loadBendingStrong) / bendingsCapacity +
                    parseFloat(loadBendingWeak) / bendingwCapacity);

                totalCapacityOutput = totalCapacity.toFixed(2);

                return [
                    `The total structural capacity ratio of this design section is based on provided loadings: ${totalCapacityOutput}`,
                    { totalCapacity: totalCapacityOutput }
                ];

                } catch (error) {
                console.error("Error in pileCapacity function:", error);
                return [
                    `Error: ${error.message}`,
                    { error: error.message }
                ];
                }
            },
            {
                name: "pileCapacity",
                description:
              "Calculate the capacity ratio of a steel pile section W6x15 based on axial and bending loads (Px, Mx, My). \
              If the user does not provide these loadings, automatically call the 'retrieve' tool to extract them \
              from the geotechnical report before performing the calculation. \
              You are allowed to use the retrieved numerical values as inputs for loadAxial, loadBendingStrong, and loadBendingWeak.",
                schema: PileCapacitySchema,
                responseFormat: "content_and_artifact",
            }

    )

    // Step 1: Generate an AIMessage that may include a tool-call to be sent.
      async function queryOrRespond(state) {
        const llmWithTools = llm.bindTools([retrieve, pileCapacity]);
        const response = await llmWithTools.invoke(state.messages);
        // MessagesState appends messages to state instead of overwriting
        return { messages: [response] };
      }

        // Step 2: Execute the retrieval.
      const tools = new ToolNode([retrieve, pileCapacity]);

        // Step 3: Generate a final response based on the retrieved documents.
        async function generate(state) {
            // Get recent tool messages
            const recentToolMessages = [];
            for (let i = state.messages.length - 1; i >= 0; i--) {
                const msg = state.messages[i];
                if (msg instanceof ToolMessage) {
                recentToolMessages.push(msg);
                } else {
                break;
                }
            }
            const toolMessages = recentToolMessages.reverse();
            const lastTool = toolMessages[toolMessages.length - 1];

            // --- 🔍 Identify which tool was used
            const toolUsed = lastTool?.name;

            let systemMessageContent = "";

            if (toolUsed === "retrieve") {
                systemMessageContent = `
                1. You are a technical assistant.
                Use the retrieved context below to answer concisely and cite page numbers and the title. This retrieval is from the geotechnical report.
                2. If the capacity ratio is NOT explicitly provided and is requested by the user:
                    - Call the 'pileCapacity' tool using the retrieved values:
                      loadAxial = Px, loadBendingStrong = Mx, loadBendingWeak = My.
                3. Use the output from the 'pileCapacity' tool to provide a final interpretation if the capacity is requested by the user:
                If you don't know, say "I don't know".
                ---
                ${toolMessages.map(m => m.content).join("\n\n")}
                `;
            } else if (toolUsed === "pileCapacity") {
                systemMessageContent = `
                You are a structural engineering assistant.
                The tool 'pileCapacity' has already calculated the capacity ratio.
                Do NOT recalculate manually. Just interpret the result clearly:
                - If the ratio ≤ 1.0, say the section is adequate.
                - If the ratio > 1.0, say the section is overstressed.
                - Report the ratio from the tool output directly.
                ---
                ${toolMessages.map(m => m.content).join("\n\n")}
                `;
            } else {
                systemMessageContent = `
                You are an assistant. If no tool result exists, answer concisely.
                `;
            }

        // Format into prompt
        // const docsContent = toolMessages.map((doc) => doc.content).join("\n");

        // console.log(toolMessages);

        // const docsContent = toolMessages
        // .map((doc) => {
        //   const title = doc.metadata.title || "Unknown";
        //   const page = doc.metadata.pageNumber || "Unknown";
        //   return `Title: ${title}, Page: ${page}\nContent: ${doc.content}`;
        // })
        // .join("\n\n---\n\n");
        // const systemMessageContent =
        //   "You are an assistant for question-answering tasks. " +
        //   "Use the following pieces of retrieved context to answer " +
        //   "the question. If you don't know the answer, say that you " +
        //   "don't know. Use three sentences maximum and keep the " +
        //   "answer concise." +
        //   "\n\n" +
        //   `${docsContent}` + "Add also the sources of the information with page numbers.";


        //   const systemMessageContent =
        //   "You are an assistant for question-answering tasks. " +
        //   "Use the tools provided : retrieval or pile capacity" +
        //   "the question. If you don't know the answer, say that you " +
        //   "If the user asks to check for loadings or capacity, use calculated pile capacity tool to infer and no need to calculate section properties."
        //   "don't know. Use three sentences maximum and keep the " +
        //   "answer concise." +  
        //   "\n\n" +
        //   `${docsContent} if retrieval is the tool used` + "Add also the sources of the information with page numbers.";

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

      // const graphBuilder = new StateGraph(MessagesAnnotation)
      // .addNode("queryOrRespond", queryOrRespond)
      // .addNode("tools", tools)
      // .addNode("generate", generate)
      // .addEdge("__start__", "queryOrRespond")
      // .addConditionalEdges("queryOrRespond", toolsCondition, {
      //   __end__: "__end__",
      //   tools: "tools",
      // })
      // .addEdge("tools", "generate")
      // .addEdge("generate", "__end__");

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
        .addConditionalEdges("generate", (state) => {
          console.log("I am here for the state");
          console.log(state);
          const lastAI = [...state.messages].reverse().find(msg => msg instanceof AIMessage);
          console.log("HEY YOUUUUUUUU");
          console.log(lastAI.content);
          if (lastAI && lastAI.content.includes("pileCapacity")) {
            // Loop back to tools if the AI wants to call a tool
            console.log("I am here to loop back to tools");
            return { tools: "tools" };
          }
          return { __end__: "__end__" };
        });

    const graph = graphBuilder.compile();

    let inputs1 = { messages: [{ role: "user", content: req.body.prompt }] };

     // Add chat history to the graph

    // const checkpointer = new MemorySaver();
    graphWithMemory = graphBuilder.compile({checkpointer});

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

    // const result = await graphWithMemory.invoke(inputs3,threadConfig);

    // console.log(result.messages);

    // const lastAI = [...result.messages].reverse().find(msg => msg.constructor.name === 'AIMessage');
    // const lastAIContent = lastAI?.content;

    // console.log(lastAIContent);

    // res.json({success: true, message: lastAIContent});   

    const allToolCalls = [];
    let finalAIMessage;

    for await (const step of await graphWithMemory.stream(inputs3, threadConfig)) {
      step.messages.forEach(m => {
        if (m instanceof ToolMessage) {
          allToolCalls.push({ toolName: m.name, content: m.content });
        } else if (m instanceof AIMessage) {
          finalAIMessage = m.content;
        }
      });
    }

    // console.log("All tool calls:", allToolCalls);

    console.log(Px);
    console.log(Mx);
    console.log(My);

    res.json({
      success: true,
      message: finalAIMessage,
      toolsUsed: allToolCalls,
      axialCapacity: axialCapacity,
      bendingsCapacity: bendingsCapacity,
      bendingwCapacity: bendingwCapacity,
      totalCapacity: totalCapacityOutput,
      loadAx:Px,
      MomentX:Mx,
      MomentY:My,
      technical:true
    });




      });

    



    

module.exports = router;
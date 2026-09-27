const express = require('express');
const { OPENAIKEY, APS_CLIENT_ID, APS_CLIENT_SECRET, OPENAI_API_KEY,TAVILY_API_KEY } = require('../config.js');
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
const { RunnableConfig } = require("@langchain/core/runnables") ;
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
const { ToolNode, createReactAgent } = require ("@langchain/langgraph/prebuilt") ;
const { toolsCondition } = require ("@langchain/langgraph/prebuilt") ;
const { BaseMessage, isAIMessage } = require ("@langchain/core/messages") ;
const { END } = require ("@langchain/langgraph");
const { DynamicStructuredTool } = require("@langchain/core/tools") ;
const { TavilySearchResults } = require ("@langchain/community/tools/tavily_search") ;




//

let router = express.Router();

const checkpointer = new MemorySaver();

let graphWithMemory;

// Add general varial

let Px = 0;
let Mx = 0;
let My = 0;

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



router.post('/technical_agent_langgraph_supervisor', async function (req, res, next) {


    const llm = new ChatOpenAI ({
        temperature: 0,
        openAIApiKey: OPENAIKEY,
        modelName: "gpt-4o-mini"
    });


    console.log("the LLM is loaded");

    /// ****** NEW CODE FOR AGENT CREATION ////

    // in the graph. We will create different nodes for each agent and tool
       const AgentState = Annotation.Root({
            messages: Annotation({
                reducer: (x, y) => x.concat(y),
                default: () => [],
            }),
            next: Annotation({
                reducer: (x, y) => y ?? x ?? END,
                default: () => END,
            }),
            });

    // Create the tools 
            const pileCapacityTool = new DynamicStructuredTool({
            name: "pile_capacity_calculator",
            description:
                "Calculates the capacity ratio of a steel pile section based on axial and bending loads (Px, Mx, My). \
              If the user does not provide these loadings, automatically call the 'retrieve' tool to extract them \
              from the geotechnical report before performing the calculation. \
              You are allowed to use the retrieved numerical values as inputs for loadAxial, loadBendingStrong, and loadBendingWeak.",
            schema: z.object({
                data: z
                .object({
                    loadAxial: z.string().describe("Axial load provided by the user, can be provided by the user as Px"),
                    loadBendingStrong: z.string().describe("Bending load Moment for strong axis provided by the user, can be provided by the user as Mx"),
                    loadBendingWeak: z.string().describe("Bending load Moment for weak axis provided by the user, can be provided by the user as My"),
                })
               
            }),
            func: async ({ loadAxial, loadBendingStrong, loadBendingWeak }) => {
                

                try {
                if (!loadAxial || !loadBendingStrong || !loadBendingWeak) {
                    throw new Error("All loading parameters must be provided.");
                }

                const axialCapacity = 91;
                const bendingSCapacity = 20;
                const bendingWCapacity = 8.66;

                Px = loadAxial;
                Mx = loadBendingStrong;
                My = loadBendingWeak;

                const totalCapacity =
                    parseFloat(loadAxial) / axialCapacity +
                    (8 / 9) *
                    (parseFloat(loadBendingStrong) / bendingSCapacity +
                    parseFloat(loadBendingWeak) / bendingWCapacity);

                const totalCapacityOutput = totalCapacity.toFixed(2);

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
            });

            // const tavilyTool = new TavilySearch();
            // const tavilyTool = new TavilySearchResults();

            const retrieveSchema = z.object({ query: z.string() });

            const retriever = tool(
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
                    description: "Retrieve information from a document related to a query. Use this to answer questions and get data from the geotechnical report.",
                    schema: retrieveSchema,
                    responseFormat: "content_and_artifact",
                  }
            );


    /// Create Agent Supervisor

        const members = ["pileCapacityCalculator", "retriever"]

        const systemPrompt =
        "You are a supervisor tasked with managing a conversation between the" +
        " following workers: {members}. Given the following user request," +
        " respond with the worker to act next. Each worker will perform a" +
        " task and respond with their results and status. When finished," +
        " respond with FINISH.";
        const options = [END, ...members];

        // Define the routing function
        const routingTool = {
        name: "route",
        description: "Select the next role.",
        schema: z.object({
            next: z.enum([END, ...members]),
        }),
        }

        const prompt = ChatPromptTemplate.fromMessages([
        ["system", systemPrompt],
        new MessagesPlaceholder("messages"),
        [
            "human",
            "Given the conversation above, who should act next?" +
            " Or should we FINISH? Select one of: {options}",
        ],
        ]);

        const formattedPrompt = await prompt.partial({
        options: options.join(", "),
        members: members.join(", "),
        });
    ///

        const supervisorChain = formattedPrompt
        .pipe(llm.bindTools(
            [routingTool],
            {
            tool_choice: "route",
            },
        ))
        // select the first one
        // .pipe((x) => (x.tool_calls[0].args || { next: "END" }));
        .pipe((x) => {
            console.log("Supervisor raw output:", x);
            const nextStep = x.tool_calls?.[0]?.args?.next || "END";
            // const nextStep = x.tool_calls?.[0]?.args?.next || "researcher";
            console.log("Supervisor selected next:", nextStep);
            return { next: nextStep };

        });

    

    

    ///*****////// */    


    /// Now we construct the graph - Agents are created using pre-built react agents from langgraph

    const pileCapacityAgent = createReactAgent({
        llm,
        tools:[pileCapacityTool],
        stateModifier: new SystemMessage("You are a calculator. You can calculate the capacity of the pile based on provided user loadings" +
        " In case, no loadings are provided use the retriever agent.")

    })

        const pileCapacityNode = async (state, config) => {
            const result = await pileCapacityAgent.invoke(state, config);
            const lastMessage = result.messages[result.messages.length - 1];
            return {
                messages: [
                new HumanMessage({ content: lastMessage.content, name: "pileCapacityCalculator" }),
                ],
            };
            };
    
        const retrieverAgent = createReactAgent({
            llm,
            tools: [retriever],
            stateModifier: new SystemMessage("You excel at retrieving information from the geotechnical report." + "Retrieve the loadings (Px, Mx, My) from the geotechnical report and output them in pure JSON format like this: \
        {\"loadAxial\": <number>, \"loadBendingStrong\": <number>, \"loadBendingWeak\": <number>}.")
            })

        // const retrieverNode = async (state,config) =>
        //  {
        // const result = await retrieverAgent.invoke(state, config);
        
        // const lastMessage = result.messages[result.messages.length - 1];
        // return {
        //     messages: [
        //     new HumanMessage({ content: lastMessage.content, name: "retriever" }),
        //     ],
        // };
        // };

        const retrieverNode = async (state, config) => {
        const result = await retrieverAgent.invoke(state, config);
        const lastMessage = result.messages[result.messages.length - 1];
        const retrieverMsg = lastMessage.content;

        // Try to extract the JSON block from the message
        const jsonMatch = retrieverMsg.match(/```json([\s\S]*?)```/);
        if (jsonMatch) {
            try {
            const parsed = JSON.parse(jsonMatch[1].trim());
            console.log("✅ Parsed JSON successfully:", parsed);

            // Store in state so next node can access
            state.pileCapacityCalculator = {
                loadAxial: parsed.loadAxial,
                loadBendingStrong: parsed.loadBendingStrong,
                loadBendingWeak: parsed.loadBendingWeak
            };
            } catch (err) {
            console.error("❌ Failed to parse JSON:", err);
            }
        }

        return {
            ...state,
            messages: [
            new HumanMessage({
                content: "Loads retrieved successfully.",
                name: "retriever",
            }),
            ],
            next: "pileCapacityCalculator"
        };
        };

        // 1. Create the graph
        const workflow = new StateGraph(AgentState)
        // 2. Add the nodes; these will do the work
        .addNode("pileCapacityCalculator", pileCapacityNode)
        .addNode("retriever", retrieverNode)
        .addNode("supervisor",supervisorChain)

        .addEdge("__start__", "supervisor"); // <--- ADD THIS

        // 3. Define the edges. We will define both regular and conditional ones
        // After a worker completes, report to supervisor

        members.forEach((member) => {
        workflow.addEdge(member, "supervisor");
        });

        workflow.addConditionalEdges(
        "supervisor",
        (x) => x.next,
        );

        const graph = workflow.compile();

        const streamResults = await graph.stream(
            {
                messages: [
                new HumanMessage({
                    content: req.body.prompt,
                }),
                ],
            },
            { recursionLimit: 10 },
            );

            console.log("Stream created:", typeof streamResults[Symbol.asyncIterator]);

            for await (const output of streamResults) {
            if (!output?.__end__) {
                console.log(output);
                console.log("----");
            }
            }

            // res.json({
            // success: true,
            // message: streamResults,

            // });




      });

    



    

module.exports = router;
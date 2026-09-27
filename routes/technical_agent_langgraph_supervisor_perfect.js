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
            const chartTool = new DynamicStructuredTool({
            name: "generate_bar_chart",
            description:
                "Generates a bar chart from an array of data points using D3.js and displays it for the user.",
            schema: z.object({
                data: z
                .object({
                    label: z.string(),
                    value: z.number(),
                })
                .array(),
            }),
            func: async ({ data }) => {
                const width = 500;
                const height = 500;
                const margin = { top: 20, right: 30, bottom: 30, left: 40 };

                const canvas = createCanvas(width, height);
                const ctx = canvas.getContext("2d");

                const x = d3
                .scaleBand()
                .domain(data.map((d) => d.label))
                .range([margin.left, width - margin.right])
                .padding(0.1);

                const y = d3
                .scaleLinear()
                .domain([0, d3.max(data, (d) => d.value) ?? 0])
                .nice()
                .range([height - margin.bottom, margin.top]);

                const colorPalette = [
                "#e6194B",
                "#3cb44b",
                "#ffe119",
                "#4363d8",
                "#f58231",
                "#911eb4",
                "#42d4f4",
                "#f032e6",
                "#bfef45",
                "#fabebe",
                ];

                data.forEach((d, idx) => {
                ctx.fillStyle = colorPalette[idx % colorPalette.length];
                ctx.fillRect(
                    x(d.label) ?? 0,
                    y(d.value),
                    x.bandwidth(),
                    height - margin.bottom - y(d.value),
                );
                });

                ctx.beginPath();
                ctx.strokeStyle = "black";
                ctx.moveTo(margin.left, height - margin.bottom);
                ctx.lineTo(width - margin.right, height - margin.bottom);
                ctx.stroke();

                ctx.textAlign = "center";
                ctx.textBaseline = "top";
                x.domain().forEach((d) => {
                const xCoord = (x(d) ?? 0) + x.bandwidth() / 2;
                ctx.fillText(d, xCoord, height - margin.bottom + 6);
                });

                ctx.beginPath();
                ctx.moveTo(margin.left, height - margin.top);
                ctx.lineTo(margin.left, height - margin.bottom);
                ctx.stroke();

                ctx.textAlign = "right";
                ctx.textBaseline = "middle";
                const ticks = y.ticks();
                ticks.forEach((d) => {
                const yCoord = y(d); // height - margin.bottom - y(d);
                ctx.moveTo(margin.left, yCoord);
                ctx.lineTo(margin.left - 6, yCoord);
                ctx.stroke();
                ctx.fillText(d.toString(), margin.left - 8, yCoord);
                });
                await tslab.display.png(canvas.toBuffer());
                return "Chart has been generated and displayed to the user!";
            },
            });

            // const tavilyTool = new TavilySearch();
            const tavilyTool = new TavilySearchResults();


    /// Create Agent Supervisor

        const members = ["researcher", "chart generator"]

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

    
        // let result = await supervisorChain.invoke({
        // messages: [
        //     new HumanMessage({
        //     content: "write a report on birds.",
        //     }),
        // ],
        // });

        // console.log("Supervisor result: ", result);
        

    

    ///*****////// */    


    /// Now we construct the graph - Agents are created using pre-built react agents from langgraph

    const researcherAgent = createReactAgent({
        llm,
        tools:[tavilyTool],
        stateModifier: new SystemMessage("You are a web researcher. You may use the Tavily search engine to search the web for" +
        " important information, so the Chart Generator in your team can make useful plots.")

    })

        const researcherNode = async (state, config) => {
            const result = await researcherAgent.invoke(state, config);
            const lastMessage = result.messages[result.messages.length - 1];
            return {
                messages: [
                new HumanMessage({ content: lastMessage.content, name: "Researcher" }),
                ],
            };
            };
    
        const chartGenAgent = createReactAgent({
            llm,
            tools: [chartTool],
            stateModifier: new SystemMessage("You excel at generating bar charts. Use the researcher's information to generate the charts.")
            })

        const chartGenNode = async (state,config) =>
         {
        const result = await chartGenAgent.invoke(state, config);
        const lastMessage = result.messages[result.messages.length - 1];
        return {
            messages: [
            new HumanMessage({ content: lastMessage.content, name: "ChartGenerator" }),
            ],
        };
        };

        // 1. Create the graph
        const workflow = new StateGraph(AgentState)
        // 2. Add the nodes; these will do the work
        .addNode("researcher", researcherNode)
        .addNode("chart generator", chartGenNode)
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
                    content: "What were the 3 most popular tv shows in 2023?",
                }),
                ],
            },
            { recursionLimit: 100 },
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
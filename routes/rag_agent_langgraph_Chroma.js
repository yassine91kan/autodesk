const express = require('express');
const { OPENAIKEY } = require('../config.js');
const { CHROMA_API_KEY } = require('../config.js');
const { ChatOpenAI } = require("@langchain/openai");
const { PDFLoader } = require("@langchain/community/document_loaders/fs/pdf");
const { RecursiveCharacterTextSplitter } = require("langchain/text_splitter");
const { OpenAIEmbeddings } = require("@langchain/openai");
// const { Chroma } = require("@langchain/community/vectorstores/chroma");
const { Document } = require("@langchain/core/documents");
const { tool } = require("@langchain/core/tools");
const { z } = require("zod");
const { StateGraph, MessagesAnnotation, MemorySaver } = require("@langchain/langgraph");
const { ToolNode, toolsCondition } = require("@langchain/langgraph/prebuilt");
const { HumanMessage, AIMessage, SystemMessage, ToolMessage } = require("@langchain/core/messages");

let router = express.Router();

//

const { ChromaClient } = require("chromadb");
const { CloudClient } = require ("chromadb") ;
const { OpenAIEmbeddingFunction } = require("@chroma-core/openai") ;
const { metadata } = require('cesium');


router.post('/rag_agent_langgraph_Chroma', async function (req, res) {

  try {
    // 1️⃣ Initialize LLM
    const llm = new ChatOpenAI({
      temperature: 0,
      openAIApiKey: OPENAIKEY,
      modelName: "gpt-4o-mini"
    });

    // 2️⃣ Load PDF documents
    // const loader = new PDFLoader("./data/Geotechnical-Report.pdf");
    // const rawDocs = await loader.load();

    // const docs = rawDocs.map((doc, idx) => {
    //   const cleanMetadata = {
    //     title: "Geotechnical-Report.pdf",
    //     pageNumber: idx + 1,
    //   };

    //   return new Document({
    //           pageContent: doc.pageContent,
    //           metadata:{
    //             title: "Geotechnical-Report.pdf",
    //             // pageNumber: idx + 1     
    //           }
    //         })
    // });


    //     const docs = rawDocs.map((doc, idx) => {
    //   // Build metadata and strip out problematic fields
    //   const rawMeta = {
    //     ...doc.metadata,
    //     title: "Geotechnical-Report.pdf",
    //     pageNumber: idx + 1,
    //   };

    //   // Remove any nested objects or arrays from metadata
    //   const cleanMetadata = {};
    //   for (const [key, value] of Object.entries(rawMeta)) {
    //     if (
    //       typeof value === "string" ||
    //       typeof value === "number" ||
    //       typeof value === "boolean" ||
    //       value === null
    //     ) {
    //       cleanMetadata[key] = value;
    //     } else {
    //       // For debugging: see which fields are dropped
    //       console.log(`🧹 Removing invalid metadata field: ${key}`);
    //     }
    //   }

    //   return new Document({
    //     pageContent: doc.pageContent,
    //     metadata: cleanMetadata,
    //   });
    // });

    // 3️⃣ Split documents into chunks
    // const splitter = new RecursiveCharacterTextSplitter({
    //   chunkSize: 1000,
    //   chunkOverlap: 200
    // });
    // const allSplits = await splitter.splitDocuments(docs);

    // 4️⃣ Create embeddings
    const embeddings = new OpenAIEmbeddings({ openAIApiKey: OPENAIKEY, model: "text-embedding-3-small" });

    const client = new CloudClient({
      apiKey: CHROMA_API_KEY,
      tenant: '5094c1fd-4e5b-41c2-af49-d10eedb4eaad',
      database: 'autodesk'
   });


    collection = await client.getCollection({ name: "my_collection" });

    // const queryEmbedding = await embeddings.embedQuery("What is the frost depth");

    // await collection.query({ queryEmbeddings: [queryEmbedding], }); // 'ids', 'documents', and 'metadatas' are returned


    const collectionNames = await client.listCollections();
    console.log(collectionNames); // must include "my_collection"
    console.log(`✅ Connected to Chroma Cloud collection`);

    // const results = await collection.query({
    // queryTexts: ["What is the frost depth"],
    // });

    // console.log(results);

    // const vectorStore = await client.fromExistingCollection(embeddings, {
    //     collection,
    //     client,
    // });



    // const texts = allSplits.map(doc => doc.pageContent);
    // // const metadatas = allSplits.map(doc => doc.metadata);

    // // Clean up metadata before embedding
    //   const metadatas = allSplits.map((doc, idx) => {
    //     const meta = doc.metadata || {};

    //     // Only keep flat primitive values (no nested objects)
    //     const cleanMeta = {};
    //     for (const [key, value] of Object.entries(meta)) {
    //       if (
    //         typeof value === "string" ||
    //         typeof value === "number" ||
    //         typeof value === "boolean" ||
    //         value === null
    //       ) {
    //         cleanMeta[key] = value;
    //       }
    //     }

    //     // Add your own stable metadata fields
    //     cleanMeta.title = "Geotechnical-Report.pdf";
    //     cleanMeta.pageNumber = idx + 1;

    //     return cleanMeta;
    //   });
    
    // const ids = allSplits.map((_, i) => `doc-${i}`);

    // console.log(metadatas);

    // // Generate embeddings
    // const vectors = await embeddings.embedDocuments(texts);

    // // Add to Chroma Cloud collection
    // await collection.add({
    //   ids,
    //   documents: texts,
    //   metadatas,
    //   embeddings: vectors,
    // });

    // console.log(`✅ Added ${texts.length} documents to Chroma Cloud!`);



    // 6️⃣ Create retrieval tool
    const retrieveSchema = z.object({ query: z.string() });

      const retrieve = tool(
        async ({ query }) => {
          const results = await collection.query({ queryTexts: [query] });

          const retrievedDocs = results.documents[0].map((docText, i) => {
            const metadata = results.metadatas[0][i] || {};
            return { pageContent: docText, metadata };
          });

          const serialized = retrievedDocs.map(doc => {
            const title = doc.metadata?.title || "Unknown";
            const page = doc.metadata?.pageNumber || "Unknown";
            return `Title: ${title}, Page: ${page}\nContent: ${doc.pageContent}`;
          }).join("\n\n---\n\n");

          return {
            content: serialized,
            artifact: { retrievedDocs }
          };
        },
        {
          name: "retrieve",
          description: "Retrieve information related to a query.",
          schema: z.object({ query: z.string() }),
          responseFormat: "content_and_artifact", // keep artifact
        }
      );

    // 7️⃣ RAG steps
    async function queryOrRespond(state) {
      const llmWithTools = llm.bindTools([retrieve]);
      const response = await llmWithTools.invoke(state.messages);
      return { messages: [response] };
    }

    const toolsNode = new ToolNode([retrieve]);

    async function generate(state) {
      let recentToolMessages = [];
      for (let i = state.messages.length - 1; i >= 0; i--) {
        let message = state.messages[i];
        if (message instanceof ToolMessage) recentToolMessages.push(message);
        else break;
      }
      const toolMessages = recentToolMessages.reverse();

      // const docsContent = toolMessages.map(doc => {
      //   const title = doc.metadata?.title || "Unknown";
      //   const page = doc.metadata?.pageNumber || "Unknown";
      //   return `Title: ${title}, Page: ${page}\nContent: ${doc.content}`;
      // }).join("\n\n---\n\n");

      const docsContent = toolMessages.map(doc => doc.content).join("\n\n---\n\n");

      const systemMessageContent =
        "You are an assistant for question-answering tasks. " +
        "Use the following pieces of retrieved context to answer the question. " +
        "If you don't know the answer, say so. Keep it concise (max 3 sentences).\n\n" +
        `${docsContent}\nAdd also the sources with page numbers.`;

      const conversationMessages = state.messages.filter(
        m => m instanceof HumanMessage || m instanceof SystemMessage ||
          (m instanceof AIMessage && m.tool_calls.length === 0)
      );

      const prompt = [
        new SystemMessage(systemMessageContent),
        ...conversationMessages
      ];

      const response = await llm.invoke(prompt);
      return { messages: [response] };
    }

    // 8️⃣ Build LangGraph
    const graphBuilder = new StateGraph(MessagesAnnotation)
      .addNode("queryOrRespond", queryOrRespond)
      .addNode("tools", toolsNode)
      .addNode("generate", generate)
      .addEdge("__start__", "queryOrRespond")
      .addConditionalEdges("queryOrRespond", toolsCondition, {
        __end__: "__end__",
        tools: "tools"
      })
      .addEdge("tools", "generate")
      .addEdge("generate", "__end__");

    const checkpointer = new MemorySaver();
    const graphWithMemory = graphBuilder.compile({ checkpointer });

    const threadConfig = { configurable: { thread_id: "abc123" }, streamMode: "values" };
    const inputs = { messages: [{ role: "user", content: req.body.prompt }] };

    const result = await graphWithMemory.invoke(inputs, threadConfig);

    const lastMessage = result.messages[result.messages.length - 1];


    res.json({ success: true, message: lastMessage.content });

    // res.json({ success: true, message: result.messages[1].content });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
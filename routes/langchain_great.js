const express = require('express');
const { OPENAIKEY, APS_CLIENT_ID, APS_CLIENT_SECRET, OPENAI_API_KEY } = require('../config.js');
// import OpenAI from "openai";
const axios = require("axios");    // For making HTTP requests.
// Langchain Imports
const { ChatOpenAI } = require("@langchain/openai");
// const { HumanMessage } = require("@langchain/core/messages");
const { ChatPromptTemplate } = require("@langchain/core/prompts"); 
const { StringOutputParser } = require ("@langchain/core/output_parsers") ;
const { GithubRepoLoader } = require("langchain/document_loaders/web/github") ;
const { PDFLoader } = require("langchain/document_loaders/fs/pdf"); 
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


let router = express.Router();

// Global variables to hold the vectorstore
let vectorstore;

// Load and prepare data (executed once)
async function loadAndPrepareData() {
    // Load the PDF
    const loader = new PDFLoader("./data/RoboticPileDriver.pdf");
    const rawCS229Docs = await loader.load();

    // Split the document into chunks
    const splitter = new RecursiveCharacterTextSplitter({
        chunkSize: 512,
        chunkOverlap: 64,
    });
    const splitDocs = await splitter.splitDocuments(rawCS229Docs);

    // Create embeddings
    const embeddings = new OpenAIEmbeddings({
        openAIApiKey: OPENAIKEY
    });
    
    // Create a vectorstore and add documents
    vectorstore = new MemoryVectorStore(embeddings);
    await vectorstore.addDocuments(splitDocs);

    console.log("Vector store initialized with document embeddings.");
}

// Call the loadAndPrepareData when server starts
loadAndPrepareData();

router.post('/langchain_great', async function (req, res, next) {



//***// */ Lesson 4: Question Answering

        try {
          if (!vectorstore) {
              return res.status(500).json({ success: false, message: "Vector store is not initialized yet." });
          }

          // ***General Invoking of the LLM
          const model = new ChatOpenAI({
            modelName: "gpt-4o-mini",
            openAIApiKey: OPENAIKEY,
            temperature:0
        });

        
        const retriever = vectorstore.asRetriever();

        // Document Retrieval in a Chain

        const convertDocsToString = (documents) => {
            return documents.map((document) => {
            return `<doc>\n${document.pageContent}\n</doc>`;
            }).join("\n");
        };

        
        const TEMPLATE_STRING = `You are an experienced researcher, 
        expert at interpreting and answering questions based on provided sources.
        Using the provided context, answer the user's question 
        to the best of your ability using only the resources provided. 
        Be verbose!

        <context>

        {context}

        </context>

        Now, answer this question using the above context:

        {question}`;

        const answerGenerationPrompt = ChatPromptTemplate.fromTemplate(
            TEMPLATE_STRING
        );

///**** */

//***// */ Lesson 5: Conversational Question Answering (History Retaining of the Responses)

        // Adding History //  (Rephrasing original question and original answer into a chat history and a standalone question + a new question)


        const REPHRASE_QUESTION_SYSTEM_TEMPLATE = 
        `Given the following conversation and a follow up question, 
        rephrase the follow up question to be a standalone question.`;

        const rephraseQuestionChainPrompt = ChatPromptTemplate.fromMessages([
            ["system", REPHRASE_QUESTION_SYSTEM_TEMPLATE],
            new MessagesPlaceholder("history"),
            [
              "human", 
              "Rephrase the following question as a standalone question:\n{question}"
            ],
          ]);

        const rephraseQuestionChain = RunnableSequence.from([
            rephraseQuestionChainPrompt,
            // new ChatOpenAI({ temperature: 0.1, modelName: "gpt-3.5-turbo-1106", openAIApiKey: OPENAIKEY }),
            model,
            new StringOutputParser(),
        ])

        // Putting it all together

          
          const documentRetrievalChain = RunnableSequence.from([
            (input) => input.standalone_question,
            retriever,
            convertDocsToString,
          ]);

          const ANSWER_CHAIN_SYSTEM_TEMPLATE = `You are an experienced researcher, 
            expert at interpreting and answering questions based on provided sources.
            Using the below provided context and chat history, 
            answer the user's question to the best of 
            your ability 
            using only the resources provided. Be verbose!

            <context>
            {context}
            </context>`;

            const answerGenerationChainPrompt = ChatPromptTemplate.fromMessages([
                ["system", ANSWER_CHAIN_SYSTEM_TEMPLATE],
                new MessagesPlaceholder("history"),
                [
                  "human", 
                  "Now, answer this question using the previous context and chat history:\n{standalone_question}"
                ]
              ]);

              const conversationalRetrievalChain = RunnableSequence.from([
                RunnablePassthrough.assign({
                  standalone_question: rephraseQuestionChain,
                }),
                RunnablePassthrough.assign({
                  context: documentRetrievalChain,
                }),
                answerGenerationChainPrompt,
                model,
                new StringOutputParser(),
              ]);

              const messageHistory = new ChatMessageHistory();

            const finalRetrievalChain = new RunnableWithMessageHistory({
            runnable: conversationalRetrievalChain,
            getMessageHistory: (_sessionId) => messageHistory,
            historyMessagesKey: "history",
            inputMessagesKey: "question",
            });


            // const originalQuestion = "What are the prerequisites for this course?";

            // const originalAnswer = await finalRetrievalChain.invoke({
            // question: originalQuestion,
            // }, {
            // configurable: { sessionId: "test" }
            // });

            // console.log(originalAnswer);

            const finalResult = await finalRetrievalChain.invoke({
            question: req.body.prompt
            }, {
            configurable: { sessionId: "test" }
            });


            console.log (messageHistory) ;


            res.json({success: true, message: finalResult});


        } catch (error) {
          console.error(error);
          res.status(500).json({ success: false, message: "Server Error" });
        }




///**** */

 });

module.exports = router;
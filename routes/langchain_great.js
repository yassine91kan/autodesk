const express = require('express');
const { OPENAIKEY, APS_CLIENT_ID, APS_CLIENT_SECRET, OPENAI_API_KEY } = require('../config.js');
// import OpenAI from "openai";
const axios = require("axios");    // For making HTTP requests.
const moment = require("moment-timezone");
// Langchain Imports
const { ChatOpenAI } = require("@langchain/openai");
// const { HumanMessage } = require("@langchain/core/messages");
const { ChatPromptTemplate } =require("@langchain/core/prompts"); 
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

let access_token;

let resp_forge;



router.post('/langchain_great', async function (req, res, next) {

// ***General Invoking of the LLM
    const model = new ChatOpenAI({
        modelName: "gpt-3.5-turbo-1106",
        openAIApiKey: OPENAIKEY,
    });
    
    const response_old = await model.invoke([
        new HumanMessage("Tell me a joke.")
    ]);

    //*** */ console.log(response);


/// **LLM PROMPT TEMPLATE (Template variables)

    // const promptFromMessages = ChatPromptTemplate.fromMessages([
    //     ["system", "You are an expert at picking company names."],
    //     ["human", "What are three good names for a company that makes {product}?"]
    // ]);
    
    // const response = await promptFromMessages.formatMessages({
    //     product: "shiny objects"
    // });

///***** */


/// ****Langchain Expression Language   

    // const chain = promptFromMessages.pipe(model);

    // const resp = await chain.invoke({
    //     product: "colorful socks"
    // });



    // Output parser

    // const outputParser = new StringOutputParser();
    // const nameGenerationChain = promptFromMessages.pipe(model).pipe(outputParser);

    // const resp = await nameGenerationChain.invoke({
    //     product: "colorful socks"
    // });

    // console.log(resp);

    // console.log(typeof resp);

    // res.json({success: false, message: resp});
    ///****
    // ****Streaming

    // const stream = await nameGenerationChain.stream({
    //     product: "really cool robots",
    //   });

    //   for await (const chunk of stream) {
    //     console.log(chunk);
    // }

    // ***Batch (Multiple Concureent Prompts)

    // const inputs = [
    //     { product: "large calculators" },
    //     { product: "alpaca wool sweaters" }
    // ];
    
    // const re = await nameGenerationChain.batch(inputs);

    // console.log(re);

    //Lesson 2: Loading and preparing data

    // const loader = new GithubRepoLoader(
    //     "https://github.com/langchain-ai/langchainjs",
    //     { recursive: false, ignorePaths: ["*.md", "yarn.lock"] }
    // );

    // const docs = await loader.load();

    // console.log(docs.slice(0, 3));



      //Synthesizing a response
    
      
      //**** */


//***// */ Lesson 4: Question Answering

            const loader = new PDFLoader("./data/MachineLearning-Lecture01.pdf");

            const rawCS229Docs = await loader.load();

            // console.log(rawCS229Docs.slice(0, 5));

            // *****Splitting

            const splitter = new RecursiveCharacterTextSplitter({
                chunkSize: 512,
                chunkOverlap: 64,
            });

            const splitDocs = await splitter.splitDocuments(rawCS229Docs);

            // console.log(splitDocs.slice(0, 5));  

            ///**** */

            // *** Create a New Embeddings


            const embeddings = new OpenAIEmbeddings();

            // console.log(await embeddings.embedQuery("This is some sample text"));

            const vectorstore = new MemoryVectorStore(embeddings);

            await vectorstore.addDocuments(splitDocs);

            const retriever = vectorstore.asRetriever();

            // Document Retrieval in a Chain


            const convertDocsToString = (documents) => {
                return documents.map((document) => {
                return `<doc>\n${document.pageContent}\n</doc>`;
                }).join("\n");
            };


            /*
            {
            question: "What is deep learning?"
            }
            */

            // const documentRetrievalChain = RunnableSequence.from([
            //     (input) => input.question,
            //     retriever,
            //     convertDocsToString
            // ]);


                
            // const results = await documentRetrievalChain.invoke({
            //     question: "What are the prerequisites for this course?"
            // });
            // console.log(results); 

            // res.json({success: true, message: results});

            // Synthesizing a response

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


            // const runnableMap = RunnableMap.from({
            //     context: documentRetrievalChain,
            //     question: (input) => input.question,
            //   });
              
            //   await runnableMap.invoke({
            //       question: "What are the prerequisites for this course?"
            //   })


            //   const retrievalChain = RunnableSequence.from([
            //     {
            //       context: documentRetrievalChain,
            //       question: (input) => input.question,
            //     },
            //     answerGenerationPrompt,
            //     model,
            //     new StringOutputParser(),
            //   ]);

            //   const answer = await retrievalChain.invoke({
            //     question: req.body.prompt
            //   });
              
            //   console.log(answer);

            //   res.json({success: true, message: answer});



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
                new ChatOpenAI({ temperature: 0.1, modelName: "gpt-3.5-turbo-1106", openAIApiKey: OPENAIKEY }),
                new StringOutputParser(),
            ])

            // const originalQuestion = "What are the prerequisites for this course?";

            // const originalAnswer = await retrievalChain.invoke({
            // question: originalQuestion
            // });

            // console.log(originalAnswer);

            // const chatHistory = [
            //     new HumanMessage(originalQuestion),
            //     new AIMessage(originalAnswer),
            // ];
              
            //   const answer_rephrased = await rephraseQuestionChain.invoke({
            //     question: "Can you list them in bullet point form?",
            //     history: chatHistory,
            //   });

            //   console.log(answer_rephrased);

            // res.json({success: true, message: answer_rephrased});


            //


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
                    new ChatOpenAI({ modelName: "gpt-3.5-turbo" }),
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




///**** */

 });

module.exports = router;
const express = require('express');
const { OPENAIKEY, APS_CLIENT_ID, APS_CLIENT_SECRET } = require('../config.js');
// import OpenAI from "openai";
const OpenAI = require('openai');
// Langchain Imports
const axios = require("axios");
const { z } = require('zod');

//

const { PDFDocument } = require("pdf-lib");
const { writeFileSync } = require("fs");



let router = express.Router();

let access_token;
let resp_forge;
let tokenExpirationTime;
let metadata_ask;
let propertiesList;
let objid_coord ;
let token;
let completionTokens=0;
let promptTokens=0;

async function createPDF() {
    const PDFdoc = await PDFDocument.create();
    const page = PDFdoc.addPage([300, 400]);
    writeFileSync("blank.pdf", await PDFdoc.save());
  }


router.get('/PDF_agent', async function (req, res, next) {

    // res.json({success: true, message: objid_coord,geomtype:geomType});
 
 });

 router.put('/PDF_agent', async function (req, res, next) {

 
 });

router.post('/PDF_agent', async function (req, res, next) {
 

    
    

    const tools = [customTool];



    const llm = new ChatOpenAI({
        modelName: "gpt-4o-mini",      
        temperature: 0,
        apiKey: OPENAIKEY,
        callbacks: [
            {
              handleLLMEnd(output) {
                
                // Directly access the token usage values from the output object
                completionTokens = completionTokens + output.llmOutput.tokenUsage.completionTokens;
                promptTokens = promptTokens + output.llmOutput.tokenUsage.promptTokens;
                

                // Store the tokens in variables if needed
                token = {
                    completionTokens,
                    promptTokens
                };

                // If you need to store it as a string
                const tokenString = JSON.stringify(token, null, 2);
                console.log(tokenString);

                
              },
            },
          ],
      });


      const prompt = ChatPromptTemplate.fromMessages([
        ["system", "You are a very powerful assistant that can help me determine the embedment depth of piles based on loadings on the foundations. Use the tools."],
        ["human", "{input}"],
        new MessagesPlaceholder("agent_scratchpad")
      ]);
 

    const agent = await createOpenAIFunctionsAgent({
        llm,
        tools,
        prompt

    });

    const agentExecutor = new AgentExecutor({
        agent,
        tools,
        verbose:true,
        // returnIntermediateSteps: true,      
        
    });


    const results = await agentExecutor.invoke({
        input:req.body.prompt
    })


    res.json({success: true, message: results.output, token:token, power:resultPower});

    //Stream The response using the Log


  
 });

module.exports = router;
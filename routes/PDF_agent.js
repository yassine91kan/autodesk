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
 

    
    res.json({success: true, message: results.output, token:token, power:resultPower});

    //Stream The response using the Log


  
 });

module.exports = router;
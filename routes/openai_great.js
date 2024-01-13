const express = require('express');
const { OPENAIKEY } = require('../config.js');
// import OpenAI from "openai";
const OpenAI = require('openai');




let router = express.Router();

router.post('/openaifunc', async function (req, res, next) {

    const openai = new OpenAI({
        apiKey: OPENAIKEY
      });

    let query = {
        "model": "gpt-3.5-turbo",
        "messages": [{"role": "user", "content": req.body.prompt}],
        "temperature": 0.7

    };

     try {
        const chatCompletion = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [{"role": "user", "content": req.body.prompt}],
          });
          console.log(chatCompletion.choices[0].message);

          res.json({success: true, message: chatCompletion.choices[0].message.content});

      } catch (e) {
        console.error(e); // 30
        console.log(e);
        res.json({success: false, message: "You are unsuccessful"})
      }


  
 });

module.exports = router;
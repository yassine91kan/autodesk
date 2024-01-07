const express = require('express');
const { OPENAIKEY } = require('../config.js');


let router = express.Router();

router.post('/openai', async function (req, res, next) {



    console.log(req.body);

    let query = {
        "model": "gpt-3.5-turbo",
        "messages": [{"role": "user", "content": req.body.prompt}],
        "temperature": 0.7

    };


    fetch(`https://api.openai.com/v1/chat/completions`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${OPENAIKEY}`,
            'Content-Type': 'application/json'
        },
        body:JSON.stringify(query)
    })
    .then(response => response.json())
    .then(data => {

        res.json({success: true, message: data.choices[0].message.content})

    })
    .catch(error => {
        console.error("Error retrieving object tree:", error);
        res.json({success: false, message: "You are unsuccessful"})
    });

});

module.exports = router;
const express = require('express');
const { OPENAIKEY } = require('../config.js');
// import OpenAI from "openai";
const OpenAI = require('openai');
const axios = require("axios");    // For making HTTP requests.
const moment = require("moment-timezone");



let router = express.Router();

let access_token;

let resp_forge;

router.post('/openaifunc', async function (req, res, next) {

    const openai = new OpenAI({
        apiKey: OPENAIKEY
      });


      let query = {
           
        "query": {
            "$contains": [
                "properties.Materials and Finishes.Structural Material",
                "Concrete"
            ]
        },
        "fields": [
            "objectid",
            "name",
            "externalId",
            "properties.Materials and Finishes"
        ],
        "pagination": {
            "offset": 30,
            "limit": 30
        },
        "payload": "text"

    };

      function queryModel(access_token) {

      // Proceed to query the model's metadata
      let urn = "dXJuOmFkc2sub2JqZWN0czpvcy5vYmplY3Q6ZnFwdGd0Z2Q2N2dnNGd2dWJhZ2VpdmpweHVzdW9pbXMtYmFzaWMtYXBwL3JzdGJhc2ljc2FtcGxlcHJvamVjdC5ydnQ";
      let guid = "2b8b1cf8-31bf-7e71-dfb5-e1d4342ddb82";

        fetch(`https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/metadata/${guid}/properties:query`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${access_token}`,
                'Content-Type': 'application/json'
            },
            body:JSON.stringify(query)
        })
        .then(response => response.json())
        .then(data => {
            console.log("Query Response:", data.data.collection);
            resp_forge=data.data.collection;
        })
        .catch(error => {
            console.error("Error retrieving the query:", error);
        });
    }


    function authenticate(){

      const client_id = 'fQPtGtGD67GG4gVubAGeIvjPXUsuOimS';
      const client_secret = 'Wrwo4ROxNFlfrYmG';
      const credentials = `client_id=${client_id}&client_secret=${client_secret}&grant_type=client_credentials&scope=data:read`;

      fetch('https://developer.api.autodesk.com/authentication/v1/authenticate', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: credentials
        })
        .then(response => response.json())
        .then(data => {
        access_token = data.access_token;
        console.log("You access token is :");    
        console.log(access_token);
        // queryModel(urn, guid, access_token)

        queryModel(access_token);


        })
        .catch(error => {
            console.error("Error authenticating:", error);
        });

    }



        async function lookupTime(location) {
          try {
              const response = await axios.get(`http://worldtimeapi.org/api/timezone/${location}`); // Make a GET request to the World Time API with the location parameter as the timezone.
              const { datetime } = response.data;    // Extract the datetime property from the data in the response.
              const dateTime = moment.tz(datetime, location).format("h:mmA"); // Use moment-timezone to create the Date object in the specified timezone.
              const timeResponse = `The current time in ${location} is ${dateTime}.`; // Log the formatted time to the console.
              return timeResponse;
          } catch (error) {
              console.error(error);    // Log any errors that occur to the console.
          }
      }
      

     try {
        const chatCompletion = await openai.chat.completions.create({
            model: "gpt-3.5-turbo-0613",
            messages: [{"role": "user", "content": req.body.prompt}],
            functions: [
              {
                name: "lookupTime",
                description: "get the current time in a given location",
                parameters: {
                    type: "object", // specify that the parameter is an object
                    properties: {
                        location: {
                            type: "string", // specify the parameter type as a string
                            description: "The location, e.g. Beijing, China. But it should be written in a timezone name like Asia/Shanghai"
                        }
                    },
                    required: ["location"] // specify that the location parameter is required
                }
              }
            ],
            function_call: "auto"
          });
          console.log(chatCompletion.choices[0].message);

          if(!chatCompletion.choices[0].message.content) { 

            console.log("I am here");
            const functionCallName = chatCompletion.choices[0].message.function_call.name;

            if(functionCallName === "lookupTime") {

              const completionArguments = JSON.parse(chatCompletion.choices[0].message.function_call.arguments);

              const completion_text = await lookupTime(completionArguments.location);

              console.log(completion_text);

              authenticate();

              res.json({success: true, message: completion_text});

            }

          }

          else if(chatCompletion.choices[0].message.content) { 

            
            authenticate();

            // res.json({success: true, message: chatCompletion.choices[0].message.content});
            
            res.json({success: true, message: resp_forge});
          }
          

      } catch (e) {
        console.error(e); // 30
        console.log(e);
        res.json({success: false, message: "You are unsuccessful"})
      }


  
 });

module.exports = router;
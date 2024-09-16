import { initViewer, loadModel } from './viewer.js';


// import { OPENAIKEY } from '../config.js';

let routeselect = "langchain";

initViewer(document.getElementById('preview')).then(viewer => {
    const urn = window.location.hash?.substring(1);
    setupModelSelection(viewer, urn);
    setupModelUpload(viewer);
});

async function setupModelSelection(viewer, selectedUrn) {
    const dropdown = document.getElementById('models');
    dropdown.innerHTML = '';
    try {
        const resp = await fetch('/api/models');
        if (!resp.ok) {
            throw new Error(await resp.text());
        }
        const models = await resp.json();
        dropdown.innerHTML = models.map(model => `<option value=${model.urn} ${model.urn === selectedUrn ? 'selected' : ''}>${model.name}</option>`).join('\n');
        dropdown.onchange = () => onModelSelected(viewer, dropdown.value);
        if (dropdown.value) {
            onModelSelected(viewer, dropdown.value);
        }
    } catch (err) {
        alert('Could not list models. See the console for more details.');
        console.error(err);
    }
}

async function setupModelUpload(viewer) {
    const upload = document.getElementById('upload');
    const input = document.getElementById('input');
    const models = document.getElementById('models');
    upload.onclick = () => input.click();
    input.onchange = async () => {
        const file = input.files[0];
        let data = new FormData();
        data.append('model-file', file);
        if (file.name.endsWith('.zip')) { // When uploading a zip file, ask for the main design file in the archive
            const entrypoint = window.prompt('Please enter the filename of the main design inside the archive.');
            data.append('model-zip-entrypoint', entrypoint);
        }
        upload.setAttribute('disabled', 'true');
        models.setAttribute('disabled', 'true');
        showNotification(`Uploading model <em>${file.name}</em>. Do not reload the page.`);
        try {
            const resp = await fetch('/api/models', { method: 'POST', body: data });
            if (!resp.ok) {
                throw new Error(await resp.text());
            }
            const model = await resp.json();
            setupModelSelection(viewer, model.urn);
        } catch (err) {
            alert(`Could not upload model ${file.name}. See the console for more details.`);
            console.error(err);
        } finally {
            clearNotification();
            upload.removeAttribute('disabled');
            models.removeAttribute('disabled');
            input.value = '';
        }
    };
}

async function onModelSelected(viewer, urn) {
    if (window.onModelSelectedTimeout) {
        clearTimeout(window.onModelSelectedTimeout);
        delete window.onModelSelectedTimeout;
    }
    window.location.hash = urn;
    try {
        const resp = await fetch(`/api/models/${urn}/status`);
        if (!resp.ok) {
            throw new Error(await resp.text());
        }
        const status = await resp.json();
        switch (status.status) {
            case 'n/a':
                showNotification(`Model has not been translated.`);
                break;
            case 'inprogress':
                showNotification(`Model is being translated (${status.progress})...`);
                window.onModelSelectedTimeout = setTimeout(onModelSelected, 5000, viewer, urn);
                break;
            case 'failed':
                showNotification(`Translation failed. <ul>${status.messages.map(msg => `<li>${JSON.stringify(msg)}</li>`).join('')}</ul>`);
                break;
            default:
                clearNotification();
                loadModel(viewer, urn);
                break; 
        }
    } catch (err) {
        alert('Could not load model. See the console for more details.');
        console.error(err);
    }
}

function showNotification(message) {
    const overlay = document.getElementById('overlay');
    overlay.innerHTML = `<div class="notification">${message}</div>`;
    overlay.style.display = 'flex';
}

function clearNotification() {
    const overlay = document.getElementById('overlay');
    overlay.innerHTML = '';
    overlay.style.display = 'none';
}

// Function to handle click events
function handleClick(routeselectValue,checked) {

    if(checked){

    routeselect = routeselectValue;
    console.log(routeselect);

    }
}

// Attach event listeners to elements
document.getElementById('type0').addEventListener("click", () => handleClick("ask_agent_simple",document.getElementById('type0').checked));
document.getElementById('type1').addEventListener("click", () => handleClick("langchain_great",document.getElementById('type1').checked));
document.getElementById('type2').addEventListener("click", () => handleClick("ask_agent_simple",document.getElementById('type2').checked));
document.getElementById('type3').addEventListener("click", () => handleClick("sql",document.getElementById('type3').checked));
document.getElementById('addGeom').addEventListener("click", () => handleClick("geom_agent",document.getElementById('addGeom').checked));


async function getopenai(prompt) {
    // try {
    //     const resp = await fetch('/openai');
    //     console.log(resp);
    //     console.log(resp.json());
    // } catch (err) {
    //     alert('Could not obtain access token. See the console for more details.');
    //     console.error(err);
    // }

    if (routeselect=="openaifunc"){

        const response = await fetch(`/${routeselect}`, {

            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body:JSON.stringify({"prompt":prompt})

        });

        console.log(response)

        // const data = await response.json();

        const reader = response.body.getReader();

        console.log(reader);
        document.getElementById('gpt_response').innerHTML="";

        while (true) {
            const { done, value } = await reader.read();
            if (done) {
              // Do something with last chunk of data then exit reader
              break;
            }
            // Otherwise do something here to process current chunk
            console.log(value);
            console.log(done);
            const text = new TextDecoder().decode(value);
            console.log(text);
            document.getElementById('gpt_response').innerHTML+=text;
          }


    }

    else {

        fetch(`/${routeselect}`, {
            method:  'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body:JSON.stringify({"prompt":prompt})
        })
        .then(response => response.json())
        .then(data => {

            console.log(data.message);

            console.log(data.token);

            let customItems = data.message;
            customItems = customItems.split("\n");

            for (let i = 0; i < customItems.length; i++) {
            customItems[i] =  customItems[i] + "<br>";
            }

            customItems = customItems.join("");




            document.getElementById('gpt_response').innerHTML=customItems;

            if(data.token){

                document.getElementById('compToken').innerHTML=data.token.completionTokens;
                document.getElementById('promptToken').innerHTML=data.token.promptTokens ;
            }

        })
        .catch(error => {
            console.error("Error retrieving object tree:", error);
            // res.json({success: false, message: "You are unsuccessful"})
        });

    }  
    
    

}


document.querySelector('#fname').addEventListener('keypress', function (e) {
    if (e.key === 'Enter') {
    //   console.log(document.querySelector('#fname').value);
    //   openaiquery(document.querySelector('#fname').value)

    getopenai(document.querySelector('#fname').value);




    }
});
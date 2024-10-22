// Start the initialization process

Cesium.Ion.defaultAccessToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiJkNjI4NTkwMC03OWZjLTQyZGQtOWM5ZS04YWM0OWJkMzY3YjQiLCJpZCI6MjQyMjc0LCJpYXQiOjE3MjY2MjYxOTR9.kwtkAvEFXBiLJOCOBYZejDQZbqPZrLZzdcSjbI284bM';
              
// Initialize the Cesium Viewer in the HTML element with the `cesiumContainer` ID.
const viewer = new Cesium.Viewer('cesiumContainer', {
    terrain: Cesium.Terrain.fromWorldTerrain({
        // requestWaterMask: true,
        // requestVertexNormals: true,
    }),

});  

// Global array to store the models
let loadedEntities = [];
let polygonArray = [];

let apiKey = "ee92de415a9747069da56179e723f4ba"; 

async function geocodeAddress(address) {
    const apiKey = "ee92de415a9747069da56179e723f4ba";
    const url = `https://api.opencagedata.com/geocode/v1/json?q=${encodeURIComponent(address)}&key=${apiKey}&limit=1`;

    try {
        const response = await fetch(url);
        const data = await response.json();

        if (data.results.length > 0) {
            const { lat, lng } = data.results[0].geometry;
            return { latitude: lat, longitude: lng };
        } else {
            throw new Error('Address not found');
        }
    } catch (error) {
        console.error(error);
        throw error;
    }
}



// Function to add solar panels to the viewer
function addSolarPanel(viewer, longitude, latitude, height) {
    const modelUrl = './assets/glTf/solar_panel/scene.gltf';  // Your model URL here

    return Cesium.Model.fromGltfAsync({
        url: modelUrl,
        modelMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(
            Cesium.Cartesian3.fromDegrees(longitude, latitude, height)
        ),
        scale: 1.0 // Adjust scale as needed
    }).then((model) => {
        viewer.scene.primitives.add(model);
        loadedEntities.push(model);
    }).catch((error) => {
        console.error('Error loading model:', error);
    });
}

function addTurbine(viewer,longitude,latitude,height){

    const entity = viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(longitude, latitude,height),
        model: {
          uri: './assets/glTf/solar_panel/scene.gltf',
        },
        label: {
            text: "P01",
            font: "10pt monospace",
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            outlineWidth: 2,
            verticalOrigin: Cesium.VerticalOrigin.TOP,
            pixelOffset: new Cesium.Cartesian2(0, 32),
          },
      });

      loadedEntities.push(entity);
}

let i=0;

function addPoint (long,lat){

    console.log("I am adding this point");
    console.log(long);
    console.log(lat);

    i++;

    let citizensBankPark=[];

    citizensBankPark[i] = viewer.entities.add({
        position : Cesium.Cartesian3.fromDegrees(long, lat, 40),
        point : {
          color : Cesium.Color.YELLOW,
          pixelSize : 6
        },
        // label: {
        //     text: "Citizens Bank Park",
        //     font: "14pt monospace",
        //     style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        //     outlineWidth: 2,
        //     verticalOrigin: Cesium.VerticalOrigin.TOP,
        //     pixelOffset: new Cesium.Cartesian2(0, 32),
        //   },
      });

      console.log(citizensBankPark);

}

// Function to initialize the viewer and add the solar panels
async function initialize(long,lat) {
    // Example: Geocode an address and fly to its location
    // const addressData = await geocodeAddress("1251 Thomas A. Dolan Pkwy, Dunrobin, Ontario");
    // console.log("Geocoded Address:", addressData);

    // const addressData = {"longitude":-76.0316771,"latitude":45.4160587}
    // The corresponding address is : 1251 Thomas Dolan Parkway, Ottawa, Canada
    const addressData = {"longitude":long,"latitude":lat}
    console.log(addressData);

    viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(addressData.longitude, addressData.latitude, 40),
        orientation: {
            heading: Cesium.Math.toRadians(0.0),
            pitch: Cesium.Math.toRadians(-15.0),
        }
    });

    // Add a grid of solar panels near the geocoded location
    const numRows = 28;            // Number of rows of panels
    const numCols = 10;            // Number of columns of panels
    const panelSpacing = 0.0001;   // Approx. 11 meters spacing

    const spacingRow = 0.000015;
    const spacingCol = 0.0001;

    const startLongitude = addressData.longitude;
    const startLatitude = addressData.latitude;
    let pileNumber=0;

    // Use Promise.all to wait for all solar panels to load before moving objects
    const promises = [];

    for (let row = 0; row < numRows; row++) {
        for (let col = 0; col < numCols; col++) {
            const longitude = startLongitude + col * spacingCol;
            const latitude = startLatitude + row * spacingRow;

            polygonArray.push(longitude);
            polygonArray.push(latitude);

            const height = 33.53;  // You can adjust the height
            const rowNumber ="0100";
            pileNumber +=1;

            // Add each solar panel to the scene
            // addSolarPanel(viewer, longitude, latitude, height);
            // promises.push(addSolarPanel(viewer, longitude, latitude, height));
            // promises.push(addPoint (longitude,latitude));
            promises.push(addTurbine(viewer,longitude,latitude,height))
            document.querySelector('#table_pile').innerHTML += `
            <tr>
                <td>
                <div class="check-input-primary">
                    <input class="form-check-input" type="checkbox" id="checkbox-${rowNumber}" />
                </div>
                </td>
                <td>
                <p>${pileNumber}</p>
                </td>
                <td>
                <p>Steel Pile</p> <!-- You can replace 'Some Value 1' with actual dynamic values -->
                </td>
                <td>
                <p>${longitude.toFixed(4).toString()}<</p>
                </td>
                <td>
                <p>${latitude.toFixed(4)}<</p>
                </td>
                <td>
                <p>Some Value 4</p>
                </td>
                <td>
                <div class="action">
                    <button class="text-danger" onclick="removeRow(this)">
                    <i class="lni lni-trash-can"></i>
                    </button>
                </div>
                </td>
            </tr>
            `
        
    }
}

        // Wait for all models to load before moving them
        await Promise.all(promises);
        console.log("All solar panels have been loaded.");

        // await moveObjects();

        // Move the objects after loading
        // await moveEntities();
        
}

let targetLongitude;
let targetLatitude;

let pointArray=[];

// Move Objects 

// Move Entities
async function moveEntities(number) {

    const metersToLatitudeDegrees = number / 111320;  // Approx constant
    const metersToLongitudeDegrees = (latitude) => number / (111320 * Math.cos(Cesium.Math.toRadians(latitude)));  // Varies by latitude

    pointArray=[];

    try {
        if (!loadedEntities || loadedEntities.length === 0) {
            console.log("No entities are loaded yet.");
            return;
        }

        console.log(loadedEntities);

        loadedEntities.forEach(function(entity) {

            const cartesianPosition = entity.position.getValue(Cesium.JulianDate.now());
            const cartographicPosition = Cesium.Cartographic.fromCartesian(cartesianPosition);

            // Compute new latitude and longitude


            // Longitude and latitude are returned in radians, so convert them to degrees
            const longitudeInDegrees = Cesium.Math.toDegrees(cartographicPosition.longitude);
            const latitudeInDegrees = Cesium.Math.toDegrees(cartographicPosition.latitude);

            const newLatitude = latitudeInDegrees + metersToLatitudeDegrees;
            const newLongitude = longitudeInDegrees + metersToLongitudeDegrees(Cesium.Math.toDegrees(cartographicPosition.latitude));

            targetLongitude=newLongitude;
            targetLatitude=newLongitude;

            pointArray.push({"longitude":newLongitude,"latitude":newLatitude});

            // Update the entity's position
            const newPosition = Cesium.Cartesian3.fromDegrees(newLongitude, newLatitude, cartographicPosition.height);
            entity.position = newPosition;
        });

        

        console.log("Entities moved successfully.");

        console.log(targetLongitude);
        console.log(targetLatitude);

        console.log(pointArray);

        let bouboxArray = await BoundaryBox(pointArray);

        console.log(bouboxArray);

        // drawPolygon(polygonArray);
        drawPolygon(bouboxArray);

        // viewer.camera.flyTo({
        //     destination: Cesium.Cartesian3.fromDegrees(targetLongitude, targetLatitude, 100),
        //     orientation: {
        //         heading: Cesium.Math.toRadians(0.0),
        //         pitch: Cesium.Math.toRadians(-15.0),
        //     }
        // });



    } catch (error) {
        console.error(error);
        throw error;
    }
}

async function drawPolygon(array) {

    
    try {

        console.log(array);
        
        const wyoming = viewer.entities.add({
            polygon: {
              hierarchy: Cesium.Cartesian3.fromDegreesArray(array),
              height: 33.53,
              material: Cesium.Color.RED.withAlpha(0.5),
              outline: true,
              outlineColor: Cesium.Color.BLACK,
            },

          });


    } catch (error) {
        console.error(error);
        throw error;
    }
}

async function BoundaryBox(points){

    let minLng = Infinity, maxLng = -Infinity;
    let minLat = Infinity, maxLat = -Infinity;

    try {

        points.forEach(point=>{

            minLng = Math.min(minLng, point.longitude);
            maxLng = Math.max(maxLng, point.longitude);
            minLat = Math.min(minLat, point.latitude);
            maxLat = Math.max(maxLat, point.latitude);
    
        });
    
        // Calculate width and height of the bounding box
        const width = maxLng - minLng;
        const height = maxLat - minLat;
    
        let bbArray =[];
        bbArray.push(minLng);
        bbArray.push(maxLat);
        bbArray.push(maxLng);
        bbArray.push(maxLat);
        bbArray.push(maxLng);
        bbArray.push(minLat); 
        bbArray.push(minLng);
        bbArray.push(minLat);
  
          
        return bbArray;


    } catch (error) {
        console.error(error);
        throw error;
    }

    

}

async function addrobModel(){

    const coordRob ={"longitude":-76.0316771,"latitude":45.4160587,"height":34.2}

    try {

        const entityRob = viewer.entities.add({
            position: Cesium.Cartesian3.fromDegrees(coordRob.longitude, coordRob.latitude,coordRob.height),
            model: {
              uri: './assets/glTf/excavator_robo/scene.gltf',
            },
            label: {
                text: "Robotic Pile",
                font: "10pt monospace",
                style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                outlineWidth: 2,
                verticalOrigin: Cesium.VerticalOrigin.TOP,
                pixelOffset: new Cesium.Cartesian2(0, 32),
              },
          });

    } catch (error) {
        console.error(error);
        throw error;
    }

    


}

function removeModels(){
    console.log("I am removing the models");
    viewer.entities.removeAll();
}

document.getElementById('remove').addEventListener("click", () => 
    
    removeModels());

document.getElementById('addRob').addEventListener("click", () => 
    
    addrobModel());


// Main function to load models and move them after loading


initialize(-76.0316771,45.4160587);

// initialize(-76.03731,45.41632);

// setTimeout(moveObjects(),6000)

// Call the main function to load and move the models
// Function to sample the terrain for height 



// Start the initialization process
// initialize(-76.0316771,45.4160587);

// Callback function for handling terrain sampling success
function terrainsuccess(positions) {
console.log('Sampled positions:', positions);
}

// Function to sample the terrain

function terrain() {
// Define terrain sample positions (as an array)
const terrainSamplePositions = [
    Cesium.Cartographic.fromDegrees(-76.0316771, 45.4160587)
];

// Sample the terrain at zoom level 9
Cesium.sampleTerrain(viewer.terrainProvider, 12, terrainSamplePositions)
    .then(terrainsuccess)  // Pass callback correctly
    .catch(error => console.error('Error sampling terrain:', error));  // Handle errors
    }

// Add Cesium OSM buildings to the scene as our example 3D Tileset.
const osmBuildingsTileset = await Cesium.createOsmBuildingsAsync();
viewer.scene.primitives.add(osmBuildingsTileset);

// Trigger terrain sampling immediately (no need for a readyPromise)
    // Poll the terrain provider until it's ready
function waitForTerrainToLoad() {
    // Check if the terrain provider is ready
    // if (viewer.terrainProvider.ready) {
    //     console.log("Terrain is ready, starting sampling.");
    console.log(viewer.terrainProvider);
    console.log(viewer.terrainProvider.readyEvent);
    console.log("Executing Terrain Loading...");
        terrain();  // Sample the terrain once it's ready
    // } else {
        console.log("Waiting for terrain to load...");
        // Retry until terrain is ready
        // setTimeout(waitForTerrainToLoad, 60000);  // Check every 100 milliseconds
    // }
}

// Start checking for terrain readiness
// setTimeout(waitForTerrainToLoad, 6); 

let routeselect = "langchain";

// Function to handle click events
function handleClick(routeselectValue,checked) {

    if(checked){

    routeselect = routeselectValue;
    console.log(routeselect);

    }
}

// Attach event listeners to elements
document.getElementById('type0').addEventListener("click", () => handleClick("gis_agent",document.getElementById('type0').checked));
document.getElementById('type1').addEventListener("click", () => handleClick("langchain_great",document.getElementById('type1').checked));
document.getElementById('type2').addEventListener("click", () => handleClick("ask_agent_simple",document.getElementById('type2').checked));
document.getElementById('type3').addEventListener("click", () => handleClick("sql",document.getElementById('type3').checked));
document.getElementById('addGeom').addEventListener("click", () => handleClick("geom_agent",document.getElementById('addGeom').checked));

document.getElementById('move').addEventListener("click", () => 
    
    moveEntities(20));


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

            console.log(data.addressObj);

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

            initialize(data.addressObj.longitude,data.addressObj.latitude);

            

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

const form = document.getElementById("form");
form.addEventListener("submit",handleSubmit);

function handleSubmit(e){

    e.preventDefault();
    console.log("I am here");
    uploadFiles();
}

function uploadFiles(){

    const url = 'https://httpbin.org/post';
    const formData = new FormData(form);

    const fetchOptions = {
    method: 'post',
    body: formData
    };

  fetch(url, fetchOptions);

}
// Start the initialization process

// }

const { PDFDocument, StandardFonts, rgb, degrees } = PDFLib ; 

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
        // label: {
        //     text: "P01",
        //     font: "10pt monospace",
        //     style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        //     outlineWidth: 2,
        //     verticalOrigin: Cesium.VerticalOrigin.TOP,
        //     pixelOffset: new Cesium.Cartesian2(0, 32),
        //   },
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
async function initialize(long,lat,powerPlant) {
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
    
    const numCols = 10;            // Number of columns of panels
    const powerModule =450 ;        // Each Module provides 450 w
    const numRows = Math.round((powerPlant/powerModule)/numCols);            // Number of rows of panels

    console.log(numRows);

    const panelSpacing = 0.0001;   // Approx. 11 meters spacing

    const spacingRow = 0.000015; // 
    const spacingCol = 0.00005; // This the spacing between the rows of panels or the pitch.

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
                <p>${longitude.toFixed(6).toString()}<</p>
                </td>
                <td>
                <p>${latitude.toFixed(6)}<</p>
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

async function drawTerrain(){

    viewer.cesiumWidget.screenSpaceEventHandler.removeInputAction(
        Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK,
      );

      function createPoint(worldPosition) {
        const point = viewer.entities.add({
          position: worldPosition,
          point: {
            color: Cesium.Color.WHITE,
            pixelSize: 5,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          },
        });
        return point;
      }
      let drawingMode = "line";
      function drawShape(positionData) {
        let shape;
        if (drawingMode === "line") {
          shape = viewer.entities.add({
            polyline: {
              positions: positionData,
              clampToGround: true,
              width: 3,
            },
          });
        } else if (drawingMode === "polygon") {
          shape = viewer.entities.add({
            polygon: {
              hierarchy: positionData,
              material: new Cesium.ColorMaterialProperty(
                Cesium.Color.WHITE.withAlpha(0.7),
              ),
            },
          });
        }
        return shape;
      }

      let activeShapePoints = [];
let activeShape;
let floatingPoint;
const handler = new Cesium.ScreenSpaceEventHandler(viewer.canvas);
handler.setInputAction(function (event) {
  // We use `viewer.scene.globe.pick here instead of `viewer.camera.pickEllipsoid` so that
  // we get the correct point when mousing over terrain.
  const ray = viewer.camera.getPickRay(event.position);
  const earthPosition = viewer.scene.globe.pick(ray, viewer.scene);
  // `earthPosition` will be undefined if our mouse is not over the globe.
  if (Cesium.defined(earthPosition)) {
    if (activeShapePoints.length === 0) {
      floatingPoint = createPoint(earthPosition);
      activeShapePoints.push(earthPosition);
      const dynamicPositions = new Cesium.CallbackProperty(function () {
        if (drawingMode === "polygon") {
          return new Cesium.PolygonHierarchy(activeShapePoints);
        }
        return activeShapePoints;
      }, false);
      activeShape = drawShape(dynamicPositions);
    }
    activeShapePoints.push(earthPosition);
    createPoint(earthPosition);
  }
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

        handler.setInputAction(function (event) {
        if (Cesium.defined(floatingPoint)) {
            const ray = viewer.camera.getPickRay(event.endPosition);
            const newPosition = viewer.scene.globe.pick(ray, viewer.scene);
            if (Cesium.defined(newPosition)) {
            floatingPoint.position.setValue(newPosition);
            activeShapePoints.pop();
            activeShapePoints.push(newPosition);
            }
        }
        }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
        // Redraw the shape so it's not dynamic and remove the dynamic shape.
        function terminateShape() {
        activeShapePoints.pop();
        drawShape(activeShapePoints);
        viewer.entities.remove(floatingPoint);
        viewer.entities.remove(activeShape);
        floatingPoint = undefined;
        activeShape = undefined;
        activeShapePoints = [];
        }
        handler.setInputAction(function (event) {
        terminateShape();
        }, Cesium.ScreenSpaceEventType.RIGHT_CLICK);

        const options = [
        {
            text: "Draw Lines",
            onselect: function () {
            if (!Cesium.Entity.supportsPolylinesOnTerrain(viewer.scene)) {
                window.alert("This browser does not support polylines on terrain.");
            }

            terminateShape();
            drawingMode = "line";
            },
        },
        {
            text: "Draw Polygons",
            onselect: function () {
            terminateShape();
            drawingMode = "polygon";
            },
        },
        ];

        Sandcastle.addToolbarMenu(options);
        // Zoom in to an area with mountains
        viewer.camera.lookAt(
        Cesium.Cartesian3.fromDegrees(-122.2058, 46.1955, 1000.0),
        new Cesium.Cartesian3(5000.0, 5000.0, 5000.0),
        );
        viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);

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

function reorderPointsClockwise(coords) {
    // Calculate the centroid of the points
    let centerX = 0;
    let centerY = 0;
    const numPoints = coords.length / 2;

    for (let i = 0; i < coords.length; i += 2) {
        centerX += coords[i];
        centerY += coords[i + 1];
    }
    centerX /= numPoints;
    centerY /= numPoints;

    // Calculate angle for each point and sort by angle
    const pointsWithAngles = [];
    for (let i = 0; i < coords.length; i += 2) {
        const x = coords[i];
        const y = coords[i + 1];
        const angle = Math.atan2(y - centerY, x - centerX);
        pointsWithAngles.push({ x, y, angle });
    }

    // Sort points by angle in clockwise order
    pointsWithAngles.sort((a, b) => a.angle - b.angle);

    // Flatten the sorted points back into an array
    const sortedCoords = [];
    for (const point of pointsWithAngles) {
        sortedCoords.push(point.x, point.y);
    }

    // Ensure the polygon is closed by adding the first point at the end
    sortedCoords.push(sortedCoords[0], sortedCoords[1]);

    return sortedCoords;
}

async function drawProperty(array) {

    const arrayTest = [
        -76.031677, 45.416059,
        -76.031227, 45.416209,
        -76.031377, 45.416209,
        -76.031277, 45.416149,
        -76.031527, 45.416119,
        -76.031577, 45.416074,
        -76.031677, 45.416059 // Closing the polygon by repeating the first point
    ];

    const orderedCoords = reorderPointsClockwise(arrayTest);



    try {

        // console.log('This is the array test');
        // console.log(arrayTest);

        console.log('Ordered coordinates:', orderedCoords);
        
        const wyoming = viewer.entities.add({
            polygon: {
              hierarchy: Cesium.Cartesian3.fromDegreesArray(orderedCoords),
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

document.getElementById('remove').addEventListener("click", () => 
    
    removeModels());

document.getElementById('addRob').addEventListener("click", () => 
    
    addrobModel());

document.getElementById('drawPolygon').addEventListener("click", () => 
    
        drawTerrain());

document.getElementById('drawProperty').addEventListener("click", () => 
    
    drawProperty());

    


// Main function to load models and move them after loading


// initialize(-76.0316771,45.4160587,100000);

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
document.getElementById('SolarGeom').addEventListener("click", () => handleClick("solar_agent",document.getElementById('SolarGeom').checked));
document.getElementById('SolarTechnical').addEventListener("click", () => handleClick("solar_technical_agent",document.getElementById('SolarTechnical').checked));


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

            console.log("Your power output is");
            console.log(data.power);

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

            // initialize(data.addressObj.longitude,data.addressObj.latitude);

            initialize(-76.0316771,45.4160587,parseInt(data.power));

            if(data.soilLayer){

                console.log("I am here the calc wizard");
                modifyPdfCalc(data.soilLayer, data.soilFriction, data.soilDepth);

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


////// 

// async function modifyPdf() {
//     // Fetch an existing PDF document
//     const url = './Drawing_1.pdf'
//     const existingPdfBytes = await fetch(url).then(res => res.arrayBuffer())

// // Load a PDFDocument from the existing PDF bytes
// const pdfDoc = await PDFDocument.load(existingPdfBytes)

// // Embed the Helvetica font
// const helveticaFont = await pdfDoc.embedFont(StandardFonts.Helvetica)

// // Get the first page of the document
// const pages = pdfDoc.getPages()
// const firstPage = pages[0]

// // Get the width and height of the first page
// const { width, height } = firstPage.getSize();

// console.log(firstPage.getSize());

// // Draw a string of text diagonally across the first page
// // firstPage.drawText('BV AUGMENTED DRAFT!', {
// //   x: width/2,
// //   y: height / 2,
// //   size: 10,
// //   font: helveticaFont,
// //   color: rgb(0.95, 0.1, 0.1),
// //   rotate: degrees(-45),
// // })

// // Add a table of two columns and two rows 

//     // Define cell width and height
//     const cellWidth = 150;
//     const cellHeight = 30;
  
//     // Define table's top-left corner position
//     const startX = width/2;
//     const startY = height/2;

//     for(let i=0;i<polygonArray.length/2;i++){

//         // Draw table cells as rectangles
//         firstPage.drawRectangle({
//         x: startX,
//         y: startY- cellHeight*i,
//         width: cellWidth,
//         height: cellHeight,
//         borderColor: rgb(0, 0, 0),
//         borderWidth: 1,
//         rotate: degrees(90),

//       });

//       firstPage.drawRectangle({
//         x: startX + cellWidth,
//         y: startY- cellHeight*i,
//         width: cellWidth,
//         height: cellHeight,
//         borderColor: rgb(0, 0, 0),
//         borderWidth: 1,
//         rotate: degrees(90),

//       });

//       firstPage.drawText(polygonArray[2*i].toFixed(5).toString(), {
//       x: startX + 10,
//       y: startY - cellHeight*(i+1)+10 ,
//       size: 10,
//       color: rgb(0, 0, 0),
//       rotate: degrees(90),

//     });
//     firstPage.drawText(polygonArray[2*i+1].toFixed(5).toString(), {
//       x: startX + cellWidth + 10,
//       y: startY - cellHeight*(i+1) +10,
//       size: 10,
//       color: rgb(0, 0, 0),
//       rotate: degrees(90),

//     });


//     }
  
  
//     // Add text to each cell
//     firstPage.drawText('Pile Longitude', {
//       x: startX + 10,
//       y: startY +10,
//       size: 10,
//       color: rgb(0, 0, 0),
//       rotate: degrees(90),

//     });
//     firstPage.drawText('Pile Latitude', {
//       x: startX + cellWidth + 10,
//       y: startY +10,
//       size: 10,
//       color: rgb(0, 0, 0),
//       rotate: degrees(90),

//     });

// // Serialize the PDFDocument to bytes (a Uint8Array)
// const pdfBytes = await pdfDoc.save()

//       // Trigger the browser to download the PDF document
// download(pdfBytes, "pdf-lib_modification_example.pdf", "application/pdf");


// }


async function modifyPdf() {
    // Fetch an existing PDF document
    const url = './Drawing_1.pdf'
    const existingPdfBytes = await fetch(url).then(res => res.arrayBuffer()) ;

    const pngUrl = './Sketch.png';
    const pngImageBytes = await fetch(pngUrl).then((res) => res.arrayBuffer());

   

// Load a PDFDocument from the existing PDF bytes
const pdfDoc = await PDFDocument.load(existingPdfBytes);

// Load an Image 

const pngImage = await pdfDoc.embedPng(pngImageBytes);
const pngDims = pngImage.scale(1);

// Embed the Helvetica font
const helveticaFont = await pdfDoc.embedFont(StandardFonts.Helvetica)

// Get the first page of the document
const pages = pdfDoc.getPages()
const firstPage = pages[0]

// Get the width and height of the first page
const { width, height } = firstPage.getSize();

console.log(firstPage.getSize());

// Draw a string of text diagonally across the first page
// firstPage.drawText('BV AUGMENTED DRAFT!', {
//   x: width/2,
//   y: height / 2,
//   size: 10,
//   font: helveticaFont,
//   color: rgb(0.95, 0.1, 0.1),
//   rotate: degrees(90),
// })

// Add a table of two columns and two rows 

    // Define cell width and height
    const cellWidth = 150;
    const cellHeight = 30;
  
    // Define table's top-left corner position
    // Higher x is pushing the table to the right
    // Lower Y is pushing the table to the top 

    const startX = 5*width/6;
    const startY = height/10;

    for(let i=0;i<polygonArray.length/2;i++){

        // Draw table cells as rectangles
        firstPage.drawRectangle({
        y: startX,
        x: startY+ cellHeight*i,
        width: cellWidth,
        height: cellHeight,
        borderColor: rgb(0, 0, 0),
        borderWidth: 1,
        rotate: degrees(90),

      });

      firstPage.drawRectangle({
        y: startX + cellWidth,
        x: startY+ cellHeight*i,
        width: cellWidth,
        height: cellHeight,
        borderColor: rgb(0, 0, 0),
        borderWidth: 1,
        rotate: degrees(90),

      });

      firstPage.drawText(polygonArray[2*i].toFixed(5).toString(), {
      y: startX + 10,
      x: startY + cellHeight*(i+1)+10 ,
      size: 10,
      color: rgb(0, 0, 0),
      rotate: degrees(90),

    });
    firstPage.drawText(polygonArray[2*i+1].toFixed(5).toString(), {
      y: startX + cellWidth + 10,
      x: startY + cellHeight*(i+1) +10,
      size: 10,
      color: rgb(0, 0, 0),
      rotate: degrees(90),

    });


    }
  
  
    // Add text to each cell
    firstPage.drawText('Pile Longitude', {
      y: startX + 10,
      x: startY +10,
      size: 12,
      color: rgb(0, 0, 0),
      rotate: degrees(90),

    });
    firstPage.drawText('Pile Latitude', {
      y: startX + cellWidth + 10,
      x: startY +10,
      size: 12,
      color: rgb(0, 0, 0),
      rotate: degrees(90),

    });

      // })
   firstPage.drawImage(pngImage, {
    x: firstPage.getWidth() * 3/6 ,
    y: firstPage.getHeight() /10 ,
    width: pngDims.width,
    height: pngDims.height,
    rotate: degrees(90)
  })

// Serialize the PDFDocument to bytes (a Uint8Array)
const pdfBytes = await pdfDoc.save()

      // Trigger the browser to download the PDF document
download(pdfBytes, "Layout-Solar.pdf", "application/pdf");


}




async function modifyPdfCalc(numsoilLayers, soilFriction, soilDepth) {
    // Fetch an existing PDF document
    const url = './Pile_Embedment_Calculation.pdf'
    const existingPdfBytes = await fetch(url).then(res => res.arrayBuffer())

// Load a PDFDocument from the existing PDF bytes
const pdfDoc = await PDFDocument.load(existingPdfBytes)

// Embed the Helvetica font
const helveticaFont = await pdfDoc.embedFont(StandardFonts.Helvetica)

// Get the first page of the document
const pages = pdfDoc.getPages()
const firstPage = pages[0]

// Get the width and height of the first page
const { width, height } = firstPage.getSize();

console.log(firstPage.getSize());

// Draw a string of text diagonally across the first page
firstPage.drawText('BV AUGMENTED DRAFT!', {
  x: width/2,
  y: height / 2,
  size: 10,
  font: helveticaFont,
  color: rgb(0.95, 0.1, 0.1),
  rotate: degrees(-45),
})

// Add a table of two columns and two rows 

    // Define cell width and height
    const cellWidth = 100;
    const cellHeight = 20;
  
    // Define table's top-left corner position
    const startX = 0.5*width/6;
    const startY = 4.5*height/6;

    let upperbound = parseInt(numsoilLayers)+1;

    for(let i=1;i<upperbound;i++){

        // Draw table cells as rectangles
        firstPage.drawRectangle({
        x: startX,
        y: startY- cellHeight*i,
        width: cellWidth,
        height: cellHeight,
        borderColor: rgb(0, 0, 0),
        borderWidth: 1,

      });

      firstPage.drawRectangle({
        x: startX + cellWidth,
        y: startY- cellHeight*i,
        width: cellWidth,
        height: cellHeight,
        borderColor: rgb(0, 0, 0),
        borderWidth: 1,

      });

      firstPage.drawRectangle({
        x: startX + 2*cellWidth,
        y: startY- cellHeight*i,
        width: cellWidth,
        height: cellHeight,
        borderColor: rgb(0, 0, 0),
        borderWidth: 1,

      });

      firstPage.drawText(`Layer : ${i}`, {
      x: startX + 10,
      y: startY - cellHeight*(i)+10 ,
      size: 8,
      color: rgb(0, 0, 0),

    });
    firstPage.drawText(`${soilFriction}`, {
      x: startX + cellWidth + 10,
      y: startY - cellHeight*(i) +10,
      size: 8,
      color: rgb(0, 0, 0),

    });

    firstPage.drawText(`${soilDepth}`, {
        x: startX + 2*cellWidth + 10,
        y: startY - cellHeight*(i) +10,
        size: 8,
        color: rgb(0, 0, 0),
  
      });


    }

    firstPage.drawRectangle({
        x: startX,
        y: startY,
        width: cellWidth,
        height: cellHeight,
        borderColor: rgb(0, 0, 0),
        borderWidth: 1,

      });

      firstPage.drawRectangle({
        x: startX + cellWidth,
        y: startY,
        width: cellWidth,
        height: cellHeight,
        borderColor: rgb(0, 0, 0),
        borderWidth: 1,

      });

      firstPage.drawRectangle({
        x: startX + 2*cellWidth,
        y: startY,
        width: cellWidth,
        height: cellHeight,
        borderColor: rgb(0, 0, 0),
        borderWidth: 1,

      });
  
  
    // Add text to each cell
    firstPage.drawText('Layer', {
      x: startX + 10,
      y: startY +10,
      size: 8,
      color: rgb(0, 0, 0),

    });
    firstPage.drawText('Skin Fricition (psf)', {
      x: startX + cellWidth + 10,
      y: startY +10,
      size: 8,
      color: rgb(0, 0, 0),

    });

    firstPage.drawText('Layer Depth (ft)', {
        x: startX + 2*cellWidth + 10,
        y: startY +10,
        size: 8,
        color: rgb(0, 0, 0),
  
      });

// Serialize the PDFDocument to bytes (a Uint8Array)
const pdfBytes = await pdfDoc.save()

      // Trigger the browser to download the PDF document
download(pdfBytes, "pdf-lib_modification_example.pdf", "application/pdf");


}




document.getElementById('PDF').addEventListener("click", () => 
    
    modifyPdf());

document.getElementById('PDFCalc').addEventListener("click", () => 
    
    modifyPdfCalc());
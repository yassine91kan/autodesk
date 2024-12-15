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

let entityNumber =0 ; 

function addTurbine(viewer,longitude,latitude,height){

    // const entity = viewer.entities.add({
      loadedEntities[entityNumber] = viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(longitude, latitude,height),
        model: {
          uri: './assets/glTf/solar_panel_new/solar_panel_compressed/scene.gltf',
        },
        // label: {
        //     text: "P01",
        //     font: "10pt monospace",
        //     style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        //     outlineWidth: 2,
        //     verticalOrigin: Cesium.VerticalOrigin.TOP,
        //     pixelOffset: new Cesium.Cartesian2(0, 32),
        //   },
        // show: false, // Initially hidden
      });

      entityNumber++;

      // loadedEntities.push(entity);
}

let i=0;
let citizensBankPark=[];
let pointArrayNew ;

function addPoint (long,lat){

    console.log("I am adding this point");
    console.log(long);
    console.log(lat);

    i++;



    citizensBankPark[i] = viewer.entities.add({
        position : Cesium.Cartesian3.fromDegrees(long, lat, 33),
        point : {
          color : Cesium.Color.YELLOW,
          pixelSize : 8
        },
        show: true, // Initially hidden
        clampToGround: true,
        label: {
            text: `P${i}`,
            font: "12pt monospace",
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            outlineWidth: 12,
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          },
      });

      console.log(citizensBankPark);

}

// Function to check if a point is inside a polygon // RayCasting Algorithm

function isPointInPolygon(point, polygon) {
  const [x, y] = point;
  let isInside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const [xi, yi] = polygon[i];
      const [xj, yj] = polygon[j];
      const intersect = ((yi > y) !== (yj > y)) && 
                        (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
      if (intersect) isInside = !isInside;
  }
  console.log("The point is not inside");
  return isInside;
}

let powerModule =450 ;        // Each Module provides 450 w
let powerReq = 1 ;
let powerNum = 1;

// Function to initialize the viewer and add the solar panels
async function initialize(long,lat,powerPlant) {
    // Example: Geocode an address and fly to its location
    // const addressData = await geocodeAddress("1251 Thomas A. Dolan Pkwy, Dunrobin, Ontario");
    // console.log("Geocoded Address:", addressData);
// ];

const propertyLine=[[-76.031671, 45.4160587], 
  [-76.031671, 45.4160587], 
  [-76.0312271, 45.4160587], 
  [-76.0312271, 45.4162387], 
  [-76.031671, 45.4162387], 
  [-76.031671, 45.4160587]];

    // const addressData = {"longitude":-76.0316771,"latitude":45.4160587}
    // The corresponding address is : 1251 Thomas Dolan Parkway, Ottawa, Canada
    const addressData = {"longitude":long,"latitude":lat}
    console.log(addressData);

    viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(addressData.longitude, addressData.latitude, 40),
        orientation: {
            heading: Cesium.Math.toRadians(0.0),
            pitch: Cesium.Math.toRadians(0.0),
        }
    });

    // Add a grid of solar panels near the geocoded location
    
    const numCols = 10;            // Number of columns of panels
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

    powerReq = powerPlant;
    powerNum = powerReq/ powerModule;

    for (let row = 0; row < numRows; row++) {
        for (let col = 0; col < numCols; col++) {
            const longitude = startLongitude + col * spacingCol;
            const latitude = startLatitude + row * spacingRow;

              // Check if the point is inside the property line polygon
              // if (!isPointInPolygon([longitude, latitude], propertyLine)) {
              //     addPoint (longitude,latitude)
              //     continue; // Skip this panel if it is outside the property line
              // }

            polygonArray.push(longitude);
            polygonArray.push(latitude);

            const height = 33.00;  // You can adjust the height
            const rowNumber ="0100";
            pileNumber +=1;

            if (row === 0 || row % 4 === 0) {

              pointArray.push({"longitude":longitude,"latitude":latitude});

              // pointArrayNew.push(longitude);
              // pointArrayNew.push(latitude);

              addPoint(longitude,latitude);



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
                <p>${longitude.toFixed(5)}<</p>
                </td>
                <td>
                <p>${latitude.toFixed(5)}<</p>
                </td>
            </tr>
            `

            }

            



            // Add each solar panel to the scene
            // addSolarPanel(viewer, longitude, latitude, height);
            // promises.push(addSolarPanel(viewer, longitude, latitude, height));
            // promises.push(addPoint (longitude,latitude));


            // promises.push(addTurbine(viewer,longitude,latitude,height));
            
        
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

        console.log("These are the loaded entities");
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
        console.log("This is the new point array");
        console.log(pointArray);

        let bouboxArray = await BoundaryBox(pointArray);

        console.log(bouboxArray);

        // drawPolygon(polygonArray);
        // drawPolygon(bouboxArray);

   
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

async function addInstancing(long,lat,powerPlant){


const propertyLine=[[-76.031671, 45.4160587], 
[-76.031671, 45.4160587], 
[-76.0312271, 45.4160587], 
[-76.0312271, 45.4162387], 
[-76.031671, 45.4162387], 
[-76.031671, 45.4160587]];

  const addressData = {"longitude":long,"latitude":lat}
  console.log(addressData);

  viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(addressData.longitude, addressData.latitude, 40),
      orientation: {
          heading: Cesium.Math.toRadians(0.0),
          pitch: Cesium.Math.toRadians(0.0),
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

  const instances = [];

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
          instances.push({
            modelMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(
                Cesium.Cartesian3.fromDegrees(longitude, latitude, height)
            )
        });
          // promises.push(addPoint (longitude,latitude));
          promises.push(addTurbine(viewer,longitude,latitude,height));
      
  }
}

    const instancedModel = Cesium.ModelInstanceCollection.fromGltf({
      uri: './assets/glTf/solar_panel_new/solar_panel_compressed/scene.gltf',
      instances: instances
    });

    viewer.scene.primitives.add(instancedModel);


      // Wait for all models to load before moving them
      // await Promise.all(promises);
      console.log("All solar panels have been loaded.");
 





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

    const coordRob ={"longitude":-76.0316771,"latitude":45.4160587,"height":34.2};

      //   [[-76.031671, 45.4160587], 
      // [-76.031671, 45.4160587], 
      // [-76.0314271, 45.4160587], 
      // [-76.0312271, 45.4162387], 
      // [-76.031671, 45.4162387], 
      // [-76.031671, 45.4160587]];

    try {


          const pilePositions = [
            Cesium.Cartesian3.fromDegrees(-76.031671, 45.4160587, 34.2),
            Cesium.Cartesian3.fromDegrees(-76.0314271, 45.4160587, 34.2),
            Cesium.Cartesian3.fromDegrees(-76.031671, 45.4162387, 34.2),
            // Add more pile positions
        ];

        const driverPath = new Cesium.SampledPositionProperty();

        const startTime = Cesium.JulianDate.now();
        let timeOffset = 0; // Time offset for each waypoint (in seconds)

        pilePositions.forEach((position) => {
            const time = Cesium.JulianDate.addSeconds(startTime, timeOffset, new Cesium.JulianDate());
            driverPath.addSample(time, position);
            timeOffset += 5; // 5 seconds between each waypoint

        const pileDriver  = viewer.entities.add({
              position: driverPath,
              model: {
                uri: './assets/glTf/excavator_robo_enlarged/scene.gltf',
              },
              label: {
                  text: "Robotic Pile",
                  font: "10pt monospace",
                  style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                  outlineWidth: 2,
                  verticalOrigin: Cesium.VerticalOrigin.TOP,
                  pixelOffset: new Cesium.Cartesian2(0, 32),
                },
                scale: 100,
                orientation: new Cesium.VelocityOrientationProperty(driverPath), // Makes it face the direction of movement
            });
        
        viewer.entities.add({
              polyline: {
                  positions: pilePositions,
                  width: 2,
                  material: Cesium.Color.YELLOW,
                  clampToGround: true,
              },
          });

          viewer.clock.startTime = startTime;
          viewer.clock.stopTime = Cesium.JulianDate.addSeconds(startTime, timeOffset, new Cesium.JulianDate());
          viewer.clock.currentTime = startTime;
          viewer.clock.clockRange = Cesium.ClockRange.LOOP_STOP; // Loop the simulation
          viewer.clock.multiplier = 1; // Adjust speed multiplier

          viewer.clock.onTick.addEventListener(() => {
            const currentPosition = driverPath.getValue(viewer.clock.currentTime);
            if (currentPosition) {
                console.log('Current Position:', Cesium.Cartographic.fromCartesian(currentPosition));
            }
        });
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

    // const arrayTest = [
    //     -76.031677, 45.416059,
    //     -76.031227, 45.416209,
    //     -76.031377, 45.416209,
    //     -76.031277, 45.416149,
    //     -76.031527, 45.416119,
    //     -76.031577, 45.416074,
    //     -76.031677, 45.416059 // Closing the polygon by repeating the first point
    // ];


    const arrayTest = [
      -76.031671, 45.4160587,
      -76.0312271, 45.4160587,
      -76.031671, 45.4162387,
      -76.0312271, 45.4162387,
      -76.031671, 45.4160587 // Closing the polygon by repeating the first point
  ];

    const orderedCoords = reorderPointsClockwise(arrayTest);



    try {

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



document.getElementById('drawPolygon').addEventListener("click", () => 
    
        drawTerrain());

document.getElementById('drawProperty').addEventListener("click", () => 
    
    drawProperty());

function getPolygonBounds(polygon) {

      let minLon = Number.POSITIVE_INFINITY, minLat = Number.POSITIVE_INFINITY;
      let maxLon = Number.NEGATIVE_INFINITY, maxLat = Number.NEGATIVE_INFINITY;
  
      for (const [lon, lat] of polygon) {
          if (lon < minLon) minLon = lon;
          if (lat < minLat) minLat = lat;
          if (lon > maxLon) maxLon = lon;
          if (lat > maxLat) maxLat = lat;
      }
  
      return { minLon, minLat, maxLon, maxLat };
  }
    
async function generatePanelsInPolygon(viewer, propertyLine, powerPlant) {

      const numCols = 10;                // Number of columns of panels
      const powerModule = 450;           // Power per module (Watts)
      const numRows = Math.round((powerPlant / powerModule) / numCols); // Calculate rows dynamically
  
      const spacingRow = 0.000015;       // Spacing between rows (latitude)
      const spacingCol = 0.00005;        // Spacing between columns (longitude)
  
      const bounds = getPolygonBounds(propertyLine); // Function to calculate polygon bounds
      const panels = [];
      const promises = [];
  
      let pileNumber = 0;
  
      // Iterate through the grid within the polygon bounds
      for (let lat = bounds.minLat; lat <= bounds.maxLat; lat += spacingRow) {
          for (let lon = bounds.minLon; lon <= bounds.maxLon; lon += spacingCol) {
              // Check if the point is within the property line polygon
              const point = [lon, lat];

              if (isPointInPolygon(point, propertyLine)) {
                  // Add panel data to the array
                  pileNumber += 1;
                  panels.push({ longitude: lon, latitude: lat });
  
                  // Add a visual representation in CesiumJS
                  promises.push(addSolarPanel(viewer, lon, lat, 33.53));
  
                  // Optionally add the point to a table
                  document.querySelector('#table_pile').innerHTML += `
                  <tr>
                      <td>
                          <div class="check-input-primary">
                              <input class="form-check-input" type="checkbox" id="checkbox-${pileNumber}" />
                          </div>
                      </td>
                      <td><p>${pileNumber}</p></td>
                      <td><p>Steel Pile</p></td>
                      <td><p>${lon.toFixed(6)}</p></td>
                      <td><p>${lat.toFixed(6)}</p></td>
                      <td><p>Some Value</p></td>
                      <td>
                          <div class="action">
                              <button class="text-danger" onclick="removeRow(this)">
                                  <i class="lni lni-trash-can"></i>
                              </button>
                          </div>
                      </td>
                  </tr>`;
              }
          }
      }
  
      // Wait for all models to load
      await Promise.all(promises);
      console.log("Panels generated inside the polygon:", panels);
      return panels;
  }

  const propertyLine=[[-76.031671, 45.4160587], 
  [-76.031671, 45.4160587], 
  [-76.0314271, 45.4160587], 
  [-76.0312271, 45.4162387], 
  [-76.031671, 45.4162387], 
  [-76.031671, 45.4160587]];

  // [{-76.031671, 45.4160587}, 
  // {-76.031671, 45.4160587}, 
  // {-76.0314271, 45.4160587}, 
  // {-76.0312271, 45.4162387}, 
  // {-76.031671, 45.4162387}, 
  // {-76.031671, 45.4160587}];

  // [
  //   { "longitude": -76.031671, "latitude": 45.4160587 },
  //   { "longitude": -76.031671, "latitude": 45.4160587 },
  //   { "longitude": -76.0314271, "latitude": 45.4160587 },
  //   { "longitude": -76.0312271, "latitude": 45.4162387 },
  //   { "longitude": -76.031671, "latitude": 45.4162387 },
  //   { "longitude": -76.031671, "latitude": 45.4160587 }
  // ]

  
  // for (let i=0;i<propertyLine.length;i++){

  //   addPoint(propertyLine[i][0],propertyLine[i][1]);
  // }

  document.getElementById('LayoutGen').addEventListener("click", () => 
      
    generatePanelsInPolygon(viewer,propertyLine,100000)

  );

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
// document.getElementById('addGeom').addEventListener("click", () => handleClick("geom_agent",document.getElementById('addGeom').checked));
document.getElementById('SolarGeom').addEventListener("click", () => handleClick("solar_agent",document.getElementById('SolarGeom').checked));
document.getElementById('SolarTechnical').addEventListener("click", () => handleClick("solar_technical_agent",document.getElementById('SolarTechnical').checked));
document.getElementById('SolarSim').addEventListener("click", () => handleClick("solar_agent_simulation",document.getElementById('SolarSim').checked));


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
            // document.getElementById('gpt_response').innerHTML+=text;

            document.getElementById("loader").style.display="none";

            document.getElementById("promptInput").innerHTML +=
            `<div class="author" id="promptOutputMain"><img src="./assets/images/robot.svg" alt="" class="fn__svg" /></div>
            <div>
            <p id="gpt_response">
              ${text}
            </p></div>`;
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

            // console.log(data.message);

            // console.log("Your power output is");
            // console.log(data.power);

            // console.log(data.token);

            let customItems = data.message;
            customItems = customItems.split("\n");

            for (let i = 0; i < customItems.length; i++) {
            customItems[i] =  customItems[i] + "<br>";
            }

            customItems = customItems.join("");

            // document.getElementById('gpt_response').innerHTML=customItems;

            document.getElementById("loader").style.display="none";

            document.getElementById("promptInput").innerHTML +=
            `<div class="author" id="promptOutputMain"><img src="./assets/images/robot.svg" alt="" class="fn__svg" /></div>
            <div>
            <p id="gpt_response">
              ${customItems}
            </p></div>`;

            if(data.token){

                document.getElementById('compToken').innerHTML=data.token.completionTokens;
                document.getElementById('promptToken').innerHTML=data.token.promptTokens ;
            }

            // initialize(data.addressObj.longitude,data.addressObj.latitude);

            if(!data.coordinates && !data.resultConfiguration){

              console.log(data.coordinates);
              // initialize(-76.0316771,45.4160587,parseInt(data.power));

              initialize(-76.03116520703031,45.41641802447001,parseInt(data.power));

              // addInstancing(-76.0316771,45.4160587,parseInt(data.power));
            }

            if(data.resultConfiguration){

              calculateOptimizedPath(pointArray);

              animatePileDriver(optimizedPath, pileDriver, 1);
            }

            

            if(data.soilLayer){

                console.log("I am here the calc wizard");
                modifyPdfCalc(data.soilLayer, data.soilFriction, data.soilDepth,data.embedment);

            }

            
            if(data.totalCapacity){

                console.log("data.totalCapacity");
                modifyPdfCalcPile(data.totalCapacity.toString("0.00"), data.loadAx, data.MomentX, data.MomentY);

            }

            if(data.coordinates){

              console.log(`These are the coordinates of the plant : ${data.coordinates}`);

              let jsonObject = JSON.parse(data.coordinates);

              const outputArray = jsonObject.map(({ longitude, latitude }) => [longitude, latitude]);

              generatePanelsInPolygon(viewer,outputArray,100000);

              console.log(jsonObject);
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

      document.getElementById("loader").style.display="block";

      document.getElementById("promptInput").innerHTML +=
      `<div class="author" id="promptInputMain"><img src="./assets/images/user.svg" alt="" class="fn__svg" /></div>
      <div id="input_contain">
      <p id="gpt_input">
        ${document.querySelector('#fname').value}
      </p></div>`;
 
    getopenai(document.querySelector('#fname').value);

    document.getElementById("fname").value="";

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


let finX ;  
let finY ; 

function createTable(numRows,titleLeft,titleRight,width,height,firstPage,arrayLeft,arrayRight){

    // Add a table of two columns and two rows 

    // Define cell width and height
    const cellWidth = 120;
    const cellHeight = 20;
  
    // Define table's top-left corner position

      
        let startX = 0.5*width/6;
        let startY = 4.5*height/6;

        if(finX){

            console.log(finY);
            console.log(finX);

            startX = finY;
            startY = finX;

            console.log("I am checking here 2");

        }

    let loadVar;
    let loadVal;

    // let upperbound = parseInt(numsoilLayers)+1;

    for(let i=1;i<numRows+1;i++){

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

      loadVar= arrayLeft[i-1];
      loadVal = arrayRight[i-1];



    //   switch(i){

    //     case 1:
    //         loadVar=array;
    //         break;
    //     case 2:
    //         loadVar="Moment Mx (kips*ft)";
    //         break;
    //     case 3:
    //         loadVar="Moment My (kips*ft)";
    //         break;
    //     default:
    //         loadVar="Axial";

    //   }


      firstPage.drawText(`${loadVar}`, {
      x: startX + 10,
      y: startY - cellHeight*(i)+10 ,
      size: 8,
      color: rgb(0, 0, 0),

    });
    firstPage.drawText(`${loadVal}`, {
      x: startX + cellWidth + 10,
      y: startY - cellHeight*(i) +10,
      size: 8,
      color: rgb(0, 0, 0),

    });


      finY = startX ;
      finX = startY - cellHeight*(i+1) -10;


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


  
  
    // Add text to each cell
    firstPage.drawText(titleLeft, {
      x: startX + 10,
      y: startY +10,
      size: 8,
      color: rgb(0, 0, 0),

    });
    firstPage.drawText(titleRight, {
      x: startX + cellWidth + 10,
      y: startY +10,
      size: 8,
      color: rgb(0, 0, 0),

    });



}

function createText(text,gap,firstPage){

  if(!finY){
    let finY = 0.5*612/6;
    let finX = 4.5*792/6;
  }

 firstPage.drawText(text, {
  x: finY+gap,
  y: finX-gap,
  size: 10,
  color: rgb(0, 0, 0),
});

finY = finY ;
finX = finX - 30  ;

console.log(finY);
console.log(finX);

}

function addGap(a,b,c){

  a=a+c ;
  b=b+c;

}

// async function ScreenShot(){

//   const captureElement = document.getElementById("cesiumContainer");
//   html2canvas(captureElement).then(canvas => {
//       // Convert canvas to image
//       const image = canvas.toDataURL("image/png");

//       // Create a download link
//       const link = document.createElement("a");
//       link.href = image;
//       link.download = "screenshot.png";

//       // Trigger download
//       link.click();

//       return image;
//   });
  
// }

async function ScreenShot() {
  const cesiumCanvas = document.querySelector("#cesiumContainer canvas");
  if (!cesiumCanvas) {
    console.error("WebGL canvas not found!");
    return;
  }

  // Wait for the next animation frame to ensure rendering is complete
  await new Promise((resolve) => requestAnimationFrame(resolve));

  // Capture the canvas as an image
  const image = cesiumCanvas.toDataURL("image/png");

  // // Optional: Download the screenshot
  // const link = document.createElement("a");
  // link.href = image;
  // link.download = "screenshot.png";
  // link.click();

  return image; // Return the Base64 image
}
async function modifyPdf() {
    // Fetch an existing PDF document
    const url = './Drawing_1.pdf'
    const existingPdfBytes = await fetch(url).then(res => res.arrayBuffer()) ;

const base64Image = await ScreenShot();

// Convert Base64 to Uint8Array for embedding in PDF-lib
const pngImageBytes = Uint8Array.from(atob(base64Image.split(",")[1]), (c) => c.charCodeAt(0));


// Load a PDFDocument from the existing PDF bytes
const pdfDoc = await PDFDocument.load(existingPdfBytes);

// Load an Image 

const pngImage = await pdfDoc.embedPng(pngImageBytes);
const pngDims = pngImage.scale(1);

// Embed the Helvetica font
const helveticaFont = await pdfDoc.embedFont(StandardFonts.Helvetica)

// Get the first page of the document
const pages = pdfDoc.getPages() ;
const firstPage = pages[0] ; 

// Get the width and height of the first page
const { width, height } = firstPage.getSize();

console.log(firstPage.getSize());

// Add a table of two columns and two rows 

    // Define cell width and height
    const cellWidth = 150;
    const cellHeight = 30;
  
    // Define table's top-left corner position
    // Higher x is pushing the table to the right
    // Lower Y is pushing the table to the top 

    const startX = 5*width/6;
    const startY = height/10;

    for(let i=1;i<40;i++){

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
      x: startY + cellHeight*(i)+13 ,
      size: 12,
      color: rgb(0, 0, 0),
      rotate: degrees(90),

    });
    firstPage.drawText(polygonArray[2*i+1].toFixed(5).toString(), {
      y: startX + cellWidth + 10,
      x: startY + cellHeight*(i) +13,
      size: 12,
      color: rgb(0, 0, 0),
      rotate: degrees(90),

    });

    }

            // Draw table cells as rectangles
            firstPage.drawRectangle({
              y: startX,
              x: startY+ cellHeight*40,
              width: cellWidth,
              height: cellHeight,
              borderColor: rgb(0, 0, 0),
              borderWidth: 1,
              rotate: degrees(90),
      
            });
      
            firstPage.drawRectangle({
              y: startX + cellWidth,
              x: startY+ cellHeight*40,
              width: cellWidth,
              height: cellHeight,
              borderColor: rgb(0, 0, 0),
              borderWidth: 1,
              rotate: degrees(90),
      
            });
  
  
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
  });


  firstPage.drawText('Plan View - Solar Layout', {
    x: firstPage.getWidth() * 3.1/6,
    y: firstPage.getHeight() /10,
    size: 16,   
    color: rgb(0, 0, 0),
    rotate: degrees(90),

  });



  let startXN = firstPage.getWidth() * 3.5/6; 
  let startYN =firstPage.getHeight() /10 ; 

  let parameterArray = ["Site","Characteristics","Longitude","11","Latitude","5.2555","Module Power",`${powerModule.toString()}`,"Number of Panels",`${powerNum.toFixed(0)}`,"Panel Manufacturer","TBD","Type","SAT"]


  for(let i=0;i<7;i++){



    // Draw table cells as rectangles
    firstPage.drawRectangle({
    y: startYN,
    x: startXN + cellHeight*i,
    width: cellWidth,
    height: cellHeight,
    borderColor: rgb(0, 0, 0),
    borderWidth: 1,
    rotate: degrees(90),

  });

  firstPage.drawRectangle({
    y: startYN + cellWidth,
    x: startXN+ cellHeight*i,
    width: cellWidth,
    height: cellHeight,
    borderColor: rgb(0, 0, 0),
    borderWidth: 1,
    rotate: degrees(90),

  });

  firstPage.drawText(parameterArray[2*i], {
  y: startYN + 14,
  x: startXN + cellHeight*(i) -5,
  size: 14,
  color: rgb(0, 0, 0),
  rotate: degrees(90),

});
firstPage.drawText(parameterArray[2*i+1], {
  y: startYN + cellWidth + 10,
  x: startXN + cellHeight*(i)-5,
  size: 14,
  color: rgb(0, 0, 0),
  rotate: degrees(90),

});

}




// Serialize the PDFDocument to bytes (a Uint8Array)
const pdfBytes = await pdfDoc.save()

      // Trigger the browser to download the PDF document
download(pdfBytes, "Layout-Solar.pdf", "application/pdf");

viewer.scene.render();

  ScreenShot();



}




async function modifyPdfCalc(numsoilLayers, soilFriction, soilDepth, embedment) {
    // Fetch an existing PDF document
    const url = './Solar_Pile_Design.pdf'
    const existingPdfBytes = await fetch(url).then(res => res.arrayBuffer())

// Load a PDFDocument from the existing PDF bytes
const pdfDoc = await PDFDocument.load(existingPdfBytes)

// Embed the Helvetica font
const helveticaFont = await pdfDoc.embedFont(StandardFonts.Helvetica)

// Get the first page of the document
const pages = pdfDoc.getPages()
const firstPage = pages[1]

// Get the width and height of the first page
const { width, height } = firstPage.getSize();

console.log(firstPage.getSize());

// Draw a string of text diagonally across the first page

// Add a table of two columns and two rows 

    // Define cell width and height
    const cellWidth = 100;
    const cellHeight = 20;
  
    // Define table's top-left corner position
    const startX = 0.5*width/6;
    const startY = 4.5*height/6;

    console.log(`The width is : ${width}`);
    console.log(`The height is : ${height}`);

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

      finY = startX + 10;
      finX = startY - cellHeight*(i+1) -10;


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



      firstPage.drawText(`Embedment Total Force (kips) is ${embedment} `, {
        y: finX,
        x: finY,
        size: 8,
        color: rgb(0, 0, 0),
    
      });

// Serialize the PDFDocument to bytes (a Uint8Array)
const pdfBytes = await pdfDoc.save()

      // Trigger the browser to download the PDF document
download(pdfBytes, "pdf-lib_modification_example.pdf", "application/pdf");


}

async function modifyPdfCalcPile(totalCap, loadAx, MomentX, MomentY) {
    // Fetch an existing PDF document
    const url = './Solar_Pile_Design.pdf'
    const existingPdfBytes = await fetch(url).then(res => res.arrayBuffer())

// Load a PDFDocument from the existing PDF bytes
const pdfDoc = await PDFDocument.load(existingPdfBytes)

// Embed the Helvetica font
const helveticaFont = await pdfDoc.embedFont(StandardFonts.Helvetica)

// Get the first page of the document
const pages = pdfDoc.getPages();
const firstPage = pages[0];

// Get the width and height of the first page
const { width, height } = firstPage.getSize();

const arrayLeft = ["Axial load Px (kips)","Moment Mx (kips*ft)", "Moment My (kips*ft)"];
const arrayRight = [loadAx,MomentX,MomentY];

const arrayLeft_1 = ["Axial Resistance Px (kips)","Mx Resistance (kips*ft)", "My Resistance (kips*ft)"];
const arrayRight_1 = [loadAx,MomentX,MomentY];

console.log(firstPage.getSize());

const arrayLeft_2 = ["Fy (ksi)","Fu (ksi)", "Unbraced Length (ft)", "K Factor"];
const arrayRight_2 = ["50","65","14","1"];

// createText("The resistance values for this specific section are :",0,firstPage);

createTable(4,"Parameter","Value",width,height,firstPage,arrayLeft_2,arrayRight_2);

createText("The resistance values for this specific section are :",0,firstPage);

createTable(3,"Load","Value",width,height,firstPage,arrayLeft_1,arrayRight_1);

createText("Then, we have the loading conditions provided by the user are :",0,firstPage);

createTable(3,"Load","Value",width,height,firstPage,arrayLeft,arrayRight);

createText("The following equation is checked per Code requirements:",0,firstPage);

createText("UR = Px/Pr + 8/9* (Mx/Mrx + My/Mry)  <= 1       (AISC 360, Eq H1-1a)",0,firstPage);

createText(`UR = ${totalCap} `,0,firstPage);





// Serialize the PDFDocument to bytes (a Uint8Array)
const pdfBytes = await pdfDoc.save()

      // Trigger the browser to download the PDF document
download(pdfBytes, "pdf-lib_modification_example.pdf", "application/pdf");


}

let currentPileIndex = 1;

// function showNextPile(pileEntities) {
//     if (currentPileIndex < pileEntities.length) {
//         pileEntities[currentPileIndex+1].show = true;
//         currentPileIndex++;

//         // Schedule the next pile to appear after a delay
        
//     }
//     setTimeout(showNextPile(pileEntities) , 50000); // Adjust delay (1000ms = 1 second)
// }

function showNextPile(){

  let startTime = Cesium.JulianDate.now();
  let interval = 0.1; // Seconds between pile visibility

viewer.clock.onTick.addEventListener(() => {
    const currentTime = Cesium.JulianDate.now();
    const elapsedSeconds = Cesium.JulianDate.secondsDifference(currentTime, startTime);

    // if (currentPileIndex < citizensBankPark.length && elapsedSeconds > currentPileIndex * interval) {
      if (currentPileIndex < loadedEntities.length && elapsedSeconds > currentPileIndex * interval) {
      // citizensBankPark[currentPileIndex].show = true;
      loadedEntities[currentPileIndex].show = true;
        currentPileIndex++;
    }
});

}

let optimizedPath = [];

function calculateOptimizedPath(piles) {

  console.log("I am trying man");
  console.log(piles);
  if (piles.length === 0) return [];

  
  let unvisited = [...piles]; // Copy the piles array
  let current = unvisited.shift(); // Start with the first pile (you can customize the starting point)

  optimizedPath.push(current);

  while (unvisited.length > 0) {
      // Find the closest pile to the current position
      let closestIndex = 0;
      let closestDistance = Infinity;

      for (let i = 0; i < unvisited.length; i++) {
          const pile = unvisited[i];

          console.log(pile);

          // Compute the distance between the current pile and this unvisited pile
          const distance = Cesium.Cartesian3.distance(
              Cesium.Cartesian3.fromDegrees(current.lon, current.lat),
              Cesium.Cartesian3.fromDegrees(pile.lon, pile.lat)
          );

          // Keep track of the closest pile
          if (distance < closestDistance) {
              closestDistance = distance;
              closestIndex = i;
          }
      }

      // Move to the closest pile
      current = unvisited.splice(closestIndex, 1)[0];
      optimizedPath.push(current);
  }

  console.log(optimizedPath);

    const pathPositions = optimizedPath.map(loc =>
      Cesium.Cartesian3.fromDegrees(loc.longitude, loc.latitude)
  );

  viewer.entities.add({
      polyline: {
          positions: pathPositions,
          width: 3,
          material: Cesium.Color.YELLOW,
          clampToGround: true,
      },
  });

  return optimizedPath;
}

const pileDriver = viewer.entities.add({
  position: Cesium.Cartesian3.fromDegrees(-76.03116520703031,45.41641802447001, 33.5),
  model: {
      uri: './assets/glTf/excavator_robo_enlarged/scene.gltf', // Path to the pile driver model
      scale: 1.0,
  },
});

function updateOrientation(currentPile, nextPile, model) {
  const heading = Cesium.Math.toDegrees(
      Math.atan2(
          nextPile.longitude - currentPile.longitude,
          nextPile.latitude - currentPile.latitude
      )
  );

  // Update model orientation
  model.orientation = Cesium.Transforms.headingPitchRollQuaternion(
      Cesium.Cartesian3.fromDegrees(currentPile.longitude, currentPile.latitude),
      new Cesium.HeadingPitchRoll(
          Cesium.Math.toRadians(heading), // Heading
          0, // Pitch
          0  // Roll
      )
  );
}

// Function to move the pile driver
function animatePileDriver(path, entity, duration) {
  let index = 0;
  let distanceTotal=0 ;

  console.log("This is the path length");
  console.log(path.length);

  function moveNextStep() {
      if (index >= path.length - 1) return;

      const start = Cesium.Cartesian3.fromDegrees(path[index].longitude, path[index].latitude, 33);
      const end = Cesium.Cartesian3.fromDegrees(path[index + 1].longitude, path[index + 1].latitude, 33);

      const startTime = viewer.clock.currentTime;
      const stopTime = Cesium.JulianDate.addSeconds(startTime, duration, new Cesium.JulianDate());

      const distance = Cesium.Cartesian3.distance(start, end)*3.6;

      const distanceMetric=distance.toFixed(2) ;

      distanceTotal+=distance;

      const distanceFinal = distanceTotal.toFixed(1);

      document.getElementById('speedRobo').innerText=` ${distanceMetric} m/s`;
      document.getElementById('pileNumber').innerText=` ${index+1}`;
      document.getElementById('totalDistance').innerText=` ${distanceFinal} m`;
      // Create position property for animation
      const position = new Cesium.SampledPositionProperty();
      position.addSample(startTime, start);
      position.addSample(stopTime, end);

      entity.position = position;

      const currentPile = optimizedPath[i];
      const nextPile = optimizedPath[i + 1];
  
  
      // Update its orientation to face the next pile
      updateOrientation(path[index], path[index + 1], pileDriver);

      // Schedule the next movement after the current one completes
      setTimeout(() => {
          index++;
          moveNextStep();
      }, duration * 1000);
  }

  moveNextStep();
}

// Start the animation (e.g., 5 seconds per step)



document.getElementById('PDF').addEventListener("click", () => 
    
    modifyPdf());

document.getElementById('PDFCalc').addEventListener("click", () => 
    
    modifyPdfCalc());

document.getElementById('PDFCalcPile').addEventListener("click", () => 
    
    modifyPdfCalcPile());

document.getElementById('ShowPlan').addEventListener("click", () => 


    
//  showNextPile()
calculateOptimizedPath(pointArray)
);

document.getElementById('addRob').addEventListener("click", () => 
    
  animatePileDriver(optimizedPath, pileDriver, 1));
import { BaseExtension } from './BaseExtension.js';

class LoggerExtension extends BaseExtension {
    load() {
        super.load();
        console.log('LoggerExtension loaded.');
        return true;
    }

    unload() {
        super.unload();
        console.log('LoggerExtension unloaded.');
        return true;
    }

    async onModelLoaded(model) {
        super.onModelLoaded(model);
        const props = await this.findPropertyNames(this.viewer.model);
        console.log('New model has been loaded. Its objects contain the following properties:', props);
    }

    async onSelectionChanged(model, dbids) {
        super.onSelectionChanged(model, dbids);
        console.log('Selection has changed', dbids);
        
        try {
            
            let coordinates = [];
            coordinates [0]= await this.getElementCoordinates(model, dbids[0]);
            console.log('Coordinates:', coordinates);

            const coordinateAll= await this.getAllDbIds(this.viewer) ; 

            const coordinateJson = coordinateAll.map((num) => {
                  return {"objectID":num,"coordinateCent":""};  
            });

            console.log(coordinateJson);

            // Convert array to a map
            let coordinateMap = {};

            // array.forEach(item => {
            //     coordinateMap[item.objectID] = item.coordinateCent;
            // });
          

            for (let i=1;i<900;i++) {

                console.log('I am here',i);
                console.log(coordinateAll[10]);

                const coordinateUpd = await this.getElementCoordinates(model, coordinateAll[i])

                console.log(coordinateUpd);

                coordinateMap[coordinateAll[i]] = coordinateUpd;

                console.log(coordinateMap);

                // try {
                //     this.addModel(this.viewer, coordinateUpd.elementCent);
        
                // } catch (error) {
                //     console.error('Error getting to add the model:', error);
                // }
                
            }

            try {
                this.addModel(this.viewer, coordinates[1].elementCent);
    
            } catch (error) {
                console.error('Error getting to add the model:', error);
            }

            fetch(`/ask_agent_simple`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json'
                },
                body:JSON.stringify(coordinateMap)
            })
            .then(response => response.json())
            .then(data => {
                    console.log("The PUT Request is successful")
              })
            .catch(error => {
                console.error("Error retrieving object tree:", error);
                // res.json({success: false, message: "You are unsuccessful"})
            });        

        } catch (error) {
            console.error('Error getting coordinates:', error);
        }      
    

    }

    onIsolationChanged(model, dbids) {
        super.onIsolationChanged(model, dbids);
        console.log('Isolation has changed', dbids);
    }
}

Autodesk.Viewing.theExtensionManager.registerExtension('LoggerExtension', LoggerExtension);
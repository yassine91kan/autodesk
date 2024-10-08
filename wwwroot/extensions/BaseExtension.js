export class BaseExtension extends Autodesk.Viewing.Extension {
    constructor(viewer, options) {
        super(viewer, options);
        this._onObjectTreeCreated = (ev) => this.onModelLoaded(ev.model);
        this._onSelectionChanged = (ev) => this.onSelectionChanged(ev.model, ev.dbIdArray);
        this._onIsolationChanged = (ev) => this.onIsolationChanged(ev.model, ev.nodeIdArray);
    }

    load() {
        this.viewer.addEventListener(Autodesk.Viewing.OBJECT_TREE_CREATED_EVENT, this._onObjectTreeCreated);
        this.viewer.addEventListener(Autodesk.Viewing.SELECTION_CHANGED_EVENT, this._onSelectionChanged);
        this.viewer.addEventListener(Autodesk.Viewing.ISOLATE_EVENT, this._onIsolationChanged);
        return true;
    }

    unload() {
        this.viewer.removeEventListener(Autodesk.Viewing.OBJECT_TREE_CREATED_EVENT, this._onObjectTreeCreated);
        this.viewer.removeEventListener(Autodesk.Viewing.SELECTION_CHANGED_EVENT, this._onSelectionChanged);
        this.viewer.removeEventListener(Autodesk.Viewing.ISOLATE_EVENT, this._onIsolationChanged);
        return true;
    }

    

    onToolbarCreated() {}

    onModelLoaded(model) {}

    onSelectionChanged(model, dbids) {}

    onIsolationChanged(model, dbids) {}

    findLeafNodes(model) {
        return new Promise(function (resolve, reject) {
            model.getObjectTree(function (tree) {
                let leaves = [];
                tree.enumNodeChildren(tree.getRootId(), function (dbid) {
                    if (tree.getChildCount(dbid) === 0) {
                        leaves.push(dbid);
                    }
                }, true);
                resolve(leaves);
            }, reject);
        });
    }

    async findPropertyNames(model) {
        const dbids = await this.findLeafNodes(model);
        return new Promise(function (resolve, reject) {
            model.getBulkProperties(dbids, {}, function (results) {
                let propNames = new Set();
                for (const result of results) {
                    for (const prop of result.properties) {
                        propNames.add(prop.displayName);
                    }
                }
                resolve(Array.from(propNames.values()));
            }, reject);
        });
    }

// Helper Function added for the Model Summary Toolbar

    createToolbarButton(buttonId, buttonIconUrl, buttonTooltip) {
        let group = this.viewer.toolbar.getControl('dashboard-toolbar-group');
        if (!group) {
            group = new Autodesk.Viewing.UI.ControlGroup('dashboard-toolbar-group');
            this.viewer.toolbar.addControl(group);
        }
        const button = new Autodesk.Viewing.UI.Button(buttonId);
        button.setToolTip(buttonTooltip);
        group.addControl(button);
        const icon = button.container.querySelector('.adsk-button-icon');
        if (icon) {
            icon.style.backgroundImage = `url(${buttonIconUrl})`; 
            icon.style.backgroundSize = `24px`; 
            icon.style.backgroundRepeat = `no-repeat`; 
            icon.style.backgroundPosition = `center`; 
        }
        return button;
    }

    removeToolbarButton(button) {
        const group = this.viewer.toolbar.getControl('dashboard-toolbar-group');
        group.removeControl(button);
    }

    loadScript(url, namespace) {
        if (window[namespace] !== undefined) {
            return Promise.resolve();
        }
        return new Promise(function (resolve, reject) {
            const el = document.createElement('script');
            el.src = url;
            el.onload = resolve;
            el.onerror = reject;
            document.head.appendChild(el);
        });
    }

    loadStylesheet(url) {
        return new Promise(function (resolve, reject) {
            const el = document.createElement('link');
            el.rel = 'stylesheet';
            el.href = url;
            el.onload = resolve;
            el.onerror = reject;
            document.head.appendChild(el);
        });
    }

    async getAllDbIds(viewer) {

        try {

            var instanceTree = viewer.model.getData().instanceTree;
      
            var allDbIdsStr = Object.keys(instanceTree.nodeAccess.dbIdToIndex);

        } catch (error) {
            console.error('Error getting to add the model list od dbIDs:', error);
        }

        console.log(allDbIdsStr.map(function(id) { return parseInt(id)}));
   
        return allDbIdsStr.map(function(id) { return parseInt(id)});

    }


    async getElementCoordinates(model, dbId) {
        return new Promise((resolve, reject) => {
            model.getProperties(dbId, (props) => {
                console.log('Element properties:', props);

                const instanceTree = model.getInstanceTree();
                const fragList = model.getFragmentList();

                if (!instanceTree || !fragList) {
                    console.error('Instance tree or fragment list is not available.');
                    return reject('Instance tree or fragment list is not available.');
                }

                const fragIds = [];

                const collectFragIds = (nodeId) => {
                    instanceTree.enumNodeFragments(nodeId, (fragId) => {
                        fragIds.push(fragId);
                    });
                    instanceTree.enumNodeChildren(nodeId, (childId) => {
                        collectFragIds(childId);
                    });
                };

                collectFragIds(dbId);

                console.log('Collected fragment IDs:', fragIds);

                if (fragIds.length === 0) {
                    console.log(`No fragments found for dbId ${dbId} or its children.`);
                    return reject(`No fragments found for dbId ${dbId} or its children.`);
                }

                const coordinates = [];
                let elementCent;

                fragIds.forEach(fragId => {
                    const fragProxy = this.viewer.impl.getFragmentProxy(model, fragId);
                    fragProxy.updateAnimTransform();

                    const matrix = new THREE.Matrix4();
                    fragProxy.getWorldMatrix(matrix);

                    console.log(matrix);

                    const position = new THREE.Vector3();
                    const rotation = new THREE.Quaternion();
                    let scale = new THREE.Vector3();

                    matrix.decompose(position, rotation, scale);

                    coordinates.push({ x: position.x, y: position.y, z: position.z });

                    console.log(`Element coordinates: ${position.x}, ${position.y}, ${position.z}`);

                    scale += 10.0; 

                    fragList.getWorldMatrix(fragId, matrix);
                  
                    
                    let bbox = new THREE.Box3();
                    
                    
                    fragList.getWorldBounds(fragId, bbox);
                    elementCent = bbox.getCenter(new THREE.Vector3());
                    console.log('World bounds:', JSON.stringify(bbox));
                    console.log('Center of BB',elementCent);

               });

                resolve({ coordinates, elementCent });
            });
        });

    }

    findLeafNodes(nodeId, fragIds) {
        const instanceTree = this.viewer.model.getInstanceTree();

        if (!instanceTree) {
            return;
        }

        const collectLeafNodes = (nodeId) => {
            instanceTree.enumNodeChildren(nodeId, (childId) => {
                if (instanceTree.getChildCount(childId) === 0) {
                    instanceTree.enumNodeFragments(childId, (fragId) => {
                        fragIds.push(fragId);
                    });
                } else {
                    collectLeafNodes(childId);
                }
            });
        };

        collectLeafNodes(nodeId);
    }

    async addModel(viewer, point){


        const sceneBuilder = await viewer.loadExtension('Autodesk.Viewing.SceneBuilder');
        const modelBuilder = await sceneBuilder.addNewModel({
            conserveMemory: false,
            modelNameOverride: 'My Model Name'
        });

        let elementCenter;
        elementCenter = new THREE.Vector3(0, 0, 0);

        const boxGeometry = new THREE.BufferGeometry().fromGeometry(new THREE.BoxGeometry(1, 1, 1));
        const boxMaterial = new THREE.MeshPhongMaterial({
            color: new THREE.Color(1, 0, 1)
        });
        const boxMesh = new THREE.Mesh(boxGeometry, boxMaterial);
        boxMesh.matrix= new THREE.Matrix4().compose(
            // new THREE.Vector3(0, 0, 0),
            point,
            new THREE.Quaternion(0, 0, 0, 1),
            new THREE.Vector3(1, 1, 1)
        )

        modelBuilder.addMesh(boxMesh);


    }

    
    


        async addgltf(viewer,elementcent,geomT){


            // let xform = new THREE.Vector3(100, 7, -3);
            // const matrix = new THREE.Matrix4().makeTranslation(xform.x, xform.y, xform.z);
            // matrix.scale(new THREE.Vector3(2, 2, 2)); 


            const translation = new THREE.Matrix4().makeTranslation(10, 5, -3);
            const rotation = new THREE.Matrix4().makeRotationX(Math.PI / 2);  // Rotate 90 degrees around Z
            const scaling = new THREE.Matrix4().makeScale(3, 3, 3);  // Double size

            // Combine the transformations
            let xform = new THREE.Matrix4();
            // xform.multiply(translation).multiply(rotation).multiply(scaling);
            xform.multiply(translation).multiply(scaling);

            let xformArray=[];
            let matrixArray=[];
            let j;
            let b;

            await viewer.loadExtension('Autodesk.glTF');



            for (let i=0;i<1;i++) {

                for(let k=0;k<1;k++){

                j=0+i*20;
                console.log(j);
                b = 50+k*20

                // xformArray[i]= new THREE.Vector3(j, b, 0);
                // xformArray[i]= new THREE.Vector3(0, 0, 0);
                // xformArray[i]= new THREE.Vector3(-45.16, 17.95, -2.77);
                xformArray[i]= new THREE.Vector3(elementcent.x, elementcent.y, elementcent.z);
                console.log(xformArray[i]);
                matrixArray[i]= new THREE.Matrix4().makeTranslation(xformArray[i].x, xformArray[i].y, xformArray[i].z).multiply(rotation).multiply(scaling);
                

                viewer.loadModel(`./assets/glTf/${geomT}/scene.gltf`, 
                {
                    placementTransform: new THREE.Matrix4()
                },
                function (secondModel) {  // onSuccessCallback

                    let sr = secondModel.getPlacementTransform();
                    console.log(sr);

                    // Assuming 'm.xform' is a valid position vector
                    secondModel.setPlacementTransform(matrixArray[i]);
                    // secondModel.setPlacementTransform(sr);

                    let tr = secondModel.getPlacementTransform();
                    console.log(tr);


                },
                function (error) {  // onErrorCallback
                    console.error('Error loading the model:', error);
                }

                
                );



                }

                


            }

            // let xformm = new THREE.Vector3(1, 50, 0);
            // let xformmm = new THREE.Vector3(30, 50, 0);

            // const matrix = new THREE.Matrix4().makeTranslation(xformm.x, xformm.y, xformm.z).multiply(scaling);

            // const matrix2 = new THREE.Matrix4().makeTranslation(xformmm.x, xformmm.y, xformmm.z).multiply(scaling);


            // viewer.loadModel('./assets/glTf/solar_panel/scene.gltf', 
            //     {
            //         placementTransform: new THREE.Matrix4()
            //     },
            //     function (secondModel) {  // onSuccessCallback
            //         // Assuming 'm.xform' is a valid position vector
            //         secondModel.setPlacementTransform(matrix);

            //         let tr = secondModel.getPlacementTransform();
            //         console.log(tr);
            //     },
            //     function (error) {  // onErrorCallback
            //         console.error('Error loading the model:', error);
            //     }

                
            //     );


            //     viewer.loadModel('./assets/glTf/solar_panel/scene.gltf', 
            //     {
            //         placementTransform: new THREE.Matrix4()
            //     },
            //     function (thirdModel) {  // onSuccessCallback
            //         // Assuming 'm.xform' is a valid position vector
            //         thirdModel.setPlacementTransform(matrix2);

            //         let tr = thirdModel.getPlacementTransform();
            //         console.log(tr);
            //     },
            //     function (error) {  // onErrorCallback
            //         console.error('Error loading the model:', error);
            //     }

                
            //     );

                

                


    
        }



}
var xeometry = {};

/**
 * A JavaScript API for viewing glTF models on WebGL.
 *
 * A xeometry Viewer is a single class that wraps [xeogl](http://xeogl.org) in a
 * set of simple data-driven methods focused on loading glTF models and manipulating
 * their objects to create cool presentations.
 *
 * @class Viewer
 * @param {Object} [cfg] Configs
 * @param {Function} [cfg.loadModel] Callback fired to load model
 * @param {Function} [cfg.loadedModel] Callback fired when model loaded
 * @param {Function} [cfg.unloadedModel] Callback fired when model unloaded
 * @param {Object} [cfg.contextAttr] WebGL context attributes
 * @example
 *
 * // Create viewer with default canvas
 * var viewer1 = new xeometry.Viewer();
 *
 * // Create viewer bound to an existing canvas
 * var viewer2 = new xeometry.Viewer({
 *     canvas: "theCanvas"
 * });
 *
 * // Create viewer that loads via custom loader callback
 * var viewer3 = new xeometry.Viewer({
 *     loadModel: function (modelId, src, ok, error) {
 *         var request = new XMLHttpRequest();
 *         request.overrideMimeType("application/json");
 *         request.open('GET', src2, true);
 *         request.onreadystatechange = function () {
 *             if (request.readyState == 4 && // Request finished, response ready
 *                 request.status == "200") { // Status OK
 *                     var json = JSON.parse(request.responseText);
 *                     ok(json, this);
 *             }
 *         };
 *         request.send(null);
 *     },
 *     loadedModel: function(modelId, src, ok) {
 *         console.log("Loaded modelId=" + modelId);
 *         ok(); // Unblock the viewer
 *     },
 *     unloadedModel: function(modelId, src) {
 *         console.log("Unloaded modelId=" + modelId);
 *     }
 * });
 */
xeometry.Viewer = function (cfg) {

    var self = this;

    cfg = cfg || {};

    var loadModel = cfg.loadModel; // Optional callback to load models
    var loadedModel = cfg.loadedModel; // Optional callback to fire after each model is loaded
    var unloadedModel = cfg.unloadedModel; // Optional callback to fire after each model is unloaded

    var scene = new xeogl.Scene({
        canvas: cfg.canvas,
        webgl2: false,
        contextAttr: cfg.contextAttr || {}
        //,
        //transparent: true
    });

    var math = xeogl.math;
    var camera = scene.camera;
    var view = camera.view;

    var types = {}; // List of objects for each type
    var models = {}; // Models mapped to their IDs
    var modelSrcs = {}; // Data ID each model was loaded from
    var objects = {}; // Objects mapped to their IDs
    var annotations = {}; // Annotations mapped to their IDs
    var objectAnnotations = {}; // Annotations for each object
    var eulerAngles = {}; // Euler rotation angles for each model and object
    var rotations = {}; // xeogl.Rotate for each model and object
    var translations = {}; // xeogl.Translate for each model and object
    var scales = {}; // xeogl.Scale for each model and object
    var objectModels = {}; // Model of each object
    var transformable = {}; // True for each model and object that has transforms
    var yspin = 0;
    var xspin = 0;
    var clips = {};
    var clipHelpers = {};
    var clipsDirty = true;
    var lights = {};
    var lightHelpers = {};
    var lightsDirty = false;
    var aabbHelpers = {};

    var onTick = scene.on("tick", function () {

        // Orbit animation
        if (yspin !== 0) {
            view.rotateEyeY(yspin);
        }
        if (xspin !== 0) {
            view.rotateEyeX(xspin);
        }

        // Rebuild user clip planes
        if (clipsDirty) {
            var clip;
            var clipArray = [];
            for (var id in clips) {
                if (clips.hasOwnProperty(id)) {
                    clip = clips[id];
                    clipArray.push(clip);
                }
            }
            scene.clips.clips = clipArray;
            clipsDirty = false;
        }

        // Rebuild lights
        if (lightsDirty) {
            var light;
            var lightArray = [];
            for (var id in lights) {
                if (lights.hasOwnProperty(id)) {
                    light = lights[id];
                    lightArray.push(light);
                }
            }
            scene.lights.lights = lightArray;
            lightsDirty = false;
        }
    });

    var cameraFlight = new xeogl.CameraFlightAnimation(scene, {
        viewFitFOV: 45,
        duration: 0
    });

    var projections = { // Camera projections to switch between
        perspective: camera.project, // Camera has a xeogl.Perspective by default
        orthographic: new xeogl.Ortho(scene, {
            scale: 1.0,
            near: 0.1,
            far: 5000
        })
    };

    projections.perspective.far = 5000;

    var projectionType = "perspective";

    //var cameraControl = new xeogl.CameraControl(scene);

    //----------------------------------------------------------------------------------------------------
    // Task management
    //----------------------------------------------------------------------------------------------------

    /**
     * Schedules a task for the viewer to run asynchronously at the next opportunity.
     *
     * Internally, this pushes the task to a FIFO queue. Within each frame interval, the viewer pumps the queue
     * for a certain period of time, popping tasks and running them. After each frame interval, tasks that did not
     * get a chance to run during the task are left in the queue to be run next time.
     *
     * @param {Function} callback Callback that runs the task.
     * @param {Object} [scope] Scope for the callback.
     * @returns {Viewer} this
     * @example
     * viewer.scheduleTask(function() { ... });
     * viewer.scheduleTask(function() { this.log("foo"); }, console); // Set a scope for the task
     */
    this.scheduleTask = function (callback, scope) {
        if (!callback) {
            error("scheduleTask() - Missing callback");
            return;
        }
        xeogl.scheduleTask(callback, scope);
        return this;
    };

    /**
     * Gets the viewer's WebGL canvas.
     *
     * @returns {HTMLCanvasElement}
     */
    this.getCanvas = function () {
        return scene.canvas.canvas;
    };

    /**
     * Returns the HTML DIV element that overlays the WebGL canvas.
     *
     * This overlay is for catching mouse navigation events.
     *
     * @returns {HTMLDivElement}
     */
    this.getOverlay = function () {
        return scene.canvas.overlay;
    };

    //==================================================================================================================
    // Models
    //==================================================================================================================

    /**
     * Loads a model into the viewer.
     *
     * Assigns the model an ID, which gets prefixed to the IDs of its objects.
     *
     * @param {String} id ID to assign to the model. This gets prefixed to the IDs of the model's objects.
     * @param {String} src Locates the model. This could be a path to a file or an ID within a database.
     * @param {Function} [ok] Callback fired when model loaded.
     * @return {Viewer} this
     * @example
     * // Load saw model, fit in view, show two of its objects
     * viewer.loadModel("saw", "models/gltf/ReciprocatingSaw/glTF-MaterialsCommon/ReciprocatingSaw.gltf", function () {
     *    viewer.viewFit("saw");
     *    viewer.hide();
     *    viewer.show(["saw#0.1", "saw#0.2"]);
     * });
     */
    this.loadModel = function (id, src, ok) {
        var isFilePath = xeogl._isString(src);
        var model = models[id];
        if (model) {
            if (isFilePath && src === model.src) {
                if (ok) {
                    ok(model.id);
                }
                return this;
            }
            this.destroy(id);
        }
        if (scene.components[id]) {
            error("Component with this ID already exists: " + id);
            if (ok) {
                ok(id);
            }
            return this;
        }
        model = new xeogl.GLTFModel(scene, {
            id: id,
            transform: new xeogl.Scale(scene, {
                parent: new xeogl.Quaternion(scene, {
                    parent: new xeogl.Translate(scene)
                })
            })
        });
        models[id] = model;
        modelSrcs[id] = src;
        model.on("loaded", function () {
            var entities = model.types["xeogl.Entity"];
            var object;
            var meta;
            for (var objectId in entities) {
                if (entities.hasOwnProperty(objectId)) {
                    object = entities[objectId];
                    // model.add(object.material = object.material.clone()); // Ensure unique materials
                    objects[objectId] = object;
                    objectModels[objectId] = model;
                    // Register for type
                    meta = object.meta;
                    var type = meta && meta.type ? meta.type : "DEFAULT";
                    var objectsOfType = (types[type] || (types[type] = {}));
                    objectsOfType[objectId] = object;
                }
            }
            if (loadedModel) {
                loadedModel(id, src, function () {
                    if (ok) {
                        ok(id);
                    }
                });
            } else {
                if (ok) {
                    ok(id);
                }
            }
        });
        if (loadModel) {
            loadModel(id, src,
                function (gltf) {
                    var basePath = null;
                    xeogl.GLTFModel.parse(model, gltf, basePath);
                    // model then fires "loaded" once its finished parsing
                },
                function (errMsg) {
                    error("Error loading model: " + errMsg);
                    if (ok) {
                        ok();
                    }
                });
        } else {
            model.src = src;
        }
        return this;
    };

    /**
     * Gets the models currently loaded in the viewer.
     *
     * @see loadModel
     * @module models
     * @return {String[]} IDs of the models.
     */
    this.getModels = function () {
        return Object.keys(models);
    };

    /**
     * Gets the source of a model.
     *
     * This is the ````src```` parameter that was given to {@link #loadModel}.
     *
     * @param {String} id ID of the model.
     * @return {String} Model source.
     */
    this.getSrc = function (id) {
        var src = modelSrcs[id];
        if (!src) {
            error("Model not found: " + id);
            return null;
        }
        return src;
    };

    /**
     * Gets the model an object belongs to.
     *
     * @param {String} id ID of the object.
     * @return {String} ID of the object's model.
     */
    this.getModel = function (id) {
        var object = objects[id];
        if (!object) {
            error("Object not found: " + id);
            return;
        }
        var model = objectModels[id];
        if (!model) {
            error("Model not found for object: " + id); // Should not happen!
            return;
        }
        return model.id;
    };

    /**
     * Gets the objects belonging to the given models and/or types.
     *
     * Returns all objects in the viewer when no arguments are given.
     *
     * @param {String|String[]} [id] ID(s) of model(s) and/or a type(s).
     * @return {String[]} IDs of the objects.
     * @example
     *
     * // Get all objects currently in the viewer
     * var allObjects = viewer.getObjects();
     *
     * // Get all objects in the gearbox model
     * var gearboxObjects = viewer.getObjects("gearbox");
     *
     * // Get objects belonging to two models
     * var sawAndGearboxObjects = viewer.getObjects(["saw", "gearbox"]);
     *
     * // Get objects in the gearbox model, plus all objects in viewer that are IFC cable fittings and carriers
     * var gearboxCableFittings = viewer.getObjects("gearbox", "IfcCableFitting", "IfcCableCarrierFitting"]);
     */
    this.getObjects = function (id) {
        if (id === undefined || id === null) {
            return Object.keys(objects);
        }
        if (xeogl._isString(id)) {
            var object = objects[id];
            if (object) {
                return [id];
            }
            var objectsOfType = types[id];
            if (objectsOfType) {
                return Object.keys(objectsOfType);
            }
            var model = models[id];
            if (!model) {
                error("Model not found: " + id);
                return [];
            }
            var entities = model.types["xeogl.Entity"];
            if (!entities) {
                return [];
            }
            return Object.keys(entities);
        }
        if (xeogl._isArray(id)) {
            var result = [];
            var got = {};
            for (var i = 0; i < id.length; i++) {
                var buf = this.getObjects(id[i]);
                for (var j = 0; j < buf.length; j++) {
                    var id2 = buf[j];
                    if (!got[id2]) {
                        got[id2] = true;
                        result.push(id2);
                    }
                }
            }
            return result;
        }
        return [];
    };

    /**
     * Unloads all models, annotations and clipping planes, resets lights to defaults.
     *
     * Preserves the current camera state.
     *
     * @return {Viewer} this
     */
    this.clear = function () {
        for (var id in models) {
            if (models.hasOwnProperty(id)) {
                this.destroy(id);
            }
        }
        this.destroyAnnotations();
        this.destroyClips();
        this.destroyLights();
    };

    /**
     * Assigns a type to an object.
     *
     * A type can be anything, but when using xeometry as an IFC viewer, it's typically an IFC type.
     *
     * @param {String} id ID of an object.
     * @param {String} type The type.
     * @returns {Viewer} this
     * @example
     * viewer.setType("saw#3.1", "cover");
     */
    this.setType = function (id, type) {
        if (xeogl._isString(id)) {
            type = type || "DEFAULT";
            var object = objects[id];
            if (object) {
                var meta = object.meta;
                var currentType = meta && meta.type ? meta.type : "DEFAULT";
                if (currentType === type) {
                    return this;
                }
                var currentTypes = types[currentType];
                if (currentTypes) {
                    delete currentTypes[id];
                }
                var newTypes = (types[type] || (types[type] = {}));
                newTypes[id] = object;
                object.meta.type = type;
                return this;
            }
            var model = models[id];
            if (model) {
                //.. TODO
                return this;
            }
            error("Model, object or type not found: " + id);
            return this;
        }
        for (var i = 0, len = id.length; i < len; i++) {
            this.setType(id[i], type);
        }
        return this;
    };

    /**
     * Gets the type of an object.
     *
     * @param {String} id ID of the object.
     * @returns {String} The type of the object.
     * @example
     * var type = viewer.getType("saw#3.1");
     */
    this.getType = function (id) {
        var object = objects[id];
        if (object) {
            var meta = object.meta;
            return meta && meta.type ? meta.type : "DEFAULT";
        }
        error("Object not found: " + id);
    };

    /**
     * Gets all the object types currently in the viewer.
     *
     * @return {String[]} The types in the viewer.
     */
    this.getTypes = function () {
        return Object.keys(types);
    };

    //==================================================================================================================
    // Geometry
    //==================================================================================================================

    /**
     * Gets an object's geometry primitive type.
     *
     * This determines the layout of the indices array of the object's geometry.
     *
     * @param {String} id ID of the object.
     * @returns {String} The primitive type. Possible values are 'points', 'lines', 'line-loop',
     * 'line-strip', 'triangles', 'triangle-strip' and 'triangle-fan'.
     * @example
     * var prim = viewer.getPrimitive("saw#3.1");
     */
    this.getPrimitive = function (id) {
        var object = objects[id];
        if (object) {
            return object.geometry.primitive;
        }
        error("Object not found: " + id);
    };

    /**
     * Gets the World-space geometry vertex positions of an object.
     *
     * @param {String} id ID of the object.
     * @returns {Float32Array} The vertex positions.
     * @example
     * var positions = viewer.getPositions("saw#3.1");
     */
    this.getPositions = function (id) {
        var object = objects[id];
        if (object) {
            return object.positions;
        }
        error("Object not found: " + id);
    };

    /**
     * Gets the geometry primitive indices of an object.
     *
     * @param {String} id ID of the object.
     * @returns {Int32Array} The indices.
     * @example
     * var indices = viewer.getIndices("saw#3.1");
     */
    this.getIndices = function (id) {
        var object = objects[id];
        if (object) {
            return object.geometry.indices;
        }
        error("Object not found: " + id);
    };

    //==================================================================================================================
    // Transformation
    //==================================================================================================================

    /**
     * Sets the scale of a model or an object.
     *
     * An object's scale is relative to its model's scale. For example, if an object has a scale
     * of ````[0.5, 0.5, 0.5]```` and its model also has scale ````[0.5, 0.5, 0.5]````, then the object's
     * effective scale is ````[0.25, 0.25, 0.25]````.
     *
     * A model or object's scale is ````[1.0, 1.0, 1.0]```` by default.
     *
     * @param {String} id ID of a model or object.
     * @param {[Number, Number, Number]} xyz Scale factors for the X, Y and Z axis.
     * @returns {Viewer} this
     * @example
     * viewer.setScale("saw", [1.5, 1.5, 1.5]);
     * viewer.setScale("saw#3.1", [0.5, 0.5, 0.5]);
     */
    this.setScale = function (id, xyz) {
        if (xeogl._isString(id)) {
            var scale = scales[id];
            if (!scale) {
                var component = getTransformableComponent(id);
                if (!component) {
                    error("Model or object not found: " + id);
                    return this;
                }
                scale = scales[id];
            }
            scale.xyz = xyz;
            return this;
        }
        for (var i = 0, len = id.length; i < len; i++) {
            this.setScale(id[i], xyz);
        }
        return this;
    };

    /**
     * Gets the scale of a model or an object.
     *
     * An object's scale is relative to its model's scale. For example, if an object has a scale
     * of ````[0.5, 0.5, 0.5]```` and its model also has scale ````[0.5, 0.5, 0.5]````, then the object's
     * effective scale is ````[0.25, 0.25, 0.25]````.
     *
     * A model or object's scale is ````[1.0, 1.0, 1.0]```` by default.
     *
     * @param {String} id ID of a model or object.
     * @return {[Number, Number, Number]} Scale factors for the X, Y and Z axis.
     * @example
     * var sawScale = viewer.getScale("saw");
     * var sawCoverScale = viewer.getScale("saw#3.1");
     */
    this.getScale = function (id) {
        var scale = scales[id];
        if (!scale) {
            var component = getTransformableComponent(id);
            if (!component) {
                error("Model or object not found: " + id);
                return this;
            }
            scale = scales[id];
        }
        return scale.xyz.slice();
    };

    /**
     * Sets the rotation of a model or an object.
     *
     * An object's rotation is relative to its model's rotation. For example, if an object has a rotation
     * of ````45```` degrees about the Y axis, and its model also has a rotation of ````45```` degrees about
     * Y, then the object's effective rotation is ````90```` degrees about Y.
     *
     * Rotations are in order of X, Y then Z.
     *
     * The rotation angles of each model or object are ````[0, 0, 0]```` by default.
     *
     * @param {String} id ID of a model or object.
     * @param {[Number, Number, Number]} xyz Rotation angles, in degrees, for the X, Y and Z axis.
     * @returns {Viewer} this
     * @example
     * viewer.setRotate("saw", [90, 0, 0]);
     * viewer.setRotate("saw#3.1", [0, 35, 0]);
     */
    this.setRotate = (function () {
        var quat = math.vec4();
        return function (id, xyz) {
            if (xeogl._isString(id)) {
                var rotation = rotations[id];
                if (!rotation) {
                    var component = getTransformableComponent(id);
                    if (!component) {
                        error("Model or object not found: " + id);
                        return this;
                    }
                    rotation = rotations[id];
                }
                math.eulerToQuaternion(xyz, "XYZ", quat); // Tait-Bryan Euler angles
                rotation.xyzw = quat;
                var saveAngles = eulerAngles[id] || (eulerAngles[id] = math.vec3());
                saveAngles.set(xyz);
                return this;
            }
            for (var i = 0, len = id.length; i < len; i++) {
                this.setRotate(id[i], xyz);
            }
            return this;
        };
    })();

    /**
     * Gets the rotation of a model or an object.
     *
     * An object's rotation is relative to its model's rotation. For example, if an object has a rotation
     * of ````45```` degrees about the Y axis, and its model also has a rotation of ````45```` degrees about
     * Y, then the object's effective rotation is ````90```` degrees about Y.
     *
     * The rotation angles of each model or object are ````[0, 0, 0]```` by default.
     *
     * Rotations are in order of X, Y then Z.
     *
     * @param {String} id ID of a model or object.
     * @return {[Number, Number, Number]} Rotation angles, in degrees, for the X, Y and Z axis.
     * @example
     * var sawRotate = viewer.getRotate("saw");
     * var sawCoverRotate = viewer.getRotate("saw#3.1");
     */
    this.getRotate = function (id) {
        var component = getTransformableComponent(id);
        if (!component) {
            error("Model or object not found: " + id);
            return 0;
        }
        var angles = eulerAngles[id];
        return angles ? angles.slice() : math.vec3([0, 0, 0]);
    };

    /**
     * Sets the translation of a model or an object.
     *
     * An object's translation is relative to that of its model. For example, if an object has a translation
     * of ````[100, 0, 0]```` and its model has a translation of ````[50, 50, 50]```` , then the object's effective
     * translation is ````[150, 50, 50]````.
     *
     * The translation of each model or object is ````[0, 0, 0]```` by default.
     *
     * @param {String} id ID of a model or object.
     * @param {[Number, Number, Number]} xyz World-space translation vector.
     * @returns {Viewer} this
     * @example
     * viewer.setTranslate("saw", [100, 30, 0]);
     * viewer.setTranslate("saw#3.1", [50, 30, 0]);
     */
    this.setTranslate = function (id, xyz) {
        if (xeogl._isString(id)) {
            var translation = translations[id];
            if (!translation) {
                var component = getTransformableComponent(id);
                if (!component) {
                    error("Model or object not found: " + id);
                    return this;
                }
                translation = translations[id];
            }
            translation.xyz = xyz;
            return this;
        }
        for (var i = 0, len = id.length; i < len; i++) {
            this.setTranslate(id[i], xyz);
        }
        return this;
    };

    /**
     * Increments or decrements the translation of a model or an object.
     *
     * @param {String} id ID of a model or object.
     * @param {[Number, Number, Number]} xyz World-space translation vector.
     * @returns {Viewer} this
     * @example
     * viewer.addTranslate("saw", [10,0,0]);
     * viewer.addTranslate("saw#3.1", [10,0,0]);
     */
    this.addTranslate = function (id, xyz) {
        if (xeogl._isString(id)) {
            var translation = translations[id];
            if (!translation) {
                var component = getTransformableComponent(id);
                if (!component) {
                    error("Model or object not found: " + id);
                    return this;
                }
                translation = translations[id];
            }
            var xyzOld = translation.xyz;
            translation.xyz = [xyzOld[0] + xyz[0], xyzOld[1] + xyz[1], xyzOld[2] + xyz[2]];
            return this;
        }
        for (var i = 0, len = id.length; i < len; i++) {
            this.addTranslate(id[i], xyz);
        }
        return this;
    };

    /**
     * Gets the translation of a model or an object.
     *
     * An object's translation is relative to that of its model. For example, if an object has a translation
     * of ````[100, 0, 0]```` and its model has a translation of ````[50, 50, 50]```` , then the object's effective
     * translation is ````[150, 50, 50]````.
     *
     * The translation of each model or object is ````[0, 0, 0]```` by default.
     *
     * @param {String} id ID of a model or an object.
     * @return {[Number, Number, Number]} World-space translation vector.
     * @example
     * var sawTranslate = viewer.getTranslate("saw");
     * var sawCoverTranslate = viewer.getTranslate("saw#3.1");
     */
    this.getTranslate = function (id) {
        var translation = translations[id];
        if (!translation) {
            var component = getTransformableComponent(id);
            if (!component) {
                error("Model or object not found: " + id);
                return 0;
            }
            translation = translations[id];
        }
        return translation.xyz.slice();
    };

    function getTransformableComponent(id) {
        var component = getComponent(id);
        if (!component) {
            return;
        }
        if (transformable[id]) {
            return component;
        }
        if (models[id]) {
            buildModelTransform(component);
        } else {
            buildObjectTransform(component);
        }
        return component;
    }

    function getComponent(id) {
        var component = objects[id];
        if (!component) {
            component = models[id];
        }
        return component;
    }

    var buildModelTransform = (function () {
        var offset = new Float32Array(3);
        var negOffset = new Float32Array(3);
        return function (model) {
            var modelCenter = model.worldBoundary.center;
            var sceneCenter = scene.worldBoundary.center;
            math.subVec3(modelCenter, sceneCenter, offset);
            math.mulVec3Scalar(offset, -1, negOffset);
            var id = model.id;
            model.transform = new xeogl.Translate(model, {
                xyz: negOffset,
                parent: scales[id] = new xeogl.Scale(model, {
                    parent: rotations[id] = new xeogl.Quaternion(model, {
                        parent: translations[id] = new xeogl.Translate(model, {
                            parent: new xeogl.Translate(model, {
                                xyz: offset
                            })
                        })
                    })
                })
            });
            transformable[model.id] = true;
        };
    })();

    var buildObjectTransform = (function () {
        var matrix = new Float32Array(16);
        var offset = new Float32Array(3);
        var negOffset = new Float32Array(3);
        return function (object) {
            var objectId = object.id;
            var model = objectModels[objectId];
            var objectCenter = object.worldBoundary.center;
            var sceneCenter = scene.worldBoundary.center;
            math.subVec3(objectCenter, sceneCenter, offset);
            math.mulVec3Scalar(offset, -1, negOffset);
            var modelTransform = model.transform;
            math.identityMat4(matrix);
            for (var transform = object.transform; transform.id !== modelTransform.id; transform = transform.parent) {
                math.mulMat4(matrix, transform.matrix, matrix);
            }
            object.transform = new xeogl.Transform(object, {
                matrix: matrix,
                parent: new xeogl.Translate(object, {
                    xyz: negOffset,
                    parent: scales[objectId] = new xeogl.Scale(object, {
                        parent: rotations[objectId] = new xeogl.Quaternion(object, {
                            parent: translations[objectId] = new xeogl.Translate(object, {
                                parent: new xeogl.Translate(object, {
                                    xyz: offset,
                                    parent: model.transform
                                })
                            })
                        })
                    })
                })
            });
            transformable[object.id] = true;
        };
    })();

    //==================================================================================================================
    // Visibility
    //==================================================================================================================

    /**
     * Shows model/object/types/clip/annotation/light(s).
     *
     * Shows all objects in the viewer when no arguments are given.
     *
     * Objects are visible by default.
     *
     * @param {String|String[]} [ids] IDs of model/object/types/clip/annotation/light(s).
     * @returns {Viewer} this
     * @example
     *
     * // Show all objects in the viewer
     * viewer.show();
     *
     * // Show all objects in models "saw" and "gearbox"
     * viewer.show(["saw", "gearbox"]);
     *
     * // Show two objects in model "saw", plus all objects in model "gearbox"
     * viewer.show(["saw#0.1", "saw#0.2", "gearbox"]);
     *
     * // Show objects in the model "gearbox", plus all objects in viewer that are IFC cable fittings and carriers
     * viewer.show("gearbox", "IfcCableFitting", "IfcCableCarrierFitting"]);
     */
    this.show = function (ids) {
        setVisible(ids, true);
        return this;
    };

    /**
     * Hides model/object/types/clip/annotation/light(s).
     *
     * Hides all objects in the viewer when no arguments are given.
     *
     * Objects are visible by default.
     *
     * @param {String|String[]} ids IDs of model/object/types/clip/annotation/light(s).
     * @returns {Viewer} this
     * @example
     *
     * // Hide all objects in the viewer
     * viewer.hide();
     *
     * // Hide all objects in models "saw" and "gearbox"
     * viewer.hide(["saw", "gearbox"]);
     *
     * // Hide two objects in model "saw", plus all objects in model "gearbox"
     * viewer.hide(["saw#0.1", "saw#0.2", "gearbox"]);
     *
     * // Hide objects in the model "gearbox", plus all objects in viewer that are IFC cable fittings and carriers
     * viewer.hide("gearbox", "IfcCableFitting", "IfcCableCarrierFitting"]);
     */
    this.hide = function (ids) {
        setVisible(ids, false);
        return this;
    };

    function setVisible(ids, visible) {
        if (ids === undefined || ids === null) {
            setVisible(self.getObjects(), visible);
            setVisible(self.getLights(), visible);
            setVisible(self.getClips(), visible);
            return;
        }
        if (xeogl._isString(ids)) {
            var id = ids;
            var object = objects[id];
            if (object) {
                object.visible = visible;
                return;
            }
            var light = lights[id];
            if (light) {
                var lightHelper = lightHelpers[id];
                if (lightHelper) {
                    lightHelper.visible = visible;
                }
                return;
            }
            var clipHelper = clipHelpers[id];
            if (clipHelper) {
                clipHelper.visible = visible;
                return;
            }
            // TODO: Show/hide annotations
            var model = models[id];
            if (!model) {
                var objectsOfType = types[id];
                if (objectsOfType) {
                    var typeIds = Object.keys(objectsOfType);
                    if (typeIds.length === 0) {
                        return;
                    }
                    setVisible(typeIds, visible);
                    return
                }
                error("Model, object or type not found: " + id);
                return;
            }
            setVisible(self.getObjects(id), visible);
            return;
        }
        for (var i = 0, len = ids.length; i < len; i++) {
            setVisible(ids[i], visible);
        }
    }

    //==================================================================================================================
    // Opacity
    //==================================================================================================================

    /**
     * Sets the opacity of model/object/type(s).
     *
     * @param {String|String[]} ids IDs of models, objects or types. Sets opacity of all objects when this is null or undefined.
     * @param {Number} opacity Degree of opacity in range ````[0..1]````.
     * @returns {Viewer} this
     * @example
     * // Create an X-ray view of two objects in the "saw" model
     * viewer.setOpacity("saw", 0.4);
     * viewer.setOpacity(["saw#0.1", "saw#0.2"], 1.0);
     */
    this.setOpacity = function (ids, opacity) {
        if (opacity === null || opacity === undefined) {
            opacity = 1.0;
        }
        if (ids === undefined || ids === null) {
            self.setOpacity(self.getObjects(), opacity);
            return this;
        }
        if (xeogl._isString(ids)) {
            var id = ids;
            var object = objects[id];
            if (object) {
                object.material.alphaMode = (opacity < 1) ? "blend" : "opaque";
                object.material.alpha = opacity;
                return;
            }
            var model = models[id];
            if (!model) {
                var objectsOfType = types[id];
                if (objectsOfType) {
                    var typeIds = Object.keys(objectsOfType);
                    if (typeIds.length === 0) {
                        return this;
                    }
                    self.setOpacity(typeIds, opacity);
                    return this;
                }
                error("Model, object or type not found: " + id);
                return this;
            }
            self.setOpacity(self.getObjects(id), opacity);
            return this;
        }
        for (var i = 0, len = ids.length; i < len; i++) {
            self.setOpacity(ids[i], opacity);
        }
        return this;
    };

    /**
     * Gets the opacity of an object.
     *
     * @param {String|String} id ID of an object.
     * @return {Number} Degree of opacity in range [0..1].
     * @example
     * var sawObjectOpacity = viewer.getOpacity("saw#0.1");
     */
    this.getOpacity = function (id) {
        var object = objects[id];
        if (!object) {
            error("Model, object or type not found: " + id);
            return 1.0;
        }
        return object.material.alpha;
    };

    //==================================================================================================================
    // Color
    //==================================================================================================================

    /**
     * Sets the color of model/object/type/light(s).
     *
     * @param {String|String[]} ids IDs of models, objects, types or lights. Applies to all objects when this is null or undefined.
     * @param {[Number, Number, Number]} color The RGB color, with each element in range [0..1].
     * @returns {Viewer} this
     * @example
     *  // Set all objects in saw model red
     * viewer.setColor("saw", [1,0,0]);
     *
     *  // Set two objects in saw model green
     * viewer.setColor(["saw#0.1", "saw#0.2"], [0,1,0]);
     */
    this.setColor = function (ids, color) {
        if (color === null || color === undefined) {
            color = [1, 1, 1];
        }
        if (ids === undefined || ids === null) {
            self.setColor(self.getObjects(), color);
            return this;
        }
        if (xeogl._isString(ids)) {
            var id = ids;
            var object = objects[id];
            if (object) {
                var material = object.material;
                if (material.diffuse) {
                    material.diffuse = color; // xeogl.SpecularMaterial or xeogl.Phongmaterial
                } else {
                    material.baseColor = color; // xeogl.MetallicMaterial
                }
                return this;
            }
            var light = lights[id];
            if (light) {
                light.color = color;
                return this;
            }
            var model = models[id];
            if (!model) {
                var objectsOfType = types[id];
                if (objectsOfType) {
                    var typeIds = Object.keys(objectsOfType);
                    if (typeIds.length === 0) {
                        return;
                    }
                    self.setColor(typeIds, color);
                    return this;
                }
                error("Model, object or type not found: " + id);
                return this;
            }
            self.setColor(self.getObjects(id), color);
            return this;
        }
        for (var i = 0, len = ids.length; i < len; i++) {
            self.setColor(ids[i], color);
        }
        return this;
    };

    /**
     * Gets the color of an object or a light.
     *
     * @param {String|String} id ID of an object or a light.
     * @return {[Number, Number, Number]} color The RGB color, with each element in range [0..1].
     * @example
     * var objectColor = viewer.getColor("saw#3.1");
     */
    this.getColor = function (id) {
        var object = objects[id];
        if (object) {
            var material = object.material;
            var color = material.diffuse || material.baseColor || [1, 1, 1]; // PhongMaterial || SpecularMaterial || MetallicMaterial
            return color.slice();
        }
        var light = lights[id];
        if (light) {
            return light.color.slice();
        }
        error("Object or light not found: " + id);
    };

    //==================================================================================================================
    // Clippability
    //==================================================================================================================

    /**
     * Makes model/object/type(s) clippable.
     *
     * Makes all objects in the viewer clippable when no arguments are given.
     *
     * Objects are clippable by default.
     *
     * @param {String|String[]} [ids] IDs of model(s) and/or object(s).
     * @returns {Viewer} this
     * @example
     *
     * // Make all objects in the viewer clippable
     * viewer.setClippable();
     *
     * // Make all objects in models "saw" and "gearbox" clippable
     * viewer.setClippable(["saw", "gearbox"]);
     *
     * // Make two objects in model "saw" clippable, plus all objects in model "gearbox"
     * viewer.setClippable(["saw#0.1", "saw#0.2", "gearbox"]);
     *
     * // Make objects in the model "gearbox" clippable, plus all objects in viewer that are IFC cable fittings and carriers
     * viewer.setClippable("gearbox", "IfcCableFitting", "IfcCableCarrierFitting"]);
     */
    this.setClippable = function (ids) {
        setClippable(ids, true);
        return this;
    };

    /**
     * Makes model/object/type(s) unclippable.
     *
     * Unclippable objects will then remain fully visible when they would otherwise be clipped by clipping planes.
     *
     * Makes all objects in the viewer unclippable when no arguments are given.
     *
     * Objects are clippable by default.
     *
     * @param {String|String[]} ids IDs of model(s) and/or object(s).
     * @returns {Viewer} this
     * @example
     *
     * // Make all objects in the viewer unclippable
     * viewer.setUnclippable();
     *
     * // Make all objects in models "saw" and "gearbox" unclippable
     * viewer.setUnclippable(["saw", "gearbox"]);
     *
     * // Make two objects in model "saw" unclippable, plus all objects in model "gearbox"
     * viewer.setUnclippable(["saw#0.1", "saw#0.2", "gearbox"]);
     *
     * // Make all objects in the model "gearbox" unclippable, plus all objects in viewer that are IFC cable fittings and carriers
     * viewer.setUnclippable("gearbox", "IfcCableFitting", "IfcCableCarrierFitting"]);
     */
    this.setUnclippable = function (ids) {
        setClippable(ids, false);
        return this;
    };

    function setClippable(ids, clippable) {
        if (ids === undefined || ids === null) {
            setClippable(self.getObjects(), clippable);
            return;
        }
        if (xeogl._isString(ids)) {
            var id = ids;
            var object = objects[id];
            if (object) {
                object.clippable = clippable;
                return;
            }
            var model = models[id];
            if (!model) {
                var objectsOfType = types[id];
                if (objectsOfType) {
                    var typeIds = Object.keys(objectsOfType);
                    if (typeIds.length === 0) {
                        return;
                    }
                    setClippable(typeIds, clippable);
                    return
                }
                error("Model, object or type not found: " + id);
                return;
            }
            setClippable(self.getObjects(id), clippable);
            return;
        }
        for (var i = 0, len = ids.length; i < len; i++) {
            setClippable(ids[i], clippable);
        }
    }

    //==================================================================================================================
    // Pickability
    //==================================================================================================================

    /**
     * Makes model(s) and/or object(s) pickable.
     *
     * Makes all objects in the viewer pickable when no arguments are given.
     *
     * Objects are pickable by default.
     *
     * @param {String|String[]} [ids] IDs of model(s) and/or object(s).
     * @returns {BIMViewer} this
     * @example
     *
     * // Make all objects in the viewer pickable
     * viewer.setPickable();
     *
     * // Make all objects in models "saw" and "gearbox" pickable
     * viewer.setPickable(["saw", "gearbox"]);
     *
     * // Make two objects in model "saw" pickable, plus all objects in model "gearbox"
     * viewer.setPickable(["saw#0.1", "saw#0.2", "gearbox"]);
     *
     * // Make objects in the model "gearbox" pickable, plus all objects in viewer that are IFC cable fittings and carriers
     * viewer.setPickable("gearbox", "IfcCableFitting", "IfcCableCarrierFitting"]);
     */
    this.setPickable = function (ids) {
        setPickable(ids, true);
        return this;
    };

    /**
     * Makes model(s) and/or object(s) unpickable.
     *
     * Makes all objects in the viewer unpickable when no arguments are given.
     *
     * Objects are pickable by default.
     *
     * @param {String|String[]} ids IDs of model(s) and/or object(s).
     * @returns {BIMViewer} this
     * @example
     *
     * // Make all objects in the viewer unpickable
     * viewer.setUnpickable();
     *
     * // Make all objects in models "saw" and "gearbox" unpickable
     * viewer.setUnpickable(["saw", "gearbox"]);
     *
     * // Make two objects in model "saw" unpickable, plus all objects in model "gearbox"
     * viewer.setUnpickable(["saw#0.1", "saw#0.2", "gearbox"]);
     *
     * // Make all objects in the model "gearbox" unpickable, plus all objects in viewer that are IFC cable fittings and carriers
     * viewer.setUnpickable("gearbox", "IfcCableFitting", "IfcCableCarrierFitting"]);
     */
    this.setUnpickable = function (ids) {
        setPickable(ids, false);
        return this;
    };

    function setPickable(ids, pickable) {
        if (ids === undefined || ids === null) {
            setPickable(self.getObjects(), pickable);
            return;
        }
        if (xeogl._isString(ids)) {
            var id = ids;
            var object = objects[id];
            if (object) {
                object.pickable = pickable;
                return;
            }
            var model = models[id];
            if (!model) {
                var objectsOfType = types[id];
                if (objectsOfType) {
                    var typeIds = Object.keys(objectsOfType);
                    if (typeIds.length === 0) {
                        return;
                    }
                    setPickable(typeIds, pickable);
                    return
                }
                error("Model, object or type not found: " + id);
                return;
            }
            setPickable(self.getObjects(id), pickable);
            return;
        }
        for (var i = 0, len = ids.length; i < len; i++) {
            setPickable(ids[i], pickable);
        }
    }

    //----------------------------------------------------------------------------------------------------
    // Outlines
    //----------------------------------------------------------------------------------------------------

    /**
     * Shows outline around model/object/type(s).
     *
     * Outlines all objects in the viewer when no arguments are given.
     *
     * @param {String|String[]} ids IDs of model(s) and/or object(s). Outlines all objects by default.
     * @returns {Viewer} this
     * @example
     * viewer.showOutline(); // Show outline around all objects in viewer
     * viewer.showOutline("saw"); // Show outline around all objects in saw model
     * viewer.showOutline(["saw#0.1", "saw#0.2"]); // Show outline around two objects in saw model
     */
    this.showOutline = function (ids) {
        setOutline(ids, true);
        return this;
    };

    /**
     * Hides outline around model/object/type(s).
     *
     * Hides all outlines in the viewer when no arguments are given.
     *
     * @param {String|String[]} ids IDs of model(s) and/or object(s).
     * @returns {Viewer} this
     * @example
     * viewer.hideOutline(); // Hide outline around all objects in viewer
     * viewer.hideOutline("saw"); // Hide outline around all objects in saw model
     * viewer.hideOutline(["saw#0.1", "saw#0.2"]); // Hide outline around two objects in saw model
     */
    this.hideOutline = function (ids) {
        setOutline(ids, false);
        return this;
    };

    function setOutline(ids, outline) {
        if (ids === undefined || ids === null) {
            setOutline(self.getObjects(), outline);
            return this;
        }
        if (xeogl._isString(ids)) {
            var id = ids;
            var object = objects[id];
            if (object) {
                object.outlined = outline;
                return this;
            }
            var model = models[id];
            if (!model) {
                var objectsOfType = types[id];
                if (objectsOfType) {
                    var typeIds = Object.keys(objectsOfType);
                    if (typeIds.length === 0) {
                        return this;
                    }
                    setOutline(typeIds, outline);
                    return
                }
                error("Model, object or type not found: " + id);
                return this;
            }
            setOutline(self.getObjects(id), outline);
            return this;
        }
        for (var i = 0, len = ids.length; i < len; i++) {
            setOutline(ids[i], outline);
        }
        return this;
    }

    /**
     * Sets the current outline thickness.
     * @param {Number} thickness Thickness in pixels.
     * @returns {Viewer} this
     * @example
     * viewer.setOutlineThickness(3);
     */
    this.setOutlineThickness = function (thickness) {
        scene.outline.thickness = thickness;
        return this;
    };

    /**
     * Gets the current outline thickness.
     * @return {Number} Thickness in pixels.
     */
    this.getOutlineThickness = function () {
        return scene.outline.thickness;
    };

    /**
     * Sets the current outline color.
     * @param {[Number, Number, Number]} color RGB color as a value per channel, in range [0..1].
     * @returns {Viewer} this
     * @example
     * viewer.setOutlineColor([1,0,0]);
     */
    this.setOutlineColor = function (color) {
        scene.outline.color = color;
        return this;
    };

    /**
     * Returns the current outline color.
     * @return {[Number, Number, Number]} RGB color as a value per channel, in range [0..1].
     */
    this.getOutlineColor = function () {
        return scene.outline.color;
    };

    //----------------------------------------------------------------------------------------------------
    // Boundaries
    //----------------------------------------------------------------------------------------------------

    /**
     * Gets the World-space center point of the given model/object/types/clip/annotation/light(s).
     *
     * When no arguments are given, returns the collective center of all objects in the viewer.
     *
     * @param {String|String[]} target IDs of models and/or objects.
     * @returns {[Number, Number, Number]} The World-space center point.
     * @example
     * viewer.getCenter(); // Gets collective center of all objects in the viewer
     * viewer.getCenter("saw"); // Gets collective center of all objects in saw model
     * viewer.getCenter(["saw", "gearbox"]); // Gets collective center of all objects in saw and gearbox models
     * viewer.getCenter("saw#0.1"); // Get center of an object in the saw model
     * viewer.getCenter(["saw#0.1", "saw#0.2"]); // Get collective center of two objects in saw model
     */
    this.getCenter = function (target) {
        var aabb = this.getAABB(target);
        return new Float32Array([
            (aabb[0] + aabb[3]) / 2,
            (aabb[1] + aabb[4]) / 2,
            (aabb[2] + aabb[5]) / 2
        ]);
    };

    /**
     * Gets the axis-aligned World-space boundary of the given model/object/type/annotation/light(s).
     *
     * When no arguments are given, returns the collective boundary of all objects in the viewer.
     *
     * @param {String|String[]} target IDs of model/object/type/annotation/light(s).
     * @returns {[Number, Number, Number, Number, Number, Number]} An axis-aligned World-space bounding box, given as elements ````[xmin, ymin, zmin, xmax, ymax, zmax]````.
     * @example
     * viewer.getAABB(); // Gets collective boundary of all objects in the viewer
     * viewer.getAABB("saw"); // Gets collective boundary of all objects in saw model
     * viewer.getAABB(["saw", "gearbox"]); // Gets collective boundary of all objects in saw and gearbox models
     * viewer.getAABB("saw#0.1"); // Get boundary of an object in the saw model
     * viewer.getAABB(["saw#0.1", "saw#0.2"]); // Get collective boundary of two objects in saw model
     */
    this.getAABB = function (target) {
        if (arguments.length === 0 || target === undefined) {
            return scene.worldBoundary.aabb;
        }
        if (xeogl._isArray(target) && (!xeogl._isString(target[0]))) {
            return target; // AABB
        }
        if (xeogl._isString(target)) {
            target = [target];
        }
        if (target.length === 0) {
            return scene.worldBoundary.aabb;
        }
        var id;
        var component;
        var worldBoundary;
        var objectsOfType;
        if (target.length === 1) {
            id = target[0];
            component = scene.components[id];
            if (component) {
                worldBoundary = component.worldBoundary;
                if (worldBoundary) {
                    return worldBoundary.aabb;
                } else {
                    error("// TODO: Calculate AABB for a single light source or annotation");
                    return null;
                }
            } else {
                objectsOfType = types[id];
                if (objectsOfType) {
                    return this.getAABB(Object.keys(objectsOfType));
                }
                return null;
            }
        }
        // Many ids given
        var i;
        var len;
        var xmin = 100000;
        var ymin = 100000;
        var zmin = 100000;
        var xmax = -100000;
        var ymax = -100000;
        var zmax = -100000;
        var aabb;
        var pos;
        var valid = false;
        for (i = 0, len = target.length; i < len; i++) {
            aabb = null;
            pos = null;
            id = target[i];
            component = scene.components[id];
            if (!component) {
                component = models[id];
            }
            if (component) {
                worldBoundary = component.worldBoundary;
                if (worldBoundary) {
                    aabb = worldBoundary.aabb;
                } else if (component.pos) {
                    pos = component.pos;
                } else {
                    continue;
                }
            } else {
                objectsOfType = types[id];
                if (objectsOfType) {
                    var ids = Object.keys(objectsOfType);
                    if (ids.length === 0) {
                        continue;
                    }
                    aabb = this.getAABB(ids);
                } else {
                    continue;
                }
            }
            if (aabb) {
                if (aabb[0] < xmin) {
                    xmin = aabb[0];
                }
                if (aabb[1] < ymin) {
                    ymin = aabb[1];
                }
                if (aabb[2] < zmin) {
                    zmin = aabb[2];
                }
                if (aabb[3] > xmax) {
                    xmax = aabb[3];
                }
                if (aabb[4] > ymax) {
                    ymax = aabb[4];
                }
                if (aabb[5] > zmax) {
                    zmax = aabb[5];
                }
            }
            if (pos) {
                if (pos[0] < xmin) {
                    xmin = pos[0];
                }
                if (pos[1] < ymin) {
                    ymin = pos[1];
                }
                if (pos[2] < zmin) {
                    zmin = pos[2];
                }
                if (pos[3] > xmax) {
                    xmax = pos[0];
                }
                if (pos[4] > ymax) {
                    ymax = pos[1];
                }
                if (pos[5] > zmax) {
                    zmax = pos[2];
                }
            }
            valid = true;
        }
        if (valid) {
            var aabb2 = new math.AABB3();
            aabb2[0] = xmin;
            aabb2[1] = ymin;
            aabb2[2] = zmin;
            aabb2[3] = xmax;
            aabb2[1 + 3] = ymax;
            aabb2[2 + 3] = zmax;
            return aabb2;
        } else {
            return scene.worldBoundary.aabb;
        }
    };

    //----------------------------------------------------------------------------------------------------
    // Camera
    //----------------------------------------------------------------------------------------------------

    /**
     * Sets the field-of-view (FOV) angle for perspective projection.
     * @param {Number} fov Field-of-view angle, in degrees, on Y-axis.
     * @returns {Viewer} this
     */
    this.setPerspectiveFOV = function (fov) {
        projections.perspective.fov = fov;
        return this;
    };

    /**
     * Gets the field-of-view (FOV) angle for perspective projection.
     * @return  {Number} Field-of-view angle, in degrees, on Y-axis.
     */
    this.getPerspectiveFOV = function () {
        return projections.perspective.fov;
    };

    /**
     * Sets the position of the near plane on the View-space Z-axis for perspective projection.
     * @param {Number} near Position of the near plane on the View-space Z-axis.
     * @returns {Viewer} this
     */
    this.setPerspectiveNear = function (near) {
        projections.perspective.near = near;
        return this;
    };

    /**
     * Gets the position of the near plane on the View-space Z-axis for perspective projection.
     * @return  {Number} Position of the near clipping plane on the View-space Z-axis.
     */
    this.getPerspectiveNear = function () {
        return projections.perspective.near;
    };

    /**
     * Sets the position of the far clipping plane on the View-space Z-axis for perspective projection.
     * @param {Number} far Position of the far clipping plane on the View-space Z-axis.
     * @returns {Viewer} this
     */
    this.setPerspectiveFar = function (far) {
        projections.perspective.far = far;
        return this;
    };

    /**
     * Gets the position of the far clipping plane on the View-space Z-axis for perspective projection.
     * @return  {Number} Position of the far clipping plane on the View-space Z-axis.
     */
    this.getPerspectiveFar = function () {
        return projections.perspective.far;
    };

    /**
     * Sets the orthographic projection boundary scale on X and Y axis.
     *
     * This specifies how many units fit within the current orthographic boundary extents.
     *
     * @param {Number} scale The scale factor.
     * @returns {Viewer} this
     */
    this.setOrthoScale = function (scale) {
        projections.orthographic.scale = scale;
        return this;
    };

    /**
     * Gets the orthographic projection boundary scale.
     *
     * This specifies how many units fit within the current orthographic boundary extents.
     *
     * @return  {Number} The scale factor.
     */
    this.getOrthoScale = function () {
        return projections.orthographic.scale;
    };

    /**
     * Sets the position of the near plane on the View-space Z-axis for orthographic projection.
     *
     * @param {Number} near Position of the near plane on the View-space Z-axis.
     * @returns {Viewer} this
     */
    this.setOrthoNear = function (near) {
        projections.orthographic.near = near;
        return this;
    };

    /**
     * Gets the position of the near plane on the View-space Z-axis for orthographic projection.
     *
     * @return  {Number} Position of the near clipping plane on the View-space Z-axis.
     */
    this.getOrthoNear = function () {
        return projections.orthographic.near;
    };

    /**
     * Sets the position of the far clipping plane on the View-space Z-axis for orthographic projection.
     *
     * @param {Number} far Position of the far clipping plane on the View-space Z-axis.
     * @returns {Viewer} this
     */
    this.setOrthoFar = function (far) {
        projections.orthographic.far = far;
    };

    /**
     * Gets the position of the far clipping plane on the View-space Z-axis for orthographic projection.
     *
     * @return  {Number} Position of the far clipping plane on the View-space Z-axis.
     */
    this.getOrthoFar = function () {
        return projections.orthographic.far;
    };

    /**
     * Sets the camera's current projection type.
     *
     * Options are "perspective" and "ortho". You can set properties for either of these, regardless
     * of whether they are currently active or not.
     *
     * @param {String} type Either "perspective" or "ortho".
     * @returns {Viewer} this
     */
    this.setProjection = function (type) {
        if (projectionType === type) {
            return;
        }
        var projection = projections[type];
        if (!projection) {
            error("Unsupported camera projection type: " + type);
        } else {
            camera.project = projection;
            projectionType = type;
        }
        return this;
    };

    /**
     * Gets the camera's current projection type.
     *
     * @return {String} Either "perspective" or "ortho".
     */
    this.getProjection = function () {
        return projectionType;
    };

    /**
     * Sets the camera viewpoint.
     *
     * @param {[Number, Number, Number]} eye The new viewpoint.
     * @returns {Viewer} this
     */
    this.setEye = function (eye) {
        view.eye = eye;
        return this;
    };

    /**
     * Gets the camera viewpoint.
     *
     * @return {[Number, Number, Number]} The current viewpoint.
     */
    this.getEye = function () {
        return view.eye;
    };

    /**
     * Sets the camera's point-of-interest.
     *
     * @param {[Number, Number, Number]} look The new point-of-interest.
     * @returns {Viewer} this
     */
    this.setLook = function (look) {
        view.look = look;
        return this;
    };

    /**
     * Gets the camera's point-of-interest.
     *
     * @return {[Number, Number, Number]} The current point-of-interest.
     */
    this.getLook = function () {
        return view.look;
    };

    /**
     * Sets the camera's "up" direction.
     *
     * @param {[Number, Number, Number]} up The new up direction.
     * @returns {Viewer} this
     */
    this.setUp = function (up) {
        view.up = up;
        return this;
    };

    /**
     * Gets the camera's "up" direction.
     *
     * @return {[Number, Number, Number]} The current "up" direction.
     */
    this.getUp = function () {
        return view.up;
    };

    /**
     * Sets the camera's pose, which consists of eye position, point-of-interest and "up" vector.
     *
     * @param {[Number, Number, Number]} eye Camera's new viewpoint.
     * @param {[Number, Number, Number]} look Camera's new point-of-interest.
     * @param {[Number, Number, Number]} up Camera's new up direction.
     * @returns {Viewer} this
     */
    this.setEyeLookUp = function (eye, look, up) {
        view.eye = eye;
        view.look = look;
        view.up = up || [0, 1, 0];
        return this;
    };

    /**
     * Locks the camera's vertical rotation axis to the World-space Y axis.
     * @returns {Viewer} this
     */
    this.lockGimbalY = function () {
        view.gimbalLockY = true;
        return this;
    };

    /**
     * Allows camera yaw rotation around the camera's "up" vector.
     * @returns {Viewer} this
     */
    this.unlockGimbalY = function () {
        view.gimbalLockY = false;
        return this;
    };

    /**
     * Rotates the camera's 'eye' position about its 'look' position, around the 'up' vector.
     * @param {Number} angle Angle of rotation in degrees
     * @returns {Viewer} this
     */
    this.rotateEyeY = function (angle) {
        view.rotateEyeY(angle);
        return this;
    };

    /**
     * Rotates the camera's 'eye' position about its 'look' position, pivoting around its X-axis.
     * @param {Number} angle Angle of rotation in degrees
     * @returns {Viewer} this
     */
    this.rotateEyeX = function (angle) {
        view.rotateEyeX(angle);
        return this;
    };

    /**
     * Rotates the camera's 'look' position about its 'eye' position, pivoting around its 'up' vector.
     *
     * @param {Number} angle Angle of rotation in degrees
     * @returns {Viewer} this
     */
    this.rotateLookY = function (angle) {
        view.rotateLookY(angle);
        return this;
    };

    /**
     * Rotates the camera's 'eye' position about its 'look' position, pivoting around its X-axis.
     *
     * @param {Number} angle Angle of rotation in degrees
     * @returns {Viewer} this
     */
    this.rotateLookX = function (angle) {
        view.rotateLookX(angle);
        return this;
    };

    /**
     * Pans the camera along its local X, Y or Z axis.
     * @param {[Number, Number, Number]} pan The pan vector
     * @returns {Viewer} this
     */
    this.pan = function (pan) {
        view.pan(pan);
        return this;
    };

    /**
     * Increments/decrements the camera's zoom distance, ie. distance between eye and look.
     * @param {Number} delta The zoom increment.
     * @returns {Viewer} this
     */
    this.zoom = function (delta) {
        view.zoom(delta);
        return this;
    };

    /**
     * Sets the camera's flight duration when fitting elements to view.
     *
     * Initial default value is ````0.5```` seconds.
     *
     * A value of zero (default) will cause the camera to instantly jump to each new target .
     *
     * @param {Number} value The new flight duration, in seconds.
     * @returns {Viewer} this
     */
    this.setViewFitDuration = function (value) {
        cameraFlight.duration = value;
        return this;
    };

    /**
     * Gets the camera's flight duration when fitting elements to view.
     *
     * @returns {Number} The current flight duration, in seconds.
     */
    this.getViewFitDuration = function () {
        return cameraFlight.duration;
    };

    /**
     * Sets the target field-of-view (FOV) angle when fitting elements to view.
     *
     * This is the portion of the total frustum FOV that the elements' boundary
     * will occupy when fitted to view.
     *
     * Default value is 45.
     *
     * @param {Number} value The new view-fit FOV angle, in degrees.
     * @returns {Viewer} this
     */
    this.setViewFitFOV = function (value) {
        cameraFlight.fitFOV = value;
        return this;
    };

    /**
     * Gets the target field-of-view angle when fitting elements to view.
     *
     * @returns {Number} The current view-fit FOV angle, in degrees.
     */
    this.getViewFitFOV = function () {
        return cameraFlight.fitFOV;
    };

    /**
     * Moves the camera to fit the given model/object/annotation/light/boundary(s).
     *
     * Preserves the direction that the camera is currently pointing in.
     *
     * A boundary is an axis-aligned World-space bounding box, given as elements ````[xmin, ymin, zmin, xmax, ymax, zmax]````.
     *
     * @param {String|[]} target The elements to fit in view, given as either the ID of an annotation, model or object, a boundary, or an array containing mixture of IDs and boundaries.
     * @param {Function} [ok] Callback fired when camera has arrived at its target position.
     * @returns {Viewer} this
     */
    this.viewFit = function (target, ok) {
        if (xeogl._isString(target)) {
            var annotation = annotations[target];
            if (annotation) {
                if (ok || cameraFlight.duration > 0) {
                    cameraFlight.flyTo({eye: annotation.eye, look: annotation.look, up: annotation.up}, ok);
                } else {
                    cameraFlight.jumpTo({eye: annotation.eye, look: annotation.look, up: annotation.up});
                }
                return this;
            }
        }
        if (ok || cameraFlight.duration > 0) {
            cameraFlight.flyTo({aabb: this.getAABB(target)}, ok);
        } else {
            cameraFlight.jumpTo({aabb: this.getAABB(target)});
        }
        return this;
    };

    /**
     * Moves the camera to fit the given model/object/annotation/light/boundary(s) in view, while looking along the +X axis.
     *
     * @param {String|[]} target The element(s) to fit in view, given as either the ID of model, ID of object, a boundary, or an array containing mixture of IDs and boundaries.
     * @param {Function} [ok] Callback fired when camera has arrived at its target position.
     * @returns {Viewer} this
     */
    this.viewFitRight = function (target, ok) {
        viewFitAxis(target, 0, ok);
        return this;
    };

    /**
     * Moves the camera to fit the given model/object/annotation/light/boundary(s) in view, while looking along the +Z axis.
     *
     * @param {String|[]} target The element(s) to fit in view, given as either the ID of model, ID of object, a boundary, or an array containing mixture of IDs and boundaries.
     * @param {Function} [ok] Callback fired when camera has arrived at its target position.
     * @returns {Viewer} this
     */
    this.viewFitBack = function (target, ok) {
        viewFitAxis(target, 1, ok);
        return this;
    };

    /**
     * Moves the camera to fit the given model/object/annotation/light/boundary(s) in view, while looking along the -X axis.
     *
     * @param {String|[]} target The element(s) to fit in view, given as either the ID of model, ID of object, a boundary, or an array containing mixture of IDs and boundaries.
     * @param {Function} [ok] Callback fired when camera has arrived at its target position.
     * @returns {Viewer} this
     */
    this.viewFitLeft = function (target, ok) {
        viewFitAxis(target, 2, ok);
        return this;
    };

    /**
     * Moves the camera to fit the given model/object/annotation/light/boundary(s) in view, while looking along the +X axis.
     *
     * @param {String|[]} target The element(s) to fit in view, given as either the ID of model, ID of object, a boundary, or an array containing mixture of IDs and boundaries.
     * @param {Function} [ok] Callback fired when camera has arrived at its target position.
     * @returns {Viewer} this
     */
    this.viewFitFront = function (target, ok) {
        viewFitAxis(target, 3, ok);
        return this;
    };

    /**
     * Moves the camera to fit the given model/object/annotation/light/boundary(s) in view, while looking along the -Y axis.
     *
     * @param {String|[]} target The element(s) to fit in view, given as either the ID of model, ID of object, a boundary, or an array containing mixture of IDs and boundaries.
     * @param {Function} [ok] Callback fired when camera has arrived at its target position.
     * @returns {Viewer} this
     */
    this.viewFitTop = function (target, ok) {
        viewFitAxis(target, 4, ok);
        return this;
    };

    /**
     * Moves the camera to fit the given model/object/annotation/light/boundary(s) in view, while looking along the +X axis.
     *
     * @param {String|[]} target The element(s) to fit in view, given as either the ID of model, ID of object, a boundary, or an array containing mixture of IDs and boundaries.
     * @param {Function} [ok] Callback fired when camera has arrived at its target position.
     * @returns {Viewer} this
     */
    this.viewFitBottom = function (target, ok) {
        viewFitAxis(target, 5, ok);
        return this;
    };

    var viewFitAxis = (function () {
        var center = new math.vec3();
        return function (target, axis, ok) {
            var aabb = self.getAABB(target);
            var diag = math.getAABB3Diag(aabb);
            center[0] = aabb[0] + aabb[3] / 2.0;
            center[1] = aabb[1] + aabb[4] / 2.0;
            center[2] = aabb[2] + aabb[5] / 2.0;
            var dist = Math.abs((diag) / Math.tan(cameraFlight.fitFOV / 2));
            var cameraTarget;
            switch (axis) {
                case 0: // Right view
                    cameraTarget = {
                        look: center,
                        eye: [center[0] - dist, center[1], center[2]],
                        up: [0, 1, 0]
                    };
                    break;
                case 1: // Back view
                    cameraTarget = {
                        look: center,
                        eye: [center[0], center[1], center[2] - dist],
                        up: [0, 1, 0]
                    };
                    break;
                case 2: // Left view
                    cameraTarget = {
                        look: center,
                        eye: [center[0] + dist, center[1], center[2]],
                        up: [0, 1, 0]
                    };
                    break;
                case 3: // Front view
                    cameraTarget = {
                        look: center,
                        eye: [center[0], center[1], center[2] + dist],
                        up: [0, 1, 0]
                    };
                    break;
                case 4: // Top view
                    cameraTarget = {
                        look: center,
                        eye: [center[0], center[1] + dist, center[2]],
                        up: [0, 0, 1]
                    };
                    break;
                case 5: // Bottom view
                    cameraTarget = {
                        look: center,
                        eye: [center[0], center[1] - dist, center[2]],
                        up: [0, 0, -1]
                    };
                    break;
            }
            if (ok || cameraFlight.duration > 0.1) {
                cameraFlight.flyTo(cameraTarget, ok);
            } else {
                cameraFlight.jumpTo(cameraTarget);
            }
            return this;
        };
    })();

    /**
     * Sets the camera's 'eye' position orbiting its 'look' position, pivoting
     * about the camera's local horizontal axis, by the given increment on each frame.
     *
     * Call with a zero value to stop spinning about this axis.
     *
     * @param {Number} value The increment angle, in degrees.
     */
    this.yspin = function (value) {
        return (arguments.length === 0) ? yspin : yspin = value;
    };

    /**
     * Sets the camera's 'eye' position orbiting about its 'look' position, pivoting
     * about the camera's horizontal axis, by the given  increment on each frame.
     *
     * Call again with a zero value to stop spinning about this axis.
     *
     * @param {Number} value The increment angle, in degrees.
     */
    this.xspin = function (value) {
        return (arguments.length === 0) ? xspin : xspin = value;
    };

    //----------------------------------------------------------------------------------------------------
    // Ray casting
    //----------------------------------------------------------------------------------------------------

    /**
     * Picks the first object that intersects the given ray.
     *
     * @param {[Number, Number, Number]} origin World-space ray origin.
     * @param {[Number, Number, Number]} dir World-space ray direction vector.
     * @returns {{id: String}} If object found, a hit record containing the ID of the object, else null.
     * @example
     * var hit = viewer.rayCastObject([0,0,-5], [0,0,1]);
     * if (hit) {
     *      var objectId = hit.id;
     * }
     */
    this.rayCastObject = function (origin, dir) {
        var hit = scene.pick({origin: origin, direction: dir, pickSurface: false});
        if (hit) {
            return {id: hit.entity.id};
        }
    };

    /**
     * Picks the first object that intersects the given ray, along with geometric information about
     * the ray-object intersection.
     *
     * @param {[Number, Number, Number]} origin World-space ray origin.
     * @param {[Number, Number, Number]} dir World-space ray direction vector.
     * @returns {{id: String, worldPos: [number,number,number], primIndex:number, bary: [number,number,number]}} If object
     * found, a hit record containing the ID of object, World-space 3D surface intersection, primitive index and
     * barycentric coordinates, else null.
     * @example
     * var hit = viewer.rayCastSurface([0,0,-5], [0,0,1]);
     * if (hit) {
     *      var objectId = hit.id;
     *      var primitive = hit.primitive;
     *      var primIndex = hit.primIndex;
     *      var bary = hit.bary;
     * }
     */
    this.rayCastSurface = function (origin, dir) {
        var hit = scene.pick({origin: origin, direction: dir, pickSurface: true});
        if (hit) {
            return {
                id: hit.entity.id,
                worldPos: hit.worldPos,
                normal: hit.normal,
                primIndex: hit.primIndex,
                bary: hit.bary
            };
        }
    };

    /**
     * Picks the closest object behind the given canvas coordinates.
     *
     * This is equivalent to firing a ray through the canvas, down the negative Z-axis, to find the first entity it hits.
     *
     * @param {[Number, Number]} canvasPos Canvas position.
     * @returns {{id: String}} If object found, a hit record containing the ID of the object, else null.
     * @example
     * var hit = viewer.pickObject([234, 567]);
     * if (hit) {
     *      var objectId = hit.id;
     * }
     */
    this.pickObject = function (canvasPos) {
        var hit = scene.pick({canvasPos: canvasPos, pickSurface: false});
        if (hit) {
            return {id: hit.entity.id};
        }
    };

    /**
     * Picks the closest object behind the given canvas coordinates, along with geometric information about
     * the point on the object's surface that lies right behind those canvas coordinates.
     *
     * @param {[Number, Number]} canvasPos Canvas position.
     * @returns {{id: String, worldPos: [number,number,number], primIndex:number, bary: [number,number,number]}} If object
     * found, a hit record containing the ID of object, World-space 3D surface intersection, primitive index and
     * barycentric coordinates, else null.
     * @example
     * var hit = viewer.pickSurface([234, 567]);
     * if (hit) {
     *      var objectId = hit.id;
     *      var primitive = hit.primitive;
     *      var primIndex = hit.primIndex;
     *      var bary = hit.bary;
     * }
     */
    this.pickSurface = function (canvasPos) {
        var hit = scene.pick({canvasPos: canvasPos, pickSurface: true});
        if (hit) {
            return {
                id: hit.entity.id,
                canvasPos: canvasPos,
                worldPos: hit.worldPos,
                normal: hit.normal,
                primIndex: hit.primIndex,
                bary: hit.bary
            };
        }
    };

    //----------------------------------------------------------------------------------------------------
    // Annotations
    //----------------------------------------------------------------------------------------------------

    /**
     * Creates an annotation.
     *
     * An annotation is a labeled pin that's attached to the surface of an object.
     *
     * An annotation is pinned within a triangle of an object's geometry, at a position given in barycentric
     * coordinates. A barycentric coordinate is a three-element vector that indicates the position within
     * the triangle as a weight per vertex, where a value of ````[0.3,0.3,0.3]```` places the annotation
     * at the center of its triangle.
     *
     * An annotation can be configured with an optional camera position from which to view it, given as ````eye````,
     * ````look```` and ````up```` vectors.
     *
     * By default, an annotation will be invisible while occluded by other objects in the 3D view.
     *
     * Note that when you pick an object with {@link #.Viewer#rayCastSurface} or {@link #.Viewer#pickSurface}, you'll get
     * a triangle index and barycentric coordinates in the intersection result. This makes it convenient to
     * create annotations directly from pick results.
     *
     * @param {String} id ID for the new annotation.
     * @param {Object} cfg Properties for the new annotation.
     * @param {String} cfg.object ID of an object to pin the annotation to.
     * @param {String} [cfg.glyph=""] A glyph for the new annotation. This appears in the annotation's pin and
     * is typically a short string of 1-2 chars, eg. "a1".
     * @param {String} [cfg.title=""] Title text for the new annotation.
     * @param {String} [cfg.desc=""] Description text for the new annotation.
     * @param {Number} cfg.primIndex Index of a triangle, within the object's geometry indices, to attach the annotation to.
     * @param {[Number, Number, Number]} cfg.bary Barycentric coordinates within the triangle, at which to position the annotation.
     * @param {[Number, Number, Number]} [cfg.eye] Eye position for optional camera viewpoint.
     * @param {[Number, Number, Number]} [cfg.look] Look position for optional camera viewpoint.
     * @param {[Number, Number, Number]} [cfg.up] Up direction for optional camera viewpoint.
     * @param {Boolean} [cfg.occludable=true] Whether or not the annotation dissappears while occluded by something else in the 3D view.
     * @param {Boolean} [cfg.pinShown=true] Whether or not the annotation's pin is initially shown.
     * @param {Boolean} [cfg.labelShown=true] Whether or not the annotation's label is initially shown.
     * @returns {Viewer} this
     */
    this.createAnnotation = function (id, cfg) {
        if (scene.components[id]) {
            error("Component with this ID already exists: " + id);
            return this;
        }
        if (cfg === undefined) {
            error("Annotation configuration expected");
            return this;
        }
        var objectId = cfg.object;
        if (objectId === undefined) {
            error("Annotation property expected: objectId");
            return this;
        }
        var object = objects[objectId];
        if (!object) {
            error("Object not found: " + objectId);
            return this;
        }
        var primIndex = cfg.primIndex;
        if (primIndex === undefined) {
            error("Annotation property expected: primIndex");
            return this;
        }
        var annotation = new xeogl.Annotation(scene, {
            id: id,
            entity: object,
            primIndex: primIndex,
            bary: cfg.bary,
            eye: cfg.eye,
            look: cfg.look,
            up: cfg.up,
            occludable: cfg.occludable,
            glyph: cfg.glyph,
            title: cfg.title,
            desc: cfg.desc,
            pinShown: cfg.pinShown,
            labelShown: cfg.labelShown
        });
        annotations[annotation.id] = annotation;
        var oa = objectAnnotations[objectId] || (objectAnnotations[objectId] = {});
        oa[annotation.id] = annotation;
        return this;
    };

    /**
     * Gets the IDs of the annotations within a model, object or a type.
     *
     * When no argument is given, returns the IDs of all annotations.
     *
     * @param {String|String[]} id ID of a model, object or IFC type.
     * @return {String[]} IDs of the annotations.
     */
    this.getAnnotations = function (id) {
        return Object.keys(annotations);
    };

    /**
     * Destroys all annotations.
     *
     * @return {Viewer} This viewer
     */
    this.destroyAnnotations = function () {
        this.destroy(this.getAnnotations());
        return this;
    };

    /**
     * Sets the triangle that an annotation is pinned to.
     *
     * The triangle is indicated by the position of the first of the triangle's vertex indices within
     * the object's geometry indices array.
     *
     * @param {String} id ID of the annotation.
     * @param {Number} primIndex The index of the triangle's first element within the geometry's
     * indices array.
     * @returns {Viewer} This viewer
     */
    this.setAnnotationPrimIndex = function (id, primIndex) {
        var annotation = annotations[id];
        if (!annotation) {
            error("Annotation not found: \"" + id + "\"");
            return this;
        }
        annotation.primIndex = primIndex;
        return this;
    };

    /**
     * Gets the triangle that an annotation is pinned to.
     *
     * The triangle is indicated by the position of the first of the triangle's vertex indices within
     * the object's geometry indices array.
     *
     * @param {String} id ID of the annotation.
     * @returns {Number} The index of the triangle's first element within the geometry's indices array.
     */
    this.getAnnotationPrimIndex = function (id) {
        var annotation = annotations[id];
        if (!annotation) {
            error("Annotation not found: \"" + id + "\"");
            return;
        }
        return annotation.primIndex;
    };

    /**
     * Sets the text within an annotation's pin.
     *
     * In order to fit within the pin, this should be a short string of 1-2 characters.
     *
     * @param {String} id ID of the annotation.
     * @param {String} glyph Pin text.
     * @returns {Viewer} This
     */
    this.setAnnotationGlyph = function (id, glyph) {
        var annotation = annotations[id];
        if (!annotation) {
            error("Annotation not found: \"" + id + "\"");
            return this;
        }
        annotation.glyph = glyph;
        return this;
    };

    /**
     * Gets the text within an annotation's pin.
     *
     * @param {String} id ID of the annotation.
     * @returns {String} Pin text.
     */
    this.getAnnotationGlyph = function (id) {
        var annotation = annotations[id];
        if (!annotation) {
            error("Annotation not found: \"" + id + "\"");
            return;
        }
        return annotation.glyph;
    };

    /**
     * Sets the title text within an annotation's label.
     *
     * @param {String} id ID of the annotation.
     * @param {String} title Title text.
     * @returns {Viewer} This
     */
    this.setAnnotationTitle = function (id, title) {
        var annotation = annotations[id];
        if (!annotation) {
            error("Annotation not found: \"" + id + "\"");
            return this;
        }
        annotation.title = title;
        return this;
    };

    /**
     * Gets the title text within an annotation's label.
     *
     * @param {String} id ID of the annotation.
     * @returns {String} Title text.
     */
    this.getAnnotationTitle = function (id) {
        var annotation = annotations[id];
        if (!annotation) {
            error("Annotation not found: \"" + id + "\"");
            return;
        }
        return annotation.title;
    };

    /**
     * Sets the description text within an annotation's label.
     *
     * @param {String} id ID of the annotation.
     * @param {String} title Description text.
     * @returns {Viewer} This
     */
    this.setAnnotationDesc = function (id, desc) {
        var annotation = annotations[id];
        if (!annotation) {
            error("Annotation not found: \"" + id + "\"");
            return this;
        }
        annotation.desc = desc;
        return this;
    };

    /**
     * Gets the description text within an annotation's label.
     *
     * @param {String} id ID of the annotation.
     * @returns {String} Title text.
     */
    this.getAnnotationDesc = function (id) {
        var annotation = annotations[id];
        if (!annotation) {
            error("Annotation not found: \"" + id + "\"");
            return;
        }
        return annotation.desc;
    };

    /**
     * Sets the barycentric coordinates of an annotation within its triangle.
     *
     * A barycentric coordinate is a three-element vector that indicates the position within the triangle as a weight per vertex,
     * where a value of ````[0.3,0.3,0.3]```` places the annotation at the center of its triangle.
     *
     * @param {String} id ID of the annotation.
     * @param {[Number, Number, Number]} bary The barycentric coordinates.
     * @returns {Viewer} This
     */
    this.setAnnotationBary = function (id, bary) {
        var annotation = annotations[id];
        if (!annotation) {
            error("Annotation not found: \"" + id + "\"");
            return this;
        }
        annotation.bary = bary;
        return this;
    };

    /**
     * Gets the barycentric coordinates of an annotation within its triangle.
     *
     * @param {String} id ID of the annotation.
     * @returns {[Number, Number, Number]} The barycentric coordinates.
     */
    this.getAnnotationBary = function (id) {
        var annotation = annotations[id];
        if (!annotation) {
            error("Annotation not found: \"" + id + "\"");
            return;
        }
        return annotation.bary;
    };

    /**
     * Sets the object that an annotation is pinned to.
     *
     * An annotation must always be pinned to an object.
     *
     * @param {String} id ID of the annotation.
     * @param {String} objectId ID of the object.
     * @returns {Viewer} This
     */
    this.setAnnotationObject = function (id, objectId) {
        var annotation = annotations[id];
        if (!annotation) {
            error("Annotation not found: \"" + id + "\"");
            return this;
        }
        var object = objects[objectId];
        if (!object) {
            error("Object not found: \"" + objectId + "\"");
            return this;
        }
        annotation.entity = object;
        return this;
    };

    /**
     * Gets the object that an annotation is pinned to.
     *
     * @param {String} id ID of the annotation.
     * @returns {String} ID of the object.
     */
    this.getAnnotationObject = function (id) {
        var annotation = annotations[id];
        if (!annotation) {
            error("Annotation not found: \"" + id + "\"");
            return;
        }
        var entity = annotation.entity;
        return entity ? entity.id : null;
    };

    /**
     * Sets the camera ````eye```` position from which to view an annotation.
     *
     * @param {String} id ID of the annotation.
     * @param {[Number, Number, Number]} eye Eye position for camera viewpoint.
     * @returns {Viewer} This viewer.
     */
    this.setAnnotationEye = function (id, eye) {
        var annotation = annotations[id];
        if (!annotation) {
            error("Annotation not found: \"" + id + "\"");
            return this;
        }
        annotation.eye = eye;
        return this;
    };

    /**
     * Gets the camera ````eye```` position from which to view an annotation.
     *
     * @param {String} id ID of the annotation.
     * @param {[Number, Number, Number]} eye Eye position for camera viewpoint.
     */
    this.getAnnotationEye = function (id) {
        var annotation = annotations[id];
        if (!annotation) {
            error("Annotation not found: \"" + id + "\"");
            return;
        }
        return annotation.eye;
    };

    /**
     * Sets the camera ````look```` position from which to view an annotation.
     *
     * @param {String} id ID of the annotation.
     * @param {[Number, Number, Number]} look Look position for camera viewpoint.
     * @returns {Viewer} This viewer.
     */
    this.setAnnotationLook = function (id, look) {
        var annotation = annotations[id];
        if (!annotation) {
            error("Annotation not found: \"" + id + "\"");
            return this;
        }
        annotation.look = look;
        return this;
    };

    /**
     * Gets the camera ````look```` position from which to view an annotation.
     *
     * @param {String} id ID of the annotation.
     * @returns {[Number, Number, Number]} Look position for camera viewpoint.
     */
    this.getAnnotationLook = function (id) {
        var annotation = annotations[id];
        if (!annotation) {
            error("Annotation not found: \"" + id + "\"");
            return;
        }
        return annotation.look;
    };

    /**
     * Sets the camera ````up```` vector from which to view an annotation.
     *
     * @param {String} id ID of the annotation.
     * @param {[Number, Number, Number]} up Up vector for camera viewpoint.
     * @returns {Viewer} This viewer.
     */
    this.setAnnotationUp = function (id, up) {
        var annotation = annotations[id];
        if (!annotation) {
            error("Annotation not found: \"" + id + "\"");
            return this;
        }
        annotation.up = up;
        return this;
    };

    /**
     * Gets the camera ````up```` direction from which to view an annotation.
     *
     * @param {String} id ID of the annotation.
     * @returns {[Number, Number, Number]} Up vector for camera viewpoint.
     */
    this.getAnnotationUp = function (id) {
        var annotation = annotations[id];
        if (!annotation) {
            error("Annotation not found: \"" + id + "\"");
            return;
        }
        return annotation.up;
    };

    /**
     * Sets whether or not an annotation dissappears when occluded by another object.
     *
     * @param {String} id ID of the annotation.
     * @param {Boolean} occludable Whether the annotation dissappears when occluded.
     * @returns {Viewer} This viewer.
     */
    this.setAnnotationOccludable = function (id, occludable) {
        var annotation = annotations[id];
        if (!annotation) {
            error("Annotation not found: \"" + id + "\"");
            return this;
        }
        annotation.occludable = occludable;
        return this;
    };

    /**
     * Gets whether or not an annotation dissappears when occluded by another object.
     *
     * @param {String} id ID of the annotation.
     * @returns {Boolean} Whether the annotation dissappears when occluded.
     */
    this.getAnnotationOccludable = function (id) {
        var annotation = annotations[id];
        if (!annotation) {
            error("Annotation not found: \"" + id + "\"");
            return;
        }
        return annotation.occludable;
    };

    /**
     * Sets whether an annotation's pin is shown.
     *
     * @param {String} id ID of the annotation.
     * @param {Boolean} pinShown Whether the annotation's pin is shown.
     * @returns {Viewer} This viewer.
     */
    this.setAnnotationPinShown = function (id, pinShown) {
        var annotation = annotations[id];
        if (!annotation) {
            error("Annotation not found: \"" + id + "\"");
            return this;
        }
        annotation.pinShown = pinShown;
        return this;
    };

    /**
     * Gets whether an annotation's pin is shown.
     *
     * @param {String} id ID of the annotation.
     * @returns {Boolean} Whether the annotation's pin is shown.
     */
    this.getAnnotationPinShown = function (id) {
        var annotation = annotations[id];
        if (!annotation) {
            error("Annotation not found: \"" + id + "\"");
            return;
        }
        return annotation.pinShown;
    };

    /**
     * Sets whether an annotation's label is shown.
     *
     * @param {String} id ID of the annotation.
     * @param {Boolean} labelShown Whether the annotation's label is shown.
     * @returns {Viewer} This viewer.
     */
    this.setAnnotationLabelShown = function (id, labelShown) {
        var annotation = annotations[id];
        if (!annotation) {
            error("Annotation not found: \"" + id + "\"");
            return this;
        }
        annotation.labelShown = labelShown;
        return this;
    };

    /**
     * Gets whether an annotation's label is shown.
     *
     * @param {String} id ID of the annotation.
     * @returns {Boolean} Whether the annotation's label is shown.
     */
    this.getAnnotationLabelShown = function (id) {
        var annotation = annotations[id];
        if (!annotation) {
            error("Annotation not found: \"" + id + "\"");
            return;
        }
        return annotation.labelShown;
    };

    //----------------------------------------------------------------------------------------------------
    // User clipping planes
    //----------------------------------------------------------------------------------------------------

    /**
     * Creates a user-defined clipping plane.
     *
     * The plane is positioned at a given World-space position and oriented in a given direction.
     *
     * @param {String} id Unique ID to assign to the clipping plane.
     * @param {Object} cfg Clip plane configuration.
     * @param {[Number, Number, Number]} [cfg.pos=0,0,0] World-space position of the clip plane.
     * @param {[Number, Number, Number]} [cfg.dir=0,0,-1] Vector indicating the orientation of the clip plane.
     * @param {Boolean} [cfg.active=true] Whether the clip plane is initially active. Only clips while this is true.
     * @param {Boolean} [cfg.shown=true] Whether to show a helper object to indicate the clip plane's position and orientation.
     * the front of the plane (with respect to the plane orientation vector), while ````-1```` discards elements behind the plane.
     * @returns {Viewer} this
     */
    this.createClip = function (id, cfg) {
        if (scene.components[id]) {
            error("Component with this ID already exists: " + id);
            return this;
        }
        if (cfg === undefined) {
            error("Clip configuration expected");
            return this;
        }
        var clip = new xeogl.Clip(scene, {
            id: id,
            pos: cfg.pos,
            dir: cfg.dir,
            active: cfg.active
        });
        clips[clip.id] = clip;
        clipHelpers[clip.id] = new xeogl.ClipHelper(scene, {
            clip: clip,
            autoPlaneSize: true
        });
        clipsDirty = true;
        if (cfg.shown) {
            this.show(id);
        } else {
            this.hide(id);
        }
        return this;
    };

    /**
     * Gets the IDs of the clip planes currently in the viewer.
     * @return {String[]} IDs of the clip planes.
     */
    this.getClips = function () {
        return Object.keys(clips);
    };

    /**
     * Removes all clip planes from this viewer.
     * @returns {Viewer} this
     */
    this.destroyClips = function () {
        this.destroy(this.getClips());
        return this;
    };

    /**
     * Enables a clipping plane.
     * @param {String} id ID of the clip plane to enable.
     * @returns {Viewer}
     */
    this.enable = function (id) {
        if (xeogl._isString(id)) {
            var clip = clips[id];
            if (clip) {
                clip.active = true;
                return this;
            }
            error("Clip not found: \"" + id + "\"");
            return this;
        }
        for (var i = 0, len = id.length; i < len; i++) {
            this.enable(id[i]);
        }
        return this;
    };

    /**
     * Disables a clipping plane.
     * @param {String} id ID of the clip plane to disable.
     * @returns {Viewer}
     */
    this.disable = function (id) {
        if (xeogl._isString(id)) {
            var clip = clips[id];
            if (clip) {
                clip.active = false;
                return this;
            }
            error("Clip not found: \"" + id + "\"");
            return this;
        }
        for (var i = 0, len = id.length; i < len; i++) {
            this.disable(id[i]);
        }
        return this;
    };

    //----------------------------------------------------------------------------------------------------
    // Light sources
    //----------------------------------------------------------------------------------------------------

    /**
     * Creates a light source.
     *
     * @param {String} id Unique ID to assign to the lightping plane.
     * @param {Object} cfg Light plane configuration.
     * @param {Number} [cfg.type="dir"} Type of light source: "dir", "point" or "ambient".
     * @param {[Number, Number, Number]} [cfg.color=[1,1,1]} RGB color for "dir", "point" and "ambient" light source.
     * @param {Number} [cfg.intensity=1] Intensity factor for "dir", "point" and "ambient" light source, in range ````[0..1]````.
     * @param {[Number, Number, Number]} [cfg.pos=0,0,0] World-space position for "point" light source..
     * @param {[Number, Number, Number]} [cfg.dir=0,0,-1] Direction for "dir" light source..
     * @param {Boolean} [cfg.shown=false] Whether or not to show a helper for "point" light source, to indicate its position, color etc..
     * @returns {Viewer} this
     */
    this.createLight = function (id, cfg) {
        if (scene.components[id]) {
            error("Component with this ID already exists: " + id);
            return this;
        }
        if (cfg === undefined) {
            error("Light configuration expected");
            return this;
        }
        var type = cfg.type || "dir";
        var light;
        if (type === "ambient") {
            light = new xeogl.AmbientLight(scene, {
                id: id,
                color: cfg.color,
                intensity: cfg.intensity
            });
        } else if (type === "point") {
            light = new xeogl.PointLight(scene, {
                id: id,
                pos: cfg.pos,
                color: cfg.color,
                intensity: cfg.intensity,
                space: cfg.space
            });
            //lightHelpers[light.id] = new xeogl.PointLightHelper(scene, {
            //    light: light
            //});
        } else {
            if (type !== "dir") {
                error("Light type not recognized: " + type + " - defaulting to 'dir'");
            }
            light = new xeogl.DirLight(scene, {
                id: id,
                dir: cfg.dir,
                color: cfg.color,
                intensity: cfg.intensity,
                space: cfg.space
            });
        }
        lights[light.id] = light;
        lightsDirty = true;
        if (cfg.shown) {
            this.show(id);
        } else {
            this.hide(id);
        }
        return this;
    };

    /**
     * Gets the IDs of the light sources currently in the viewer.
     *
     * @return {String[]} IDs of the light sources.
     */
    this.getLights = function () {
        return Object.keys(lights);
    };

    /**
     * Destroys all lights.
     *
     * @return {Viewer} This viewer
     */
    this.destroyLights = function () {
        this.destroy(this.getLights());
        return this;
    };

    /**
     * Sets light sources to defaults.
     *
     * @returns {Viewer} this
     */
    this.defaultLights = function () {
        this.destroyLights();
        this.createLight("light0", {
            type: "ambient",
            color: [1, 1, 1],
            intensity: 1
        });
        this.createLight("light1", {
            type: "dir",
            dir: [0.8, -0.6, -0.8],
            color: [1.0, 1.0, 1.0],
            intensity: 1.0,
            space: "view"
        });
        this.createLight("light2", {
            type: "dir",
            dir: [-0.8, -0.3, -0.4],
            color: [0.8, 0.8, 0.8],
            intensity: 1.0,
            space: "view"
        });
        this.createLight("light3", {
            type: "dir",
            dir: [0.4, -0.4, 0.8],
            color: [0.8, 1.0, 1.0],
            intensity: 1.0,
            space: "view"
        });
        return this;
    };

    /**
     * Gets the type of the given light source.
     *
     * Returns null if the given ID is not a light source.
     *
     * @param {String} id ID of the light source.
     * @returns {String} The light type: "dir", "point" or "ambient".
     */
    this.getLightType = (function () {
        var types = {
            "xeogl.DirLight": "dir",
            "xeogl.PointLight": "point",
            "xeogl.AmbientLight": "ambient"
        };
        return function (id) {
            var light = lights[id];
            if (!light) {
                error("Light not found: \"" + id + "\"");
                return null;
            }
            return types[light.type];
        };
    })();

    /**
     * Sets the position of the given point light or clip plane.
     *
     * @param {String} id ID of the light source or clip plane.
     * @param {[Number, Number, Number]} [pos=0,0,0] World-space position.
     * @returns {Viewer}
     */
    this.setPos = function (id, pos) {
        if (xeogl._isString(id)) {
            var light = lights[id];
            if (light) {
                if (light.type !== "xeogl.PointLight") {
                    warn("Ignoring call to setPos() on light of incompatible type: \"" + id + "\"");
                    return this;
                }
                light.pos = pos;
                return this;
            }
            var clip = clips[id];
            if (clip) {
                clip.pos = pos;
                return this;
            }
            error("Light or clip plane not found: \"" + id + "\"");
            return this;
        }
        for (var i = 0, len = id.length; i < len; i++) {
            this.setPos(id[i], pos);
        }
        return this;
    };

    /**
     * Gets the position of the given point light or clip plane.
     *
     * When the given ID is not a point light or clip plane,
     * will log an error message and return a default value of ````[0,0,0]```` .
     *
     * @param {String} id ID of the light source or clip plane.
     * @returns {[Number, Number, Number]} World-space position.
     */
    this.getPos = function (id) {
        var light = lights[id];
        if (light) {
            if (light.type !== "xeogl.PointLight") {
                error("Called getPos() for light of incompatible type: \"" + id + "\"");
                return [0, 0, 0];
            }
            return light.pos;
        }
        var clip = clips[id];
        if (clip) {
            return clip.pos;
        }
        error("Light or clip plane not found: \"" + id + "\"");
        return [0, 0, 0];
    };

    /**
     * Sets the direction of the given directional light or clip plane.
     *
     * @param {String} id ID of a "dir" light source or clip plane.
     * @param {[Number, Number, Number]} [dir=0,0,1] Direction vector.
     * @returns {Viewer} this
     */
    this.setDir = function (id, dir) {
        if (xeogl._isString(id)) {
            var light = lights[id];
            if (light) {
                if (light.type !== "xeogl.DirLight") {
                    warn("Ignoring call to setDir() on light of incompatible type: \"" + id + "\"");
                    return this;
                }
                light.dir = dir;
                return this;
            }
            var clip = clips[id];
            if (clip) {
                clip.dir = dir;
                return this;
            }
            error("Light or clip plane not found: \"" + id + "\"");
            return this;
        }
        for (var i = 0, len = id.length; i < len; i++) {
            this.setDir(id[i], dir);
        }
        return this;
    };

    /**
     * Gets the direction of the given directional light source or clip plane.
     *
     * When the given ID is not a directional light or clip plane,
     * will log an error message and return a default value of ````[0,0,1]```` .
     *
     * @param {String} id ID of a "dir" light source or clip plane.
     * @returns {[Number, Number, Number]} Direction vector.
     */
    this.getDir = function (id) {
        var light = lights[id];
        if (light) {
            if (light.type !== "xeogl.DirLight") {
                error("Called getDir() for light of incompatible type: \"" + id + "\"");
                return null;
            }
            return light.dir;
        }
        var clip = clips[id];
        if (clip) {
            return clip.dir;
        }
        error("Light or clip plane not found: \"" + id + "\"");
        return [0, 0, 1];
    };

    /**
     * Sets the intensity of the given light source.
     *
     * @param {String} id ID of the light source.
     * @param {Number} intensity Intensity factor in range [0..1].
     * @returns {Viewer}
     */
    this.setIntensity = function (id, intensity) {
        if (xeogl._isString(id)) {
            var light = lights[id];
            if (light) {
                light.intensity = intensity;
                return this;
            }
            error("Light not found: \"" + id + "\"");
            return this;
        }
        for (var i = 0, len = id.length; i < len; i++) {
            this.setIntensity(id[i], intensity);
        }
        return this;
    };

    /**
     * Gets the intensity of the given light source.
     *
     * When the given ID is not a light source, will log an error message and return a default value of 1.0.
     *
     * @param {String} id ID of the light source.
     * @returns {Number} Intensity factor in range [0..1].
     */
    this.getIntensity = function (id) {
        var light = lights[id];
        if (light) {
            return light.intensity;
        }
        error("Light not found: \"" + id + "\"");
        return 1.0;
    };

    /**
     * Sets the coordinate space of the given light source.
     *
     * @param {String} id ID of the light source.
     * @param {String} space The coordinate space: "world" or "view".
     * @returns {Viewer}
     */
    this.setSpace = function (id, space) {
        if (xeogl._isString(id)) {
            var light = lights[id];
            if (light) {
                if (light.type !== "xeogl.DirLight" && light.type !== "xeogl.PointLight") {
                    error("Called setSpace() for light of incompatible type: \"" + id + "\"");
                    return this;
                }
                space = space || "view";
                if (space !== "view" && space !== "world") {
                    error("Light space not recognized: " + space + " - defaulting to 'view'");
                    space = "view";
                }
                light.space = space;
                return this;
            }
            error("Light not found: \"" + id + "\"");
            return this;
        }
        for (var i = 0, len = id.length; i < len; i++) {
            this.setSpace(id[i], space);
        }
        return this;
    };

    /**
     * Gets the coordinate space of the given light source.
     *
     * When the given ID is not a light source, will log an error message and return the default value of "view".
     *
     * @param {String} id ID of the light source.
     * @returns {String} Coordinate space: "world" or "view".
     */
    this.getSpace = function (id) {
        var light = lights[id];
        if (light) {
            if (light.type !== "xeogl.DirLight" && light.type !== "xeogl.PointLight") {
                error("Called getSpace() for light of incompatible type: \"" + id + "\"");
                return "view";
            }
            return light.space;
        }
        error("Light not found: \"" + id + "\"");
        return "view";
    };

    /**
     *
     *
     * @param id
     * @returns {Viewer}
     */
    this.destroy = function (id) {

        if (!id) { // Destroy everything
            scene.off(onTick);
            scene.destroy();
            models = {};
            objects = {};
            objectModels = {};
            eulerAngles = {};
            transformable = {};
            translations = {};
            rotations = {};
            scales = {};
            annotations = {};
            objectAnnotations = {};
            clips = {};
            clipHelpers = {};
            return this;
        }

        if (xeogl._isString(id)) {
            var annotation = annotations[id];
            if (annotation) {

                // Destroy annotation

                if (annotation.entity) {
                    delete objectAnnotations[annotation.entity.id][annotation.id];
                }
                annotation.destroy();
                delete annotations[id];
                return this;
            }

            var light = lights[id];
            if (light) {

                // Destroy light

                this.hide(id);
                light.destroy();
                delete lights[id];
                var helper = lightHelpers[id];
                if (helper) {
                    helper.destroy();
                    delete lightHelpers[id];
                }
                lightsDirty = true;
                return this;
            }

            var clip = clips[id];
            if (clip) {

                // Destroy clip

                this.hide(id);
                clip.destroy();
                delete clips[id];
                var clipHelper = clipHelpers[id];
                if (clipHelper) {
                    clipHelper.destroy();
                    delete clipHelpers[id];
                }
                clipsDirty = true;
                return this;
            }

            var model = models[id];
            if (model) {

                // Destroy model

                var entities = model.types["xeogl.Entity"];
                var entity;
                var meta;
                for (var objectId in entities) {
                    if (entities.hasOwnProperty(objectId)) {
                        entity = entities[objectId];
                        // Deregister for type
                        meta = entity.meta;
                        var type = meta && meta.type ? meta.type : "DEFAULT";
                        var objectsOfType = types[type];
                        if (objectsOfType) {
                            delete objectsOfType[objectId];
                        }
                        delete objects[objectId];
                        delete objectModels[objectId];
                        delete eulerAngles[objectId];
                        delete transformable[objectId];
                        delete translations[objectId];
                        delete rotations[objectId];
                        delete scales[objectId];
                        var objectAABBHelper = aabbHelpers[objectId];
                        if (objectAABBHelper) {
                            objectAABBHelper.destroy();
                            delete objectAABBHelper[id];
                        }
                    }
                }
                var modelAABBHelper = aabbHelpers[objectId];
                if (modelAABBHelper) {
                    modelAABBHelper.destroy();
                    delete modelAABBHelper[id];
                }
                model.destroy();
                delete models[id];
                delete modelSrcs[id];
                delete eulerAngles[id];
                delete transformable[id];
                delete translations[id];
                delete rotations[id];
                delete scales[id];

                if (unloadedModel) {
                    unloadedModel(id);
                }

                return this;
            }
        }

        for (var i = 0, len = id.length; i < len; i++) {
            this.destroy(id[i]);
        }

        return this;
    };

    //----------------------------------------------------------------------------------------------------
    // Bookmarking
    //----------------------------------------------------------------------------------------------------

    /**
     * Gets a JSON bookmark of the viewer's current state.
     *
     * The viewer can then be restored to the bookmark at any time using {@link #setBookmark}.
     *
     * For compactness, a bookmark only contains state that has non-default values.
     *
     * @return {Object} A JSON bookmark.
     */
    this.getBookmark = (function () {

        // This method optimizes bookmark size by storing values only when they override default
        // values, many of which are baked into xeogl. This method will therefore break if those
        // default values happen to change within xeogl.

        var vecToArray = math.vecToArray;

        function getTranslate(id) {
            var translation = translations[id];
            if (!translation) {
                return;
            }
            var xyz = translation.xyz;
            if (xyz[0] !== 0 || xyz[1] !== 0 || xyz[1] !== 0) {
                return vecToArray(xyz);
            }
        }

        function getScale(id) {
            var scale = scales[id];
            if (!scale) {
                return;
            }
            var xyz = scale.xyz;
            if (xyz && (xyz[0] !== 1 || xyz[1] !== 1 || xyz[1] !== 1)) {
                return vecToArray(xyz);
            }
        }

        function getRotate(id) {
            var xyz = eulerAngles[id];
            if (xyz && (xyz[0] !== 0 || xyz[1] !== 0 || xyz[2] !== 0)) {
                return vecToArray(xyz);
            }
        }

        function getSrc(id) {
            var src = modelSrcs[id];
            return xeogl._isString(src) ? src : xeogl._copy(src);
        }

        return function () {

            var bookmark = {};
            var id;
            var model;
            var modelData;
            var translate;
            var scale;
            var rotate;

            // Serialize models

            var modelStates = [];
            for (id in models) {
                if (models.hasOwnProperty(id)) {
                    model = models[id];
                    modelData = {
                        id: id,
                        src: getSrc(id)
                    };
                    translate = getTranslate(id);
                    if (translate) {
                        modelData.translate = translate;
                    }
                    scale = getScale(id);
                    if (scale) {
                        modelData.scale = scale;
                    }
                    rotate = getRotate(id);
                    if (rotate) {
                        modelData.rotate = rotate;
                    }
                    modelStates.push(modelData);
                }
            }
            if (modelStates.length > 0) {
                bookmark.models = modelStates;
            }

            // Serialize object states

            var objectStates = [];
            var object;
            var objectState;
            for (id in objects) {
                if (objects.hasOwnProperty(id)) {
                    object = objects[id];
                    objectState = null;
                    translate = getTranslate(id);
                    if (translate) {
                        objectState = objectState || {id: id};
                        objectState.translate = translate;
                    }
                    scale = getScale(id);
                    if (scale) {
                        objectState = objectState || {id: id};
                        objectState.scale = scale;
                    }
                    rotate = getRotate(id);
                    if (rotate) {
                        objectState = objectState || {id: id};
                        objectState.rotate = rotate;
                    }
                    if (!object.visible) {
                        objectState = objectState || {id: id};
                        objectState.visible = false;
                    }
                    if (object.material.alphaMode === "blend") {
                        if (object.material.alpha < 1.0) {
                            objectState = objectState || {id: id};
                            objectState.opacity = object.material.alpha;
                        }
                    }
                    if (object.outlined) {
                        objectState = objectState || {id: id};
                        objectState.outlined = true;
                    }
                    if (!object.clippable) {
                        objectState = objectState || {id: id};
                        objectState.clippable = false;
                    }
                    if (!object.pickable) {
                        objectState = objectState || {id: id};
                        objectState.pickable = false;
                    }
                    if (objectState) {
                        objectStates.push(objectState);
                    }
                }
            }
            if (objectStates.length > 0) {
                bookmark.objects = objectStates;
            }

            // Serialize annotations

            var annotationStates = [];
            var annotation;
            var annotationState;
            for (id in annotations) {
                if (annotations.hasOwnProperty(id)) {
                    annotation = annotations[id];
                    annotationState = {
                        id: id,
                        primIndex: annotation.primIndex,
                        bary: vecToArray(annotation.bary)
                    };
                    if (annotation.glyph !== "") {
                        annotationState.glyph = annotation.glyph;
                    }
                    if (annotation.title !== "") {
                        annotationState.title = annotation.title;
                    }
                    if (annotation.desc !== "") {
                        annotationState.desc = annotation.desc;
                    }
                    if (!annotation.pinShown) {
                        annotationState.pinShown = annotation.pinShown;
                    }
                    if (!annotation.labelShown) {
                        annotationState.labelShown = annotation.labelShown;
                    }
                    if (!annotation.occludable) {
                        annotationState.occludable = annotation.occludable;
                    }
                    if (annotation.entity) {
                        annotationState.object = annotation.entity.id;
                    }
                    if (annotation.eye) {
                        annotationState.eye = vecToArray(annotation.eye);
                    }
                    if (annotation.look) {
                        annotationState.look = vecToArray(annotation.look);
                    }
                    if (annotation.up) {
                        annotationState.up = vecToArray(annotation.up);
                    }
                    if (!bookmark.annotations) {
                        bookmark.annotations = {};
                    }
                    annotationStates.push(annotationState);
                }
            }
            if (annotationStates.length > 0) {
                bookmark.annotations = annotationStates;
            }

            // Serialize clips

            var clipStates = [];
            var clip;
            var clipState;
            for (id in clips) {
                if (clips.hasOwnProperty(id)) {
                    clip = clips[id];
                    clipState = {
                        id: id,
                        pos: vecToArray(clip.pos),
                        dir: vecToArray(clip.dir)
                    };
                    if (!clip.active) {
                        clipState.active = clip.active;
                    }
                    var clipHelper = clipHelpers[id];
                    if (clipHelper && !clipHelper.visible) {
                        clipState.shown = true;
                    }
                    clipStates.push(clipState);
                }
            }
            if (clipStates.length > 0) {
                bookmark.clips = clipStates;
            }

            // Serialize lights

            var lightStates = [];
            var light;
            var lightState;
            for (id in lights) {
                if (lights.hasOwnProperty(id)) {
                    light = lights[id];
                    lightState = {
                        id: id,
                        //type: light.type, // TODO
                        pos: vecToArray(light.pos),
                        dir: vecToArray(light.dir)
                    };
                    switch (light.type) {

                        case "xeogl.AmbientLight":
                            lightState.type = "ambient";
                            lightState.color = vecToArray(light.color);
                            lightState.intensity = light.intensity;
                            break;

                        case "xeogl.DirLight":
                            lightState.type = "dir";
                            lightState.color = vecToArray(light.color);
                            lightState.dir = vecToArray(light.dir);
                            lightState.intensity = light.intensity;
                            break;

                        case "xeogl.PointLight":
                        default:
                            lightState.type = "point";
                            lightState.color = vecToArray(light.color);
                            lightState.pos = vecToArray(light.pos);
                            lightState.intensity = light.intensity;
                            break;
                    }
                    //if (!light.active) {
                    //    lightState.active = light.active;
                    //}
                    var lightHelper = lightHelpers[id];
                    if (lightHelper && lightHelper.visible) {
                        clipState.shown = true;
                    }
                    lightStates.push(lightState);
                }
            }
            if (lightStates.length > 0) {
                bookmark.lights = lightStates;
            }

            // Serialize camera position

            bookmark.eye = vecToArray(view.eye);
            bookmark.look = vecToArray(view.look);
            bookmark.up = vecToArray(view.up);

            // Serialize all other viewer properties, when they have non-default values

            if (view.gimbalLockY !== true) {
                bookmark.gimbalLockY = view.gimbalLockY;
            }

            if (cameraFlight.viewFitFOV !== 45) {
                bookmark.viewFitFOV = cameraFlight.viewFitFOV;
            }

            if (cameraFlight.duration !== 0.5) {
                bookmark.viewFitDuration = cameraFlight.duration;
            }

            if (projectionType !== "perspective") {
                bookmark.projection = projectionType;
            }

            if (projections.perspective.near !== 0.1) {
                bookmark.perspectiveNear = projections.perspective.near;
            }

            if (projections.perspective.far !== 5000.0) {
                bookmark.perspectiveFar = projections.perspective.far;
            }

            if (projections.perspective.fov !== 60.0) {
                bookmark.perspectiveFOV = projections.perspective.fov;
            }

            if (projections.orthographic.near !== 0.1) {
                bookmark.orthoNear = projections.orthographic.near;
            }

            if (projections.orthographic.far !== 5000.0) {
                bookmark.orthoFar = projections.orthographic.far;
            }

            if (projections.orthographic.scale !== 1.0) {
                bookmark.orthoScale = projections.orthographic.scale;
            }

            if (scene.outline.thickness !== 15) {
                bookmark.outlineThickness = scene.outline.thickness;
            }

            var outlineColor = scene.outline.color;
            if (outlineColor[0] !== 1 || outlineColor[1] !== 1 || outlineColor[2] !== 0) {
                bookmark.outlineColor = outlineColor;
            }

            return bookmark;
        };
    })();

    /**
     * Sets viewer state to the snapshot contained in given JSON bookmark.
     *
     * A bookmark is a complete snapshot of the viewer's state, which was
     * captured earlier with {@link #getBookmark}. Setting a bookmark will
     * clear everything in the viewer first.
     *
     * @param {Object} bookmark JSON bookmark.
     * @param {Function} [ok] Callback fired once the bookmark has been set.
     * @returns {Viewer} this
     */
    this.setBookmark = (function () {

        function loadModels(_modelsData, i, ok) {
            if (i >= _modelsData.length) {
                ok();
                return;
            }
            var modelData = _modelsData[i];
            var id = modelData.id;
            self.loadModel(id, modelData.src, function () {
                if (modelData.translate) {
                    self.setTranslate(id, modelData.translate);
                }
                if (modelData.scale) {
                    self.setScale(id, modelData.scale);
                }
                if (modelData.rotate) {
                    self.setRotate(id, modelData.rotate);
                }
                loadModels(_modelsData, i + 1, ok);
            });
        }

        return function (bookmark, ok) {

            this.clear();

            if (!bookmark.models || bookmark.models.length === 0) {
                this.defaultLights();
                if (ok) {
                    ok();
                }
                return;
            }

            loadModels(bookmark.models, 0, function () {

                var i;
                var len;
                var id;
                var objectStates = bookmark.objects;
                var invisible = [];

                if (objectStates) {
                    var objectState;
                    for (i = 0, len = objectStates.length; i < len; i++) {
                        objectState = objectStates[i];
                        id = objectState.id;
                        if (objectState.visible === false) {
                            invisible.push(id);
                        }
                        if (objectState.translate) {
                            self.setTranslate(id, objectState.translate);
                        }
                        if (objectState.scale) {
                            self.setScale(id, objectState.scale);
                        }
                        if (objectState.rotate) {
                            self.setRotate(id, objectState.rotate);
                        }
                        if (objectState.opacity !== undefined) {
                            self.setOpacity(id, objectState.opacity);
                        }
                        if (!!objectState.outlined) {
                            self.showOutline(id);
                        }
                        if (objectState.clippable !== undefined) {
                            self.setClippable(id, objectState.clippable);
                        }
                        if (objectState.pickable !== undefined) {
                            self.setPickable(id, objectState.pickable);
                        }
                    }
                }

                var clipStates = bookmark.clips;
                if (clipStates) {
                    var clipState;
                    for (i = 0, len = clipStates.length; i < len; i++) {
                        clipState = clipStates[i];
                        self.createClip(clipState.id, clipState);
                    }
                }

                var annotationStates = bookmark.annotations;
                if (annotationStates) {
                    var annotationState;
                    for (i = 0, len = annotationStates.length; i < len; i++) {
                        annotationState = annotationStates[i];
                        self.createAnnotation(annotationState.id, annotationState);
                    }
                }

                var lightStates = bookmark.lights;
                if (lightStates) {

                    // TODO: Load lights from bookmark
                } else {
                    self.defaultLights();
                }

                if (invisible.length > 0) {
                    self.hide(invisible);
                }
                self.setEyeLookUp(bookmark.eye, bookmark.look, bookmark.up);
                (bookmark.gimbalLockY === false) ? self.unlockGimbalY() : self.lockGimbalY();
                self.setProjection(bookmark.projection || "perspective");
                self.setViewFitFOV(bookmark.viewFitFOV || 45);
                self.setViewFitDuration(bookmark.viewFitDuration !== undefined ? bookmark.viewFitDuration : 0.5);
                self.setPerspectiveNear(bookmark.perspectiveNear !== undefined ? bookmark.perspectiveNear : 0.1);
                self.setPerspectiveFar(bookmark.perspectiveFar != undefined ? bookmark.perspectiveFar : 5000.0);
                self.setPerspectiveFOV(bookmark.perspectiveFOV || 60);
                self.setOrthoNear(bookmark.orthoNear != undefined ? bookmark.orthoNear : 0.1);
                self.setOrthoFar(bookmark.orthoFar != undefined ? bookmark.orthoFar : 5000);
                self.setOrthoScale(bookmark.orthoScale != undefined ? bookmark.orthoScale : 1.0);
                self.setOutlineThickness(bookmark.outlineThickness != undefined ? bookmark.outlineThickness : 15);
                self.setOutlineColor(bookmark.outlineColor != undefined ? bookmark.outlineColor : [1, 1, 0]);

                if (ok) {
                    ok();
                }
            });
        };
    })();

    /**
     * Captures a snapshot image of the viewer's canvas.
     *
     * @param {*} [params] Capture options.
     * @param {Number} [params.width] Desired width of result in pixels - defaults to width of canvas.
     * @param {Number} [params.height] Desired height of result in pixels - defaults to height of canvas.
     * @param {String} [params.format="jpeg"] Desired format; "jpeg", "png" or "bmp".
     * @param {Function} ok Callback to return the image data.
     * @returns {String} String-encoded image data when taking the snapshot synchronously. Returns null when the ````ok```` callback is given.
     * @example
     * viewer.getSnapshot({
     *     width: 500,
     *     height: 500,
     *     format: "png"
     * }, function(imageDataURL) {
     *     imageElement.src = imageDataURL;
     * });
     */
    this.getSnapshot = function (params, ok) {
        params = params || {};
        scene.canvas.getSnapshot({
            width: params.width, // Defaults to size of canvas
            height: params.height,
            format: params.format || "png" // Options are "jpeg" (default), "png" and "bmp"
        }, ok);
    };

    /**
     * Clears and destroys this viewer.
     * @returns {Viewer} this
     */
    //this.destroy = function () {
    //    scene.off(onTick);
    //    scene.destroy();
    //    models = {};
    //    objects = {};
    //    objectModels = {};
    //    eulerAngles = {};
    //    transformable = {};
    //    translations = {};
    //    rotations = {};
    //    scales = {};
    //    annotations = {};
    //    objectAnnotations = {};
    //    clips = {};
    //    clipHelpers = {};
    //    return this;
    //};

    function error(msg) {
        console.error("[xeometry] " + msg);
    }

    function warn(msg) {
        console.warn("[xeometry] " + msg);
    }

    //this.setBookmark(cfg);

    this.defaultLights();

    var eventSubs = {};

    /**
     * Subscribes to an event on this BIMViewer.
     * @method on
     * @param {String} event The event
     * @param {Function} callback Called fired on the event
     */
    this.on = function (event, callback) {
        var subs = eventSubs[event];
        if (!subs) {
            subs = [];
            eventSubs[event] = subs;
        }
        subs.push(callback);
    };

    /**
     * Fires an event on this BIMViewer.
     * @method fire
     * @param {String} event The event type name
     * @param {Object} value The event parameters
     */
    this.fire = function (event, value) {
        var subs = eventSubs[event];
        if (subs) {
            for (var i = 0, len = subs.length; i < len; i++) {
                subs[i](value);
            }
        }
    };

};
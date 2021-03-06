/**

 Helper that visualizes the position and direction of a plane.

 @class PlaneHelper
 @constructor
 @param cfg {*} Configuration
 @param [cfg.pos=[0,0,0]] {Float32Array} World-space position.
 @param [cfg.dir=[0,0,1]] {Float32Array} World-space direction vector.
 @param [cfg.color=[0.4,0.4,0.4]] {Float32Array} Emmissive color
 @param [cfg.visible=true] {Boolean} Indicates whether or not this helper is visible.
 @param [cfg.planeSize] {Float32Array} The width and height of the PlaneHelper plane indicator.
 @param [cfg.autoPlaneSize=false] {Boolean} Indicates whether or not this PlaneHelper's
 {{#crossLink "PlaneHelper/planeSize:property"}}{{/crossLink}} is automatically sized to fit within
 the {{#crossLink "Scene/worldBoundary:property"}}Scene's worldBoundary{{/crossLink}}.
 */
(function () {

    "use strict";

    xeogl.PlaneHelper = xeogl.Component.extend({

        type: "xeogl.PlaneHelper",

        _init: function (cfg) {

            var transform = this._planeScale = new xeogl.Scale(this, {
                worldPos: [10, 10, 0],
                parent: this._quaternion = new xeogl.Quaternion(this, {
                    worldPosw: [0, 0, 0, 1],
                    parent: this._translate = new xeogl.Translate(this, {
                        worldPos: [0, 0, 0]
                    })
                })
            });

            this._planeWire = new xeogl.Entity(this, {
                geometry: new xeogl.Geometry(this, {
                    primitive: "lines",
                    positions: [
                        0.5, 0.5, 0.0, 0.5, -0.5, 0.0, // 0
                        -0.5, -0.5, 0.0, -0.5, 0.5, 0.0, // 1
                        0.5, 0.5, -0.0, 0.5, -0.5, -0.0, // 2
                        -0.5, -0.5, -0.0, -0.5, 0.5, -0.0 // 3
                    ],
                    indices: [0, 1, 0, 3, 1, 2, 2, 3]
                }),
                material: new xeogl.PhongMaterial(this, {
                    emissive: [1, 0, 0],
                    diffuse: [0, 0, 0],
                    lineWidth: 2
                }),
                transform: transform,
                pickable: false,
                collidable: false,
                clippable: false
            });

            this._planeSolid = new xeogl.Entity(this, {
                geometry: new xeogl.Geometry(this, {
                    primitive: "triangles",
                    positions: [
                        0.5, 0.5, 0.0, 0.5, -0.5, 0.0, // 0
                        -0.5, -0.5, 0.0, -0.5, 0.5, 0.0, // 1
                        0.5, 0.5, -0.0, 0.5, -0.5, -0.0, // 2
                        -0.5, -0.5, -0.0, -0.5, 0.5, -0.0 // 3
                    ],
                    indices: [0, 1, 2, 2, 3, 0]
                }),
                material: new xeogl.PhongMaterial(this, {
                    emissive: [0, 0, 0],
                    diffuse: [0, 0, 0],
                    specular: [1, 1, 1],
                    shininess: 120,
                    alpha: 0.3,
                    alphaMode: "blend",
                    backfaces: true
                }),
                transform: transform,
                pickable: false,
                collidable: false,
                clippable: false
            });

            this._arrow = new xeogl.Entity(this, {
                geometry: new xeogl.Geometry(this, {
                    primitive: "lines",
                    positions: [
                        1.0, 1.0, 1.0, 1.0, -1.0, 1.0
                    ],
                    indices: [0, 1]
                }),
                material: new xeogl.PhongMaterial(this, {
                    emissive: [1, 0, 0],
                    diffuse: [0, 0, 0],
                    lineWidth: 4
                }),
                pickable: false,
                collidable: false,
                clippable: false
            });

            this._label = new xeogl.Entity(this, {
                geometry: new xeogl.VectorTextGeometry(this, {
                    text: this.id,
                    size: 0.07,
                    origin: [0.02, 0.02, 0.0]
                }),
                material: new xeogl.PhongMaterial(this, {
                    emissive: [0.3, 1, 0.3],
                    lineWidth: 2
                }),
                transform: transform, // Shares transform with plane
                pickable: false,
                collidable: false,
                clippable: false,
                billboard: "spherical"
            });

            this.planeSize = cfg.planeSize;
            this.autoPlaneSize = cfg.autoPlaneSize;
            this.pos = cfg.pos;
            this.dir = cfg.dir;
            this.color = cfg.color;
            this.visible = cfg.visible;
        },

        _update: (function () {
            var arrowPositions = new Float32Array(6);
            return function () {

                var pos = this._pos;
                var dir = this._dir;

                // Rebuild arrow geometry

                arrowPositions[0] = pos[0];
                arrowPositions[1] = pos[1];
                arrowPositions[2] = pos[2];
                arrowPositions[3] = pos[0] + dir[0];
                arrowPositions[4] = pos[1] + dir[1];
                arrowPositions[5] = pos[2] + dir[2];

                this._arrow.geometry.positions = arrowPositions;
            }
        })(),

        _props: {

            /**
             * World-space position of this PlaneHelper.
             * Fires an {{#crossLink "PlaneHelper/worldPos:event"}}{{/crossLink}} event on change.
             * @property worldPos
             * @default [0,0,0]
             * @type {Float32Array}
             */
            pos: {

                set: function (value) {

                    (this._pos = this._pos || new xeogl.math.vec3()).set(value || [0, 0, 0]);

                    this._translate.xyz = this._pos;

                    this._needUpdate(); // Need to rebuild arrow

                    /**
                     Fired whenever this PlaneHelper's {{#crossLink "PlaneHelper/pos:property"}}{{/crossLink}} property changes.
                     @event pos
                     @param value {Float32Array} The property's new value
                     */
                    this.fire("pos", this._pos);
                },

                get: function () {
                    return this._pos;
                }
            },

            /**
             * World-space direction of this PlaneHelper.
             * Fires an {{#crossLink "PlaneHelper/dir:event"}}{{/crossLink}} event on change.
             * @property dir
             * @default [0,0,1]
             * @type {Float32Array}
             */
            dir: {

                set: (function () {

                    var zeroVec = new Float32Array([0, 0, -1]);
                    var quat = new Float32Array(4);

                    return function (value) {

                        (this._dir = this._dir || new xeogl.math.vec3()).set(value || [0, 0, 1]);

                        xeogl.math.vec3PairToQuaternion(zeroVec, this._dir, quat);

                        this._quaternion.xyzw = quat;

                        this._needUpdate(); // Need to rebuild arrow

                        /**
                         Fired whenever this PlaneHelper's {{#crossLink "PlaneHelper/dir:property"}}{{/crossLink}} property changes.
                         @event dir
                         @param value {Float32Array} The property's new value
                         */
                        this.fire("dir", this._dir);
                    };
                })(),

                get: function () {
                    return this._dir;
                }
            },

            /**
             * The width and height of the PlaneHelper plane indicator.
             *
             * Values assigned to this property will be overridden by an auto-computed value when
             * {{#crossLink "PlaneHelper/autoPlaneSize:property"}}{{/crossLink}} is true.
             *
             * Fires an {{#crossLink "PlaneHelper/planeSize:event"}}{{/crossLink}} event on change.
             *
             * @property planeSize
             * @default [1,1]
             * @type {Float32Array}
             */
            planeSize: {

                set: function (value) {

                    (this._planeSize = this._planeSize || new xeogl.math.vec2()).set(value || [1, 1]);

                    this._planeScale.xyz = [this._planeSize[0], this._planeSize[1], 1.0];

                    /**
                     Fired whenever this PlaneHelper's {{#crossLink "PlaneHelper/planeSize:property"}}{{/crossLink}} property changes.
                     @event planeSize
                     @param value {Float32Array} The property's new value
                     */
                    this.fire("planeSize", this._planeSize);
                },

                get: function () {
                    return this._planeSize;
                }
            },

            /**
             * Indicates whether this PlaneHelper's {{#crossLink "PlaneHelper/planeSize:property"}}{{/crossLink}} is automatically
             * generated or not.
             *
             * When auto-generated, {{#crossLink "PlaneHelper/planeSize:property"}}{{/crossLink}} will automatically size
             * to fit within the {{#crossLink "Scene/worldBoundary:property"}}Scene's worldBoundary{{/crossLink}}.
             *
             * Fires an {{#crossLink "PlaneHelper/autoPlaneSize:event"}}{{/crossLink}} event on change.
             *
             * @property autoPlaneSize
             * @default false
             * @type {Boolean}
             */
            autoPlaneSize: {

                set: function (value) {

                    value = !!value;

                    if (this._autoPlaneSize === value) {
                        return;
                    }

                    this._autoPlaneSize = value;

                    if (this._autoPlaneSize) {
                        if (!this._onSceneAABB) {
                            this._onSceneAABB = this.scene.worldBoundary.on("updated", function () {
                                var aabbDiag = xeogl.math.getAABB3Diag(this.scene.worldBoundary.aabb);
                                var clipSize = (aabbDiag * 0.50);
                                this.planeSize = [clipSize, clipSize];
                            }, this);
                        }
                    } else {
                        if (this._onSceneAABB) {
                            this.scene.worldBoundary.off(this._onSceneAABB);
                            this._onSceneAABB = null;
                        }
                    }

                    /**
                     Fired whenever this PlaneHelper's {{#crossLink "PlaneHelper/autoPlaneSize:property"}}{{/crossLink}} property changes.
                     @event autoPlaneSize
                     @param value {Boolean} The property's new value
                     */
                    this.fire("autoPlaneSize", this._autoPlaneSize);
                },

                get: function () {
                    return this._autoPlaneSize;
                }
            },

            /**
             * Emmissive color of this PlaneHelper.
             *
             * Fires an {{#crossLink "PlaneHelper/color:event"}}{{/crossLink}} event on change.
             *
             * @property color
             * @default [0.4,0.4,0.4]
             * @type {Float32Array}
             */
            color: {

                set: function (value) {

                    (this._color = this._color || new xeogl.math.vec3()).set(value || [0.4,0.4,0.4]);

                    this._planeWire.material.emissive = this._color;
                    this._arrow.material.emissive = this._color;

                    /**
                     Fired whenever this PlaneHelper's {{#crossLink "PlaneHelper/color:property"}}{{/crossLink}} property changes.
                     @event color
                     @param value {Float32Array} The property's new value
                     */
                    this.fire("color", this._color);
                },

                get: function () {
                    return this._color;
                }
            },

            /**
             Indicates whether this PlaneHelper is visible or not.

             Fires a {{#crossLink "PlaneHelper/active:event"}}{{/crossLink}} event on change.

             @property visible
             @default true
             @type Boolean
             */
            visible: {

                set: function (value) {

                    value = value !== false;

                    this._planeWire.visible = value;
                    this._planeSolid.visible = value;
                    this._arrow.visible = value;
                    this._label.visible = value;

                    /**
                     Fired whenever this helper's {{#crossLink "PlaneHelper/visible:property"}}{{/crossLink}} property changes.

                     @event visible
                     @param value {Boolean} The property's new value
                     */
                    this.fire("visible", this._planeWire.visible);
                },

                get: function () {
                    return this._planeWire.visible;
                }
            }
        },

        _destroy: function () {
            if (this._onSceneAABB) {
                this.scene.worldBoundary.off(this._onSceneAABB);
            }
        }
    });
})();
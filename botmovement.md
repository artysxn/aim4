Here is a structured Markdown plan designed to be fed directly to an AI coding agent. It includes the context, the exact architectural changes required, and strict operational directives.

---

# Implementation Plan: CSBotModel.js Enhancements

## Context & Target

**Target File:** `CSBotModel.js`
**Environment:** Three.js
**Objective:** Refine the procedural skeletal bot model by adjusting proportions, adding dynamic visual joints to bridge capsule gaps, and implementing a procedural directional lean based on local velocity.

## ⚠️ Critical System Directives

* **Token Preservation:** Do not re-generate or output the entire file. When executing these changes, modify and output **only** the specific lines or blocks of code that are necessary.
* **Existing Architecture:** Maintain the existing mathematical IK solver and procedural logic. Do not convert the model to a `SkinnedMesh` with bone weights.

---

## Phase 1: Pelvis Slimming

**Goal:** Reduce the horizontal width of the pelvis capsule to correct disproportionate scaling.

1. Locate the pelvis generation line within `_buildSkeleton()`: `this._cap(this.pelvis, 0.145, 0.14, { y: -0.01, axis: 'x', hitgroup: 'pelvis' });`
2. Reduce the radius parameter (the first number, `0.145`) to a slimmer value, such as `0.11` or `0.12`.
3. Adjust the segment length (the second number, `0.14`) down slightly if the hip joints need to be brought closer together to match the new radius.

## Phase 2: Dynamic Joint Bridges

**Goal:** Create dynamic "bridge" meshes that stretch between limb endpoints to create visually smooth transitions, preventing the floating capsule look.

1. **State Initialization:** In the `constructor`, declare an empty array `this._dynamicJoints = []` to track the generated bridge meshes and their target nodes.
2. **Bridge Generator Method:** Create a helper method (e.g., `_buildJointBridge(upperNode, lowerNode, radius)`) that generates a generic cylindrical or tapered mesh using `this._bodyMat`.
3. **Skeleton Attachment:** Inside `_buildSkeleton()`, invoke the bridge generator for the following connections:
* Thigh to Knee
* Knee to Foot
* Shoulder to Elbow
* Elbow to Hand (Forearm)
Push these mesh references and their target upper/lower nodes into `this._dynamicJoints`.


4. **Update Loop Logic:** At the end of the `update(dt)` method (after the IK solver has positioned the limbs), iterate through `this._dynamicJoints`:
* Calculate the world positions of the upper node's bottom anchor and the lower node's top anchor.
* Set the bridge mesh's position to the exact midpoint of these two vectors.
* Use `.lookAt()` to orient the bridge mesh toward the lower anchor.
* Calculate the distance between the anchors and apply it to the bridge mesh's Z-scale (or length axis) so it stretches dynamically without overlapping the main joints.



## Phase 3: Directional Lean

**Goal:** Implement a subtle 1-3 degree lean that matches the bot's direction of travel (e.g., leaning right when strafing right).

1. **Calculate Local Velocity:** Inside `update(dt)`, take the global velocity `(vx, vz)` and rotate it by `-eyeYaw` to determine the local forward/backward and left/right strafing speeds.
2. **Map to Lean Angles:** * Define a maximum lean angle of ~0.052 radians (3 degrees).
* Multiply the local X (strafe) and local Z (forward) velocities by a small sensitivity multiplier.
* Clamp the resulting values between `-0.052` and `0.052`.


3. **Apply with Smoothing:** * Do not apply the raw targets directly to prevent snapping.
* Lerp the current `this.lower.rotation.z` (for X-axis lean) and `this.lower.rotation.x` (for Z-axis lean) toward the newly calculated target angles over `dt`.
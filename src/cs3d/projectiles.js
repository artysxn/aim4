// ---------------------------------------------------------------------------
// src/cs3d/projectiles.js
// The map explorer's binding of the shared projectile entity
// (src/cs3d/projectilesCore.js) to the WebGPU renderer it draws with.
//
// Everything that decides how a grenade behaves is in the core; this file
// exists only to say which `three` it is, so the aim trainer can say a
// different one over the same code. See the core's header.
// ---------------------------------------------------------------------------

import * as THREE from 'three/webgpu';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { createHullWorld } from './hullWorld.js';
import { makeProjectiles } from './projectilesCore.js';

export const { Projectiles } = makeProjectiles({ THREE, cloneSkinned, createHullWorld });

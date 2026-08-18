// ---------------------------------------------------------------------------
// src/cs3d/smokePass.js
// Raymarched smoke, off the bloom HDR target.
//
// Drawn into a half-res non-MSAA buffer and composited AFTER the map bloom,
// which is how CS2 does it and why a competitor cloud does not glow. The
// march samples smokeDepth.js for walls. Pipelines are compiled against this
// target at load so a grenade is not a 3s hitch.
// ---------------------------------------------------------------------------

import * as THREE from 'three/webgpu';
import { screenUV, texture } from 'three/webgpu';
import { captureSmokeDepth, skipSmokeDepth, smokePassSize } from './smokeDepth.js';

export function createSmokePass(renderer) {
  const { w, h } = smokePassSize(renderer);
  const volumeRT = new THREE.RenderTarget(w, h, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    colorSpace: THREE.NoColorSpace,
    samples: 0,
    depthBuffer: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: false
  });
  volumeRT.texture.generateMipmaps = false;

  const blitMat = new THREE.NodeMaterial();
  blitMat.colorNode = texture(volumeRT.texture, screenUV);
  blitMat.transparent = true;
  blitMat.depthTest = false;
  blitMat.depthWrite = false;
  blitMat.toneMapped = false;
  blitMat.fog = false;
  blitMat.blending = THREE.CustomBlending;
  blitMat.blendSrc = THREE.OneFactor;
  blitMat.blendDst = THREE.OneMinusSrcAlphaFactor;
  blitMat.blendSrcAlpha = THREE.OneFactor;
  blitMat.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;

  const blitMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), blitMat);
  blitMesh.frustumCulled = false;
  const blitScene = new THREE.Scene();
  blitScene.add(blitMesh);
  const blitCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const _clear = new THREE.Color(0, 0, 0);

  return {
    target: volumeRT,
    resize() {
      const s = smokePassSize(renderer);
      volumeRT.setSize(s.w, s.h);
    },
    /**
     * Depth first, then the volumes into `volumeRT`, then a premultiplied blit
     * over the canvas. No-op when `smokeScene` has nothing to draw.
     */
    render(camera, worldScene, hide, smokeScene) {
      if (!smokeScene?.children.length) {
        skipSmokeDepth();
        return;
      }
      captureSmokeDepth(renderer, worldScene, camera, hide);
      const { w: rw, h: rh } = smokePassSize(renderer);
      if (volumeRT.width !== rw || volumeRT.height !== rh) volumeRT.setSize(rw, rh);

      const prevTarget = renderer.getRenderTarget();
      const prevAlpha = renderer.getClearAlpha();
      const prevClear = new THREE.Color();
      renderer.getClearColor(prevClear);
      const prevAuto = renderer.autoClear;
      const prevTone = renderer.toneMapping;

      renderer.toneMapping = THREE.NoToneMapping;
      renderer.autoClear = true;
      renderer.setClearColor(_clear, 0);
      renderer.setRenderTarget(volumeRT);
      renderer.clear();
      renderer.render(smokeScene, camera);

      renderer.setRenderTarget(null);
      renderer.autoClear = false;
      renderer.render(blitScene, blitCam);

      renderer.setRenderTarget(prevTarget);
      renderer.setClearColor(prevClear, prevAlpha);
      renderer.autoClear = prevAuto;
      renderer.toneMapping = prevTone;
    }
  };
}

/**
 * viewer.js — Three.js 3D viewer for generated GLB models.
 * Handles scene setup, lighting, HDR environment, orbit controls,
 * auto-rotate, wireframe toggle, screenshot, and reset camera.
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RGBELoader } from "three/addons/loaders/RGBELoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

class ModelViewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.wrap = canvas.parentElement;

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
    this.camera.position.set(2.4, 1.8, 2.6);
    this.defaultCameraPos = this.camera.position.clone();

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true, // needed for screenshot()
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setClearColor(0x000000, 0); // transparent background

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 0.4;
    this.controls.maxDistance = 20;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 2.2;
    this.controls.target.set(0, 0.4, 0);

    // Post-processing
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new OutputPass());

    this._setupLights();
    this._setupGround();
    this._setupEnvironment();

    this.currentModel = null;
    this.wireframe = false;

    this._resize();
    window.addEventListener("resize", () => this._resize());

    this._animate();
  }

  _setupLights() {
    this.hemiLight = new THREE.HemisphereLight(0xffe8d0, 0x0c0c10, 0.65);
    this.scene.add(this.hemiLight);

    this.keyLight = new THREE.DirectionalLight(0xffffff, 2.4);
    this.keyLight.position.set(3, 5, 4);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(2048, 2048);
    this.keyLight.shadow.camera.near = 0.5;
    this.keyLight.shadow.camera.far = 20;
    this.keyLight.shadow.bias = -0.0005;
    this.scene.add(this.keyLight);

    this.rimLight = new THREE.DirectionalLight(0xff7a1a, 0.6);
    this.rimLight.position.set(-4, 2, -3);
    this.scene.add(this.rimLight);

    this.ambient = new THREE.AmbientLight(0xffffff, 0.25);
    this.scene.add(this.ambient);
  }

  _setupGround() {
    const geo = new THREE.PlaneGeometry(40, 40);
    const mat = new THREE.ShadowMaterial({ opacity: 0.32 });
    this.ground = new THREE.Mesh(geo, mat);
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = 0;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);

    this.grid = new THREE.GridHelper(20, 40, 0xff7a1a, 0x2a2a2a);
    this.grid.material.opacity = 0.12;
    this.grid.material.transparent = true;
    this.scene.add(this.grid);
  }

  _setupEnvironment() {
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.pmrem.compileEquirectangularShader();

    const HDR_URL =
      "https://cdn.jsdelivr.net/gh/mrdoob/three.js@r169/examples/textures/equirectangular/venice_sunset_1k.hdr";

    new RGBELoader().load(
      HDR_URL,
      (hdrTexture) => {
        const envMap = this.pmrem.fromEquirectangular(hdrTexture).texture;
        this.scene.environment = envMap;
        hdrTexture.dispose();
        this.pmrem.dispose();
      },
      undefined,
      () => {
        // Offline / blocked fallback: keep the studio lights only, no HDR.
        console.warn("HDR environment failed to load; using light-only environment.");
      }
    );
  }

  /**
   * Load a GLB model from a URL and add it to the scene.
   * @param {string} url
   * @param {(pct:number)=>void} onProgress
   */
  loadModel(url, onProgress) {
    return new Promise((resolve, reject) => {
      const dracoLoader = new DRACOLoader();
      dracoLoader.setDecoderPath("https://www.gstatic.com/draco/versioned/decoders/1.5.6/");

      const loader = new GLTFLoader();
      loader.setDRACOLoader(dracoLoader);

      loader.load(
        url,
        (gltf) => {
          this.clearModel();

          const model = gltf.scene;
          model.traverse((child) => {
            if (child.isMesh) {
              child.castShadow = true;
              child.receiveShadow = true;
              if (child.material) {
                child.material.envMapIntensity = 1.0;
              }
            }
          });

          // Normalize scale & center on ground
          const box = new THREE.Box3().setFromObject(model);
          const size = new THREE.Vector3();
          box.getSize(size);
          const maxDim = Math.max(size.x, size.y, size.z) || 1;
          const scale = 1.6 / maxDim;
          model.scale.setScalar(scale);

          const box2 = new THREE.Box3().setFromObject(model);
          const center = new THREE.Vector3();
          box2.getCenter(center);
          model.position.x -= center.x;
          model.position.z -= center.z;
          model.position.y -= box2.min.y;

          this.scene.add(model);
          this.currentModel = model;
          this.resetCamera();
          resolve(model);
        },
        (evt) => {
          if (onProgress && evt.total) {
            onProgress(Math.round((evt.loaded / evt.total) * 100));
          }
        },
        (err) => reject(err)
      );
    });
  }

  clearModel() {
    if (this.currentModel) {
      this.scene.remove(this.currentModel);
      this.currentModel.traverse((child) => {
        if (child.isMesh) {
          child.geometry?.dispose();
          if (Array.isArray(child.material)) {
            child.material.forEach((m) => m.dispose());
          } else {
            child.material?.dispose();
          }
        }
      });
      this.currentModel = null;
    }
  }

  toggleAutoRotate(force) {
    this.controls.autoRotate = force !== undefined ? force : !this.controls.autoRotate;
    return this.controls.autoRotate;
  }

  toggleWireframe(force) {
    this.wireframe = force !== undefined ? force : !this.wireframe;
    if (this.currentModel) {
      this.currentModel.traverse((child) => {
        if (child.isMesh && child.material) {
          child.material.wireframe = this.wireframe;
        }
      });
    }
    return this.wireframe;
  }

  resetCamera() {
    this.camera.position.copy(this.defaultCameraPos);
    this.controls.target.set(0, 0.4, 0);
    this.controls.update();
  }

  screenshot() {
    this.renderer.render(this.scene, this.camera);
    return this.canvas.toDataURL("image/png");
  }

  requestFullscreen() {
    if (this.wrap.requestFullscreen) this.wrap.requestFullscreen();
  }

  _resize() {
    const w = this.wrap.clientWidth;
    const h = this.wrap.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
  }

  _animate() {
    requestAnimationFrame(() => this._animate());
    this.controls.update();
    this.composer.render();
  }
}

window.ModelViewer = ModelViewer;
export { ModelViewer };

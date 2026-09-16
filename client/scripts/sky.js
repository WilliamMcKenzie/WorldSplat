import * as THREE from "three"

export function createSky() {
	const geometry = new THREE.SphereGeometry(80, 32, 16)
	const material = new THREE.ShaderMaterial({
		side: THREE.BackSide,
		depthWrite: false,
		depthTest: false,
		uniforms: {
			top: { value: new THREE.Color("#ffffff") },
			horizon: { value: new THREE.Color("#fcfcfc") },
		},
		vertexShader: `
			varying vec4 clipPosition;
			void main() {
				clipPosition = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
				gl_Position = clipPosition;
			}
		`,
		fragmentShader: `
			uniform vec3 top;
			uniform vec3 horizon;
			varying vec4 clipPosition;
			void main() {
				float t = clamp(clipPosition.y / clipPosition.w * 0.5 + 0.5, 0.0, 1.0);
				gl_FragColor = vec4(mix(horizon, top, t), 1.0);
			}
		`,
	})
	const sky = new THREE.Mesh(geometry, material)
	sky.userData.sky = true
	sky.renderOrder = -1000
	return sky
}

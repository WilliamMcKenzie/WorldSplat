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
			varying vec3 worldPosition;
			void main() {
				vec4 p = modelMatrix * vec4(position, 1.0);
				worldPosition = p.xyz;
				gl_Position = projectionMatrix * viewMatrix * p;
			}
		`,
		fragmentShader: `
			uniform vec3 top;
			uniform vec3 horizon;
			varying vec3 worldPosition;
			void main() {
				float h = normalize(worldPosition).y;
				float t = smoothstep(-0.08, 0.85, h);
				gl_FragColor = vec4(mix(horizon, top, t), 1.0);
			}
		`,
	})
	const sky = new THREE.Mesh(geometry, material)
	sky.userData.sky = true
	sky.renderOrder = -1000
	return sky
}

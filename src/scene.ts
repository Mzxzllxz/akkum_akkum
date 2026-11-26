import * as THREE from 'three'

export type View = 'outside' | 'inside'
export type SceneState = { inside: boolean; canSit: boolean; sitting: boolean }
// 위치(x,z)·바라보는 방향(f)·앉은 좌석 번호(s, 없으면 -1)·동작(g)
export type Pose = { x: number; z: number; f: number; s: number; g: string }
export interface ChapelScene {
  setMove(x: number, y: number): void
  goto(view: View): void
  setSnow(on: boolean): void
  setProjector(on: boolean): void
  setVerse(text: string, ref: string): void
  setCandles(n: number): void
  setQuality(high: boolean): void
  setReduceMotion(on: boolean): void
  gesture(g: 'pray' | 'wave'): void
  toggleSit(): void
  ringBell(): void
  getPose(): Pose
  setMe(name: string, hue: number): void
  setPeer(id: string, info: { name: string; hue: number } | null): void
  movePeer(id: string, pose: Pose): void
  say(id: string | null, text: string): void
  snapshot(): Promise<Blob | null>
  dispose(): void
}

// 예배당 안쪽 치수(미터). 정문은 +z, 강단은 -z.
const HALF_W = 6, HALF_L = 10, WALL_H = 6, WALL_T = 0.4, DOOR_W = 2.4
const PLAYER_R = 0.35, WALK_SPEED = 3.2, WORLD_R = 80, MAX_CANDLES = 24, MAX_PEERS = 60

type Box = [minX: number, maxX: number, minZ: number, maxZ: number]

// 고정 시드 난수: 나중에 실시간 접속자 모두가 같은 숲을 보도록.
const rng = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296

export function createScene(host: HTMLElement, onState: (s: SceneState) => void): ChapelScene {
  const renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  host.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x0a1420)
  scene.fog = new THREE.Fog(0x0a1420, 35, 120)
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 400)

  const std = (color: number, o: THREE.MeshStandardMaterialParameters = {}) =>
    new THREE.MeshStandardMaterial({ color, roughness: 0.9, ...o })
  const glow = (color: number, intensity = 1.5) => std(0x000000, { emissive: color, emissiveIntensity: intensity })
  const colliders: Box[] = []
  const solid = (cx: number, cz: number, w: number, d: number) => colliders.push([cx - w / 2, cx + w / 2, cz - d / 2, cz + d / 2])
  const put = <T extends THREE.Object3D>(o: T, x: number, y: number, z: number, parent: THREE.Object3D = scene) => {
    o.position.set(x, y, z)
    parent.add(o)
    return o
  }
  const box = (w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number, parent?: THREE.Object3D) =>
    put(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m), x, y, z, parent)
  const light = (color: number, intensity: number, distance: number, x: number, y: number, z: number) =>
    put(new THREE.PointLight(color, intensity, distance, 2), x, y, z)

  // ── 하늘·땅 ─────────────────────────────────────────────
  scene.add(new THREE.HemisphereLight(0x9db4e0, 0x1a2433, 0.8))
  put(new THREE.DirectionalLight(0xbfd0ff, 0.7), -60, 70, -120)
  put(new THREE.Mesh(new THREE.SphereGeometry(6), new THREE.MeshBasicMaterial({ color: 0xfff4d6, fog: false })), -60, 70, -120)

  const rand = rng(20261225)
  const starPos = new Float32Array(700 * 3)
  for (let i = 0; i < 700; i++) {
    const a = rand() * Math.PI * 2, phi = Math.acos(rand() * 0.95)
    starPos.set([180 * Math.sin(phi) * Math.cos(a), 180 * Math.cos(phi) + 5, 180 * Math.sin(phi) * Math.sin(a)], i * 3)
  }
  const starGeo = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(starPos, 3))
  scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xcfe0ff, size: 0.9, fog: false })))

  const ground = new THREE.Mesh(new THREE.CircleGeometry(160, 48), std(0xe6edf5, { roughness: 1 }))
  ground.rotation.x = -Math.PI / 2
  scene.add(ground)
  box(2.6, 0.04, 30, std(0x8d939c), 0, 0.02, HALF_L + 15.6) // 정문으로 이어지는 돌길

  // ── 숲 (인스턴스 3개로 전부 그림) ─────────────────────────
  const TREES = 70
  const coneGeo = new THREE.ConeGeometry(1, 1.6, 8)
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.18, 0.25, 1.2, 6), std(0x4a3526), TREES)
  const leaves = new THREE.InstancedMesh(coneGeo, std(0x1d4a3a), TREES * 3)
  const caps = new THREE.InstancedMesh(coneGeo, std(0xf2f6fb), TREES * 3)
  const dummy = new THREE.Object3D()
  const place = (m: THREE.InstancedMesh, i: number, x: number, y: number, z: number, sx: number, sy: number) => {
    dummy.position.set(x, y, z)
    dummy.scale.set(sx, sy, sx)
    dummy.updateMatrix()
    m.setMatrixAt(i, dummy.matrix)
  }
  for (let n = 0; n < TREES; ) {
    const a = rand() * Math.PI * 2, dist = 16 + rand() * 70
    const x = Math.cos(a) * dist, z = Math.sin(a) * dist
    if ((Math.abs(x) < 8 && z > 0) || (Math.abs(x) < 11 && Math.abs(z) < 15)) continue // 길과 건물 자리는 비움
    const s = 0.9 + rand() * 1.3
    place(trunks, n, x, 0.6 * s, z, s, s)
    for (let k = 0; k < 3; k++) {
      const y = (1.5 + k * 0.85) * s, r = (1.5 - k * 0.4) * s
      place(leaves, n * 3 + k, x, y, z, r, s)
      place(caps, n * 3 + k, x, y + 0.42 * s, z, r * 0.62, s * 0.5)
    }
    solid(x, z, 0.5 * s, 0.5 * s)
    n++
  }
  scene.add(trunks, leaves, caps)

  // ── 예배당 외벽·지붕·종탑 ─────────────────────────────────
  const wall = std(0xd8cdb8), wood = std(0x5a3d28), snowy = std(0xeef3f8), warm = glow(0xffc070, 1.2)
  const sideX = HALF_W + WALL_T / 2, endZ = HALF_L + WALL_T / 2
  for (const s of [-1, 1]) {
    box(WALL_T, WALL_H, HALF_L * 2 + WALL_T * 2, wall, s * sideX, WALL_H / 2, 0)
    solid(s * sideX, 0, WALL_T, HALF_L * 2 + WALL_T * 2)
    for (const z of [-6.5, -2.5, 1.5, 5.5]) box(WALL_T + 0.06, 2.4, 1.1, warm, s * sideX, 3, z) // 창
    const seg = HALF_W - DOOR_W / 2
    box(seg, WALL_H, WALL_T, wall, s * (DOOR_W / 2 + seg / 2), WALL_H / 2, endZ)
    solid(s * (DOOR_W / 2 + seg / 2), endZ, seg, WALL_T)
    const leaf = box(DOOR_W / 2, 3.2, 0.1, wood, s * (DOOR_W / 2 + 0.05), 1.6, endZ + WALL_T / 2 + DOOR_W / 4) // 활짝 연 문
    leaf.rotation.y = Math.PI / 2
  }
  box(HALF_W * 2, WALL_H, WALL_T, wall, 0, WALL_H / 2, -endZ)
  solid(0, -endZ, HALF_W * 2 + WALL_T * 2, WALL_T)
  box(DOOR_W, WALL_H - 3.2, WALL_T, wall, 0, 3.2 + (WALL_H - 3.2) / 2, endZ)
  box(1, 1.2, WALL_T + 0.06, warm, 0, 4.7, endZ)
  box(3.2, 0.15, 1.2, std(0x8d939c), 0, 0.075, endZ + 0.8)

  const RISE = 4, span = HALF_W + WALL_T
  const tri = new THREE.Shape().moveTo(-span, 0).lineTo(span, 0).lineTo(0, RISE).closePath()
  const gableGeo = new THREE.ExtrudeGeometry(tri, { depth: WALL_T, bevelEnabled: false })
  for (const z of [-(HALF_L + WALL_T), HALF_L]) put(new THREE.Mesh(gableGeo, wall), 0, WALL_H, z)
  const slope = Math.atan(RISE / span), ridgeY = WALL_H + RISE
  for (const s of [-1, 1]) {
    const roof = box(7.6 / Math.cos(slope), 0.3, HALF_L * 2 + 1.6, snowy, s * 3.8, ridgeY - 3.8 * Math.tan(slope) + 0.18, 0)
    roof.rotation.z = -s * slope
    const ceil = box(span / Math.cos(slope), 0.1, HALF_L * 2, wood, s * (span / 2), ridgeY - (span / 2) * Math.tan(slope) - 0.22, 0)
    ceil.rotation.z = -s * slope
  }
  const towerZ = HALF_L - 1.4
  box(3.2, 5.5, 3.2, wall, 0, 11.75, towerZ)
  for (const [x, z, ry] of [[0, 1.6, 0], [0, -1.6, 0], [1.6, 0, 1], [-1.6, 0, 1]])
    box(1, 1.4, 0.1, warm, x, 13, towerZ + z).rotation.y = ry * Math.PI / 2
  const spire = put(new THREE.Mesh(new THREE.ConeGeometry(2.5, 4.5, 4), snowy), 0, 16.75, towerZ)
  spire.rotation.y = Math.PI / 4
  const crossMat = glow(0xffd58a, 1.6)
  box(0.18, 1.6, 0.18, crossMat, 0, 19.6, towerZ)
  box(0.9, 0.18, 0.18, crossMat, 0, 19.9, towerZ)

  // ── 실내 ────────────────────────────────────────────────
  box(HALF_W * 2, 0.04, HALF_L * 2, std(0x7a5638), 0, 0.02, 0)
  box(1.8, 0.02, 16.5, std(0x7d1f2a), 0, 0.05, 1.6)
  const seats: { x: number; z: number }[] = []
  for (const z of [-3.6, -1.2, 1.2, 3.6, 6])
    for (const s of [-1, 1]) {
      const cx = s * 3.3
      box(3.8, 0.1, 0.55, wood, cx, 0.5, z)
      box(3.8, 0.95, 0.1, wood, cx, 0.78, z + 0.32)
      for (const e of [-1.9, 1.9]) box(0.1, 0.75, 0.6, wood, cx + e, 0.375, z + 0.03)
      solid(cx, z + 0.05, 3.8, 0.8)
      for (const dx of [-1.2, 0, 1.2]) seats.push({ x: cx + dx, z })
    }

  const PLAT = 0.3
  box(HALF_W * 2, PLAT, 3.4, std(0x6a4a33), 0, PLAT / 2, -8.3) // 강단: 올라갈 수 없음
  solid(0, -8.3, HALF_W * 2, 3.4)
  box(2.2, 0.9, 0.8, std(0xf3ead8), 0, PLAT + 0.45, -8.4)
  box(0.8, 1.1, 0.6, wood, 1.9, PLAT + 0.55, -7.2)
  const gold = glow(0xffd58a, 1.6)
  box(0.22, 2.6, 0.12, gold, 0, 4.7, -9.9)
  box(1.4, 0.22, 0.12, gold, 0, 5.3, -9.9)

  // 말씀 스크린 (빔프로젝터)
  const cv = document.createElement('canvas')
  cv.width = 1024
  cv.height = 576
  const ctx = cv.getContext('2d')!
  const screenTex = new THREE.CanvasTexture(cv)
  screenTex.colorSpace = THREE.SRGBColorSpace
  box(4.4, 2.56, 0.04, std(0x1a1d22), -3.6, 3.2, -9.97)
  put(new THREE.Mesh(new THREE.PlaneGeometry(4.2, 2.36), new THREE.MeshBasicMaterial({ map: screenTex })), -3.6, 3.2, -9.94)
  let projector = true, verse = { text: '', ref: '' }
  const drawVerse = () => {
    ctx.fillStyle = projector ? '#16263a' : '#0b0d10'
    ctx.fillRect(0, 0, cv.width, cv.height)
    if (projector) {
      ctx.textAlign = 'center'
      ctx.fillStyle = '#f6ead2'
      ctx.font = '500 56px "Noto Serif KR", "Nanum Myeongjo", serif'
      const LH = 80
      const lines: string[] = []
      let line = ''
      for (const word of verse.text.split(' ')) {
        if (line && ctx.measureText(line + ' ' + word).width > 900) {
          lines.push(line)
          line = word
        } else line = line ? line + ' ' + word : word
      }
      lines.push(line)
      const top = cv.height / 2 - (lines.length * LH) / 2
      lines.forEach((l, i) => ctx.fillText(l, cv.width / 2, top + i * LH + 20))
      ctx.fillStyle = '#e8b96a'
      ctx.font = '400 38px "Noto Serif KR", serif'
      ctx.fillText(verse.ref, cv.width / 2, top + lines.length * LH + 50)
    }
    screenTex.needsUpdate = true
  }

  // 성탄 트리
  const treeX = 4, treeZ = -8.4
  box(0.3, 0.6, 0.3, std(0x4a3526), treeX, PLAT + 0.3, treeZ)
  const ornaments = [glow(0xff5a4a, 2), glow(0xffd070, 2), glow(0x7ab8ff, 2)]
  const ballGeo = new THREE.SphereGeometry(0.07, 8, 6)
  for (let k = 0; k < 3; k++) {
    const y = PLAT + 1.2 + k * 0.75, r = 1.2 - k * 0.28
    put(new THREE.Mesh(coneGeo, std(0x1d5a3e)), treeX, y, treeZ).scale.set(r, 1, r)
    for (let i = 0; i < 6; i++) {
      const a = rand() * Math.PI * 2, h = rand() * 0.6 - 0.5
      const rr = r * (0.5 - h / 1.6) + 0.03
      put(new THREE.Mesh(ballGeo, ornaments[(i + k) % 3]), treeX + Math.cos(a) * rr, y + h, treeZ + Math.sin(a) * rr)
    }
  }
  put(new THREE.Mesh(new THREE.OctahedronGeometry(0.16), gold), treeX, PLAT + 3.6, treeZ)
  light(0xffd9a0, 6, 8, 3.6, 2, -7.4)

  // 촛대
  const tableX = -3.6, tableZ = -5.9
  box(2.4, 0.85, 0.6, wood, tableX, 0.425, tableZ)
  solid(tableX, tableZ, 2.4, 0.6)
  const wax = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.035, 0.035, 0.22, 8), std(0xf5ecd8), MAX_CANDLES)
  const flames = new THREE.InstancedMesh(new THREE.SphereGeometry(0.035, 8, 6), glow(0xffb347, 3), MAX_CANDLES)
  for (let i = 0; i < MAX_CANDLES; i++) {
    const x = tableX + ((i % 8) - 3.5) * 0.27, z = tableZ + (Math.floor(i / 8) - 1) * 0.17
    place(wax, i, x, 0.96, z, 1, 1)
    place(flames, i, x, 1.12, z, 1, 1.9)
  }
  wax.count = flames.count = 0
  scene.add(wax, flames)
  const candleLight = light(0xffb060, 0, 7, tableX, 1.6, tableZ + 0.4)

  // 조명
  for (const z of [-5, 1, 6.5]) {
    light(0xffc98a, 45, 14, 0, 5.2, z)
    put(new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 8), glow(0xffd9a0, 2.5)), 0, 5.5, z)
  }
  const lampLights: THREE.PointLight[] = []
  const postMat = std(0x20262e), bulbGeo = new THREE.SphereGeometry(0.2, 12, 8), bulbMat = glow(0xffd9a0, 2.5)
  for (const z of [14, 21])
    for (const x of [-2.2, 2.2]) {
      put(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 2.6, 6), postMat), x, 1.3, z)
      put(new THREE.Mesh(bulbGeo, bulbMat), x, 2.75, z)
      solid(x, z, 0.2, 0.2)
      lampLights.push(light(0xffc98a, 12, 12, x, 2.9, z))
    }
  light(0xffc98a, 14, 10, 0, 2.6, endZ + 1.6)

  // ── 내 캐릭터 ────────────────────────────────────────────
  const skin = std(0xf1c9a5), hatMat = std(0x2e5a4c), eyeMat = std(0x1c1c22), trousers = std(0x2b3140)
  const bodyGeo = new THREE.CapsuleGeometry(0.26, 0.42, 4, 10), headGeo = new THREE.SphereGeometry(0.23, 16, 12)
  const hatGeo = new THREE.SphereGeometry(0.245, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2)
  const pomGeo = new THREE.SphereGeometry(0.07, 8, 6), eyeGeo = new THREE.SphereGeometry(0.025, 6, 6)
  const legGeo = new THREE.CylinderGeometry(0.08, 0.08, 0.46, 8), armGeo = new THREE.CylinderGeometry(0.065, 0.065, 0.42, 8)
  const makeAvatar = (hue: number) => {
    const group = new THREE.Group()
    const coat = std(0xffffff)
    coat.color.setHSL(hue / 360, 0.55, 0.4)
    put(new THREE.Mesh(bodyGeo, coat), 0, 0.85, 0, group)
    const head = put(new THREE.Group(), 0, 1.42, 0, group)
    head.add(new THREE.Mesh(headGeo, skin))
    put(new THREE.Mesh(hatGeo, hatMat), 0, 0.03, 0, head)
    put(new THREE.Mesh(pomGeo, snowy), 0, 0.3, 0, head)
    for (const s of [-1, 1]) put(new THREE.Mesh(eyeGeo, eyeMat), s * 0.08, -0.02, 0.21, head)
    const limb = (x: number, y: number, geo: THREE.CylinderGeometry, m: THREE.Material) => {
      const pivot = put(new THREE.Group(), x, y, 0, group)
      put(new THREE.Mesh(geo, m), 0, -geo.parameters.height / 2, 0, pivot)
      return pivot
    }
    const legs = [-1, 1].map(s => limb(s * 0.11, 0.48, legGeo, trousers))
    const arms = [-1, 1].map(s => limb(s * 0.3, 1.08, armGeo, coat))
    scene.add(group)
    return { group, head, legs, arms, coat, phase: 0, bubbleT: 0, label: null as THREE.Sprite | null, bubble: null as THREE.Sprite | null }
  }
  type Avatar = ReturnType<typeof makeAvatar>
  const animate = (a: Avatar, moving: boolean, sit: boolean, g: string, dt: number, now: number) => {
    if (moving) a.phase += dt * 9
    const swing = moving ? Math.sin(a.phase) * 0.6 : 0
    a.legs.forEach((l, i) => (l.rotation.x = sit ? -Math.PI / 2 : i ? -swing : swing))
    const pray = g === 'pray', wave = g === 'wave'
    a.head.rotation.x = pray ? 0.45 : 0
    a.arms.forEach((arm, i) => {
      const s = i ? 1 : -1
      arm.rotation.x = pray ? -1.15 : i ? swing * 0.8 : -swing * 0.8
      arm.rotation.z = pray ? -s * 0.4 : wave && i ? 2.6 + Math.sin(now * 0.012) * 0.3 : s * 0.12
    })
    if (a.bubble && (a.bubbleT -= dt) <= 0) setSprite(a, 'bubble', '')
  }
  // 이름표·말풍선: 글자를 캔버스에 그려 스프라이트로 띄움(HTML로 넣지 않으므로 남이 보낸 글자도 안전)
  const textSprite = (text: string, bubble: boolean) => {
    const c = document.createElement('canvas'), x = c.getContext('2d')!
    const font = '600 40px "Pretendard", "Noto Sans KR", sans-serif'
    x.font = font
    c.width = Math.min(1024, Math.ceil(x.measureText(text).width) + 48)
    c.height = 72
    x.font = font // 캔버스 크기를 바꾸면 설정이 초기화됨
    x.fillStyle = bubble ? 'rgba(244,236,220,0.95)' : 'rgba(10,20,32,0.55)'
    x.beginPath()
    x.roundRect(0, 0, c.width, c.height, 28)
    x.fill()
    x.fillStyle = bubble ? '#1a1408' : '#f4ecdc'
    x.textAlign = 'center'
    x.textBaseline = 'middle'
    x.fillText(text, c.width / 2, c.height / 2 + 2, c.width - 32)
    const tex = new THREE.CanvasTexture(c)
    tex.colorSpace = THREE.SRGBColorSpace
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false }))
    sprite.scale.set((c.width / c.height) * 0.3, 0.3, 1)
    return sprite
  }
  const setSprite = (a: Avatar, key: 'label' | 'bubble', text: string) => {
    const old = a[key]
    if (old) {
      old.material.map?.dispose()
      old.material.dispose()
      a.group.remove(old)
    }
    a[key] = text ? put(textSprite(text, key === 'bubble'), 0, key === 'bubble' ? 2.3 : 1.92, 0, a.group) : null
  }
  const me = makeAvatar(0)
  const peers = new Map<string, { av: Avatar; pose: Pose }>()

  // ── 눈 ──────────────────────────────────────────────────
  const SNOW = 1800, SX = 60, SY = 26
  const snowBase = new Float32Array(SNOW * 4) // x, y, z, 낙하 속도
  for (let i = 0; i < SNOW; i++) snowBase.set([rand() * SX, rand() * SY, rand() * SX, 0.8 + rand() * 1.2], i * 4)
  const snowPos = new Float32Array(SNOW * 3)
  const snowGeo = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(snowPos, 3))
  const flake = document.createElement('canvas')
  flake.width = flake.height = 32
  const fctx = flake.getContext('2d')!
  const grad = fctx.createRadialGradient(16, 16, 0, 16, 16, 16)
  grad.addColorStop(0, '#fff')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  fctx.fillStyle = grad
  fctx.fillRect(0, 0, 32, 32)
  const snow = new THREE.Points(snowGeo, new THREE.PointsMaterial({
    map: new THREE.CanvasTexture(flake), size: 0.22, transparent: true, opacity: 0.9, depthWrite: false,
  }))
  snow.frustumCulled = false
  scene.add(snow)
  const wrap = (v: number, m: number) => ((v % m) + m) % m

  // ── 상태·입력 ────────────────────────────────────────────
  const OUTSIDE_Z = 31, INSIDE_Z = 6.5
  const pos = { x: 0, z: OUTSIDE_Z }
  let facing = Math.PI, yaw = 0, pitch = 0.28, dist = 5
  let sitting = -1, bellT = 0, slowMotion = false, time = 0
  let gesture: { type: 'pray' | 'wave'; t: number } | null = null
  const joy = { x: 0, y: 0 }
  const keys = new Set<string>()
  const blocked = (x: number, z: number) =>
    Math.hypot(x, z) > WORLD_R ||
    colliders.some(([x0, x1, z0, z1]) => x > x0 - PLAYER_R && x < x1 + PLAYER_R && z > z0 - PLAYER_R && z < z1 + PLAYER_R)
  const isInside = () => Math.abs(pos.x) < HALF_W && Math.abs(pos.z) < HALF_L
  const nearestSeat = () => {
    let best = -1, bestD = 1.6
    // ponytail: 동시에 같은 자리를 누르면 둘 다 앉게 됨. 문제되면 좌석 점유를 DB(유일 제약)로 옮길 것.
    const taken = new Set([...peers.values()].map(p => p.pose.s))
    seats.forEach((s, i) => {
      const d = Math.hypot(s.x - pos.x, s.z - pos.z)
      if (d < bestD && !taken.has(i)) (best = i), (bestD = d)
    })
    return best
  }
  const stand = () => {
    if (sitting < 0) return
    pos.z = seats[sitting].z - 0.9 // 앞쪽 통로로 일어섬
    sitting = -1
  }

  const typing = (e: Event) => (e.target as HTMLElement | null)?.closest?.('input,textarea,select,dialog')
  const onKeyDown = (e: KeyboardEvent) => { if (!typing(e)) keys.add(e.code) } // e.code: 한글 입력 상태에서도 WASD 동작
  const onKeyUp = (e: KeyboardEvent) => keys.delete(e.code)
  const onBlur = () => keys.clear()
  addEventListener('keydown', onKeyDown)
  addEventListener('keyup', onKeyUp)
  addEventListener('blur', onBlur)
  const el = renderer.domElement
  let drag: { x: number; y: number } | null = null
  el.onpointerdown = e => { el.setPointerCapture(e.pointerId); drag = { x: e.clientX, y: e.clientY } }
  el.onpointermove = e => {
    if (!drag) return
    yaw -= (e.clientX - drag.x) * 0.005
    pitch = THREE.MathUtils.clamp(pitch + (e.clientY - drag.y) * 0.004, 0.03, 1.2)
    drag = { x: e.clientX, y: e.clientY }
  }
  el.onpointerup = el.onpointercancel = () => { drag = null }
  el.onwheel = e => { dist = THREE.MathUtils.clamp(dist + e.deltaY * 0.004, 2, 9) }

  const ro = new ResizeObserver(() => {
    const w = host.clientWidth || 1, h = host.clientHeight || 1
    renderer.setSize(w, h)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  })
  ro.observe(host)

  // ── 매 프레임 ────────────────────────────────────────────
  const camGoal = new THREE.Vector3()
  let snapCam = true
  let last: SceneState = { inside: false, canSit: false, sitting: false }
  let prev = performance.now(), raf = 0
  const frame = (now: number) => {
    raf = requestAnimationFrame(frame)
    const dt = Math.min((now - prev) / 1000, 0.05)
    prev = now
    time += dt * (slowMotion ? 0.35 : 1)

    const has = (...c: string[]) => (c.some(k => keys.has(k)) ? 1 : 0)
    let ix = joy.x + has('KeyD', 'ArrowRight') - has('KeyA', 'ArrowLeft')
    let iy = joy.y + has('KeyW', 'ArrowUp') - has('KeyS', 'ArrowDown')
    const len = Math.hypot(ix, iy)
    if (len > 1) (ix /= len), (iy /= len)
    const moving = len > 0.05
    if (moving) {
      stand()
      gesture = null
      const mx = -Math.sin(yaw) * iy + Math.cos(yaw) * ix, mz = -Math.cos(yaw) * iy - Math.sin(yaw) * ix
      const step = WALK_SPEED * dt
      if (!blocked(pos.x + mx * step, pos.z)) pos.x += mx * step // 축별로 따로 막아 벽을 타고 미끄러지게
      if (!blocked(pos.x, pos.z + mz * step)) pos.z += mz * step
      const turn = wrap(Math.atan2(mx, mz) - facing + Math.PI, Math.PI * 2) - Math.PI
      facing += turn * Math.min(1, dt * 10)
    }

    me.group.position.set(pos.x, sitting >= 0 ? 0.1 : 0, pos.z)
    me.group.rotation.y = facing
    if (gesture && (gesture.t -= dt) <= 0) gesture = null
    animate(me, moving, sitting >= 0, gesture?.type ?? '', dt, now)
    const ease = 1 - Math.exp(-dt * 8) // 다른 방문자는 받은 위치로 부드럽게 따라감
    for (const { av, pose } of peers.values()) {
      const g = av.group, dx = pose.x - g.position.x, dz = pose.z - g.position.z
      g.position.set(g.position.x + dx * ease, pose.s >= 0 ? 0.1 : 0, g.position.z + dz * ease)
      g.rotation.y += (wrap(pose.f - g.rotation.y + Math.PI, Math.PI * 2) - Math.PI) * ease
      animate(av, Math.hypot(dx, dz) > 0.05, pose.s >= 0, pose.g, dt, now)
    }

    const inside = isInside()
    const ty = sitting >= 0 ? 1.2 : 1.35
    let cx = pos.x + Math.sin(yaw) * Math.cos(pitch) * dist
    let cy = ty + Math.sin(pitch) * dist
    let cz = pos.z + Math.cos(yaw) * Math.cos(pitch) * dist
    if (inside) {
      // 실내에서는 카메라를 벽 안쪽에 가둠. 문턱 근처에서만 정문 틈으로 빠져나갈 수 있게 둠.
      cx = THREE.MathUtils.clamp(cx, -HALF_W + 0.4, HALF_W - 0.4)
      cy = Math.min(cy, WALL_H - 0.4)
      cz = Math.max(cz, -HALF_L + 0.4)
      if (pos.z < HALF_L - 2.5 || Math.abs(cx) > DOOR_W / 2 - 0.2 || cy > 3) cz = Math.min(cz, HALF_L - 0.4)
    }
    camera.position.lerp(camGoal.set(cx, cy, cz), snapCam ? 1 : 1 - Math.exp(-dt * 12)) // 벽에 걸릴 때 튀지 않게
    snapCam = false
    camera.lookAt(pos.x, ty, pos.z)

    if (snow.visible) {
      for (let i = 0; i < SNOW; i++) {
        const x = wrap(snowBase[i * 4] - camera.position.x, SX) - SX / 2 + camera.position.x
        const z = wrap(snowBase[i * 4 + 2] - camera.position.z, SX) - SX / 2 + camera.position.z
        const roofed = Math.abs(x) < HALF_W + 0.5 && Math.abs(z) < HALF_L + 0.5
        snowPos[i * 3] = x + Math.sin(time * 0.6 + i) * 0.3
        snowPos[i * 3 + 1] = roofed ? -50 : wrap(snowBase[i * 4 + 1] - time * snowBase[i * 4 + 3], SY)
        snowPos[i * 3 + 2] = z
      }
      snowGeo.attributes.position.needsUpdate = true
    }
    bellT = Math.max(0, bellT - dt)
    crossMat.emissiveIntensity = 1.6 + bellT * 2 * (0.6 + 0.4 * Math.sin(now * 0.02))

    const next = { inside, canSit: inside && sitting < 0 && nearestSeat() >= 0, sitting: sitting >= 0 }
    if (next.inside !== last.inside || next.canSit !== last.canSit || next.sitting !== last.sitting) onState((last = next))
    renderer.render(scene, camera)
  }
  raf = requestAnimationFrame(frame)

  return {
    setMove(x, y) { joy.x = x; joy.y = y },
    goto(view) {
      sitting = -1
      pos.x = 0
      pos.z = view === 'inside' ? INSIDE_Z : OUTSIDE_Z
      facing = Math.PI
      yaw = 0
      snapCam = true
    },
    setSnow(on) { snow.visible = on },
    setProjector(on) { projector = on; drawVerse() },
    setVerse(text, ref) { verse = { text, ref }; drawVerse() },
    setCandles(n) {
      wax.count = flames.count = Math.min(n, MAX_CANDLES)
      candleLight.intensity = Math.min(n, MAX_CANDLES) * 0.35
    },
    setQuality(high) {
      renderer.setPixelRatio(high ? Math.min(devicePixelRatio, 2) : 1)
      lampLights.forEach(l => (l.visible = high))
    },
    setReduceMotion(on) { slowMotion = on },
    gesture(type) { gesture = { type, t: type === 'pray' ? 4 : 2.5 } },
    toggleSit() {
      if (sitting >= 0) return stand()
      const i = nearestSeat()
      if (i < 0) return
      sitting = i
      pos.x = seats[i].x
      pos.z = seats[i].z
      facing = Math.PI
    },
    ringBell() { bellT = 3 },
    getPose: () => ({ x: pos.x, z: pos.z, f: facing, s: sitting, g: gesture?.type ?? '' }),
    setMe(name, hue) {
      me.coat.color.setHSL(hue / 360, 0.55, 0.4)
      setSprite(me, 'label', name)
    },
    setPeer(id, info) {
      let p = peers.get(id)
      if (!info) {
        if (!p) return
        setSprite(p.av, 'label', '')
        setSprite(p.av, 'bubble', '')
        p.av.coat.dispose()
        scene.remove(p.av.group)
        peers.delete(id)
        return
      }
      if (!p) {
        if (peers.size >= MAX_PEERS) return
        p = { av: makeAvatar(info.hue), pose: { x: 0, z: 0, f: 0, s: -1, g: '' } }
        p.av.group.visible = false // 첫 위치를 받을 때까지 숨김
        peers.set(id, p)
      }
      p.av.coat.color.setHSL(info.hue / 360, 0.55, 0.4)
      setSprite(p.av, 'label', info.name)
    },
    movePeer(id, pose) {
      const p = peers.get(id)
      if (!p) return
      p.pose = pose
      if (!p.av.group.visible) {
        p.av.group.position.set(pose.x, 0, pose.z)
        p.av.group.rotation.y = pose.f
        p.av.group.visible = true
      }
    },
    say(id, text) {
      const a = id ? peers.get(id)?.av : me
      if (!a) return
      setSprite(a, 'bubble', text)
      a.bubbleT = 6
    },
    snapshot() {
      renderer.render(scene, camera) // 같은 태스크 안에서 읽어야 버퍼가 비워지기 전
      return new Promise(res => el.toBlob(res, 'image/png'))
    },
    dispose() {
      cancelAnimationFrame(raf)
      removeEventListener('keydown', onKeyDown)
      removeEventListener('keyup', onKeyUp)
      removeEventListener('blur', onBlur)
      ro.disconnect()
      renderer.dispose()
      el.remove()
    },
  }
}

import { createClient } from '@supabase/supabase-js'
import type { Pose } from './scene'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
/** 환경변수가 없으면 null → 앱은 혼자 쓰는 모드로 동작 */
export const db = url && key ? createClient(url, key) : null
/** 탭마다 다른 id. 같은 사람이 탭 두 개를 열면 캐릭터도 둘. */
export const myId = crypto.randomUUID()

export type Peer = { name: string; hue: number }
export const NAME_MAX = 12, CHAT_MAX = 60
const SEND_MS = 200, HEARTBEAT_MS = 3000

// ── 남이 보낸 값은 전부 검사해서 받는다 ──────────────────────
const num = (v: unknown, lo: number, hi: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')
export const cleanName = (v: unknown) => text(v, NAME_MAX) || '이웃'
export function parsePose(p: Record<string, unknown>): Pose | null {
  const x = num(p.x, -80, 80), z = num(p.z, -80, 80), f = num(p.f, -1e4, 1e4), s = num(p.s, -1, 999)
  if (x === null || z === null || f === null || s === null) return null
  return { x, z, f, s: Math.round(s), g: p.g === 'pray' || p.g === 'wave' ? p.g : '' }
}

/** 익명 로그인. 꺼져 있거나 실패하면 null → 기도·촛불은 기기에만 저장 */
export async function signIn(): Promise<string | null> {
  if (!db) return null
  const { data } = await db.auth.getSession()
  if (data.session) return data.session.user.id
  return (await db.auth.signInAnonymously()).data.user?.id ?? null
}

type Handlers = {
  onStatus(online: boolean): void
  onPeers(peers: Map<string, Peer>): void
  onPose(id: string, pose: Pose): void
  onChat(id: string, text: string): void
  onBell(): void
  onRefresh(): void
}

/**
 * 예배당 방에 들어간다. 위치·대화·종은 DB를 거치지 않고 Realtime으로만 오간다.
 * ponytail: 보내는 사람 id를 서버가 확인하지 않는 공개 채널(남의 id로 보낼 수 있음).
 *   문제되면 private 채널 + Realtime 권한 정책으로 전환.
 * ponytail: 위치를 초당 5회 전송. 무료 요금제(프로젝트 전체 초당 100건)에서는 동시에 걷는 사람 20명쯤이 한계.
 */
export function joinRoom(getPose: () => Pose, h: Handlers) {
  if (!db) return null
  const client = db
  let online = false, lastSent = '', lastAt = 0
  const ch = client.channel('chapel', { config: { presence: { key: myId }, broadcast: { self: false } } })
  const send = (event: string, payload: object = {}) => {
    void ch.send({ type: 'broadcast', event, payload: { ...payload, id: myId } })
  }
  const from = (p: Record<string, unknown>) => (typeof p.id === 'string' && p.id !== myId ? p.id : null)

  ch.on('presence', { event: 'sync' }, () => {
    const peers = new Map<string, Peer>()
    for (const [id, metas] of Object.entries(ch.presenceState<Peer>())) {
      if (id !== myId) peers.set(id, { name: cleanName(metas[0]?.name), hue: num(metas[0]?.hue, 0, 360) ?? 0 })
    }
    h.onPeers(peers)
    lastSent = '' // 새로 들어온 사람이 내 위치를 바로 받도록
  })
    .on('broadcast', { event: 'pos' }, ({ payload }) => {
      const id = from(payload), pose = parsePose(payload)
      if (id && pose) h.onPose(id, pose)
    })
    .on('broadcast', { event: 'chat' }, ({ payload }) => {
      const id = from(payload), msg = text(payload.text, CHAT_MAX)
      if (id && msg) h.onChat(id, msg)
    })
    .on('broadcast', { event: 'bell' }, () => h.onBell())
    .on('broadcast', { event: 'refresh' }, () => h.onRefresh())
    .subscribe(status => {
      online = status === 'SUBSCRIBED'
      h.onStatus(online)
    })

  const timer = setInterval(() => {
    if (!online) return
    const pose = getPose()
    const snap = `${pose.x.toFixed(2)},${pose.z.toFixed(2)},${pose.f.toFixed(1)},${pose.s},${pose.g}`
    const now = Date.now()
    if (snap === lastSent && now - lastAt < HEARTBEAT_MS) return // 가만히 있으면 3초에 한 번만
    lastSent = snap
    lastAt = now
    send('pos', pose)
  }, SEND_MS)

  return {
    chat: (msg: string) => send('chat', { text: msg }),
    bell: () => send('bell'),
    refresh: () => send('refresh'),
    /** 내 이름·색을 알림. 연결된 뒤(onStatus(true))에 불러야 함 */
    announce: (p: Peer) => void ch.track(p),
    leave() {
      clearInterval(timer)
      void client.removeChannel(ch)
    },
  }
}
export type Room = NonNullable<ReturnType<typeof joinRoom>>

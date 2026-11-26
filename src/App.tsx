import { useEffect, useRef, useState, type FormEvent, type PointerEvent, type ReactNode } from 'react'
import { BRAND, TAGLINE, TRACKS, VERSES } from './data'
import { CHAT_MAX, NAME_MAX, cleanName, db, joinRoom, signIn, type Room } from './net'
import { createScene, type ChapelScene, type SceneState } from './scene'

type Prayer = { id: number; name: string; text: string; at: number }
type PrayerView = Prayer & { mine: boolean; amens: number; amened: boolean }
type Saved = {
  candles: number
  lastCandle: string
  prayers: Prayer[]
  snow: boolean
  projector: boolean
  highQuality: boolean
  reduceMotion: boolean
  volume: number
  name: string
  hue: number
}
const DEFAULTS: Saved = {
  candles: 0,
  lastCandle: '',
  prayers: [],
  snow: true,
  projector: true,
  highQuality: true,
  reduceMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
  volume: 0.4,
  name: '',
  hue: Math.floor(Math.random() * 360), // 내 외투 색. 처음 한 번 정해져 저장됨
}
const STORE_KEY = 'chapel:v1'
const PRAYER_MAX = 400
const today = () => new Date().toLocaleDateString('sv') // YYYY-MM-DD (현지 날짜)
const kstToday = () => new Date().toLocaleDateString('sv', { timeZone: 'Asia/Seoul' }) // DB의 촛불 날짜 기준과 같게
const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`

function loadSaved(): Saved {
  try {
    const s = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') }
    return { ...s, prayers: Array.isArray(s.prayers) ? s.prayers : [], candles: Number(s.candles) || 0 }
  } catch {
    return DEFAULTS
  }
}

let audioCtx: AudioContext | undefined
function bell(volume: number) {
  try {
    audioCtx ??= new AudioContext()
    const t = audioCtx.currentTime
    // 기음 + 비정수 배음을 서로 다른 속도로 감쇠시켜 종소리를 흉내
    for (const [mult, gain, dur] of [[1, 0.5, 4], [2, 0.3, 3], [2.76, 0.2, 2.2], [4.07, 0.12, 1.4], [5.4, 0.06, 0.9]]) {
      const osc = audioCtx.createOscillator(), g = audioCtx.createGain()
      osc.frequency.value = 330 * mult
      g.gain.setValueAtTime(Math.max(gain * volume, 0.0002), t)
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
      osc.connect(g).connect(audioCtx.destination)
      osc.start(t)
      osc.stop(t + dur)
    }
  } catch {
    /* 소리를 낼 수 없는 환경에서는 조용히 넘어감 */
  }
}

function Modal(p: { open: boolean; onClose: () => void; title: string; sub?: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current!
    if (p.open && !d.open) d.showModal()
    if (!p.open && d.open) d.close()
  }, [p.open])
  return (
    <dialog ref={ref} className="modal" aria-label={p.title} onClose={p.onClose} onClick={e => e.target === ref.current && p.onClose()}>
      <div className="modal-inner">
        <button className="icon close" onClick={p.onClose} aria-label="닫기">✕</button>
        <h2>{p.title}</h2>
        {p.sub && <p className="sub">{p.sub}</p>}
        {p.children}
      </div>
    </dialog>
  )
}

function Toggle(p: { label: string; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="row">
      <span>{p.label}</span>
      <input type="checkbox" role="switch" checked={p.on} onChange={e => p.onChange(e.target.checked)} />
    </label>
  )
}

function Joystick({ onMove }: { onMove: (x: number, y: number) => void }) {
  const [thumb, setThumb] = useState({ x: 0, y: 0 })
  const track = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    let x = ((e.clientX - r.left) / r.width) * 2 - 1, y = ((e.clientY - r.top) / r.height) * 2 - 1
    const len = Math.hypot(x, y)
    if (len > 1) (x /= len), (y /= len)
    setThumb({ x, y })
    onMove(x, -y)
  }
  const end = () => {
    setThumb({ x: 0, y: 0 })
    onMove(0, 0)
  }
  return (
    <div
      className="joystick"
      aria-hidden
      onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); track(e) }}
      onPointerMove={e => e.currentTarget.hasPointerCapture(e.pointerId) && track(e)}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <span style={{ transform: `translate(${thumb.x * 30}px, ${thumb.y * 30}px)` }} />
    </div>
  )
}

type ModalName = 'candle' | 'prayer' | 'meditate' | 'music' | 'settings' | 'about' | null

export default function App() {
  const host = useRef<HTMLDivElement>(null)
  const scene = useRef<ChapelScene | null>(null)
  const audio = useRef<HTMLAudioElement>(null)
  const [saved, setSaved] = useState(loadSaved)
  const patch = (p: Partial<Saved>) => setSaved(s => ({ ...s, ...p }))
  const [st, setSt] = useState<SceneState>({ inside: false, canSit: false, sitting: false })
  const [modal, setModal] = useState<ModalName>(null)
  const close = () => setModal(null)
  const [toast, setToast] = useState('')
  const [noGl, setNoGl] = useState(false)
  const [hud, setHud] = useState(true)
  const [verse, setVerse] = useState(0)
  const [autoVerse, setAutoVerse] = useState(true)
  const [track, setTrack] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [prayerTab, setPrayerTab] = useState<'write' | 'read'>('write')
  const [duration, setDuration] = useState(180)
  const [endAt, setEndAt] = useState<number | null>(null)
  const [now, setNow] = useState(Date.now)
  const left = endAt ? Math.max(0, Math.ceil((endAt - now) / 1000)) : duration
  // 함께하기(실시간). uid가 없으면 기도·촛불은 이 기기에만 저장된다.
  const room = useRef<Room | null>(null)
  const volume = useRef(saved.volume)
  const [uid, setUid] = useState<string | null>(null)
  const [online, setOnline] = useState(false)
  const [peerCount, setPeerCount] = useState(0)
  const [chatOpen, setChatOpen] = useState(false)
  const [chatLog, setChatLog] = useState<{ id: number; who: string; text: string }[]>([])
  const [shared, setShared] = useState<PrayerView[]>([])
  const [candleTotal, setCandleTotal] = useState(0)
  const [litOnline, setLitOnline] = useState(false)
  const [tick, setTick] = useState(0) // 올리면 공유 기도·촛불을 다시 읽음
  const reload = () => setTick(t => t + 1)
  const myName = cleanName(saved.name)
  const log = (who: string, text: string) => setChatLog(l => [...l.slice(-5), { id: Math.random(), who, text }])

  useEffect(() => {
    try {
      scene.current = createScene(host.current!, setSt)
    } catch {
      setNoGl(true) // WebGL 없는 환경: 3D만 빼고 나머지는 그대로 동작
      return
    }
    return () => {
      scene.current?.dispose()
      scene.current = null
    }
  }, [])
  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(saved))
    } catch {
      /* 저장이 막힌 환경(사생활 보호 모드 등)에서는 이번 방문 동안만 유지 */
    }
  }, [saved])
  useEffect(() => { scene.current?.setSnow(saved.snow) }, [saved.snow])
  useEffect(() => { scene.current?.setProjector(saved.projector) }, [saved.projector])
  useEffect(() => { scene.current?.setQuality(saved.highQuality) }, [saved.highQuality])
  useEffect(() => { scene.current?.setReduceMotion(saved.reduceMotion) }, [saved.reduceMotion])
  useEffect(() => {
    void signIn().then(setUid)
    const names = new Map<string, string>()
    const r = joinRoom(() => scene.current?.getPose() ?? { x: 0, z: 0, f: 0, s: -1, g: '' }, {
      onStatus: setOnline,
      onPeers(peers) {
        for (const id of [...names.keys()]) {
          if (peers.has(id)) continue
          scene.current?.setPeer(id, null)
          names.delete(id)
        }
        for (const [id, p] of peers) {
          scene.current?.setPeer(id, p)
          names.set(id, p.name)
        }
        setPeerCount(peers.size)
      },
      onPose: (id, pose) => scene.current?.movePeer(id, pose),
      onChat(id, text) {
        scene.current?.say(id, text)
        log(names.get(id) ?? '이웃', text)
      },
      onBell() {
        bell(volume.current)
        scene.current?.ringBell()
      },
      onRefresh: reload,
    })
    room.current = r
    return () => {
      r?.leave()
      room.current = null
    }
  }, [])
  useEffect(() => {
    scene.current?.setMe(myName, saved.hue)
    if (online) room.current?.announce({ name: myName, hue: saved.hue })
  }, [online, myName, saved.hue])
  useEffect(() => {
    if (!db || !uid) return
    const client = db
    let stale = false
    void (async () => {
      const [prayers, total, mine] = await Promise.all([
        // ponytail: 아멘 행을 통째로 받아 셈. 기도당 아멘이 수백 개가 되면 집계 뷰로 바꿀 것.
        client.from('prayers').select('id,user_id,name,body,created_at,prayer_amens(user_id)').order('created_at', { ascending: false }).limit(50),
        client.from('candles').select('*', { count: 'exact', head: true }),
        client.from('candles').select('day').eq('user_id', uid).eq('day', kstToday()),
      ])
      if (stale) return
      if (prayers.data)
        setShared(prayers.data.map(r => {
          const amens = r.prayer_amens as { user_id: string }[]
          return { id: r.id, name: r.name, text: r.body, at: Date.parse(r.created_at), mine: r.user_id === uid, amens: amens.length, amened: amens.some(a => a.user_id === uid) }
        }))
      if (total.count !== null) setCandleTotal(total.count)
      if (mine.data) setLitOnline(mine.data.length > 0)
    })()
    return () => {
      stale = true
    }
  }, [uid, tick])
  const candles = uid ? candleTotal : saved.candles
  useEffect(() => { scene.current?.setCandles(candles) }, [candles])
  useEffect(() => { scene.current?.setVerse(VERSES[verse].text, VERSES[verse].ref) }, [verse])
  useEffect(() => {
    if (!autoVerse) return
    const id = setInterval(() => setVerse(v => (v + 1) % VERSES.length), 25_000)
    return () => clearInterval(id)
  }, [autoVerse])
  useEffect(() => {
    if (!toast) return
    const id = setTimeout(() => setToast(''), 3500)
    return () => clearTimeout(id)
  }, [toast])

  // 음악
  useEffect(() => {
    volume.current = saved.volume
    if (audio.current) audio.current.volume = saved.volume
  }, [saved.volume])
  useEffect(() => {
    const a = audio.current!
    if (playing) a.play().catch(() => setPlaying(false))
    else a.pause()
  }, [playing, track])
  const step = (d: number) => setTrack(t => (t + d + TRACKS.length) % TRACKS.length)

  // 묵상: 종료 시각 기준으로 계산해 탭이 백그라운드여도 어긋나지 않음
  useEffect(() => {
    if (!endAt) return
    const id = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(id)
  }, [endAt])
  useEffect(() => {
    if (!endAt || now < endAt) return
    setEndAt(null)
    bell(saved.volume)
    scene.current?.ringBell()
    setToast('묵상 시간이 끝났어요. 평안이 함께하기를.')
  }, [endAt, now, saved.volume])

  const ring = () => {
    bell(saved.volume)
    scene.current?.ringBell()
    room.current?.bell()
  }
  const changed = () => {
    reload()
    room.current?.refresh() // 다른 방문자 화면도 다시 읽게 함
  }
  const lightCandle = async () => {
    if (db && uid) {
      const { error } = await db.from('candles').insert({})
      // 23505 = 오늘 이미 밝힘(DB의 하루 1회 제약). 그 외 오류만 실패로 알림.
      if (error && error.code !== '23505') return setToast('촛불을 밝히지 못했어요. 잠시 후 다시 해 주세요.')
      setLitOnline(true)
      changed()
    } else patch({ candles: saved.candles + 1, lastCandle: today() })
    setToast('작은 불빛 하나가 켜졌어요.')
  }
  const submitPrayer = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = e.currentTarget
    const f = new FormData(form)
    const text = String(f.get('text') ?? '').trim().slice(0, PRAYER_MAX)
    if (!text) return
    const name = String(f.get('name') ?? '').trim().slice(0, 20)
    if (db && uid) {
      const { error } = await db.from('prayers').insert({ name, body: text })
      if (error) return setToast('기도를 올리지 못했어요. 잠시 후 다시 해 주세요.')
      changed()
    } else patch({ prayers: [{ id: Date.now(), name, text, at: Date.now() }, ...saved.prayers] })
    form.reset()
    setPrayerTab('read')
    scene.current?.gesture('pray')
    setToast(uid ? '기도를 함께 나눴어요.' : '기도를 이 기기에 간직했어요.')
  }
  const amen = async (p: PrayerView) => {
    if (!db || !uid) return
    const q = db.from('prayer_amens')
    const { error } = p.amened ? await q.delete().eq('prayer_id', p.id).eq('user_id', uid) : await q.insert({ prayer_id: p.id })
    if (!error) changed()
  }
  const removePrayer = async (p: PrayerView) => {
    if (db && uid) {
      const { error } = await db.from('prayers').delete().eq('id', p.id)
      if (error) return setToast('지우지 못했어요.')
      changed()
    } else patch({ prayers: saved.prayers.filter(x => x.id !== p.id) })
  }
  const sendChat = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const input = e.currentTarget.elements.namedItem('msg') as HTMLInputElement
    const msg = input.value.replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX)
    if (!msg) return
    input.value = ''
    room.current?.chat(msg)
    scene.current?.say(null, msg)
    log(myName, msg)
  }
  const prayers: PrayerView[] = uid ? shared : saved.prayers.map(p => ({ ...p, mine: true, amens: 0, amened: false }))
  const photo = async () => {
    const blob = await scene.current?.snapshot()
    if (!blob) return setToast('사진을 저장하지 못했어요.')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `chapel-${today()}.png`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
    setToast('지금 풍경을 사진으로 저장했어요.')
  }
  const share = async () => {
    try {
      if (navigator.share) await navigator.share({ title: BRAND, url: location.href })
      else {
        await navigator.clipboard.writeText(location.href)
        setToast('주소를 복사했어요.')
      }
    } catch {
      /* 사용자가 공유를 취소함 */
    }
  }

  const litToday = uid ? litOnline : saved.lastCandle === today()
  const v = VERSES[verse]
  return (
    <main className={hud ? 'app' : 'app hud-off'}>
      <div className="scene" ref={host} aria-label="눈 내리는 밤의 예배당 3D 풍경" />
      {noGl && <p className="no-gl">이 브라우저에서는 3D 풍경을 그릴 수 없어요. 촛불·기도·묵상은 그대로 쓸 수 있어요.</p>}
      <audio ref={audio} src={TRACKS[track].src} onEnded={() => step(1)} />

      <header className="top">
        <div className="brand">
          <b>{BRAND}</b>
          <small>{TAGLINE}</small>
        </div>
        <div className="seg" role="group" aria-label="머무는 곳">
          <button className={st.inside ? '' : 'on'} onClick={() => scene.current?.goto('outside')}>바깥</button>
          <button className={st.inside ? 'on' : ''} onClick={() => scene.current?.goto('inside')}>예배당 안</button>
        </div>
        <div className="top-right">
          <span className={online ? 'badge on' : 'badge'} role="status">{online ? `함께 ${peerCount + 1}명` : '혼자 머무는 중'}</span>
          <button className="icon" onClick={() => setModal('settings')} aria-label="설정">⚙</button>
        </div>
      </header>
      <button className="icon hud-toggle" onClick={() => setHud(h => !h)} aria-label={hud ? '화면 버튼 숨기기' : '화면 버튼 보이기'}>
        {hud ? '◱' : '◰'}
      </button>

      <aside className="verse-bar" aria-label="스크린 말씀">
        <small>{v.ref}</small>
        <span className="sr-only">{v.text}</span>
        <button className="icon" onClick={() => setVerse((verse - 1 + VERSES.length) % VERSES.length)} aria-label="이전 말씀">‹</button>
        <button className={autoVerse ? 'chip on' : 'chip'} role="switch" aria-checked={autoVerse} onClick={() => setAutoVerse(a => !a)}>
          {autoVerse ? '자동' : '수동'}
        </button>
        <button className="icon" onClick={() => setVerse((verse + 1) % VERSES.length)} aria-label="다음 말씀">›</button>
      </aside>

      <div className="actions" role="group" aria-label="내 캐릭터 동작">
        {(st.canSit || st.sitting) && <button onClick={() => scene.current?.toggleSit()}>{st.sitting ? '일어서기' : '앉기'}</button>}
        <button onClick={() => scene.current?.gesture('pray')}>🙏 기도</button>
        <button onClick={() => scene.current?.gesture('wave')}>👋 인사</button>
      </div>
      <Joystick onMove={(x, y) => scene.current?.setMove(x, y)} />
      <p className="hint">W A S D · 방향키로 걷기 · 드래그로 둘러보기 · 휠로 거리 조절</p>

      <nav className="dock" aria-label="예배당 활동">
        <button onClick={() => setChatOpen(o => !o)} aria-expanded={chatOpen}><i>💬</i>대화</button>
        <button onClick={() => setModal('candle')}><i>🕯</i>촛불</button>
        <button onClick={() => setModal('prayer')}><i>✍</i>기도</button>
        <button onClick={() => setModal('meditate')}><i>⏳</i>{endAt ? mmss(left) : '묵상'}</button>
        <button onClick={() => setModal('music')}><i>{playing ? '♫' : '♪'}</i>음악</button>
        <button onClick={ring}><i>🔔</i>종</button>
        <button onClick={photo}><i>📷</i>사진</button>
      </nav>
      {chatOpen && (
        <section className="chat" aria-label="대화">
          <ul aria-live="polite">
            {chatLog.map(m => (
              <li key={m.id}><b>{m.who}</b> {m.text}</li>
            ))}
          </ul>
          <form onSubmit={sendChat}>
            <input name="msg" maxLength={CHAT_MAX} disabled={!online} autoComplete="off" autoFocus placeholder={online ? '따뜻한 한마디를 나눠요' : '연결되면 대화할 수 있어요'} />
            <button type="submit" disabled={!online}>보내기</button>
          </form>
        </section>
      )}
      <div className="toast" role="status">{toast}</div>

      <Modal open={modal === 'candle'} onClose={close} title="촛불 하나" sub="떠오르는 사람을 생각하며 조용히 불을 밝혀 보세요.">
        <div className={litToday ? 'candle lit' : 'candle'} aria-hidden><span /></div>
        <p className="center">{uid ? '모두 함께' : '지금까지'} <b>{candles}</b>개의 촛불을 밝혔어요.</p>
        <button className="primary" disabled={litToday} onClick={lightCandle}>{litToday ? '오늘의 촛불을 밝혔어요' : '촛불 밝히기'}</button>
        <p className="fine">하루에 하나씩. 밝힌 촛불은 강단 앞 촛대에 놓여요.</p>
      </Modal>

      <Modal open={modal === 'prayer'} onClose={close} title="기도" sub="마음에 있는 것을 천천히 적어 보세요.">
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={prayerTab === 'write'} onClick={() => setPrayerTab('write')}>적기</button>
          <button role="tab" aria-selected={prayerTab === 'read'} onClick={() => setPrayerTab('read')}>{uid ? '함께 읽기' : '간직한 기도'} {prayers.length}</button>
        </div>
        {prayerTab === 'write' ? (
          <form onSubmit={submitPrayer}>
            <label>이름 <small>(선택)</small><input name="name" maxLength={20} placeholder="비워 두어도 괜찮아요" autoComplete="off" /></label>
            <label>오늘의 기도<textarea name="text" required maxLength={PRAYER_MAX} rows={6} placeholder="이 밤, 드리고 싶은 기도를 적어 주세요." /></label>
            <p className="fine">{uid ? '올린 기도는 방문한 모두가 읽을 수 있어요.' : '지금은 이 기기에만 저장돼요.'} 연락처 같은 개인정보는 적지 마세요. (최대 {PRAYER_MAX}자)</p>
            <button className="primary" type="submit">{uid ? '기도 올리기' : '기도 간직하기'}</button>
          </form>
        ) : prayers.length ? (
          <ul className="prayers">
            {prayers.map(p => (
              <li key={p.id}>
                <p>{p.text}</p>
                <small>{p.name || '이름 없이'} · {new Date(p.at).toLocaleDateString('ko')}</small>
                {uid && <button className={p.amened ? 'chip on' : 'chip'} aria-pressed={p.amened} onClick={() => amen(p)}>아멘 {p.amens}</button>}
                {p.mine && <button className="link" onClick={() => removePrayer(p)}>지우기</button>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="center fine">아직 기도가 없어요.</p>
        )}
      </Modal>

      <Modal open={modal === 'meditate'} onClose={close} title="잠시 묵상" sub="아무것도 하지 않아도 괜찮은 시간이에요.">
        <time className="clock" aria-label={`남은 시간 ${Math.floor(left / 60)}분 ${left % 60}초`}>{mmss(left)}</time>
        <div className="seg" role="group" aria-label="묵상 시간">
          {[60, 180, 300].map(d => (
            <button key={d} className={d === duration ? 'on' : ''} disabled={!!endAt} onClick={() => setDuration(d)}>{d / 60}분</button>
          ))}
        </div>
        <button className="primary" onClick={() => { setNow(Date.now()); setEndAt(endAt ? null : Date.now() + duration * 1000) }}>
          {endAt ? '그만하기' : '묵상 시작'}
        </button>
        <p className="fine">창을 닫아도 시간은 계속 흘러요. 끝나면 종이 울려요.</p>
      </Modal>

      <Modal open={modal === 'music'} onClose={close} title="음악" sub="곡을 누르면 바로 들을 수 있어요.">
        <ul className="tracks">
          {TRACKS.map((t, i) => (
            <li key={t.src}>
              <button className={i === track ? 'on' : ''} onClick={() => { setTrack(i); setPlaying(true) }}>
                <b>{t.title}</b>
                <small>{t.artist} · {t.license}</small>
              </button>
            </li>
          ))}
        </ul>
        <div className="transport">
          <button className="icon" onClick={() => step(-1)} aria-label="이전 곡">⏮</button>
          <button className="primary" onClick={() => setPlaying(p => !p)}>{playing ? '일시정지' : '재생'}</button>
          <button className="icon" onClick={() => step(1)} aria-label="다음 곡">⏭</button>
        </div>
      </Modal>

      <Modal open={modal === 'settings'} onClose={close} title="설정">
        <label className="row">
          <span>이름</span>
          <input defaultValue={saved.name} maxLength={NAME_MAX} placeholder="이웃" autoComplete="off" onBlur={e => patch({ name: cleanName(e.target.value) })} />
        </label>
        <Toggle label="내리는 눈" on={saved.snow} onChange={snow => patch({ snow })} />
        <Toggle label="말씀 스크린" on={saved.projector} onChange={projector => patch({ projector })} />
        <Toggle label="움직임 줄이기" on={saved.reduceMotion} onChange={reduceMotion => patch({ reduceMotion })} />
        <Toggle label="섬세한 화질" on={saved.highQuality} onChange={highQuality => patch({ highQuality })} />
        <label className="row">
          <span>소리 크기 {Math.round(saved.volume * 100)}%</span>
          <input type="range" min={0} max={1} step={0.05} value={saved.volume} onChange={e => patch({ volume: Number(e.target.value) })} />
        </label>
        <button className="link" onClick={share}>이 공간 공유하기</button>
        <button className="link" onClick={() => setModal('about')}>이 공간에 대하여 · 출처</button>
      </Modal>

      <Modal open={modal === 'about'} onClose={close} title={BRAND} sub={TAGLINE}>
        <p>눈 내리는 밤, 작은 예배당을 거닐며 촛불을 밝히고 기도를 적고 잠시 쉬어 가는 공간입니다.</p>
        <h3>사용한 작품</h3>
        <ul className="credits">
          {TRACKS.map(t => (
            <li key={t.src}>“{t.original}” {t.artist} (incompetech.com) · Licensed under Creative Commons: By Attribution 4.0 License</li>
          ))}
          <li>성경 본문: 성경전서 개역한글판(1961)</li>
        </ul>
      </Modal>
    </main>
  )
}

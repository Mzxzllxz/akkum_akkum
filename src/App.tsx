import { useEffect, useRef, useState, type FormEvent, type PointerEvent, type ReactNode } from 'react'
import { BRAND, TAGLINE, TRACKS, VERSES } from './data'
import { createScene, type ChapelScene, type SceneState } from './scene'

type Prayer = { id: number; name: string; text: string; at: number }
type Saved = {
  candles: number
  lastCandle: string
  prayers: Prayer[]
  snow: boolean
  projector: boolean
  highQuality: boolean
  reduceMotion: boolean
  volume: number
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
}
const STORE_KEY = 'chapel:v1'
const PRAYER_MAX = 400
const today = () => new Date().toLocaleDateString('sv') // YYYY-MM-DD (현지 날짜)
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
  useEffect(() => { scene.current?.setCandles(saved.candles) }, [saved.candles])
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
  useEffect(() => { if (audio.current) audio.current.volume = saved.volume }, [saved.volume])
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
  }
  const lightCandle = () => {
    patch({ candles: saved.candles + 1, lastCandle: today() })
    setToast('작은 불빛 하나가 켜졌어요.')
  }
  const submitPrayer = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    const text = String(f.get('text') ?? '').trim().slice(0, PRAYER_MAX)
    if (!text) return
    const name = String(f.get('name') ?? '').trim().slice(0, 20)
    patch({ prayers: [{ id: Date.now(), name, text, at: Date.now() }, ...saved.prayers] })
    e.currentTarget.reset()
    setPrayerTab('read')
    scene.current?.gesture('pray')
    setToast('기도를 이 기기에 간직했어요.')
  }
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

  const litToday = saved.lastCandle === today()
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
          <span className="badge" title="실시간 연결은 준비 중이에요">혼자 머무는 중</span>
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
        <button onClick={() => setModal('candle')}><i>🕯</i>촛불</button>
        <button onClick={() => setModal('prayer')}><i>✍</i>기도</button>
        <button onClick={() => setModal('meditate')}><i>⏳</i>{endAt ? mmss(left) : '묵상'}</button>
        <button onClick={() => setModal('music')}><i>{playing ? '♫' : '♪'}</i>음악</button>
        <button onClick={ring}><i>🔔</i>종</button>
        <button onClick={photo}><i>📷</i>사진</button>
      </nav>
      <div className="toast" role="status">{toast}</div>

      <Modal open={modal === 'candle'} onClose={close} title="촛불 하나" sub="떠오르는 사람을 생각하며 조용히 불을 밝혀 보세요.">
        <div className={litToday ? 'candle lit' : 'candle'} aria-hidden><span /></div>
        <p className="center">지금까지 <b>{saved.candles}</b>개의 촛불을 밝혔어요.</p>
        <button className="primary" disabled={litToday} onClick={lightCandle}>{litToday ? '오늘의 촛불을 밝혔어요' : '촛불 밝히기'}</button>
        <p className="fine">하루에 하나씩. 밝힌 촛불은 강단 앞 촛대에 놓여요.</p>
      </Modal>

      <Modal open={modal === 'prayer'} onClose={close} title="기도" sub="마음에 있는 것을 천천히 적어 보세요.">
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={prayerTab === 'write'} onClick={() => setPrayerTab('write')}>적기</button>
          <button role="tab" aria-selected={prayerTab === 'read'} onClick={() => setPrayerTab('read')}>간직한 기도 {saved.prayers.length}</button>
        </div>
        {prayerTab === 'write' ? (
          <form onSubmit={submitPrayer}>
            <label>이름 <small>(선택)</small><input name="name" maxLength={20} placeholder="비워 두어도 괜찮아요" autoComplete="off" /></label>
            <label>오늘의 기도<textarea name="text" required maxLength={PRAYER_MAX} rows={6} placeholder="이 밤, 드리고 싶은 기도를 적어 주세요." /></label>
            <p className="fine">지금은 이 기기에만 저장돼요. 연락처 같은 개인정보는 적지 마세요. (최대 {PRAYER_MAX}자)</p>
            <button className="primary" type="submit">기도 간직하기</button>
          </form>
        ) : saved.prayers.length ? (
          <ul className="prayers">
            {saved.prayers.map(p => (
              <li key={p.id}>
                <p>{p.text}</p>
                <small>{p.name || '이름 없이'} · {new Date(p.at).toLocaleDateString('ko')}</small>
                <button className="link" onClick={() => patch({ prayers: saved.prayers.filter(x => x.id !== p.id) })}>지우기</button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="center fine">아직 간직한 기도가 없어요.</p>
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

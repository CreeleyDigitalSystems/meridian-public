import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { FOUNDING_TERRAIN_VERSION, generateWorld } from '@meridian/procedural-world';
import { idle } from '@meridian/mobile-controls';
import { cityHomeView, createWalkInput, walkCommandForKey, type CityView, type CityLight, type HomeViewUnavailableReason, type ObserverNote, type WalkCommand } from '@meridian/visual-world';
import { PublicHistorySchema, type PublicEvent } from '@meridian/world-schema/public-world';
import { choiceOriginLabel, groupPublicChanges, publicChangeText } from '../world/public-history.js';
import { label, residentKey, placeKey } from '../world/public-world.js';
import { useWorld } from '../world/use-world.js';
import { LiveActivity } from './live-activity.js';
import { WatchingNow } from './watching-now.js';
import { WorldCanvas } from './world-canvas.js';
import { WorldStatus } from './world-status.js';
import '../city.css';
const destinations: {
  id: CityView;
  label: string;
  name: string;
  note: string;
}[] = [{
  id: 'arrival',
  label: 'Arrival',
  name: 'The Founding District',
  note: 'Working neighbourhoods beside the white-and-gold civic terraces.'
}, {
  id: 'gardens',
  label: 'Gardens',
  name: 'The Prismatic Gardens',
  note: 'A planted courtyard at the heart of the neighbourhood.'
}, {
  id: 'canal',
  label: 'Workshops',
  name: 'The Riverside Workshops',
  note: 'Terracotta roofs and open workshops along the quays.'
}, {
  id: 'observatory',
  label: 'Upper',
  name: 'Upper Meridian',
  note: 'Civic terraces, banners and the clock spire.'
}];
/** Why a home cannot be opened, said plainly (never by substituting another house). */
const homeUnavailable: Record<HomeViewUnavailableReason, string> = {
  'no-anchor': 'no admitted home location',
  'not-residential': 'this place is not a home',
  'no-geometry': 'no matching building in the city plan',
  'no-entrance': 'no street entrance',
  'frontier-not-built': 'this frontier home is not built'
};
/** The viewer's own walk: what happened, in plain words. It never moves a resident or changes the world. */
const walkNotes: Record<ObserverNote, string> = {
  'start-door': "Walking from this home's doorstep.",
  'start-view': 'Walking from the street in view.',
  'start-nearest-street': 'Placed on the nearest street (not walked there).',
  travel: "Walking along the streets to this home's door.",
  arrived: 'Arrived.',
  'jump-across-water': "No walk across the water: moved to this home's doorstep on its own parcel.",
  'jump-no-route': "No walking route from here: moved to this home's doorstep.",
  'left-home': 'Home view closed: placed outside its door.',
  'returned-to-city': 'Home view closed: placed on the nearest city street (no walk across the water).'
};
const walkPad: {
  command: WalkCommand;
  label: string;
  glyph: string;
}[] = [{
  command: 'forward',
  label: 'Walk forward',
  glyph: '↑'
}, {
  command: 'left',
  label: 'Turn left',
  glyph: '↺'
}, {
  command: 'back',
  label: 'Walk back',
  glyph: '↓'
}, {
  command: 'right',
  label: 'Turn right',
  glyph: '↻'
}];
export function CityExperience() {
  const {
    projection,
    connection
  } = useWorld();
  const [presentation, setPresentation] = useState<'map' | '3d'>(() => typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('view') === 'map' ? 'map' : '3d');
  const [activityOpen, setActivityOpen] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const update = () => setFullscreen(document.fullscreenElement !== null);
    document.addEventListener('fullscreenchange', update);
    return () => document.removeEventListener('fullscreenchange', update);
  }, []);
  const mapPresentation = presentation === 'map';
  const [view, setView] = useState<CityView>('arrival'),
    [light, setLight] = useState<CityLight>('day'),
    [autoOrbit, setOrbit] = useState(false),
    [reset, setReset] = useState(0),
    [panel, setPanel] = useState(false),
    [selectedId, setSelected] = useState<string | null>(null),
    [placeId, setPlace] = useState<string | null>(null),
    [home, setHome] = useState<string | null>(null),
    [search, setSearch] = useState(''),
    [section, setSection] = useState<'residents' | 'ventures' | 'chart' | 'history'>('residents'),
    [reduced, setReduced] = useState(() => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches),
    [history, setHistory] = useState<PublicEvent[]>([]),
    [historyState, setHistoryState] = useState(''),
    [walking, setWalking] = useState(false),
    [walkNote, setWalkNote] = useState<ObserverNote | null>(null);
  const walkInput = useRef(createWalkInput());
  const onObserverNote = useCallback((note: ObserverNote) => setWalkNote(note), []);
  const stopWalking = () => {
    setWalking(false);
    setWalkNote(null);
    walkInput.current = createWalkInput();
  };
  const indexButton = useRef<HTMLButtonElement>(null),
    searchInput = useRef<HTMLInputElement>(null),
    selectedHeading = useRef<HTMLHeadingElement>(null),
    lastInspected = useRef<string | null>(null);
  const latestProjection = useRef(projection);
  latestProjection.current = projection;
  const residentButtons = useRef(new Map<string, HTMLButtonElement>());
  const [trail, setTrail] = useState<string[]>([]),
    [historyRefresh, setHistoryRefresh] = useState(0);
  const world = useMemo(() => generateWorld({
    version: FOUNDING_TERRAIN_VERSION,
    seed: projection?.seed ?? 'public-architectural-preview',
    width: 32,
    height: 32
  }), [projection?.seed]);
  const intent = useMemo(() => idle({
    reducedMotion: reduced
  }).intent, [reduced]);
  const selected = projection?.residents.find(r => r.id === selectedId),
    luna = projection?.residents.find(r => r.visual.persona === 'luna');
  const placeName = (id: string) => projection?.places.find(p => p.id === id)?.name ?? 'Location unavailable';
  const residentName = (id: number) => projection?.residents.find(r => r.ref === id)?.name ?? 'Resident unavailable';
  /** Opens the admitted home anchor's own building or founded parcel; anything else says why it cannot. */
  const homeControls = (anchor: string | undefined, explainUnavailable: boolean) => {
    const view = cityHomeView(anchor, projection?.frontier ?? []);
    if (view.status !== 'available' || !anchor) return explainUnavailable && view.status === 'unavailable' ? <p>Home view unavailable: {homeUnavailable[view.reason]}</p> : null;
    const opened = home === anchor;
    return <>
      <button onClick={() => {
          setHome(opened ? null : anchor);
          setOrbit(false);
          setReset(n => n + 1);
        }}>
        {opened ? mapPresentation ? 'Hide home occupants' : 'Close home view' : mapPresentation ? 'See home occupants' : 'View home'}
      </button>
      {opened && <p>At home: {projection?.residents.filter(r => r.visual.placeId === anchor).map(r => r.name).join(', ') || 'No residents'}</p>}
      {opened && !mapPresentation && <p>The room and its furnishings are a visual interpretation, not recorded objects.</p>}
    </>;
  };
  const placeAnchor = projection?.places.find(p => p.id === placeId)?.anchor;
  const select = (id: string) => {
    lastInspected.current = id;
    setTrail([]);
    setSelected(id);
    setPlace(null);
    setHome(null);
    setSection('residents');
    setPanel(true);
  };
  const allResidents = () => {
    lastInspected.current = null;
    setSelected(null);
    setTrail([]);
    setHome(null);
    setPlace(null);
    setSection('residents');
    setSearch('');
    searchInput.current?.focus();
  };
  const closePanel = () => {
    setPanel(false);
    indexButton.current?.focus();
  };
  const followRelated = (id: string) => {
    if (!selectedId || !projection?.residents.some(r => r.id === id)) return;
    setTrail(t => [...t, selectedId]);
    lastInspected.current = id;
    setSelected(id);
    setHome(null);
  };
  const back = () => {
    const id = trail.at(-1);
    if (id && projection?.residents.some(r => r.id === id)) {
      setTrail(t => t.slice(0, -1));
      setSelected(id);
      setHome(null);
    }
  };
  useEffect(() => {
    if (!panel || section !== 'residents') return;
    if (selectedId) selectedHeading.current?.focus();else (lastInspected.current ? residentButtons.current.get(lastInspected.current) ?? searchInput.current : searchInput.current)?.focus();
  }, [selectedId, panel, section, placeId]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && panel) {
        setPanel(false);
        setHome(null);
        indexButton.current?.focus();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [panel]);
  useEffect(() => {
    setSelected(null);
    setTrail([]);
    setPlace(null);
    setHome(null);
    setHistory([]);
  }, [projection?.streamId]);
  useEffect(() => {
    if (mapPresentation) stopWalking();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapPresentation]);
  useEffect(() => {
    // The viewer's walk keys: arrows and WASD, never while typing; one step per press under reduced motion.
    if (!walking || mapPresentation) return;
    const input = walkInput.current;
    const typing = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
    // A key pressed inside a side panel (the World index or a drawer) is the panel's own: arrows scroll it.
    const inPanel = (target: EventTarget | null) => target instanceof Element && target.closest('.city-residents, .live-activity') !== null;
    const down = (e: KeyboardEvent) => {
      const command = walkCommandForKey(e.key);
      if (!command || e.altKey || e.ctrlKey || e.metaKey || typing(e.target) || inPanel(e.target)) return;
      e.preventDefault();
      if (reduced) {
        if (!e.repeat) input.steps.push(command);
      } else input.held[command] = true;
    };
    const up = (e: KeyboardEvent) => {
      const command = walkCommandForKey(e.key);
      if (command) input.held[command] = false;
    };
    const release = () => {
      input.held = { forward: false, back: false, left: false, right: false };
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', release);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', release);
      release();
    };
  }, [walking, reduced, mapPresentation]);
  useEffect(() => {
    if (selectedId && !selected) {
      setSelected(null);
      setHome(null);
    }
  }, [selectedId, selected]);
  useEffect(() => {
    if (section !== 'history' || !panel || !projection) return;
    let active = true;
    setHistory([]);
    setHistoryState('Loading saved-world changes');
    void fetch('/world', {
      headers: {
        accept: 'application/vnd.meridian.city-ledger+json',
        'x-meridian-history-limit': '20'
      },
      cache: 'no-store'
    }).then(async response => {
      if (!response.ok) throw Error();
      const page = PublicHistorySchema.parse(await response.json());
      if (page.streamId !== projection.streamId) throw Error();
      // History reads the service's current head, independently of the opening snapshot.
      // Give the verified SSE projection a bounded chance to catch that same-stream head.
      for (let wait = 0; active && wait < 100; wait++) {
        const current = latestProjection.current;
        if (!current || current.streamId !== page.streamId) return;
        if (current.cursor >= page.asOfCursor) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const current = latestProjection.current;
      if (!active || !current || current.streamId !== page.streamId) return;
      if (current.cursor < page.asOfCursor) throw Error();
      if (active) {
        setHistory(page.events);
        setHistoryState('Changes since the public baseline');
      }
    }).catch(() => {
      if (active && latestProjection.current?.streamId === projection.streamId) setHistoryState('Saved-world changes unavailable');
    });
    return () => {
      active = false;
    };
  }, [section, panel, projection?.streamId, historyRefresh]);
  const filteredResidents = (projection?.residents ?? []).filter(r => (!placeId || r.placeId === placeId) && `${r.name} ${r.occupation} ${label(r.task?.kind ?? 'unavailable')} ${placeName(r.placeId)} ${r.task?.partner ? residentName(r.task.partner.id) : ''}`.toLowerCase().includes(search.toLowerCase()));
  const current = destinations.find(d => d.id === view)!;
  const minute = projection?.minute,
    clock = minute === undefined ? '— : —' : `${String(Math.floor(minute / 60) % 24).padStart(2, '0')} : ${String(minute % 60).padStart(2, '0')}`;
  const open = (next: typeof section) => {
    setSection(next);
    setSelected(null);
    setPlace(null);
    setPanel(true);
  };
  return <main className={`meridian-experience ${light}${mapPresentation ? " map-view" : ""}${activityOpen ? ' with-activity' : ''}`} id="city">
  {!mapPresentation && <div className="world-vignette" aria-hidden="true" />}
  <header className="city-header">
    <a className="city-wordmark" href="#city" onClick={() => {
        stopWalking();
        setPanel(false);
        setSelected(null);
        setHome(null);
        setView('arrival');
        setReset(n => n + 1);
      }}>
      <span className="meridian-seal">M</span>
      <span>MERIDIAN<small>A LIVING WORLD</small></span>
    </a>
    <div className="city-time">
      <span>World time<strong>
          {clock}
        </strong></span>
    </div>
    <WatchingNow />
    <button ref={indexButton} className="world-index-button" aria-controls="city-residents" aria-expanded={panel} onClick={() => open('residents')}>World index ↗</button>
    {!activityOpen && <button className="world-index-button" onClick={() => setActivityOpen(true)}>Show activity</button>}
    {typeof document.documentElement.requestFullscreen === 'function' && <button className="world-index-button" onClick={() => {
      setActivityOpen(false);
      void (document.fullscreenElement ? document.exitFullscreen() : document.getElementById('city')!.requestFullscreen()).catch(() => {});
    }}>{fullscreen ? 'Exit fullscreen' : 'Fullscreen'}</button>}
  </header>
  {!mapPresentation && <aside className="city-tools" aria-label="World controls">
    {luna && <button onClick={() => select(luna.id)}>◉<small>Follow Luna</small></button>}
    <button onClick={() => setLight(l => l === 'day' ? 'blue-hour' : 'day')}>◐<small>
        {light === 'day' ? 'Blue hour' : 'Daylight'}
      </small></button>
    <button disabled={reduced} aria-pressed={autoOrbit} onClick={() => setOrbit(!autoOrbit)}>◎<small>
        {autoOrbit ? 'Pause orbit' : 'Auto orbit'}
      </small></button>
    <button onClick={() => {
        stopWalking();
        setReset(n => n + 1);
      }}>↺<small>Reset view</small></button>
    <button aria-pressed={walking} onClick={() => {
        if (walking) stopWalking();else {
          setOrbit(false);
          setWalking(true);
        }
      }}>⇡<small>
        {walking ? 'Stop walking' : 'Walk'}
      </small></button>
  </aside>}
  {!mapPresentation && walking && <section className="city-walk" aria-label="Walk controls">
    <p role="status">{walkNote ? walkNotes[walkNote] : 'Walking.'}</p>
    <div className="city-walk-pad">
      {walkPad.map(({
          command,
          label: name,
          glyph
        }) => <button key={command} aria-label={name} onContextMenu={e => e.preventDefault()} onPointerDown={e => {
          if (reduced) walkInput.current.steps.push(command);else {
            walkInput.current.held[command] = true;
            e.currentTarget.setPointerCapture?.(e.pointerId);
          }
        }} onPointerUp={() => {
          walkInput.current.held[command] = false;
        }} onPointerCancel={() => {
          walkInput.current.held[command] = false;
        }} onLostPointerCapture={() => {
          walkInput.current.held[command] = false;
        }} onClick={e => {
          // Keyboard activation (Enter or Space on the button) is one step.
          if (e.detail === 0) walkInput.current.steps.push(command);
        }}>{glyph}</button>)}
    </div>
    <p>Arrow keys or WASD also walk. Your view only: residents and the saved world are unchanged.</p>
  </section>}
  {!mapPresentation && !walking && <section className="city-introduction">
    <p className="city-eyebrow">MERIDIAN / CHAPTER 01</p>
    <h1>
      {selected?.name ?? current.name}
    </h1>
    <p>
      {selected ? `${selected.task ? label(selected.task.kind) : 'Task unavailable'} · ${placeName(selected.placeId)}` : current.note}
    </p>
  </section>}
  {!mapPresentation && <div className="city-bottom">
    <button className="city-guide-button" onClick={() => open('chart')}>✧<span>YOUR WORLD GUIDE<small>Discover Meridian</small></span></button>
    <nav className="city-destinations" aria-label="Meridian districts">
      {destinations.map((d, i) => <button key={d.id} aria-pressed={view === d.id && !selected} onClick={() => {
          stopWalking();
          setSelected(null);
          setHome(null);
          setPanel(false);
          setView(d.id);
          setReset(n => n + 1);
        }}>
        <span>0{i + 1}</span>
        {d.label}
      </button>)}
    </nav>
    <div className="city-gesture-hint">DRAG TO ORBIT<span>SCROLL OR PINCH TO EXPLORE</span></div>
  </div>}
  <div className="city-footnote">
    <div>
      <WorldStatus connection={connection} />
      {!projection && <p>No verified public view available. Architectural preview; construction unavailable.</p>}
      <div className="city-ledger-controls">
        <button onClick={() => open('history')}>Recent public changes</button>
        <button onClick={() => open('ventures')}>City ventures</button>
        <button onClick={() => open('chart')}>City chart</button>
        
      </div>
    </div>
    {!mapPresentation && <button aria-pressed={reduced} onClick={() => {
        setReduced(!reduced);
        setOrbit(false);
      }}>
      {reduced ? 'Enable motion' : 'Reduce motion'}
    </button>}
  </div>
  <aside id="city-residents" className={`city-residents${selected ? ' observing details-expanded' : ''}`} hidden={!panel} aria-label="World index">
    <div className="city-panel-heading">
      <button onClick={allResidents}>← All residents</button>
      <button className="city-close" onClick={closePanel}>Close</button>
    </div>
    {selected ? <section className="resident-summary" aria-label="Resident inspection">
      <h2 ref={selectedHeading} tabIndex={-1}>
        {selected.name}
      </h2>
      {trail.length > 0 && <button onClick={back}>← Back to {projection?.residents.find(r => r.id === trail.at(-1))?.name ?? 'previous resident'}</button>}
      <p>
        {selected.lifeStage === 'child' ? 'Child' : selected.occupation}
      </p>
      <p>Current activity: {label(selected.activity)}</p>
      <p>Current task: {selected.task ? label(selected.task.kind) : 'Unavailable'}</p>
      {selected.task && <p>Choice origin: {choiceOriginLabel(selected.task.choiceOrigin)}</p>}
      <p>Location: <button onClick={() => {
            setPlace(selected.placeId);
            setSelected(null);
            setHome(null);
          }}>
          {placeName(selected.placeId)}
        </button></p>
      <p>Home: {placeName(selected.homeId)}</p>
      {homeControls(selected.visual.homePlaceId, true)}
      {selected.task?.partner && <button onClick={() => followRelated(residentKey(selected.task!.partner!.id))}>With {residentName(selected.task.partner.id)}</button>}
      {selected.vitals ? <>
        <h3>Needs and skills</h3>
        {Object.entries(selected.vitals).map(([key, value]) => <p key={key}>{label(key)}: {value}/100</p>)}
      </> : <p>Needs and skills unavailable</p>}
      <h3>Measured evidence</h3>
      {selected.measurements.length ? selected.measurements.map((r, i) => <p key={i}>{label(r.evidenceKind)} · {r.value}% at {placeName(placeKey(r.place.id))} · world minute {r.minute}</p>) : <p>No admitted readings since the public baseline</p>}
      <h3>Possessions and commitments</h3>
      {projection?.objects.filter(f => f.subjects[1].id === selected.ref).map(f => <p key={f.subjects[0].id}>Garden tools</p>)}
      {projection?.commitments.filter(f => f.subjects[1].id === selected.ref || f.subjects[2].id === selected.ref).map(f => <p key={f.subjects[0].id}>{label(f.values.status)} · {residentName(f.subjects[1].id)} / {residentName(f.subjects[2].id)} · expires minute {f.values.expiresMinute}</p>)}
    </section> : section === 'residents' ? <>
      <h2>
        {placeId ? placeName(placeId) : 'The lives of Meridian'}
      </h2>
      {placeId && homeControls(placeAnchor, false)}
      <div className="resident-search">
        <label htmlFor="resident-search">Find a resident</label>
        <input id="resident-search" ref={searchInput} type="search" aria-label="Find a resident" placeholder="Find a resident" value={search} onChange={e => setSearch(e.target.value)} />
      </div>
      <p className="resident-result-count" role="status">{filteredResidents.length} of {projection?.residents.length ?? 0} residents</p>
      <ul className="city-resident-list">
        {filteredResidents.map((r, index) => <li key={r.id}>
          <button ref={node => {
              if (node) residentButtons.current.set(r.id, node);else residentButtons.current.delete(r.id);
            }} onClick={() => select(r.id)}>
            <span aria-hidden="true">
              {String(index + 1).padStart(2, '0')}
            </span>
            <span>
              <strong>
                {r.name}
              </strong>
              <small>{r.task ? label(r.task.kind) : 'Task unavailable'} · {placeName(r.placeId)}</small>
            </span>
            <span className="inspect-label">Inspect {r.name}</span>
          </button>
        </li>)}
      </ul>
      {filteredResidents.length === 0 && <p className="resident-no-results">No residents match this search.</p>}
      <h3>Places</h3>
      {projection?.places.map(p => <p key={p.id}>
        <button onClick={() => setPlace(p.id)}>
          {p.name}
        </button>
      </p>)}
    </> : section === 'ventures' ? <>
      <h2>City ventures</h2>
      {!projection?.ventures.length && <p>No admitted ventures</p>}
      {projection?.ventures.map(f => <section key={f.subjects[0].id}>
        <h3>
          {label(f.values.labelKey)}
        </h3>
        <p>{label(f.values.status)} · {placeName(placeKey(f.subjects[1].id))}</p>
        {f.values.participants.map(p => <p key={p.resident.id}><button onClick={() => select(residentKey(p.resident.id))}>
            {residentName(p.resident.id)}
          </button> · {label(p.consent)}</p>)}
        {f.values.steps.map(s => <p key={s.ordinal}>{label(s.labelKey)} · {label(s.status)}{s.consumed.map(m => ` · ${m.quantity} ${m.material} consumed`).join('')}</p>)}
        {projection.materials.filter(m => m.subjects[0].id === f.subjects[0].id).map(m => <p key={m.minute}>Timber: {m.values.timber.reserved} reserved / {m.values.timber.consumed} consumed. Stone: {m.values.stone.reserved} reserved / {m.values.stone.consumed} consumed.</p>)}
        {f.values.outcome && <p>{label(f.values.outcome.reason)} at world minute {f.values.outcome.minute}</p>}
      </section>)}
    </> : section === 'chart' ? <>
      <h2>City chart</h2>
      <p>Lighting and camera gestures change your view. Commissioned transit and resident journeys come from admitted world records.</p>
      <h3>Construction</h3>
      <p>The site marker indicates the admitted stage; it is not a finished building.</p>
      {projection?.construction ? <p>{placeName(projection.construction.placeId)} · {label(projection.construction.stage)} · committed world minute {projection.construction.minute}</p> : <p>Construction unavailable</p>}
      <h3>Projects</h3>
      {projection?.projects.map(p => <p key={p.id}>{p.label} · {p.progress}% · {placeName(p.placeId)}</p>)}
      <h3>Frontier</h3>
      {projection?.frontier.map(p => <p key={p.id}>Ring {p.ring}, sector {p.slot + 1}: {label(p.state)}{p.buildKind && label(p.buildKind)}{p.progress !== undefined && ` · ${Math.round(p.progress * 100)}%`}</p>)}
      <h3>Place surveys</h3>
      {projection?.surveys.map(f => <p key={`${f.subjects[0].id}:${f.subjects[1].id}`}>{placeName(placeKey(f.subjects[0].id))} · {f.values.present} observed present at minute {f.values.surveyedMinute} · {residentName(f.subjects[1].id)}</p>)}
    </> : <>
      <h2>Recent public changes</h2>
      <button onClick={() => setHistoryRefresh(n => n + 1)}>Refresh changes</button>
      <p>
        {historyState}
      </p>
      {history.length>0&&<p>Work, choices and outcomes are shown first. Routine updates and removals can be expanded for each saved minute.</p>}
      {history.map(event => {
        const {highlights,routine}=groupPublicChanges(event.operations);
        return <section key={event.cursor} aria-label={`World minute ${event.minute} changes`}>
          <h3>World minute {event.minute}</h3>
          {highlights.length?highlights.map((op,i)=><p key={i}>{projection&&publicChangeText(op,projection)}</p>):<p>No highlighted work changes in this update.</p>}
          {routine.length>0&&<details>
            <summary>Routine updates and removals · {routine.length} {routine.length===1?'operation':'operations'}</summary>
            {routine.map((op,i)=><p key={i}>{projection&&publicChangeText(op,projection)}</p>)}
          </details>}
        </section>;
      })}
    </>}
  </aside>
  {activityOpen && <LiveActivity onInspect={select} onClose={() => setActivityOpen(false)} />}
  <div className="world-viewport">
    <WorldCanvas onPresentationModeChange={setPresentation} key={projection?.streamId ?? 'preview'} inspectedHomeId={home} world={world} projection={projection} cameraIntent={intent} selectedResidentId={selectedId} onSelectResident={select} cityView={view} light={light} autoOrbit={autoOrbit} cameraReset={reset} reducedMotionOverride={reduced} observerWalk={walking && !mapPresentation ? walkInput.current : null} onObserverNote={onObserverNote} immersive preferFallback={new URLSearchParams(window.location.search).get('view') === 'map'} />
  </div>
</main>;
}

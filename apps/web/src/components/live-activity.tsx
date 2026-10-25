import { useWorld } from '../world/use-world.js';
import { label, residentKey } from '../world/public-world.js';
import { choiceOriginLabel, publicChangeText } from '../world/public-history.js';

/** A view of admitted work, never an invented model/request lifecycle or a private journal. */
export function LiveActivity({ onInspect, onClose }: { onInspect(id: string): void; onClose(): void }) {
  const { projection, connection, facts, recentChanges } = useWorld();
  const tasks = [...(projection?.residents ?? [])].filter(r => r.task).sort((a,b) => Number(b.task?.choiceOrigin === 'world-only-model') - Number(a.task?.choiceOrigin === 'world-only-model') || a.ref - b.ref).slice(0, 8);
  const changes: { key: string; text: string }[] = [];
  if (projection) for (const event of [...recentChanges].reverse()) {
    for (const [index, operation] of event.operations.entries()) {
      changes.push({ key: `${event.cursor}:${index}`, text: publicChangeText(operation, projection) });
      if (changes.length >= 8) break;
    }
    if (changes.length >= 8) break;
  }
  const tools = facts.filter(f => f.code === 'object.ownership' || f.code === 'commitment.state').slice(0, 5);
  return <aside className="live-activity" aria-label="Live activity">
    <div className="activity-heading"><h2>Live activity</h2><button type="button" onClick={onClose}>City only</button></div>
    <p className="activity-intro">Follow resident tasks, tools and finished work.</p>
    {projection && connection !== 'live' && <p className="activity-status" role="status">Showing the last update while we reconnect.</p>}
    {!projection ? <p role="status">Connecting to Meridian…</p> : <>
      <h3>Recent changes</h3>
      {changes.length ? <ol className="activity-changes">{changes.map(change => <li key={change.key}>{change.text}</li>)}</ol> : <p>New changes appear as the city moves forward.</p>}
      <h3>{connection === 'live' ? 'Current tasks' : 'Last recorded tasks'}</h3>
      {tasks.length ? <ul className="activity-tasks">{tasks.map(resident => <li key={resident.id}>
        <button type="button" data-resident onClick={() => onInspect(resident.id)}><strong>{resident.name}</strong><span>{label(resident.task!.kind)}</span></button>
        <small>{choiceOriginLabel(resident.task!.choiceOrigin)}</small>
        <span>{projection.places.find(p => p.id === resident.placeId)?.name ?? 'Location unavailable'}</span>
        {resident.task!.progress !== undefined && <span>Recorded progress: {Math.round(resident.task!.progress)}%</span>}
        {resident.task!.blockerCode && <span>Blocked · further details unavailable</span>}
      </li>)}</ul> : <p>No current tasks yet.</p>}
      <h3>Tools and commitments</h3>
      {tools.length ? tools.map(fact => <p key={`${fact.code}:${fact.subjects[0].id}`}>{publicChangeText({ op: 'put', fact }, projection)} <button type="button" className="activity-link" onClick={() => onInspect(residentKey(fact.subjects[1].id))}>Inspect resident</button></p>) : <p>No tool or loan records yet.</p>}
    </>}
    <details className="activity-note"><summary>About this feed</summary><p>This feed shows resident tasks and recorded changes. AI decisions and town routines are labelled separately. Request details aren’t shown yet.</p></details>
  </aside>;
}

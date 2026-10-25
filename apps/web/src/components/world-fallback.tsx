import { constructionStageProfile, type ConstructionStage, type GeneratedWorldView, type ResidentVisualState } from '@meridian/visual-world';
import { createPlanLayout } from '../../../../packages/visual-world/src/city-plan.js';
import { residentCityPosition } from '../../../../packages/visual-world/src/city-layout.js';
export interface WorldFallbackProps {
  world: GeneratedWorldView;
  residents: readonly ResidentVisualState[];
  constructionStage: ConstructionStage;
  canonicalMinute: number;
  selectedResidentId?: string | null;
  onSelectResident?: ((id: string) => void) | undefined;
  residentNames?: Readonly<Record<string, string>> | undefined;
}
const plan = createPlanLayout();
/** Same reviewed plan and admitted place anchors as Three; no random fallback addresses. */
export function WorldFallback({
  residents,
  constructionStage,
  canonicalMinute,
  selectedResidentId = null,
  onSelectResident,
  residentNames
}: WorldFallbackProps) {
  const positions = residents.map(r => ({
    resident: r,
    position: residentCityPosition(r.placeId, r.id, plan)
  }));
  const extent = Math.max(44, ...positions.flatMap(p => [Math.abs(p.position[0]) + 4, Math.abs(p.position[2]) + 4]));
  const percent = (coordinate: number) => 50 + coordinate / extent * 46;
  return <section aria-label="Founding District low-motion map" style={{
    minHeight: '27rem',
    padding: '1rem',
    color: '#fffdf3',
    background: 'linear-gradient(155deg,#071832,#0d4858 72%,#0aa6a1)'
  }}>
  <header>
    <p className="eyebrow">Accessible district view</p>
    <h2>Founding District</h2>
    <p>World minute {canonicalMinute}. Same city plan and admitted locations as the interactive view.</p>
    <p>Construction status indicator: {constructionStage === 'unavailable' ? 'Unavailable' : constructionStage}.</p>
  </header>
  <div aria-hidden="true" style={{
      position: 'relative',
      height: '18rem',
      marginBlock: '1rem',
      overflow: 'hidden',
      border: '1px solid #fff8',
      borderRadius: '1.25rem',
      background: '#0c4056'
    }}>
    {plan.map((b, index) => <span key={b.placeId ?? index} style={{
        position: 'absolute',
        left: `${percent(b.x)}%`,
        top: `${percent(b.z)}%`,
        width: `${Math.max(.7, (b.rect ? b.rect[1] - b.rect[0] : b.radius * 2) / extent * 46)}%`,
        height: `${Math.max(.7, (b.rect ? b.rect[3] - b.rect[2] : b.radius * 2) / extent * 46)}%`,
        transform: 'translate(-50%,-50%)',
        border: '1px solid #f7d374',
        background: '#e6e0c5',
        borderRadius: '.1rem'
      }} />)}
    {constructionStage !== 'unavailable' && <span data-construction-stage={constructionStage} style={{
        position: 'absolute',
        left: `${percent(14)}%`,
        top: `${percent(-10)}%`,
        width: '.6rem',
        height: '.6rem',
        background: constructionStageProfile(constructionStage).color,
        border: '1px solid white'
      }} />}
    {positions.map(({
        resident: r,
        position: p
      }) => <span key={r.id} data-resident-id={r.id} data-place-id={r.placeId} data-plan-position={`${p[0]},${p[2]}`} style={{
        position: 'absolute',
        left: `${percent(p[0])}%`,
        top: `${percent(p[2])}%`,
        width: '.4rem',
        height: '.65rem',
        borderRadius: '99rem',
        background: r.id === selectedResidentId ? '#f7d374' : '#fff8e8',
        boxShadow: '0 0 .4rem #f7d374'
      }} />)}
  </div>
  <p id="resident-list-label" className="eyebrow">Residents available to inspect</p>
  <ul aria-labelledby="resident-list-label" style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(2,minmax(0,1fr))',
      gap: '.55rem',
      padding: 0,
      listStyle: 'none'
    }}>
    {residents.map((r, i) => <li key={r.id}>
      <button type="button" aria-pressed={r.id === selectedResidentId} onClick={() => onSelectResident?.(r.id)} style={{
          width: '100%',
          minHeight: '2.75rem',
          border: '1px solid #fff7',
          borderRadius: '.8rem',
          color: 'inherit',
          background: r.id === selectedResidentId ? '#c08d31' : '#07183299'
        }}>
        {residentNames?.[r.id] ?? `Resident ${i + 1}`}
      </button>
    </li>)}
  </ul>
</section>;
}

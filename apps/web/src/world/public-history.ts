import type { PublicFact, PublicOperation } from '@meridian/world-schema/public-world';
import { label, placeKey, type PublicCityView } from './public-world.js';
export function choiceOriginLabel(origin: 'engine' | 'world-only-model' | 'historical-unclassified'): string {
  return origin === 'engine' ? 'Town routine' : origin === 'world-only-model' ? 'AI decision' : 'Earlier choice · origin unclassified';
}
/** Presentation only: retain every admitted operation, with routine updates/removals available on disclosure. */
export function groupPublicChanges(operations: readonly PublicOperation[]): {highlights:PublicOperation[];routine:PublicOperation[]} {
  const highlights:PublicOperation[]=[],routine:PublicOperation[]=[];
  for(const operation of operations){
    const fact=operation.op==='put'?operation.fact:null;
    const background=!fact||['world.render','resident.presence','resident.vitals','resident.affordances','place.state'].includes(fact.code)
      ||fact.code==='resident.task'&&['rest','socialise','wait-tool'].includes(fact.values.kind)&&!fact.values.journey&&!fact.values.trip&&!fact.values.walk&&!fact.values.returnTrip;
    (background?routine:highlights).push(operation);
  }
  return {highlights,routine};
}
export function publicChangeText(operation: PublicOperation, view: PublicCityView): string {
  const resident = (id: number) => view.residents.find(r => r.ref === id)?.name ?? 'A resident';
  const place = (id: number) => view.places.find(p => p.id === placeKey(id))?.name ?? 'A place';
  const noun: Record<PublicFact['code'], string> = {
    'method.state': 'Resident method',
    'grant.state': 'Consented method sharing',
    'workpad.state':'Public workpad','agenda.state':'Resident investigation','consultation.state':'Consultation','design.state':'Assembly design','artifact.state':'Assembly aid','trial.state':'Measured trial','assembly-job.state':'Paid assembly work',
    'world.render': 'City presentation',
    'resident.identity': 'Resident entry',
    'resident.presence': 'Resident location',
    'resident.appearance': 'Resident appearance',
    'resident.task': 'Resident task',
    'resident.vitals': 'Needs and skills',
    'resident.measurements': 'Observed evidence',
    'resident.affordances': 'Available activities',
    'place.state': 'Place',
    'construction.state': 'Construction',
    'project.state': 'Project',
    'parcel.state': 'Frontier sector',
    'object.ownership': 'Tool ownership',
    'commitment.state': 'Tool loan',
    'venture.state': 'Venture',
    'venture.materials': 'Venture materials',
    'place.survey': 'Place survey',
    'transit.state': 'Meridian Central circuit'
  };
  if (operation.op === 'remove') return `${noun[operation.key.code]} is no longer available in the public view.`;
  const f = operation.fact;
  switch (f.code) {
    case 'method.state': {
      const state=f.values.state==='available'?'is available':f.values.state==='completed-origin-task'?'has a completed original task':'is unavailable';
      const authority=f.values.authority==='configured-provider'?'Model-authored code':'Provider test double';
      return `${resident(f.subjects[1].id)}: method version ${f.values.revision} ${state}. Test evidence ${f.values.passed?'passed':'not passing'} · ${authority}.`;
    }
    case 'grant.state': {
      const v=f.values;
      const lesson=v.lesson==='working'?' Lesson in progress.':v.lesson==='completed'?' Lesson completed.':v.lesson==='interrupted'?' Lesson interrupted.':'';
      const execution=v.executions?` Latest learner test ${v.latestPassed===true?'passed':v.latestPassed===false?'failed':'has no recorded verdict'}${v.latestExecutionAuthority?` · ${v.latestExecutionAuthority==='configured-runtime'?'Isolated runtime':'Executor test double'}`:''}.`:'';
      const reproduction=v.reproductionArtifact?' Reproduced aid recorded.':'';
      return `${resident(f.subjects[1].id)} and ${resident(f.subjects[2].id)}: method sharing ${v.status}.${lesson}${execution}${reproduction}${v.reproductionTrial?' Reproduction trial recorded.':''}`;
    }
    case 'workpad.state':
      return `Public workpad at ${place(f.subjects[1].id)}: space for ${f.values.capacity} assembly aids.`;
    case 'agenda.state':
      return `${resident(f.subjects[1].id)}: investigation stage ${label(f.values.stage)} · ${f.values.candidates.length} candidate ${f.values.candidates.length===1?'design':'designs'}.${f.values.selected?' A design is selected.':''}${f.values.blocked!=='none'?` Blocked: ${label(f.values.blocked)}.`:''}`;
    case 'consultation.state':
      return `${resident(f.subjects[1].id)} and ${resident(f.subjects[2].id)}: consultation ${f.values.status} · ${label(f.values.question)}.`;
    case 'design.state':
      return `${resident(f.subjects[1].id)}: assembly design ${f.values.status} · ${f.values.parts.length} parts · timber ${f.values.timber}, stone ${f.values.stone}.`;
    case 'artifact.state':
      return `${resident(f.subjects[2].id)} owns an assembly aid · condition ${f.values.condition}/100 · completed at world minute ${f.values.completedMinute}.`;
    case 'trial.state': {
      const v=f.values,status=v.outcome==='quality-rejected'?'rejected for quality':v.outcome;
      return `${resident(f.subjects[1].id)}: ${v.mode==='baseline'?'unassisted':'assisted'} ${v.purpose==='production'?'production':'trial'} ${status} · quality ${v.quality}/100 · ${v.duration} ${v.duration===1?'minute':'minutes'} · timber ${v.timber}, stone ${v.stone} consumed.${v.claimVerdict!=='none'?` Method claim ${v.claimVerdict}.`:''}${v.useful?' Useful result recorded.':''}`;
    }
    case 'assembly-job.state':
      return `${resident(f.subjects[1].id)}: ${f.values.purpose==='production'?'production work':'trial work'} for ${label(f.values.operation)} · ${f.values.status}.`;
    case 'world.render':
      return 'City presentation updated.';
    case 'resident.identity':
      return `${resident(f.subjects[0].id)} has an updated public entry.`;
    case 'resident.presence':
      return `${resident(f.subjects[0].id)} is at ${place(f.subjects[1].id)} · ${label(f.values.activity)}.`;
    case 'resident.appearance':
      return `${resident(f.subjects[0].id)} changed appearance.`;
    case 'resident.task':
      return `${resident(f.subjects[0].id)}: ${label(f.values.kind)} · ${choiceOriginLabel(f.values.choiceOrigin)}.`;
    case 'resident.vitals':
      return `${resident(f.subjects[0].id)}: needs and skills updated.`;
    case 'resident.measurements': {
      const latest=f.values.readings.at(-1);
      return latest?`${resident(f.subjects[0].id)}: ${label(latest.evidenceKind)} reading ${latest.value}% at ${place(latest.place.id)} · world minute ${latest.minute}. ${f.values.readings.length} admitted ${f.values.readings.length===1?'reading':'readings'}.`:`${resident(f.subjects[0].id)} has no admitted readings since the public baseline.`;
    }
    case 'resident.affordances':
      return `${resident(f.subjects[0].id)}: available activities updated.`;
    case 'place.state':
      return `${place(f.subjects[0].id)}: ${label(f.values.kind)} updated.`;
    case 'construction.state':
      return `Construction at ${place(f.subjects[1].id)} reached ${label(f.values.stage)}.`;
    case 'project.state':
      return `${label(f.values.labelKey)} at ${place(f.subjects[1].id)}: ${f.values.progress}%.`;
    case 'parcel.state':
      return `Frontier ring ${f.values.ring}, sector ${f.values.slot + 1}: ${f.values.place ? 'Founded place' : f.values.build ? `Building ${label(f.values.build.kind)}` : label(f.values.state)}.`;
    case 'object.ownership':
      return `Garden tools belong to ${resident(f.subjects[1].id)}.`;
    case 'commitment.state':
      return `Tool loan between ${resident(f.subjects[1].id)} and ${resident(f.subjects[2].id)}: ${label(f.values.status)}.`;
    case 'venture.state':
      return `${label(f.values.labelKey)}: ${label(f.values.status)}. ${f.values.participants.map(p => `${resident(p.resident.id)} · ${label(p.consent)}`).join('; ')}.`;
    case 'venture.materials':
      return `Venture materials: timber ${f.values.timber.reserved} reserved / ${f.values.timber.consumed} consumed; stone ${f.values.stone.reserved} reserved / ${f.values.stone.consumed} consumed.`;
    case 'place.survey':
      return `${resident(f.subjects[1].id)} surveyed ${place(f.subjects[0].id)} at world minute ${f.values.surveyedMinute}: ${f.values.present} residents observed.`;
    case 'transit.state':
      return f.values.route ? `Meridian Central circuit: ${f.values.route.stops.length} outer ${f.values.route.stops.length === 1 ? 'station' : 'stations'} in service.` : 'Meridian Central is open; no outer circuit yet.';
  }
}

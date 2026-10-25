import { assemblyOperation, methodSelection, methodRevisionBasis, teachableMethod, activeMethodGrant, completedMethodLesson, learnerExecutionCurrent, mayRetestGrant } from '@meridian/world-kernel';
import type { PublicAffordance, PublicKind, PublicRef, WorldState } from '@meridian/world-schema';
export function inventionAffordances(w: WorldState, actor: string, ref: (kind: PublicKind, id: string) => PublicRef): PublicAffordance[] {
  const i = w.life?.invention;
  if (!i || w.residents[actor]?.lifeStage === 'child') return [];
  const r = <K extends PublicKind,>(kind: K, id: string) => ref(kind, id) as {
    kind: K;
    id: number;
  };
  const out: PublicAffordance[] = [];
  const offer = (siteId: string, fields: Omit<Extract<PublicAffordance, {
    code: 'invention';
  }>, 'code' | 'site'>) => out.push({
    code: 'invention',
    site: r('workpad', siteId),
    ...fields
  });
  for (const c of Object.values(i.consultations).sort((a, b) => a.createdMinute - b.createdMinute || a.id.localeCompare(b.id))) {
    if (c.status === 'answered') {
      if (c.requesterId === actor || c.peerId === actor) offer(c.siteId, {
        intent: 'withdraw-consultation',
        consultation: r('consultation', c.id)
      });
      continue;
    }
    if (!['requested', 'accepted'].includes(c.status) || c.expiresMinute <= w.canonicalMinute + 1) continue;
    if (c.peerId === actor) {
      const base = {
        consultation: r('consultation', c.id)
      };
      offer(c.siteId, {
        ...base,
        intent: 'decline'
      });
      if (c.status === 'requested') offer(c.siteId, {
        ...base,
        intent: 'accept'
      });else for (const suggest of ['add-guide', 'add-clamp', 'add-support', 'add-tray', 'remove-part', 'no-evidence'] as const) {
        offer(c.siteId, {
          ...base,
          intent: 'answer',
          suggest,
          certainty: 'tentative',
          sources: []
        });
        offer(c.siteId, {
          ...base,
          intent: 'answer',
          suggest,
          certainty: 'observed',
          sources: [r('trial', c.needTrialId)]
        });
      }
    }
    if (c.requesterId === actor) offer(c.siteId, {
      intent: 'withdraw-consultation',
      consultation: r('consultation', c.id)
    });
  }
  for(const g of Object.values(i.grants).sort((a,b)=>a.expiresMinute-b.expiresMinute||a.id.localeCompare(b.id))){
    if(!g.method||![g.teacherId,g.learnerId].includes(actor))continue;
    const siteId=i.designs[g.designId]!.input.site,grant=r('grant',g.id);
    if(['offered','accepted','demonstrated'].includes(g.status)&&g.expiresMinute>w.canonicalMinute+1)offer(siteId,{intent:'revoke-method',grant});
    if(actor===g.learnerId&&!g.method.acceptance&&['offered','accepted'].includes(g.status)&&g.expiresMinute>w.canonicalMinute+1){offer(siteId,{intent:'accept-method',grant});offer(siteId,{intent:'decline-method',grant});}
    if(!activeMethodGrant(w,g,w.canonicalMinute+1))continue;
    const lesson=g.method.lessons.at(-1);
    if(actor===g.teacherId){if(lesson?.status==='interrupted'&&lesson.invitationId===g.method.invitationId&&g.method.lessons.length<8)offer(siteId,{intent:'invite-lesson',grant});else if(!lesson||lesson.invitationId!==g.method.invitationId)offer(siteId,{intent:'start-lesson',grant});}
    if(actor===g.learnerId&&completedMethodLesson(w,g)){
      const a=Object.values(i.agendas).find(a=>a.ownerId===actor&&a.siteId===siteId&&!['closed','paused'].includes(a.stage));
      if(a?.needTrialId&&mayRetestGrant(w,actor,a.id,g.id)){
        if(g.method.executions.length<8)offer(siteId,{intent:'retest-method',grant,agenda:r('agenda',a.id)});
        for(const [index,e]of g.method.executions.entries())if(e.test.passed&&learnerExecutionCurrent(w,g,e)&&!Object.values(i.designs).some(d=>d.methodApplication&&'kind'in d.methodApplication&&d.methodApplication.executionId===e.id))offer(siteId,{intent:'adopt-reproduction',grant,agenda:r('agenda',a.id),attempt:index+1});
      }
    }
  }
  for(const artifact of Object.values(i.artifacts))for(const t of Object.values(i.trials)){
    const proof=teachableMethod(w,actor,artifact.id,t.id);if(!proof)continue;
    for(const learner of Object.keys(w.residents).sort())if(learner!==actor&&w.residents[learner]!.lifeStage!=='child'&&Object.values(i.agendas).some(a=>a.ownerId===learner&&a.needTrialId&&a.siteId===artifact.siteId&&!['closed','paused'].includes(a.stage))&&!Object.values(i.grants).some(g=>g.teacherId===actor&&g.learnerId===learner&&g.method?.methodVersionId===proof.method.id&&['offered','accepted','demonstrated'].includes(g.status)&&g.expiresMinute>w.canonicalMinute+1))offer(artifact.siteId,{intent:'offer-method',method:r('method',proof.method.id),artifact:r('artifact',artifact.id),trial:r('trial',t.id),peer:r('resident',learner)});
  }
  const a = Object.values(i.agendas).find(a => a.ownerId === actor && a.stage !== 'closed');
  if (a) {
    const agenda = r('agenda', a.id);
    offer(a.siteId, {
      intent: 'withdraw',
      agenda
    });
    if (a.stage === 'paused') {
      offer(a.siteId, {
        intent: 'resume',
        agenda
      });
      return out;
    }
    offer(a.siteId, {
      intent: 'pause',
      agenda
    });
    if (a.continuation?.status === 'running') return out;
    if (!a.needTrialId) for (const operation of ['garden-plant', 'lantern-post', 'market-box', 'map-frame'] as const) if (assemblyOperation(operation).template.placeId === i.sites[a.siteId]!.placeId) offer(a.siteId, {
      intent: 'baseline',
      agenda,
      operation
    });
    if (a.needTrialId) {
      const legacy=a.candidateIds.some(id=>!i.designs[id]?.methodApplication);
      const failed=Object.values(i.trials).filter(t=>methodRevisionBasis(w,actor,a.id,t.id)).sort((a,b)=>b.endedMinute-a.endedMinute)[0];
      const basis=a.candidateIds.length<2?null:failed?.id;
      if(!a.grantId&&!legacy&&basis!==undefined&&w.residents[actor]?.placeId===i.sites[a.siteId]!.placeId&&Object.keys(i.methods??{}).length<64)offer(a.siteId,{intent:'author-method',agenda,...(basis?{trial:r('trial',basis)}:{})});
      if(!a.grantId&&a.authoring&&!legacy&&basis!==undefined)for(const m of Object.values(i.methods??{})){
        const selected=methodSelection(w,actor,a.id,m.id);
        if(!selected||a.candidateIds.some(id=>{const d=i.designs[id]!,prior=d.methodApplication&&i.methods?.[d.methodApplication.methodVersionId];return prior?.origin.context.session===m.origin.context.session||JSON.stringify(d.input.parts)===JSON.stringify(selected.result.design!.parts);}))continue;
        offer(a.siteId,{intent:'adopt-version',agenda,method:r('method',m.id),...(basis?{trial:r('trial',basis)}:{})});
      }
      if (!a.grantId && !a.authoring && a.candidateIds.length < 2) offer(a.siteId, {
        intent: 'candidate',
        agenda,
        trial: r('trial', a.needTrialId)
      });
      if (!a.consultationId || !['requested', 'accepted'].includes(i.consultations[a.consultationId]!.status)) {
        for (const id of Object.keys(w.residents).sort()) if (id !== actor && w.residents[id]!.lifeStage !== 'child') offer(a.siteId, {
          intent: 'consult',
          agenda,
          peer: r('resident', id),
          trial: r('trial', a.needTrialId)
        });
      }
      if (a.candidateIds.length === (a.grantId?1:2)) for (const id of a.candidateIds) if (i.designs[id]!.status === 'validated') offer(a.siteId, {
        intent: 'build',
        agenda,
        design: r('design', id)
      });
      for (const artifact of Object.values(i.artifacts)) if (artifact.siteId === a.siteId && artifact.condition > 0 && (artifact.ownerId === actor || artifact.access === 'public-consented')) {
        for (const operation of ['garden-plant', 'lantern-post', 'market-box', 'map-frame'] as const) {
          const envelope = assemblyOperation(operation).envelope,
            trial = i.trials[a.needTrialId]!;
          if (JSON.stringify(envelope) === JSON.stringify(trial.operation)) { offer(a.siteId, {
            intent: 'test',
            agenda,
            artifact: r('artifact', artifact.id),
            trial: r('trial', trial.id),
            operation
          });
          if(Object.values(i.trials).some(t=>t.actorId===actor&&t.artifactId===artifact.id&&t.mode==='assisted'&&t.outcome==='passed'&&t.useful))offer(a.siteId,{intent:'production',agenda,artifact:r('artifact',artifact.id),trial:r('trial',trial.id),operation});
          }
        }
      }
    }
    return out;
  }
  for (const site of Object.values(i.sites)) for (const operation of ['garden-plant', 'lantern-post', 'market-box', 'map-frame'] as const) if (assemblyOperation(operation).template.placeId === site.placeId) offer(site.id, {
    intent: 'baseline',
    operation
  });
  return out;
}
/** Required stage choices survive both finite admission pages; ordinary alternatives remain available. */
export function cognitionActionPriority(action: PublicAffordance): number {
  if (action.code === 'rest' || action.code === 'think' || action.code === 'work') return -1;
  if (action.code !== 'invention') return 3;
  if(action.grant)return 0;
  if(action.intent==='offer-method')return 2;
  if (action.intent === 'withdraw-consultation') return 3;
  return action.consultation ? 0 : action.intent === 'consult' ? 2 : 1;
}

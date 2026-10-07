// Exercise the pure logic modules (no React Native imports).
import { S, transition, acceptsJobKind, estimateRoamingPremium } from '../src/lib/supplyState.js';
import { metresBetween, insideGeofence, availableProofActions, meetsFloor,
         GRADE, DELIVERY_MODE, driverMaySwitchToLeaveAtDoor } from '../src/lib/proof.js';
import { reconcile, stepOf, dropJobs, endedMessage, STEP, stageFor } from '../src/lib/currentJob.js';

let pass=0, fail=0;
const t=(name,cond)=>{ if(cond){pass++;console.log('  PASS '+name);} else {fail++;console.log('  FAIL '+name);} };

console.log('supply state machine');
t('offline -> zone ok', transition(S.OFFLINE,S.ZONE_COMMITTED).ok);
t('offline -> roaming blocked', !transition(S.OFFLINE,S.ROAMING_ELIGIBLE).ok);
t('cannot go offline mid-job', !transition(S.ZONE_COMMITTED,S.OFFLINE,{activeJob:true}).ok);
t('cannot switch to roaming mid-job', !transition(S.ZONE_COMMITTED,S.ROAMING_ELIGIBLE,{activeJob:true}).ok);
t('roaming_active must go to returning', !transition(S.ROAMING_ACTIVE,S.OFFLINE).ok);
t('returning -> zone ok', transition(S.RETURNING,S.ZONE_COMMITTED).ok);

console.log('dispatch eligibility');
t('zone driver gets zone jobs', acceptsJobKind(S.ZONE_COMMITTED,'ZONE'));
t('zone driver refuses roaming jobs', !acceptsJobKind(S.ZONE_COMMITTED,'ROAMING'));
t('roaming driver gets roaming jobs', acceptsJobKind(S.ROAMING_ELIGIBLE,'ROAMING'));
t('returning driver gets backhaul', acceptsJobKind(S.RETURNING,'BACKHAUL'));

console.log('roaming premium tracks supply');
t('short zone pays no premium', estimateRoamingPremium(0.8)===0);
t('oversupplied zone pays premium', estimateRoamingPremium(2.5)>0.3);

console.log('geofence');
const a={latitude:-33.8312,longitude:18.6512};
const near={latitude:-33.8313,longitude:18.6513};
const far={latitude:-33.9,longitude:18.7};
t('near point within 150m', insideGeofence(a,near,150));
t('far point outside 150m', !insideGeofence(a,far,150));
t('distance is sane', Math.round(metresBetween(a,far))>8000);

console.log('proof grading');
t('A beats the C floor', meetsFloor(GRADE.A,GRADE.C));
t('C fails a B floor', !meetsFloor(GRADE.C,GRADE.B));
t('driver can never self-select leave-at-door', driverMaySwitchToLeaveAtDoor()===false);

const job={ id:'J1', dropoff:a, deliveryMode:DELIVERY_MODE.HANDOFF_REQUIRED,
  proofPolicy:{minGrade:GRADE.C, geofenceMetres:150, otpAttemptLimit:4} };
const outside = availableProofActions({job,position:far,online:true,otpAttempts:0});
t('outside geofence blocks completion', !outside.inFence && outside.actions.length===0);
const inside = availableProofActions({job,position:near,online:true,otpAttempts:0});
t('inside geofence offers OTP at grade A', inside.actions.some(x=>x.key==='OTP'&&x.grade===GRADE.A));
const offline = availableProofActions({job,position:near,online:false,otpAttempts:0});
t('offline downgrades OTP to grade B', offline.actions.find(x=>x.key==='OTP').grade===GRADE.B);
const exhausted = availableProofActions({job,position:near,online:true,otpAttempts:4});
t('attempts exhausted removes OTP, keeps escalation',
  !exhausted.actions.some(x=>x.key==='OTP') && exhausted.actions.some(x=>x.key==='ESCALATE'));

const wine={...job, deliveryMode:DELIVERY_MODE.LEAVE_AT_DOOR,
  proofPolicy:{...job.proofPolicy, minGrade:GRADE.B}};
const wineActions = availableProofActions({job:wine,position:near,online:true,otpAttempts:0});
t('age-restricted leave-at-door forced back to OTP',
  wineActions.actions.some(x=>x.key==='OTP') && !wineActions.actions.some(x=>x.key==='PHOTO'));

/* ------------------------------------------------ never stuck: current job */
console.log('never stuck: the four delivery steps');
const STORE={latitude:-33.8312,longitude:18.6512}, DOOR={latitude:-33.8401,longitude:18.6588};
const AWAY={latitude:STORE.latitude+0.0054,longitude:STORE.longitude};
const one={id:'J1',orderNumber:'KFC-1',pickup:{...STORE,name:'KFC'},dropoff:{...DOOR,name:'14 Pienaar Rd'}};
const steps=[
  ['to store',   {stopIndex:0, position:AWAY},  STEP.TO_STORE],
  ['at store',   {stopIndex:0, position:STORE}, STEP.AT_STORE],
  ['to customer',{stopIndex:1, position:STORE}, STEP.TO_CUSTOMER],
  ['at door',    {stopIndex:1, position:DOOR},  STEP.AT_DOOR],
];
const cancelled={ok:true, body:{jobs:[], stops:[], stopIndex:0, ended:[{jobId:'J1', reason:'CANCELLED'}]}};
for (const [name, where, step] of steps) {
  const local={jobs:[one], stops:[], ...where};
  t(`${name}: recognised as ${step}`, stepOf(local)===step);
  const r=reconcile(local, cancelled);
  t(`${name}: an office cancel ends the run with the message`,
    r.action==='end' && r.message==='The office cancelled this order. No action needed.');
}

console.log('never stuck: every reason has one plain sentence');
const endWith=(reason)=>reconcile({jobs:[one]}, {ok:true, body:{jobs:[], ended:[{jobId:'J1', reason}]}});
t('closed', endWith('CLOSED').message==='The office closed this order. No action needed.');
t('reassigned', endWith('REASSIGNED').message==='This order was given to another driver. No action needed.');
t('cleared', endWith('CLEARED').message==='The office took this order off you. No action needed.');
t('delivered by me ends quietly', endWith('DELIVERED').action==='end' && endWith('DELIVERED').message===null);
t('unknown reason still ends, as closed', endWith('SOMETHING_NEW').message===endedMessage('CLOSED'));

console.log('never stuck: signal, sign-out, nothing changed');
t('no signal changes nothing', reconcile({jobs:[one]}, {ok:false, status:0}).action==='none');
t('a 500 changes nothing', reconcile({jobs:[one]}, {ok:false, status:500}).action==='none');
t('401 signs out', reconcile({jobs:[one]}, {ok:false, status:401}).action==='signout');
t('401 signs out with no job too', reconcile({jobs:[]}, {ok:false, status:401}).action==='signout');
t('still mine: nothing to do', reconcile({jobs:[one]}, {ok:true, body:{jobs:[one], ended:[]}}).action==='none');
t('a finished drop the phone already marked done is not re-ended',
  reconcile({jobs:[{...one, done:true}]}, {ok:true, body:{jobs:[], ended:[]}}).action==='none');

console.log('never stuck: restore');
const lost=reconcile({jobs:[]}, {ok:true, body:{jobs:[one], stops:[], stopIndex:1, batchId:null, stage:'NAVIGATE_CUSTOMER'}});
t('dispatch has a job the phone lost: restore it', lost.action==='restore' && lost.jobs[0].id==='J1');
t('restored at the right stop', lost.stopIndex===1 && lost.stage==='NAVIGATE_CUSTOMER');
t('nothing anywhere: nothing to do', reconcile({jobs:[]}, {ok:true, body:{jobs:[], ended:[]}}).action==='none');

console.log('never stuck: part of a run');
const A={...one, id:'A', orderNumber:'KFC-A'}, B={...one, id:'B', orderNumber:'KFC-B'}, C={...one, id:'C', orderNumber:'KFC-C'};
const P={kind:'PICKUP', name:'KFC', jobIds:['A','B','C'], lat:STORE.latitude, lng:STORE.longitude};
const D=(id)=>({kind:'DROPOFF', name:id, jobIds:[id], lat:DOOR.latitude, lng:DOOR.longitude});
const run={jobs:[A,B,C], stops:[P,D('A'),D('B'),D('C')], stopIndex:2};
const part=reconcile(run, {ok:true, body:{jobs:[A,C], ended:[{jobId:'B', reason:'CANCELLED'}]}});
t('one of three cancelled: drop it, keep going', part.action==='drop' && part.jobIds.join()==='B');
t('says which order', part.message==='Order KFC-B was cancelled by the office. Carry on with the rest.');
const after=dropJobs(run, ['B']);
t('its stop is gone', after.stops.length===3 && after.stops.every((s)=>!s.jobIds.includes('B')));
t('the driver moves on to the next drop', after.stops[after.stopIndex].jobIds.join()==='C');
t('a stop before the current one going keeps the place',
  dropJobs({...run, stopIndex:3}, ['A']).stops[dropJobs({...run, stopIndex:3}, ['A']).stopIndex].jobIds.join()==='C');
const lastOne=dropJobs({jobs:[A,B], stops:[{...P, jobIds:['A','B']},D('A'),D('B')], stopIndex:1}, ['A']);
t('down to one order: a single delivery, at its drop-off', lastOne.jobs.length===1 && lastOne.stops.length===0 && lastOne.stopIndex===1);
t('all three ended: the run ends',
  reconcile(run, {ok:true, body:{jobs:[], ended:['A','B','C'].map((jobId)=>({jobId, reason:'CLEARED'}))}}).action==='end');

console.log('next job near the drop-off');
const chainRun={jobs:[one,{...one,id:'N'}], stops:[
  {kind:'PICKUP',jobIds:['J1'],lat:STORE.latitude,lng:STORE.longitude},
  {kind:'DROPOFF',jobIds:['J1'],lat:DOOR.latitude,lng:DOOR.longitude},
  {kind:'PICKUP',jobIds:['N'],lat:DOOR.latitude+0.01,lng:DOOR.longitude},
  {kind:'DROPOFF',jobIds:['N'],lat:DOOR.latitude+0.02,lng:DOOR.longitude}], stopIndex:1};
t('after the drop-off the next stop is a store: To store', stageFor(chainRun.stops[2])==='NAVIGATE_STORE');
t('a door stop is To customer', stageFor(chainRun.stops[3])==='NAVIGATE_CUSTOMER');
const cancelFirst=dropJobs(chainRun,['J1']);
t('current order cancelled: the next job remains, at its store',
  cancelFirst.jobs.length===1 && cancelFirst.jobs[0].id==='N' && cancelFirst.stopIndex===0);

console.log('\n'+pass+' passed, '+fail+' failed');
process.exit(fail?1:0);

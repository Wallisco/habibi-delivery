// Exercise the pure logic modules (no React Native imports).
import { S, transition, acceptsJobKind, estimateRoamingPremium } from '../src/lib/supplyState.js';
import { metresBetween, insideGeofence, availableProofActions, meetsFloor,
         GRADE, DELIVERY_MODE, driverMaySwitchToLeaveAtDoor } from '../src/lib/proof.js';

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

console.log('\n'+pass+' passed, '+fail+' failed');
process.exit(fail?1:0);

import test from 'node:test';
import assert from 'node:assert/strict';
import {createRoom,addPlayer,startGame,submitAnswer,finishWriting,revealFish,bankPoints,nextRound,resetGame,snapshot,skipRound,MAX_PLAYERS,expireWriting} from '../assets/engine.mjs';
const deck = [{id:'1',question:'¿Qué soy?',answer:'Verdad'}, {id:'2',question:'¿Qué era?',answer:'Otra verdad'}];
function build(n=4) {
  const s=createRoom('ABCD23','host-token-12345678901234567890','Anfitrión');
  for(let i=1;i<n;i++) addPlayer(s,`token-very-long-12345-${i}`,`Persona ${i}`);
  startGame(s,deck,1000);
  return s;
}
function fill(s) {
  const r=s.current;
  s.order.filter(id=>id!==r.blue&&id!==r.guesser).forEach((id,i)=>submitAnswer(s,id,'Mentira '+i));
  assert.equal(s.current.phase,'guessing');
}
test('lobby 4 a 10, prevents 11 and duplicates',()=>{
  const s=createRoom('ABCD23','host-token-12345678901234567890','Anfitrión');
  for(let i=1;i<MAX_PLAYERS;i++) addPlayer(s,`token-very-long-12345-${i}`,`Persona ${i}`);
  assert.equal(s.players.length,10);
  assert.throws(()=>addPlayer(s,'token-very-long-12345-10','Once'));
  assert.equal(addPlayer(s,s.players[2].id,'Persona 2').name,'Persona 2');
});
test('secrecy: fisherman never gets truth or blue identity until reveal',()=>{
  const s=build(4),r=s.current;
  const look=snapshot(s,r.guesser);
  assert.equal(look.round.myTruth,null);
  assert.equal(look.round.answers.length,0);
  assert.equal(s.usedQuestions.length,1);
  assert.equal(snapshot(s,r.blue).round.myTruth,r.truth);
  fill(s);
  const after=snapshot(s,r.guesser);
  assert.equal(after.round.answers.some(a=>a.role==='blue'),false);
  assert.equal('blue' in after.round,false);
});
test('banking after 1 red, red unflipped scores 1',()=>{
  const s=build(4),r=s.current;fill(s);
  const first=s.order.find(id=>id!==r.guesser&&id!==r.blue);
  revealFish(s,r.guesser,first);
  bankPoints(s,r.guesser);
  assert.equal(s.current.roundPoints,1);
  assert.equal(s.players.find(p=>p.id===r.guesser).score,1);
  assert.equal(s.players.find(p=>p.id===first).score,0);
  const otherRed=s.order.find(id=>id!==r.guesser&&id!==r.blue&&id!==first);
  assert.equal(s.players.find(p=>p.id===otherRed).score,1);
  assert.equal(s.players.find(p=>p.id===r.blue).score,0);
});
test('catch blue: fisherman loses round; blue scores remaining fish',()=>{
  const s=build(4),r=s.current;fill(s);
  revealFish(s,r.guesser,r.blue);
  assert.equal(r.phase,'result');
  assert.equal(s.players.find(p=>p.id===r.guesser).score,0);
  assert.equal(s.players.find(p=>p.id===r.blue).score,2);
  for(const p of s.players.filter(p=>p.id!==r.blue&&p.id!==r.guesser)) assert.equal(p.score,1);
});
test('catch every red: extra +1 and auto result',()=>{
  const s=build(10),r=s.current;fill(s);
  for(const id of s.order.filter(id=>id!==r.guesser&&id!==r.blue)) revealFish(s,r.guesser,id);
  assert.equal(r.phase,'result');
  assert.equal(s.players.find(p=>p.id===r.guesser).score,9);
});
test('4-5 players get two turns, 6-10 one each',()=>{
  assert.equal(build(4).totalTurns,8);
  assert.equal(build(5).totalTurns,10);
  assert.equal(build(6).totalTurns,6);
  assert.equal(build(10).totalTurns,10);
});
test('timeout and host emergency skip; cannot duplicate points',()=>{
  const s=build(5),r=s.current;
  assert.equal(expireWriting(s,91001),true);
  assert.equal(r.phase,'guessing');
  assert.equal(r.answers[r.blue],r.truth);
  skipRound(s,s.hostToken);
  assert.ok(s.players.every(p=>p.score===0));
  assert.throws(()=>skipRound(s,s.hostToken));
  nextRound(s,s.hostToken,deck,100000);
  assert.equal(s.current.number,2);
});
test('all full games end and can be reset',()=>{
  const s=build(6);
  for(let i=0;i<6;i++) {
    const r=s.current; finishWriting(s); bankPoints(s,r.guesser); nextRound(s,s.hostToken,deck,10000+i);
  }
  assert.equal(s.status,'finished');
  resetGame(s,s.hostToken);
  assert.equal(s.status,'lobby');
  assert.equal(s.players.length,6);
});
test('public snapshots never expose private player tokens',()=>{
  const s=build(8);
  const first=s.order[0];
  for(const observer of s.order){
    const view=snapshot(s,observer);
    for(const privateToken of s.order){
      assert.equal(JSON.stringify(view).includes(privateToken),false);
    }
    assert.equal(view.players.length,8);
    assert.ok(view.players.every(p=>p.id.length===8));
  }
  assert.notEqual(snapshot(s,first).me,first);
});
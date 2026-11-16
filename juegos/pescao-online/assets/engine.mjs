/** Reglas originales de una variante web del juego social de mentiras. */
export const MIN_PLAYERS = 4;
export const MAX_PLAYERS = 10;
export const ANSWER_SECONDS = 90;

export function randomInt(max) {
  if (!Number.isInteger(max) || max < 1) throw new Error('Rango invalido');
  const bytes = new Uint32Array(1);
  const ceiling = Math.floor(4294967296 / max) * max;
  do { crypto.getRandomValues(bytes); } while (bytes[0] >= ceiling);
  return bytes[0] % max;
}
export function roomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({length: 6}, () => alphabet[randomInt(alphabet.length)]).join('');
}
export function cleanName(input) {
  return String(input ?? '').trim().replace(/\s+/g, ' ').slice(0, 22);
}
export function createRoom(code, hostToken, hostName) {
  const name = cleanName(hostName);
  if (!name) throw new Error('Escribe tu nombre.');
  if (!/^[A-HJ-NP-Z2-9]{6}$/.test(code)) throw new Error('Código inválido.');
  return {
    version: 1, code, hostToken,
    status: 'lobby', created: Date.now(), turnIndex: 0,
    totalTurns: 0, usedQuestions: [], order: [], current: null,
    players: [{ id: hostToken, tag: crypto.randomUUID().slice(0, 8), name, connected: true, score: 0 }]
  };
}
export function getPlayer(state, token) {
  return state.players.find(p => p.id === token);
}
export function addPlayer(state, token, requestedName) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 120) throw new Error('Sesión inválida.');
  const existing = getPlayer(state, token);
  if (existing) {
    existing.connected = true;
    return existing;
  }
  if (state.status !== 'lobby') throw new Error('La partida ya comenzó.');
  if (state.players.length >= MAX_PLAYERS) throw new Error('La sala está llena (10 jugadores).');
  const name = cleanName(requestedName);
  if (name.length < 2) throw new Error('Tu nombre necesita al menos 2 letras.');
  if (state.players.some(p => p.name.toLowerCase() === name.toLowerCase())) throw new Error('Ese nombre ya está en la sala.');
  const player = { id: token, tag: crypto.randomUUID().slice(0, 8), name, connected: true, score: 0 };
  state.players.push(player);
  return player;
}
export function removePlayer(state, token) {
  if (state.status !== 'lobby') throw new Error('Sólo puedes salir de la sala antes de comenzar.');
  if (token === state.hostToken) throw new Error('El anfitrión no puede salir sin cerrar la sala.');
  state.players = state.players.filter(p => p.id !== token);
}
export function setConnected(state, token, value) {
  const p = getPlayer(state, token);
  if (p) p.connected = Boolean(value);
}
function chooseQuestion(state, deck) {
  if (!Array.isArray(deck) || deck.length < 1) throw new Error('No hay preguntas.');
  const unused = deck.filter(c => !state.usedQuestions.includes(c.id));
  if (!unused.length) state.usedQuestions = [];
  const pool = unused.length ? unused : deck;
  const q = pool[randomInt(pool.length)];
  state.usedQuestions.push(q.id);
  return q;
}
function newRound(state, deck, now) {
  const q = chooseQuestion(state, deck);
  const guesser = state.order[state.turnIndex % state.order.length];
  const others = state.order.filter(id => id !== guesser);
  const blue = others[randomInt(others.length)];
  state.current = {
    number: state.turnIndex + 1,
    phase: 'writing', guesser, blue,
    questionId: q.id, question: q.question, truth: q.answer,
    deadline: now + ANSWER_SECONDS * 1000,
    answers: { [blue]: q.answer }, revealed: [],
    outcome: null, settlement: null, roundPoints: 0, lastReveal: null
  };
}
export function startGame(state, deck, now = Date.now()) {
  if (state.status !== 'lobby') throw new Error('La partida ya comenzó.');
  if (state.players.length < MIN_PLAYERS || state.players.length > MAX_PLAYERS) {
    throw new Error('Se necesitan entre 4 y 10 jugadores.');
  }
  if (state.players.some(p => !p.connected)) throw new Error('Espera a que todos estén conectados.');
  state.players.forEach(p => { p.score = 0; });
  state.order = state.players.map(p => p.id);
  state.turnIndex = 0;
  state.totalTurns = state.players.length * (state.players.length <= 5 ? 2 : 1);
  state.usedQuestions = [];
  state.status = 'playing';
  newRound(state, deck, now);
}
export function submitAnswer(state, token, rawText) {
  const r = state.current;
  if (state.status !== 'playing' || r?.phase !== 'writing') throw new Error('No es momento de responder.');
  if (token === r.guesser) throw new Error('El pescador no responde.');
  if (token === r.blue) throw new Error('Tu respuesta verdadera ya está preparada.');
  if (!getPlayer(state, token)) throw new Error('No perteneces a la sala.');
  if (r.answers[token]) throw new Error('Ya enviaste una respuesta.');
  const text = String(rawText ?? '').trim().replace(/\s+/g, ' ').slice(0, 130);
  if (text.length < 2) throw new Error('Escribe una mentira de al menos 2 caracteres.');
  r.answers[token] = text;
  if (state.order.filter(id => id !== r.guesser).every(id => Boolean(r.answers[id]))) {
    finishWriting(state);
  }
}
export function finishWriting(state) {
  const r = state.current;
  if (state.status !== 'playing' || r?.phase !== 'writing') throw new Error('Las respuestas ya están listas.');
  for (const id of state.order) {
    if (id !== r.guesser && !r.answers[id]) r.answers[id] = 'Me quedé sin palabras 🫧';
  }
  r.phase = 'guessing';
  r.deadline = null;
}
export function expireWriting(state, now = Date.now()) {
  if (state.current?.phase === 'writing' && now >= state.current.deadline) {
    finishWriting(state);
    return true;
  }
  return false;
}
function settle(state, outcome) {
  const r = state.current;
  const countFlipped = r.revealed.length;
  const redCount = state.order.length - 2;
  const blueCaught = r.revealed.includes(r.blue);
  const caughtReds = r.revealed.filter(id => id !== r.blue).length;
  const bank = outcome === 'bank' || outcome === 'sweep';
  r.roundPoints = bank ? caughtReds + (caughtReds === redCount ? 1 : 0) : 0;
  r.settlement = state.order.map(id => {
    let delta = 0;
    let role = 'red';
    if (id === r.guesser) {
      role = 'guesser';
      delta = r.roundPoints;
    } else if (id === r.blue) {
      role = 'blue';
      delta = blueCaught ? state.order.length - 1 - countFlipped : 0;
    } else if (!r.revealed.includes(id)) {
      delta = countFlipped;
    }
    if (outcome === 'skip') delta = 0;
    const p = getPlayer(state, id);
    p.score += delta;
    return { id, role, delta, total: p.score };
  });
  r.outcome = outcome;
  r.phase = 'result';
  r.deadline = null;
}
export function revealFish(state, token, target) {
  const r = state.current;
  if (state.status !== 'playing' || r?.phase !== 'guessing') throw new Error('Todavía no puedes pescar.');
  if (r.guesser !== token) throw new Error('Sólo el pescador puede revelar peces.');
  if (!state.order.includes(target) || target === r.guesser || r.revealed.includes(target)) {
    throw new Error('Ese pez no se puede elegir.');
  }
  r.revealed.push(target);
  r.lastReveal = { id: target, role: target === r.blue ? 'blue' : 'red' };
  if (target === r.blue) settle(state, 'caught');
  else if (r.revealed.length === state.order.length - 2) settle(state, 'sweep');
  return r.lastReveal.role;
}
export function bankPoints(state, token) {
  const r = state.current;
  if (r?.phase !== 'guessing' || token !== r.guesser) throw new Error('No puedes plantarte ahora.');
  settle(state, 'bank');
}
export function skipRound(state, token) {
  if (token !== state.hostToken) throw new Error('Sólo el anfitrión puede saltar rondas.');
  if (state.status !== 'playing' || !['writing','guessing'].includes(state.current?.phase)) {
    throw new Error('No hay ronda activa.');
  }
  settle(state, 'skip');
}
export function nextRound(state, token, deck, now = Date.now()) {
  if (token !== state.hostToken) throw new Error('Sólo el anfitrión puede avanzar.');
  if (state.status !== 'playing' || state.current?.phase !== 'result') throw new Error('Espera a que termine la ronda.');
  state.turnIndex++;
  if (state.turnIndex >= state.totalTurns) {
    state.status = 'finished';
    state.current = null;
  } else newRound(state, deck, now);
}
export function resetGame(state, token) {
  if (token !== state.hostToken) throw new Error('Sólo el anfitrión puede reiniciar.');
  state.status = 'lobby';
  state.current = null;
  state.turnIndex = 0;
  state.totalTurns = 0;
  state.order = [];
  state.usedQuestions = [];
  state.players.forEach(p => { p.score = 0; });
}
export function publicId(state, privateToken) {
  return getPlayer(state, privateToken)?.tag ?? null;
}
export function snapshot(state, viewer) {
  const id = token => publicId(state, token);
  const base = {
    code: state.code, status: state.status, host: id(state.hostToken),
    me: id(viewer),
    players: state.players.map(p => ({id:p.tag, name:p.name, connected:p.connected, score:p.score})),
    turnIndex: state.turnIndex, totalTurns: state.totalTurns,
    round: null
  };
  const r = state.current;
  if (!r) return base;
  const mine = r.guesser === viewer ? 'guesser' : r.blue === viewer ? 'blue' : 'red';
  const visible = r.phase !== 'writing';
  base.round = {
    number: r.number, phase: r.phase, guesser: id(r.guesser),
    question: r.question, deadline: r.deadline,
    mine, myTruth: r.phase === 'writing' && mine === 'blue' ? r.truth : null,
    mySubmitted: Boolean(r.answers[viewer]),
    submittedIds: state.order.filter(token => token !== r.guesser && Boolean(r.answers[token])).map(id),
    answers: visible ? state.order.filter(token => token !== r.guesser).map(token => ({
      id:id(token), text:r.answers[token], flipped:r.revealed.includes(token),
      role:r.revealed.includes(token) || r.phase === 'result' ? (token === r.blue ? 'blue' : 'red') : null
    })) : [],
    flippedIds: r.revealed.map(id),
    lastReveal: r.lastReveal ? {id:id(r.lastReveal.id),role:r.lastReveal.role}:null,
    caught: r.revealed.filter(token => token !== r.blue).length,
    outcome: r.phase === 'result' ? r.outcome : null,
    roundPoints: r.phase === 'result' ? r.roundPoints : null,
    settlement: r.phase === 'result' ? r.settlement.map(s=>({...s,id:id(s.id)})) : null,
    truth: r.phase === 'result' ? r.truth : null
  };
  return base;
}
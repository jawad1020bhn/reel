import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createXR } from './helpers/xr.mjs';

function setup({ image = false, fallback = '' } = {}) {
  const { XR, load } = createXR();
  const network = { onLine: true };
  const window = new EventTarget();
  const target = new EventTarget();
  Object.assign(target, { paused: true, readyState: 0, currentTime: 0, complete: false, naturalWidth: 0, src: 'original.jpg', getAttribute() { return this.src; } });
  let now = 0, nextId = 0;
  const timers = new Map(), changes = [];
  XR.provide('ui.dom', {}); XR.provide('ui.widgets', {});
  load('src/ui/media-feedback.js', {
    window, navigator: network,
    setTimeout: (fn, ms) => { const id = ++nextId; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  const feedback = XR.resolve('ui.mediaFeedback').observe(target, { image, fallback, onChange: state => changes.push(state) });
  function tick(ms) {
    const end = now + ms;
    for (;;) {
      const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at; timers.delete(due[0]); due[1].fn();
    }
    now = end;
  }
  const emit = type => target.dispatchEvent(new Event(type));
  const online = value => { network.onLine = value; window.dispatchEvent(new Event(value ? 'online' : 'offline')); };
  return { target, feedback, changes, timers, tick, emit, online, phase: () => feedback.state.phase };
}

test('initial loading is delayed, ongoing playback waits say buffering, and slow is not failure', () => {
  const h = setup();
  h.feedback.setActive(true); h.feedback.begin();
  h.tick(449); assert.equal(h.phase(), 'idle');
  h.tick(1); assert.equal(h.phase(), 'loading');
  h.target.paused = false; h.emit('playing');
  assert.equal(h.phase(), 'idle'); assert.equal(h.timers.size, 0);
  h.emit('waiting'); h.tick(450); assert.equal(h.phase(), 'buffering');
  h.tick(7550); assert.equal(h.phase(), 'slow');
  assert.equal(h.feedback.state.failed, false, 'timeouts do not claim unavailability');
  h.emit('canplay'); assert.equal(h.phase(), 'idle');
});

test('offline is relevant only when media needs data; online alone does not mean recovered', () => {
  const h = setup(); h.feedback.setActive(true);
  h.target.paused = false; h.emit('playing'); h.online(false);
  assert.equal(h.phase(), 'idle', 'cached/buffered playback is not covered by an offline card');
  h.emit('waiting'); assert.equal(h.phase(), 'offline');
  assert.equal(h.feedback.state.failed, false);
  h.online(true); assert.equal(h.phase(), 'reconnect');
  h.emit('playing'); assert.equal(h.phase(), 'idle');
  h.online(false); assert.equal(h.phase(), 'idle');
});

test('native source fallback errors are not terminal; exhausted sources get retry feedback', () => {
  const h = setup(); h.feedback.setActive(true); h.feedback.begin();
  h.emit('error'); h.tick(450); assert.equal(h.phase(), 'loading');
  h.emit('xr:unplayable'); assert.equal(h.phase(), 'error');
  assert.equal(h.feedback.state.failed, true);
  h.online(false); assert.equal(h.phase(), 'offline');
  h.online(true); assert.equal(h.phase(), 'reconnect');
  assert.equal(h.feedback.state.failed, true);
  h.emit('canplay'); assert.equal(h.feedback.state.failed, false);
});

test('a failed image tries its preview once, then reports failure instead of an endless wait', () => {
  const h = setup({ image: true, fallback: 'preview.jpg' });
  h.feedback.setActive(true); h.tick(450); assert.equal(h.phase(), 'loading');
  h.emit('error'); assert.equal(h.target.src, 'preview.jpg');
  assert.equal(h.feedback.state.failed, false);
  h.emit('error'); assert.equal(h.phase(), 'error');
  assert.equal(h.timers.size, 0);
  h.emit('load'); assert.equal(h.phase(), 'idle');
});

test('off-screen and destroyed media have no announcements or active timers', () => {
  const h = setup({ image: true });
  h.tick(9000); assert.equal(h.timers.size, 0); assert.equal(h.changes.length, 0);
  h.feedback.setActive(true); h.tick(450); assert.equal(h.phase(), 'loading');
  h.feedback.setActive(false); assert.equal(h.phase(), 'idle'); assert.equal(h.timers.size, 0);
  h.feedback.setActive(true); h.feedback.destroy();
  const count = h.changes.length;
  h.emit('error'); h.online(false); h.tick(9000);
  assert.equal(h.changes.length, count); assert.equal(h.timers.size, 0);
});

test('pause and stalls with enough buffered data do not display loading', () => {
  const h = setup(); h.feedback.setActive(true); h.feedback.begin();
  h.emit('pause'); h.tick(9000); assert.equal(h.phase(), 'idle');
  h.target.readyState = 4; h.target.paused = false; h.emit('stalled');
  h.tick(9000); assert.equal(h.phase(), 'idle');
});

test('an already decoded offline image needs no loading or availability claim', () => {
  const { XR, load } = createXR();
  XR.provide('ui.dom', {}); XR.provide('ui.widgets', {});
  load('src/ui/media-feedback.js', { navigator: { onLine: false } });
  const target = Object.assign(new EventTarget(), { complete: true, naturalWidth: 320 });
  const changes = [];
  const feedback = XR.resolve('ui.mediaFeedback').observe(target, { image: true, onChange: state => changes.push(state) });
  feedback.setActive(true); feedback.begin();
  assert.equal(feedback.state.phase, 'idle');
  assert.equal(changes.length, 0);
  feedback.destroy();
});

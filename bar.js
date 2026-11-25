const api = window.dimmer;

const opacityInput = document.getElementById('opacity');
const opacityVal = document.getElementById('opacity-val');
const passthroughBtn = document.getElementById('passthrough');
const hideBtn = document.getElementById('hide');
const quitBtn = document.getElementById('quit');
const bar = document.getElementById('bar');
const fullBtn = document.getElementById('full');

let state = { opacity: 0.6, passthrough: false, full: false };

function apply(s) {
  state = { ...state, ...s };
  opacityInput.value = String(Math.round(state.opacity * 100));
  opacityVal.textContent = Math.round(state.opacity * 100) + '%';
  passthroughBtn.classList.toggle('active', !!state.passthrough);
  bar.classList.toggle('passthrough', !!state.passthrough);
  bar.classList.toggle('full', !!state.full);
  fullBtn.classList.toggle('active', !!state.full);
  fullBtn.textContent = state.full ? '⤡' : '⤢';
  fullBtn.title = state.full
    ? 'Restore previous size (⌘⇧F / Ctrl⇧F)'
    : 'Full screen (⌘⇧F / Ctrl⇧F)';
}

api.onApply(apply);
api.getState().then(apply);

opacityInput.addEventListener('input', () => {
  api.update({ opacity: Number(opacityInput.value) / 100 });
});

passthroughBtn.addEventListener('click', () => api.update({ passthrough: !state.passthrough }));
fullBtn.addEventListener('click', () => api.update({ full: !state.full }));
hideBtn.addEventListener('click', () => api.hide());
quitBtn.addEventListener('click', () => api.quit());

// keyboard: arrows nudge (Shift = 1 px), Esc hides
document.addEventListener('keydown', (e) => {
  const step = e.shiftKey ? 1 : 10;
  let dx = 0;
  let dy = 0;
  if (e.key === 'ArrowLeft') dx = -step;
  else if (e.key === 'ArrowRight') dx = step;
  else if (e.key === 'ArrowUp') dy = -step;
  else if (e.key === 'ArrowDown') dy = step;
  else if (e.key === 'Escape') { api.hide(); return; }
  else return;
  e.preventDefault();
  api.nudge(dx, dy);
});

// drag the whole overlay by the bar (anything that is not a control)
let drag = null;
let pending = null;

// double-click on the bar toggles full screen
bar.addEventListener('dblclick', (e) => {
  if (!e.target.closest('.no-drag')) api.update({ full: !state.full });
});

bar.addEventListener('pointerdown', async (e) => {
  if (e.button !== 0 || state.full || e.target.closest('.no-drag')) return;
  e.preventDefault();
  bar.setPointerCapture(e.pointerId);
  bar.classList.add('dragging');
  const r = await api.getRect();
  if (!r) return;
  drag = { sx: e.screenX, sy: e.screenY, x: r.x, y: r.y };
});

bar.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const first = !pending;
  pending = { x: drag.x + e.screenX - drag.sx, y: drag.y + e.screenY - drag.sy };
  // one IPC per frame is enough
  if (first) requestAnimationFrame(() => {
    if (pending) api.moveTo(pending.x, pending.y);
    pending = null;
  });
});

function endDrag() {
  if (!drag) return;
  drag = null;
  bar.classList.remove('dragging');
  api.dragEnd();
}
bar.addEventListener('pointerup', endDrag);
bar.addEventListener('pointercancel', endDrag);
bar.addEventListener('lostpointercapture', endDrag);
